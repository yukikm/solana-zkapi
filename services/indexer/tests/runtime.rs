//! Mock archive HTTP boundaries using account bytes emitted by the real SBF
//! integration harness. These checks do not claim live RPC/finality validation.
use axum::{extract::State, routing::post, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use zkapi_indexer::{
    rpc::decode_finalized_block,
    runtime::{ArchiveRpc, Config},
    Bytes32, ChainState, Indexer,
};

fn key(s: &str) -> Bytes32 {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}
fn b58(v: Bytes32) -> String {
    bs58::encode(v).into_string()
}
fn pda(program: Bytes32, seeds: &[&[u8]]) -> (Bytes32, u8) {
    let (key, bump) = Pubkey::find_program_address(seeds, &Pubkey::new_from_array(program));
    (key.to_bytes(), bump)
}
type Handler = Arc<dyn Fn(Value) -> Value + Send + Sync>;
struct Mock {
    rpc: ArchiveRpc,
    url: String,
    calls: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn mock(handler: impl Fn(Value) -> Value + Send + Sync + 'static) -> Mock {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let wrapped: Handler = Arc::new(move |request| {
        recorded.lock().unwrap().push(request.clone());
        handler(request)
    });
    async fn endpoint(State(handler): State<Handler>, Json(request): Json<Value>) -> Json<Value> {
        Json(handler(request))
    }
    let app = Router::new().route("/", post(endpoint)).with_state(wrapped);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Mock {
        rpc: ArchiveRpc::new(url.clone()).unwrap(),
        url,
        calls,
        task,
    }
}
fn success(request: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":request["id"],"result":result})
}
#[derive(Clone)]
struct Fixture {
    cfg: Config,
    expected: ChainState,
    accounts: Value,
    blocks: BTreeMap<u64, Value>,
}
impl Fixture {
    fn load(pending: bool) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let history: Value = serde_json::from_slice(
            &fs::read(root.join("target/i04/sdk-svm-history.json"))
                .expect("run the SDK/SBF integration harness to generate account checkpoints"),
        )
        .unwrap();
        let scenario = history["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "challenge")
            .unwrap();
        let checkpoint = if pending {
            scenario["checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"].as_str().unwrap().starts_with("initiate_escape"))
                .unwrap()
        } else {
            scenario["checkpoints"].as_array().unwrap().last().unwrap()
        };
        let fixture: Value =
            serde_json::from_slice(&fs::read(root.join("tests/fixtures/vault/a.json")).unwrap())
                .unwrap();
        let program: Bytes32 = hex::decode(fixture["program_id"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let pool: Bytes32 = hex::decode(fixture["pool"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let cut = checkpoint["slot"].as_u64().unwrap();
        let mut index = Indexer::new(program, pool);
        let mut blocks = BTreeMap::new();
        for row in scenario["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|b| b["slot"].as_u64().unwrap() <= cut)
        {
            let slot = row["slot"].as_u64().unwrap();
            index
                .apply_block(&decode_finalized_block(slot, &row["block"]).unwrap())
                .unwrap();
            blocks.insert(slot, row["block"].clone());
        }
        let accounts = checkpoint["accounts"].clone();
        let pool_raw = STANDARD
            .decode(accounts[b58(pool)]["data"][0].as_str().unwrap())
            .unwrap();
        let cfg = Config {
            rpc_url: "http://127.0.0.1:1".into(),
            program_id: b58(program),
            pool: b58(pool),
            genesis_hash: b58(pool_raw[10..42].try_into().unwrap()),
            circuit_profile_hash: hex::encode(&pool_raw[358..390]),
            start_slot: 1,
            listen: "127.0.0.1:0".into(),
            public_origin: "http://127.0.0.1".into(),
            snapshots_directory: root.join("target/i04/runtime-snapshots"),
        };
        Self {
            cfg,
            expected: index.replay_state().unwrap(),
            accounts,
            blocks,
        }
    }
    fn response(&self, request: &Value) -> Value {
        let result = match request["method"].as_str().unwrap() {
            "getMultipleAccounts" => {
                assert_eq!(request["params"][1]["commitment"], "finalized");
                assert_eq!(request["params"][1]["minContextSlot"], self.expected.slot);
                let values: Vec<_> = request["params"][0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| self.accounts[k.as_str().unwrap()].clone())
                    .collect();
                json!({"context":{"slot":self.expected.slot},"value":values})
            }
            "getBlock" => {
                assert_eq!(request["params"][1]["commitment"], "finalized");
                assert_eq!(request["params"][1]["maxSupportedTransactionVersion"], 0);
                self.blocks
                    .get(&request["params"][0].as_u64().unwrap())
                    .cloned()
                    .unwrap_or(Value::Null)
            }
            "getSlot" => {
                assert_eq!(request["params"][0]["commitment"], "finalized");
                json!(self.expected.slot)
            }
            "getBlocks" => {
                assert_eq!(request["params"][2]["commitment"], "finalized");
                let from = request["params"][0].as_u64().unwrap();
                let to = request["params"][1].as_u64().unwrap();
                json!(self
                    .blocks
                    .range(from..=to)
                    .map(|(s, _)| *s)
                    .collect::<Vec<_>>())
            }
            _ => panic!("unexpected mock RPC method: {}", request["method"]),
        };
        success(request, result)
    }
    fn mutate_account(&mut self, address: Bytes32, edit: impl FnOnce(&mut Vec<u8>)) {
        let v = &mut self.accounts[b58(address)]["data"][0];
        let mut raw = STANDARD.decode(v.as_str().unwrap()).unwrap();
        edit(&mut raw);
        *v = json!(STANDARD.encode(raw));
    }
}
#[tokio::test]
async fn actual_anchor_account_bytes_reconcile_active_and_pending_with_all_offsets() {
    for pending in [false, true] {
        let f = Fixture::load(pending);
        let copy = f.clone();
        let server = mock(move |r| copy.response(&r)).await;
        let observed = server.rpc.observe_chain(&f.cfg, &f.expected).await.unwrap();
        assert_eq!(observed, f.expected);
        assert_eq!(!observed.pending.is_empty(), pending);
        assert!(!observed.active.is_empty());
        assert!(server
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "getBlock"));
    }
}
#[tokio::test]
async fn account_owner_layout_profile_status_and_anchor_mutations_fail_closed() {
    let base = Fixture::load(true);
    let program = key(&base.cfg.program_id);
    let pool = key(&base.cfg.pool);
    let tree = pda(program, &[b"tree", &pool]).0;
    let active_id = *base.expected.active.keys().next().unwrap();
    let active = pda(program, &[b"note", &pool, &active_id.to_le_bytes()]).0;
    let pending_id = *base.expected.pending.keys().next().unwrap();
    let pending_note = pda(program, &[b"note", &pool, &pending_id.to_le_bytes()]).0;
    let pending = pda(program, &[b"pending", &pool, &pending_id.to_le_bytes()]).0;
    for (label, address, offset) in [
        ("pool discriminator", pool, 0),
        ("pool layout", pool, 8),
        ("pool bump", pool, 9),
        ("pool genesis", pool, 10),
        ("pool profile", pool, 358),
        ("pool seed", pool, 390),
        ("tree discriminator", tree, 0),
        ("tree bump", tree, 9),
        ("note bump", active, 9),
        ("note id", active, 10),
        ("active note status", active, 62),
        ("pending note status", pending_note, 62),
        ("pending bump", pending, 9),
        ("pending exists", pending, 10),
    ] {
        let mut f = base.clone();
        f.mutate_account(address, |raw| raw[offset] ^= 1);
        let copy = f.clone();
        let server = mock(move |r| copy.response(&r)).await;
        assert!(
            server.rpc.observe_chain(&f.cfg, &f.expected).await.is_err(),
            "{label}"
        );
    }
    for field in [
        "owner",
        "executable",
        "encoding",
        "missing",
        "length",
        "noncanonical-root",
        "balance",
    ] {
        let mut f = base.clone();
        match field {
            "owner" => f.accounts[b58(active)]["owner"] = json!(b58([99; 32])),
            "executable" => f.accounts[b58(active)]["executable"] = json!(true),
            "encoding" => f.accounts[b58(active)]["data"][1] = json!("base58"),
            "missing" => f.accounts[b58(active)] = Value::Null,
            "length" => f.mutate_account(pool, |raw| raw.push(0)),
            "noncanonical-root" => f.mutate_account(tree, |raw| raw[10..42].fill(255)),
            "balance" => f.mutate_account(pending, |raw| {
                raw[75..83].copy_from_slice(&u64::MAX.to_le_bytes())
            }),
            _ => unreachable!(),
        }
        let copy = f.clone();
        let server = mock(move |r| copy.response(&r)).await;
        assert!(
            server.rpc.observe_chain(&f.cfg, &f.expected).await.is_err(),
            "{field}"
        );
    }
    let mut f = base.clone();
    f.blocks.get_mut(&f.expected.slot).unwrap()["blockhash"] = json!(b58([22; 32]));
    let copy = f.clone();
    let server = mock(move |r| copy.response(&r)).await;
    assert!(server.rpc.observe_chain(&f.cfg, &f.expected).await.is_err());
}
#[tokio::test]
async fn advanced_cut_and_split_account_batches_are_not_combined() {
    let f = Fixture::load(false);
    let copy = f.clone();
    let server = mock(move |r| {
        let mut response = copy.response(&r);
        if r["method"] == "getMultipleAccounts" {
            response["result"]["context"]["slot"] = json!(copy.expected.slot + 1);
        }
        response
    })
    .await;
    let err = server
        .rpc
        .observe_chain(&f.cfg, &f.expected)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("cut advanced"));
    assert!(!server
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "getBlock"));
    // Stress only the context-cut policy using copies of an actual Note layout.
    // This synthetic multi-batch set is not counted as a real chain/proof result.
    let mut f = Fixture::load(false);
    let program = key(&f.cfg.program_id);
    let pool = key(&f.cfg.pool);
    let template = f.expected.active.values().next().unwrap().clone();
    let source = pda(program, &[b"note", &pool, &template.id.to_le_bytes()]).0;
    let template_account = f.accounts[b58(source)].clone();
    for id in 2..112u32 {
        let mut note = template.clone();
        note.id = id;
        f.expected.active.insert(id, note);
        let (address, bump) = pda(program, &[b"note", &pool, &id.to_le_bytes()]);
        f.accounts[b58(address)] = template_account.clone();
        f.mutate_account(address, |raw| {
            raw[9] = bump;
            raw[10..14].copy_from_slice(&id.to_le_bytes());
        });
    }
    let counter = Arc::new(AtomicUsize::new(0));
    let observed = counter.clone();
    let copy = f.clone();
    let server = mock(move |r| {
        let mut response = copy.response(&r);
        if r["method"] == "getMultipleAccounts" && observed.fetch_add(1, Ordering::SeqCst) > 0 {
            response["result"]["context"]["slot"] = json!(copy.expected.slot + 1);
        }
        response
    })
    .await;
    let err = server
        .rpc
        .observe_chain(&f.cfg, &f.expected)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("cut advanced"));
    assert_eq!(counter.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn catch_up_retries_transport_result_failure_and_requires_independent_reconciliation() {
    let f = Fixture::load(true);
    let copy = f.clone();
    let failures = Arc::new(AtomicUsize::new(0));
    let count = failures.clone();
    let server=mock(move |r|{
        if r["method"]=="getBlock" && count.fetch_add(1,Ordering::SeqCst)==0 {
            return json!({"jsonrpc":"2.0","id":r["id"],"error":{"code":-32000,"message":"temporary archive failure"}});
        }copy.response(&r)
    }).await;
    let mut index = Indexer::new(key(&f.cfg.program_id), key(&f.cfg.pool));
    let mut next = f.cfg.start_slot;
    assert!(server.rpc.catch_up(&mut index, &mut next).await.is_err());
    assert_eq!(next, 1);
    assert!(!index.is_ready());
    server.rpc.catch_up(&mut index, &mut next).await.unwrap();
    assert_eq!(next, f.expected.slot + 1);
    assert!(!index.is_ready());
    assert_eq!(index.replay_state().unwrap(), f.expected);
    let observed = server
        .rpc
        .observe_chain(&f.cfg, &index.replay_state().unwrap())
        .await
        .unwrap();
    index.reconcile(&observed).unwrap();
    assert!(index.is_ready());
}
#[tokio::test]
async fn incomplete_or_reordered_archive_never_becomes_ready() {
    for failure in ["unordered", "missing-block", "missing-tail"] {
        let f = Fixture::load(false);
        let copy = f.clone();
        let server = mock(move |r| {
            let mut response = copy.response(&r);
            match failure {
                "unordered" if r["method"] == "getBlocks" => {
                    response["result"].as_array_mut().unwrap().swap(0, 1)
                }
                "missing-block" if r["method"] == "getBlock" && r["params"][0] == 2 => {
                    response["result"] = Value::Null
                }
                "missing-tail" if r["method"] == "getBlocks" => {
                    response["result"].as_array_mut().unwrap().pop();
                }
                _ => {}
            }
            response
        })
        .await;
        let mut index = Indexer::new(key(&f.cfg.program_id), key(&f.cfg.pool));
        let mut next = 1;
        assert!(
            server.rpc.catch_up(&mut index, &mut next).await.is_err(),
            "{failure}"
        );
        assert!(!index.is_ready());
        assert!(index.root().is_err());
    }
}
#[tokio::test]
async fn rpc_envelope_errors_are_rejected_without_leaking_provider_details() {
    for result in [
        json!({"jsonrpc":"2.0","id":7,"result":1}),
        json!({"jsonrpc":"2.0","id":1,"result":null}),
        json!({"jsonrpc":"2.0","id":1,"error":{"message":"secret-provider-key"}}),
    ] {
        let server = mock(move |_| result.clone()).await;
        let err = server.rpc.call("getSlot", json!([])).await.unwrap_err();
        assert!(!err.to_string().contains("secret-provider-key"));
        assert!(server.url.starts_with("http://127.0.0.1:"));
    }
}
