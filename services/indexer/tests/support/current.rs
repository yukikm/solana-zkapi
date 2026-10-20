//! Real SBF account cuts; mock finality, RPC faults and loader metadata.
#![allow(dead_code)]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use zkapi_indexer::{
    current_state::{self as cs, service, Batch, Capture, Header, ProgramPin, Settings},
    ChainState, Indexer,
};
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
pub fn bytes(v: &Value) -> Vec<u8> {
    STANDARD.decode(v["data"][0].as_str().unwrap()).unwrap()
}
pub fn replace(v: &mut Value, raw: Vec<u8>) {
    v["data"] = json!([STANDARD.encode(raw), "base64"]);
}
pub fn key(s: &str) -> [u8; 32] {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}
pub fn b58(v: impl AsRef<[u8]>) -> String {
    bs58::encode(v).into_string()
}
pub fn manifest() -> Value {
    let a: Value =
        serde_json::from_slice(&std::fs::read(root().join("tests/fixtures/vault/a.json")).unwrap())
            .unwrap();
    let mut m: Value = serde_json::from_slice(
        &std::fs::read(root().join("tests/fixtures/layout2/profile.json")).unwrap(),
    )
    .unwrap();
    let field = |name: &str| b58(hex::decode(a[name].as_str().unwrap()).unwrap());
    let p = &a["auth"]["request"]["public_inputs"];
    for(k,v)in json!({"program_id":field("program_id"),"pool":field("pool"),"genesis_hash":field("genesis"),
        "mint":field("mint"),"token_program":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","vault_binding":p[2],
        "state_key":{"x":p[4],"y":p[5]},"clearance_key":{"x":a["auth"]["escape"]["public_inputs"][6],"y":a["auth"]["escape"]["public_inputs"][7]},
        "cap_micro_usdc":"1000000","note_ttl_seconds":"2592000","challenge_seconds":"86400","decimals":6,
        "deployment_environment":"local","transaction_formats":["v0_buffer"],"deployment_id":"challenger-test"}).as_object().unwrap(){m[k]=v.clone();}
    m["manifest_hash"] = hex::encode(Sha256::digest(serde_jcs::to_vec(&m).unwrap())).into();
    m
}
#[derive(Clone)]
pub struct Fixture {
    pub trusted: zkapi_control::chain::TrustedPool,
    pub manifest: Value,
    pub expected: ChainState,
    pub accounts: Value,
    pub time: u64,
    pub blocks: Vec<Value>,
}
impl Fixture {
    pub fn load(scenario: &str, cut_name: &str) -> Self {
        let history: Value = serde_json::from_slice(
            &std::fs::read(root().join("target/i04/sdk-svm-history.json"))
                .expect("run local sdk_transport SBF harness"),
        )
        .unwrap();
        let s = history["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == scenario)
            .unwrap();
        let cut = s["checkpoints"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"].as_str().unwrap().starts_with(cut_name))
            .unwrap();
        let manifest = manifest();
        let trusted = zkapi_control::chain::TrustedPool::from_manifest(&manifest).unwrap();
        let mut index = Indexer::new(key(&trusted.program_id), key(&trusted.pool));
        let blocks: Vec<_> = s["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|b| b["slot"].as_u64() <= cut["slot"].as_u64())
            .cloned()
            .collect();
        for b in &blocks {
            index
                .apply_block(
                    &zkapi_indexer::rpc::decode_finalized_block(
                        b["slot"].as_u64().unwrap(),
                        &b["block"],
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        Self {
            trusted,
            manifest,
            expected: index.replay_state().unwrap(),
            accounts: cut["accounts"].clone(),
            time: blocks.last().unwrap()["block"]["blockTime"]
                .as_u64()
                .unwrap(),
            blocks,
        }
    }
    pub fn settings(&self, dir: &Path) -> Settings {
        Settings {
            mode: cs::POLICY.into(),
            poll_idle_seconds: 10,
            poll_active_seconds: 2,
            max_note_ids: 4096,
            rpc_concurrency: 4,
            max_response_bytes: 16 * 1024 * 1024,
            max_chain_time_age_seconds: 120,
            state_socket: dir.join("state.sock"),
            cache_file: dir.join("state.json"),
        }
    }
    pub fn deployment(&self) -> [u8; 32] {
        service::hash(self.manifest["manifest_hash"].as_str().unwrap()).unwrap()
    }
    pub fn batch(&self, first_id: u32, pairs: u32, slot: u64) -> Batch {
        let keys = cs::addresses(&self.trusted, first_id, pairs).unwrap();
        let mut values: Vec<_> = keys.iter().map(|k| self.accounts[k].clone()).collect();
        assert!(
            !values[2].is_null() && !values[3].is_null(),
            "regenerate SBF fixture with Vault and Clock"
        );
        let mut clock = bytes(&values[3]);
        clock[..8].copy_from_slice(&slot.to_le_bytes());
        replace(&mut values[3], clock);
        Batch {
            slot,
            first_id,
            pairs,
            values,
        }
    }
    pub fn capture(&self, capacity: u32) -> Capture {
        let mut batches = vec![self.batch(0, capacity.min(48), self.expected.slot)];
        let mut first = capacity.min(48);
        while (first as u64) < self.expected.next_note_id {
            let pairs = (self.expected.next_note_id as u32 - first).min(48);
            batches.push(self.batch(first, pairs, self.expected.slot));
            first += pairs;
        }
        let mut c = Capture {
            schema: 1,
            policy: cs::POLICY.into(),
            deployment: self.deployment(),
            boot: service::boot_id().unwrap(),
            started_ms: service::monotonic_ms().unwrap(),
            batches,
            header: Header {
                slot: self.expected.slot,
                blockhash: self.expected.blockhash,
                block_time: self.time,
            },
            digest: [0; 32],
        };
        c.digest = c.digest().unwrap();
        c
    }
    pub fn wall_now(&mut self) {
        self.time = service::wall_time();
        let k = cs::CLOCK;
        let mut raw = bytes(&self.accounts[k]);
        raw[32..40].copy_from_slice(&self.time.to_le_bytes());
        replace(&mut self.accounts[k], raw);
    }
    pub fn config(&self, dir: &Path, url: String) -> service::Config {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
        let elf = std::fs::read(root().join("target/i04-sbf/zkapi_vault.so"))
            .expect("local pinned SBF ELF");
        std::fs::write(dir.join("vault.so"), &elf).unwrap();
        service::Config {
            config_version: 2,
            manifest: dir.join("manifest.json"),
            manifest_sha256: hex::encode(self.deployment()),
            devnet: None,
            program_identity: ProgramPin {
                program_file: dir.join("vault.so"),
                sha256: hex::encode(Sha256::digest(&elf)),
                deployment_slot: 1,
                authority: Some(b58([7; 32])),
                programdata_len: 45 + elf.len() + 32,
            },
            rpc_url: url,
            listen: "127.0.0.1:0".into(),
            public_origin: "http://127.0.0.1".into(),
            snapshots_directory: dir.join("snapshots"),
            chain_state: self.settings(dir),
        }
    }
    pub fn rpc_result(&self, request: &Value) -> Value {
        match request["method"].as_str().unwrap() {
            "getGenesisHash" => json!(self.trusted.genesis_hash),
            "getMultipleAccounts" => {
                let keys = request["params"][0].as_array().unwrap();
                let values: Vec<_> = keys
                    .iter()
                    .map(|k| self.accounts[k.as_str().unwrap()].clone())
                    .collect();
                json!({"context":{"slot":self.expected.slot},"value":values})
            }
            "getBlock" => {
                assert_eq!(request["params"][1]["transactionDetails"], "none");
                json!({"blockhash":b58(self.expected.blockhash),"blockTime":self.time})
            }
            other => panic!("forbidden history RPC {other}"),
        }
    }
}
pub struct Mock {
    pub url: String,
    pub calls: Arc<Mutex<Vec<Value>>>,
    pub task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn mock(handler: impl Fn(Value) -> Value + Send + Sync + 'static) -> Mock {
    use axum::{extract::State, routing::post, Json, Router};
    type Handler = Arc<dyn Fn(Value) -> Value + Send + Sync>;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let log = calls.clone();
    let h: Handler = Arc::new(move |q| {
        log.lock().unwrap().push(q.clone());
        handler(q)
    });
    async fn endpoint(State(h): State<Handler>, Json(q): Json<Value>) -> Json<Value> {
        Json(h(q))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/", post(endpoint)).with_state(h),
        )
        .await
        .unwrap();
    });
    Mock { url, calls, task }
}
pub fn success(request: &Value, value: Value) -> Value {
    json!({"jsonrpc":"2.0","id":request["id"],"result":value})
}
pub fn loader_accounts(f: &Fixture, cfg: &service::Config) -> BTreeMap<String, Value> {
    use solana_pubkey::Pubkey;
    let loader = "BPFLoaderUpgradeab1e11111111111111111111111";
    let (data, _) = Pubkey::find_program_address(
        &[&key(&f.trusted.program_id)],
        &Pubkey::new_from_array(key(loader)),
    );
    let mut program = 2u32.to_le_bytes().to_vec();
    program.extend(data.to_bytes());
    let mut raw = 3u32.to_le_bytes().to_vec();
    raw.extend(1u64.to_le_bytes());
    raw.push(1);
    raw.extend([7; 32]);
    raw.extend(std::fs::read(&cfg.program_identity.program_file).unwrap());
    raw.resize(cfg.program_identity.programdata_len, 0);
    [(f.trusted.program_id.clone(),program,true),(data.to_string(),raw,false)].into_iter().map(|(k,b,e)|{
        (k,json!({"owner":loader,"executable":e,"lamports":1,"space":b.len(),"data":[STANDARD.encode(b),"base64"]}))
    }).collect()
}
