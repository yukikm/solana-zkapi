//! Finalized archive polling and public, read-only tree endpoints.
//! Start at or before pool initialization; incomplete archive/account views fail closed.
use crate::{discriminator, rpc, Bytes32, ChainState, Indexer, Note, Pending};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use std::{collections::BTreeMap, error::Error, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::RwLock;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub rpc_url: String,
    pub program_id: String,
    pub pool: String,
    pub genesis_hash: String,
    pub circuit_profile_hash: String,
    pub start_slot: u64,
    pub listen: String,
    pub public_origin: String,
    pub snapshots_directory: PathBuf,
}
fn key(text: &str) -> Result<Bytes32> {
    Ok(bs58::decode(text)
        .into_vec()?
        .try_into()
        .map_err(|_| "invalid public key")?)
}
fn b58(bytes: &Bytes32) -> String {
    bs58::encode(bytes).into_string()
}
fn pda(program: &Bytes32, seeds: &[&[u8]]) -> (Bytes32, u8) {
    let (key, bump) = Pubkey::find_program_address(seeds, &Pubkey::new_from_array(*program));
    (key.to_bytes(), bump)
}
fn array<const N: usize>(raw: &[u8], at: usize) -> Result<[u8; N]> {
    Ok(raw.get(at..at + N).ok_or("short account")?.try_into()?)
}
fn u64_at(raw: &[u8], at: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(array(raw, at)?))
}
fn check_account(raw: &[u8], name: &str, len: usize, bump: u8) -> Result<()> {
    if raw.len() != len
        || raw[..8] != discriminator("account", name)
        || raw[8] != 2
        || raw[9] != bump
    {
        return Err("invalid account layout/PDA".into());
    }
    Ok(())
}
fn decode_note(raw: &[u8], id: u32, status: u8, bump: u8) -> Result<Note> {
    check_account(raw, "Note", 63, bump)?;
    if u32::from_le_bytes(array(raw, 10)?) != id || raw[62] != status {
        return Err("note status/id mismatch".into());
    }
    let note = Note {
        id,
        commitment: array(raw, 14)?,
        deposit: u64_at(raw, 46)?,
        expiry: u64_at(raw, 54)?,
    };
    note.leaf()?;
    Ok(note)
}
fn decode_pending(raw: &[u8], note: Note, bump: u8) -> Result<Pending> {
    check_account(raw, "PendingWithdrawal", 123, bump)?;
    if raw[10] != 1 {
        return Err("missing pending withdrawal".into());
    }
    let pending = Pending {
        note,
        old_root: array(raw, 11)?,
        nullifier: array(raw, 43)?,
        balance: u64_at(raw, 75)?,
        destination_owner: array(raw, 83)?,
        deadline: u64_at(raw, 115)?,
    };
    if pending.balance > pending.note.deposit {
        return Err("pending balance".into());
    }
    crate::canonical(pending.old_root)?;
    crate::canonical(pending.nullifier)?;
    Ok(pending)
}
#[derive(Clone)]
pub struct ArchiveRpc {
    client: reqwest::Client,
    url: String,
}
impl ArchiveRpc {
    pub fn new(url: String) -> Result<Self> {
        let parsed = reqwest::Url::parse(&url)?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("RPC must use HTTP(S)".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url,
        })
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let response = self
            .client
            .post(&self.url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| "RPC transport unavailable")?;
        if !response.status().is_success() {
            return Err("RPC HTTP error".into());
        }
        let body: Value = response.json().await.map_err(|_| "RPC invalid JSON")?;
        if body["id"] != 1 || body.get("error").is_some() {
            return Err("RPC response error".into());
        }
        body.get("result")
            .cloned()
            .filter(|v| !v.is_null())
            .ok_or_else(|| "RPC result unavailable".into())
    }
    async fn accounts(
        &self,
        keys: &[Bytes32],
        slot: u64,
        program: &Bytes32,
    ) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        for batch in keys.chunks(100) {
            let response=self.call("getMultipleAccounts",json!([batch.iter().map(b58).collect::<Vec<_>>(),{"commitment":"finalized","encoding":"base64","minContextSlot":slot}])).await?;
            if response["context"]["slot"].as_u64() != Some(slot) {
                return Err("RPC account cut advanced; replay next finalized cut".into());
            }
            let values = response["value"].as_array().ok_or("RPC account list")?;
            if values.len() != batch.len() {
                return Err("RPC account count".into());
            }
            for value in values {
                if value["owner"].as_str() != Some(b58(program).as_str())
                    || value["executable"] != false
                    || value["data"][1] != "base64"
                {
                    return Err("RPC account owner/encoding".into());
                }
                out.push(STANDARD.decode(value["data"][0].as_str().ok_or("missing account")?)?);
            }
        }
        Ok(out)
    }
    pub async fn observe_chain(&self, cfg: &Config, expected: &ChainState) -> Result<ChainState> {
        let program = key(&cfg.program_id)?;
        let pool = key(&cfg.pool)?;
        let (tree, tree_bump) = pda(&program, &[b"tree", &pool]);
        let mut keys = vec![pool, tree];
        for id in expected.active.keys() {
            keys.push(pda(&program, &[b"note", &pool, &id.to_le_bytes()]).0);
        }
        for id in expected.pending.keys() {
            keys.push(pda(&program, &[b"note", &pool, &id.to_le_bytes()]).0);
            keys.push(pda(&program, &[b"pending", &pool, &id.to_le_bytes()]).0);
        }
        let values = self.accounts(&keys, expected.slot, &program).await?;
        let pool_raw = &values[0];
        if pool_raw.len() != 422 {
            return Err("pool length".into());
        }
        let pool_id: Bytes32 = array(pool_raw, 390)?;
        let (derived, bump) = pda(&program, &[b"pool", &pool_id]);
        check_account(pool_raw, "PoolConfig", 422, bump)?;
        if derived != pool
            || array::<32>(pool_raw, 10)? != key(&cfg.genesis_hash)?
            || pool_raw[356..358] != [1, 1]
            || pool_raw[358..390] != hex::decode(&cfg.circuit_profile_hash)?
        {
            return Err("pool profile/genesis mismatch".into());
        }
        let tree_raw = &values[1];
        check_account(tree_raw, "TreeState", 66, tree_bump)?;
        let root = array(tree_raw, 10)?;
        crate::canonical(root)?;
        let mut active = BTreeMap::new();
        let mut pending = BTreeMap::new();
        let mut at = 2;
        for id in expected.active.keys() {
            let bump = pda(&program, &[b"note", &pool, &id.to_le_bytes()]).1;
            active.insert(*id, decode_note(&values[at], *id, 1, bump)?);
            at += 1;
        }
        for id in expected.pending.keys() {
            let note_bump = pda(&program, &[b"note", &pool, &id.to_le_bytes()]).1;
            let pending_bump = pda(&program, &[b"pending", &pool, &id.to_le_bytes()]).1;
            let note = decode_note(&values[at], *id, 2, note_bump)?;
            pending.insert(*id, decode_pending(&values[at + 1], note, pending_bump)?);
            at += 2;
        }
        let block=self.call("getBlock",json!([expected.slot,{"commitment":"finalized","transactionDetails":"none","maxSupportedTransactionVersion":0,"rewards":false}])).await?;
        if key(block["blockhash"].as_str().ok_or("blockhash missing")?)? != expected.blockhash {
            return Err("block anchor mismatch".into());
        }
        Ok(ChainState {
            slot: expected.slot,
            blockhash: expected.blockhash,
            root,
            sequence: u64_at(tree_raw, 50)?,
            next_note_id: u64_at(tree_raw, 42)?,
            outstanding_deposits: u64_at(tree_raw, 58)?,
            active,
            pending,
        })
    }
    pub async fn catch_up(&self, index: &mut Indexer, next_slot: &mut u64) -> Result<()> {
        // A failed refresh must not leave an earlier reconciled root available
        // through the library API. Every refresh requires a fresh account cut.
        index.ready = false;
        let tip = self
            .call("getSlot", json!([{"commitment":"finalized"}]))
            .await?
            .as_u64()
            .ok_or("invalid finalized slot")?;
        let mut scan = *next_slot;
        while scan <= tip {
            let end = scan.saturating_add(999).min(tip);
            let slots = self
                .call("getBlocks", json!([scan,end,{"commitment":"finalized"}]))
                .await?;
            let mut prior = None;
            for slot in slots.as_array().ok_or("invalid block range")? {
                let slot = slot.as_u64().ok_or("invalid block slot")?;
                if slot < scan || slot > end || prior.is_some_and(|p| slot <= p) {
                    return Err("unordered block range".into());
                }
                let value=self.call("getBlock",json!([slot,{"commitment":"finalized","encoding":"json","transactionDetails":"full","maxSupportedTransactionVersion":0,"rewards":false}])).await?;
                index.apply_block(&rpc::decode_finalized_block(slot, &value)?)?;
                *next_slot = slot.checked_add(1).ok_or("slot overflow")?;
                prior = Some(slot);
            }
            // Empty/skipped slots advance only this attempt's scan. Keep the
            // retry cursor at the last applied block: an incomplete range can
            // omit its tail, and that tail must be fetched again on retry.
            scan = end.checked_add(1).ok_or("slot overflow")?;
        }
        if index.replay_state()?.slot != tip {
            return Err("finalized tip block is unavailable".into());
        }
        Ok(())
    }
}
struct Published {
    index: Indexer,
    available: bool,
}
#[derive(Clone)]
struct HttpState {
    state: Arc<RwLock<Published>>,
    config: Arc<Config>,
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":{"code":"indexer_unavailable","message":"Finalized history or account reconciliation is incomplete","retriable":true}}))).into_response()
}
fn invalid() -> Response {
    (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"invalid_path","message":"The requested note path is unavailable","retriable":false}}))).into_response()
}
async fn root(State(s): State<HttpState>) -> Response {
    let state = s.state.read().await;
    if !state.available {
        return unavailable();
    }
    match state.index.root() {
        Ok(value) => Json(value).into_response(),
        Err(_) => unavailable(),
    }
}
async fn note_path(State(s): State<HttpState>, Path(id): Path<String>) -> Response {
    path_response(s, id, false).await
}
async fn path_response(s: HttpState, id: String, zero: bool) -> Response {
    let Ok(parsed) = id.parse::<u32>() else {
        return invalid();
    };
    if parsed.to_string() != id {
        return invalid();
    }
    let state = s.state.read().await;
    if !state.available {
        return unavailable();
    }
    let result = if zero {
        state.index.zero_path(parsed)
    } else {
        state.index.path(parsed)
    };
    match result {
        Ok(value) => {
            let encoded = serde_json::to_value(value).unwrap();
            if (encoded["leaf"] == format!("0x{}", "00".repeat(32))) != zero {
                return invalid();
            }
            Json(encoded).into_response()
        }
        Err(_) => invalid(),
    }
}
async fn zero_path(State(s): State<HttpState>, Path(id): Path<String>) -> Response {
    path_response(s, id, true).await
}
async fn snapshot(State(s): State<HttpState>) -> Response {
    let state = s.state.read().await;
    if !state.available {
        return unavailable();
    }
    let Ok(bytes) = state.index.snapshot_bytes() else {
        return unavailable();
    };
    let digest = hex::encode(Sha256::digest(&bytes));
    let file = s.config.snapshots_directory.join(format!("{digest}.json"));
    // Content-addressed snapshots remain valid across later chain updates.
    if std::fs::write(&file, &bytes).is_err() {
        return unavailable();
    }
    match state.index.root(){Ok(value)=>Json(json!({"snapshot":value,"sha256":digest,"download_url":format!("{}/zkapi/v1/tree/snapshots/{digest}.json",s.config.public_origin.trim_end_matches('/'))})).into_response(),Err(_)=>unavailable()}
}
async fn download(State(s): State<HttpState>, Path(name): Path<String>) -> Response {
    let Some(digest) = name.strip_suffix(".json") else {
        return invalid();
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return invalid();
    }
    let Ok(bytes) = std::fs::read(s.config.snapshots_directory.join(&name)) else {
        return invalid();
    };
    if hex::encode(Sha256::digest(&bytes)) != digest {
        return unavailable();
    }
    ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
pub async fn serve(cfg: Config) -> Result<()> {
    let program = key(&cfg.program_id)?;
    let pool = key(&cfg.pool)?;
    key(&cfg.genesis_hash)?;
    if cfg.circuit_profile_hash.len() != 64 || hex::decode(&cfg.circuit_profile_hash)?.len() != 32 {
        return Err("profile hash length".into());
    }
    let origin = reqwest::Url::parse(&cfg.public_origin)?;
    if !matches!(origin.scheme(), "http" | "https")
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
    {
        return Err("public origin".into());
    }
    let rpc = ArchiveRpc::new(cfg.rpc_url.clone())?;
    if rpc.call("getGenesisHash", json!([])).await?.as_str() != Some(cfg.genesis_hash.as_str()) {
        return Err("RPC genesis mismatch".into());
    }
    std::fs::create_dir_all(&cfg.snapshots_directory)?;
    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    let config = Arc::new(cfg);
    let state = Arc::new(RwLock::new(Published {
        index: Indexer::new(program, pool),
        available: false,
    }));
    let shared = HttpState {
        state: state.clone(),
        config: config.clone(),
    };
    let worker = tokio::spawn(async move {
        let mut index = Indexer::new(program, pool);
        let mut next = config.start_slot;
        loop {
            state.write().await.available = false;
            let result: Result<()> = async {
                rpc.catch_up(&mut index, &mut next).await?;
                let expected = index.replay_state()?;
                let observed = rpc.observe_chain(&config, &expected).await?;
                index.reconcile(&observed)?;
                Ok(())
            }
            .await;
            if result.is_ok() {
                *state.write().await = Published {
                    index: index.clone(),
                    available: true,
                };
            }
            // Never log raw RPC errors: URLs can contain provider credentials.
            else {
                eprintln!("indexer paused: finalized archive/account reconciliation incomplete");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let app = Router::new()
        .route("/zkapi/v1/tree/root", get(root))
        .route("/zkapi/v1/tree/snapshot", get(snapshot))
        .route("/zkapi/v1/tree/notes/{id}/path", get(note_path))
        .route("/zkapi/v1/tree/notes/{id}/zero-path", get(zero_path))
        .route("/zkapi/v1/tree/snapshots/{name}", get(download))
        .with_state(shared);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    worker.abort();
    result?;
    Ok(())
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use axum::body::to_bytes;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    async fn body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }
    fn fixture() -> (Indexer, Config) {
        let raw = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/i04/sdk-svm-history.json"),
        )
        .expect("run sdk_transport first");
        let value: Value = serde_json::from_slice(&raw).unwrap();
        let scenario = value["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "challenge")
            .unwrap();
        let first = rpc::decode_finalized_block(1, &scenario["blocks"][0]["block"]).unwrap();
        let initialize = first
            .transactions
            .iter()
            .flat_map(|t| t.instructions.iter())
            .find(|i| {
                i.data
                    .starts_with(&discriminator("global", "initialize_pool"))
            })
            .unwrap();
        let mut index = Indexer::new(initialize.program, initialize.accounts[0]);
        for entry in scenario["blocks"].as_array().unwrap() {
            index
                .apply_block(
                    &rpc::decode_finalized_block(entry["slot"].as_u64().unwrap(), &entry["block"])
                        .unwrap(),
                )
                .unwrap();
        }
        // API shape tests; independent real-account reconciliation is covered by tests/runtime.rs.
        index.reconcile(&index.replay_state().unwrap()).unwrap();
        let config = Config {
            rpc_url: "http://127.0.0.1:1".into(),
            program_id: b58(&index.program()),
            pool: b58(&index.pool()),
            genesis_hash: b58(&[0; 32]),
            circuit_profile_hash: "00".repeat(32),
            start_slot: 1,
            listen: "127.0.0.1:0".into(),
            public_origin: "https://indexer.example".into(),
            snapshots_directory: std::env::temp_dir().join(format!(
                "zkapi-i04-http-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )),
        };
        (index, config)
    }
    #[tokio::test]
    async fn finalized_http_root_paths_and_content_addressed_snapshot() {
        let (index, config) = fixture();
        std::fs::create_dir_all(&config.snapshots_directory).unwrap();
        let directory = config.snapshots_directory.clone();
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: true,
            })),
            config: Arc::new(config),
        };
        let root = body(root(State(shared.clone())).await).await;
        assert_eq!(root["sequence"], "4");
        assert_eq!(root["next_note_id"], "2");
        let path = body(note_path(State(shared.clone()), Path("0".into())).await).await;
        assert_eq!(path["snapshot"], root);
        assert_eq!(path["siblings"].as_array().unwrap().len(), 32);
        assert_eq!(
            zero_path(State(shared.clone()), Path("0".into()))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let zero = body(zero_path(State(shared.clone()), Path("2".into())).await).await;
        assert_eq!(zero["leaf"], format!("0x{}", "00".repeat(32)));
        assert_eq!(
            note_path(State(shared.clone()), Path("00".into()))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let manifest = body(snapshot(State(shared.clone())).await).await;
        assert_eq!(manifest["snapshot"], root);
        let digest = manifest["sha256"].as_str().unwrap();
        assert_eq!(
            manifest["download_url"],
            format!("https://indexer.example/zkapi/v1/tree/snapshots/{digest}.json")
        );
        let response = download(State(shared.clone()), Path(format!("{digest}.json"))).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(hex::encode(Sha256::digest(&bytes)), digest);
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_jcs::to_vec(&parsed).unwrap(), bytes);
        assert_eq!(parsed["snapshot"], root);
        assert_eq!(
            download(State(shared.clone()), Path("../outside.json".into()))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        std::fs::write(directory.join(format!("{digest}.json")), b"corrupt").unwrap();
        assert_eq!(
            download(State(shared), Path(format!("{digest}.json")))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn http_service_is_unavailable_until_reconciled() {
        let (index, config) = fixture();
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
            })),
            config: Arc::new(config),
        };
        assert_eq!(
            root(State(shared.clone())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            note_path(State(shared.clone()), Path("0".into()))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            snapshot(State(shared)).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
