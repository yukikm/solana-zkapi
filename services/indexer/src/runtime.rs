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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use std::{collections::BTreeMap, error::Error, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{watch, OwnedRwLockReadGuard, RwLock};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
#[path = "runtime_archive.rs"]
mod archive_source;
pub use archive_source::{ArchiveRefresh, ArchiveSourceResult, FinalizedArchiveSource};
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
/// Raw account bytes from one finalized RPC bank. Decode only after replay has
/// reached this exact slot; the required account inventory may have changed.
pub struct AccountCut {
    slot: u64,
    program: Bytes32,
    values: BTreeMap<Bytes32, Option<Vec<u8>>>,
    raw_accounts: BTreeMap<Bytes32, Value>,
}
impl AccountCut {
    pub fn slot(&self) -> u64 {
        self.slot
    }
    /// Exact captured bytes with the owner/encoding already authenticated by
    /// this response. No second RPC read is needed for role-specific validation.
    pub fn account(&self, address: &Bytes32) -> Result<Value> {
        self.required(address)?;
        self.raw_accounts
            .get(address)
            .cloned()
            .ok_or_else(|| "captured account metadata missing".into())
    }
    fn required(&self, key: &Bytes32) -> Result<&[u8]> {
        self.values
            .get(key)
            .ok_or("captured account inventory missing; retry after replay")?
            .as_deref()
            .ok_or_else(|| "missing account at captured cut".into())
    }
}

#[derive(Clone)]
pub struct ArchiveRpc {
    client: reqwest::Client,
    url: String,
    retry_not_before: Arc<tokio::sync::Mutex<tokio::time::Instant>>,
}
fn rate_limit_delay(headers: &reqwest::header::HeaderMap) -> Duration {
    // Only bounded delta-seconds are accepted. Missing, malformed and HTTP-date
    // values use the same conservative fallback; server text is never logged.
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(1, 60))
        .unwrap_or(10);
    Duration::from_secs(seconds)
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum RpcFailurePhase {
    Send,
    Http,
    Body,
    EnvelopeId,
    RpcError,
    ResultMissing,
}
#[derive(Serialize)]
struct RpcFailureDiagnostic {
    event: &'static str,
    method: &'static str,
    phase: RpcFailurePhase,
    http_status: Option<u16>,
    rpc_code: Option<i64>,
    timeout: bool,
    elapsed_ms: u64,
    cooldown_seconds: Option<u64>,
}
impl RpcFailureDiagnostic {
    fn new(method: &str, phase: RpcFailurePhase, elapsed: Duration) -> Self {
        Self {
            event: "archive_rpc_failure",
            // Never copy a caller-controlled method or any request arguments.
            method: match method {
                "getBlock" => "getBlock",
                "getBlocks" => "getBlocks",
                "getSlot" => "getSlot",
                "getGenesisHash" => "getGenesisHash",
                "getMultipleAccounts" => "getMultipleAccounts",
                "getLatestBlockhash" => "getLatestBlockhash",
                _ => "other",
            },
            phase,
            http_status: None,
            rpc_code: None,
            timeout: false,
            elapsed_ms: elapsed.as_millis().min(u64::MAX as u128) as u64,
            cooldown_seconds: None,
        }
    }
    fn emit(&self) {
        // Every string above is a compile-time label. Never serialize the
        // response, URL, parameters, headers or nested transport error here.
        eprintln!(
            "{}",
            serde_json::to_string(self).expect("numeric RPC diagnostic")
        );
    }
}
// Only compile-time categories may cross the operator log boundary.
fn refresh_error_category(error: &(dyn Error + Send + Sync + 'static)) -> String {
    if let Some(error) = error.downcast_ref::<crate::Error>() {
        return error.to_string();
    }
    match error.to_string().as_str() {
        "RPC transport unavailable" => "RPC transport unavailable",
        "RPC HTTP error" => "RPC HTTP error",
        "RPC response error" => "RPC response error",
        "RPC result unavailable" => "RPC result unavailable",
        "captured account inventory missing; retry after replay" => "account inventory changed",
        "RPC account cut advanced or regressed between batches" => "account cut moved",
        "finalized tip block is unavailable" => "finalized tip unavailable",
        "local archive source halted" => "local archive source halted",
        "local archive source unavailable" => "local archive source unavailable",
        "local archive is not yet complete" => "local archive incomplete",
        "local archive omits the configured start" => "local archive start missing",
        "local archive replay failed" => "local archive replay failed",
        "local archive lacks the finalized target" => "local archive target missing",
        "local archive account cut expired" => "local archive account cut expired",
        "account/replay cut mismatch" => "account replay cut mismatch",
        "pool length" => "pool length mismatch",
        "pool profile/genesis mismatch" => "pool profile genesis mismatch",
        "invalid account layout/PDA" => "account layout PDA mismatch",
        "RPC account owner/encoding" => "account owner encoding mismatch",
        "RPC account cut" => "invalid account cut",
        "RPC account list" => "invalid account list",
        "RPC account count" => "invalid account count",
        "missing account at captured cut" => "account missing at cut",
        "blockhash missing" => "blockhash missing",
        "block anchor mismatch" => "block anchor mismatch",
        _ => "runtime reconciliation unavailable",
    }
    .to_owned()
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
            retry_not_before: Arc::new(tokio::sync::Mutex::new(tokio::time::Instant::now())),
        })
    }
    async fn wait_rate_limit(&self) {
        loop {
            let until = *self.retry_not_before.lock().await;
            if until <= tokio::time::Instant::now() {
                return;
            }
            tokio::time::sleep_until(until).await;
        }
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.wait_rate_limit().await;
        let started = std::time::Instant::now();
        let response = self
            .client
            .post(&self.url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .map_err(|error| {
                let mut diagnostic =
                    RpcFailureDiagnostic::new(method, RpcFailurePhase::Send, started.elapsed());
                diagnostic.timeout = error.is_timeout();
                diagnostic.emit();
                "RPC transport unavailable"
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let delay = rate_limit_delay(response.headers());
            let until = tokio::time::Instant::now() + delay;
            drop(response);
            let mut diagnostic =
                RpcFailureDiagnostic::new(method, RpcFailurePhase::Http, started.elapsed());
            diagnostic.http_status = Some(status.as_u16());
            diagnostic.cooldown_seconds = Some(delay.as_secs());
            {
                let mut deadline = self.retry_not_before.lock().await;
                *deadline = (*deadline).max(until);
            }
            diagnostic.emit();
            // Cloned readers share the cooldown. Return the original failure;
            // only the caller may retry its read, with its unchanged cursor.
            // Dropping this future cancels the wait without another request.
            self.wait_rate_limit().await;
            return Err("RPC HTTP error".into());
        }
        if !status.is_success() {
            let mut diagnostic =
                RpcFailureDiagnostic::new(method, RpcFailurePhase::Http, started.elapsed());
            diagnostic.http_status = Some(status.as_u16());
            diagnostic.emit();
            return Err("RPC HTTP error".into());
        }
        let body: Value = response.json().await.map_err(|error| {
            let mut diagnostic =
                RpcFailureDiagnostic::new(method, RpcFailurePhase::Body, started.elapsed());
            diagnostic.http_status = Some(status.as_u16());
            diagnostic.timeout = error.is_timeout();
            diagnostic.emit();
            "RPC invalid JSON"
        })?;
        if body["id"] != 1 || body.get("error").is_some() {
            let phase = if body["id"] != 1 {
                RpcFailurePhase::EnvelopeId
            } else {
                RpcFailurePhase::RpcError
            };
            let mut diagnostic = RpcFailureDiagnostic::new(method, phase, started.elapsed());
            diagnostic.http_status = Some(status.as_u16());
            diagnostic.rpc_code = body
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_i64);
            diagnostic.emit();
            return Err("RPC response error".into());
        }
        body.get("result")
            .cloned()
            .filter(|v| !v.is_null())
            .ok_or_else(|| {
                let mut diagnostic = RpcFailureDiagnostic::new(
                    method,
                    RpcFailurePhase::ResultMissing,
                    started.elapsed(),
                );
                diagnostic.http_status = Some(status.as_u16());
                diagnostic.emit();
                "RPC result unavailable".into()
            })
    }
    async fn accounts(
        &self,
        keys: &[Bytes32],
        minimum_slot: u64,
        program: &Bytes32,
    ) -> Result<AccountCut> {
        let mut cut = None;
        let mut out = BTreeMap::new();
        let mut raw_accounts = BTreeMap::new();
        for batch in keys.chunks(100) {
            let response=self.call("getMultipleAccounts",json!([batch.iter().map(b58).collect::<Vec<_>>(),{"commitment":"finalized","encoding":"base64","minContextSlot":cut.unwrap_or(minimum_slot)}])).await?;
            let slot = response["context"]["slot"]
                .as_u64()
                .ok_or("RPC account cut")?;
            if slot < minimum_slot || cut.is_some_and(|chosen| chosen != slot) {
                return Err("RPC account cut advanced or regressed between batches".into());
            }
            cut = Some(slot);
            let values = response["value"].as_array().ok_or("RPC account list")?;
            if values.len() != batch.len() {
                return Err("RPC account count".into());
            }
            for (address, value) in batch.iter().zip(values) {
                // An account from the previous inventory may have closed at S.
                // Null is accepted only if replay no longer requires that key.
                let bytes = if value.is_null() {
                    None
                } else {
                    if value["owner"].as_str() != Some(b58(program).as_str())
                        || value["executable"] != false
                        || value["data"][1] != "base64"
                    {
                        return Err("RPC account owner/encoding".into());
                    }
                    Some(STANDARD.decode(value["data"][0].as_str().ok_or("missing account")?)?)
                };
                if out.insert(*address, bytes).is_some() {
                    return Err("duplicate account inventory".into());
                }
                raw_accounts.insert(*address, value.clone());
            }
        }
        Ok(AccountCut {
            slot: cut.ok_or("empty account inventory")?,
            program: *program,
            values: out,
            raw_accounts,
        })
    }
    /// Capture once, then let durable consumers replay to `cut.slot()` before
    /// calling `observe_cut`. An incomplete new inventory must be retried.
    pub async fn capture_chain(&self, cfg: &Config, inventory: &ChainState) -> Result<AccountCut> {
        let program = key(&cfg.program_id)?;
        let pool = key(&cfg.pool)?;
        let (tree, _) = pda(&program, &[b"tree", &pool]);
        let mut keys = vec![pool, tree];
        for id in inventory.active.keys() {
            keys.push(pda(&program, &[b"note", &pool, &id.to_le_bytes()]).0);
        }
        for id in inventory.pending.keys() {
            keys.push(pda(&program, &[b"note", &pool, &id.to_le_bytes()]).0);
            keys.push(pda(&program, &[b"pending", &pool, &id.to_le_bytes()]).0);
        }
        self.accounts(&keys, inventory.slot, &program).await
    }
    /// Preserve exact-cut observation for callers that already replayed a known
    /// slot. The live refresh path captures the bank before its final replay.
    pub async fn observe_chain(&self, cfg: &Config, expected: &ChainState) -> Result<ChainState> {
        let cut = self.capture_chain(cfg, expected).await?;
        if cut.slot != expected.slot {
            return Err("RPC account cut advanced; replay next finalized cut".into());
        }
        self.observe_cut(cfg, expected, &cut).await
    }
    pub async fn observe_cut(
        &self,
        cfg: &Config,
        expected: &ChainState,
        cut: &AccountCut,
    ) -> Result<ChainState> {
        if cut.slot != expected.slot || cut.program != key(&cfg.program_id)? {
            return Err("account/replay cut mismatch".into());
        }
        let program = key(&cfg.program_id)?;
        let pool = key(&cfg.pool)?;
        let (tree, tree_bump) = pda(&program, &[b"tree", &pool]);
        let pool_raw = cut.required(&pool)?;
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
        let tree_raw = cut.required(&tree)?;
        check_account(tree_raw, "TreeState", 66, tree_bump)?;
        let root = array(tree_raw, 10)?;
        crate::canonical(root)?;
        let mut active = BTreeMap::new();
        let mut pending = BTreeMap::new();
        for id in expected.active.keys() {
            let (address, bump) = pda(&program, &[b"note", &pool, &id.to_le_bytes()]);
            active.insert(*id, decode_note(cut.required(&address)?, *id, 1, bump)?);
        }
        for id in expected.pending.keys() {
            let (note_address, note_bump) = pda(&program, &[b"note", &pool, &id.to_le_bytes()]);
            let (pending_address, pending_bump) =
                pda(&program, &[b"pending", &pool, &id.to_le_bytes()]);
            let note = decode_note(cut.required(&note_address)?, *id, 2, note_bump)?;
            pending.insert(
                *id,
                decode_pending(cut.required(&pending_address)?, note, pending_bump)?,
            );
        }
        let block=self.call("getBlock",json!([expected.slot,{"commitment":"finalized","transactionDetails":"none","maxSupportedTransactionVersion":1,"rewards":false}])).await?;
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
    /// Reconcile one captured finalized bank without chasing a moving RPC tip.
    /// If replay discovers new required accounts, keep its advanced inventory
    /// but publish nothing until a later complete capture succeeds.
    pub async fn refresh(
        &self,
        cfg: &Config,
        index: &mut Indexer,
        next_slot: &mut u64,
    ) -> Result<()> {
        index.ready = false;
        self.catch_up(index, next_slot).await?;
        let cut = self.capture_chain(cfg, &index.replay_state()?).await?;
        self.catch_up_to(index, next_slot, cut.slot).await?;
        let observed = self.observe_cut(cfg, &index.replay_state()?, &cut).await?;
        index.reconcile(&observed)?;
        Ok(())
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
        self.catch_up_to(index, next_slot, tip).await
    }
    /// Read at most four finalized blocks concurrently, returning per-slot
    /// results in the requested order. Durable consumers must stop at the first
    /// failed item; a later fetched block never authorizes skipping that slot.
    pub async fn finalized_block_window(&self, slots: &[u64]) -> Result<Vec<Result<Value>>> {
        if slots.is_empty() || slots.len() > 4 || slots.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err("invalid finalized block window".into());
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (position, slot) in slots.iter().copied().enumerate() {
            let rpc = self.clone();
            tasks.spawn(async move {
                let value = rpc.call("getBlock", json!([slot,{"commitment":"finalized","encoding":"json","transactionDetails":"full","maxSupportedTransactionVersion":1,"rewards":false}])).await;
                (position, value)
            });
        }
        let mut completed = BTreeMap::new();
        while let Some(result) = tasks.join_next().await {
            let (position, value) = result.map_err(|_| "RPC archive task unavailable")?;
            completed.insert(position, value);
        }
        // Completion order never becomes execution order. Dropping JoinSet on
        // error/cancellation aborts pending requests; no detached tasks linger.
        Ok(completed.into_values().collect())
    }
    async fn catch_up_to(&self, index: &mut Indexer, next_slot: &mut u64, tip: u64) -> Result<()> {
        index.ready = false;
        let mut scan = *next_slot;
        let report_progress = tip.saturating_sub(scan) >= 999;
        if report_progress {
            eprintln!("indexer replay start: next_slot={scan} target_slot={tip}");
        }
        while scan <= tip {
            let end = scan.saturating_add(999).min(tip);
            let slots = self
                .call("getBlocks", json!([scan,end,{"commitment":"finalized"}]))
                .await?;
            let mut prior = None;
            // Keep memory/RPC pressure bounded while replaying long archives.
            // Decode and apply only the ordered successful prefix of each read
            // window. A later successful fetch cannot skip a failed slot.
            for window in slots.as_array().ok_or("invalid block range")?.chunks(4) {
                let mut ordered = Vec::with_capacity(window.len());
                for slot in window {
                    let slot = slot.as_u64().ok_or("invalid block slot")?;
                    if slot < scan || slot > end || prior.is_some_and(|p| slot <= p) {
                        return Err("unordered block range".into());
                    }
                    prior = Some(slot);
                    ordered.push(slot);
                }
                let values = self.finalized_block_window(&ordered).await?;
                for (slot, value) in ordered.into_iter().zip(values) {
                    index.apply_block(&rpc::decode_finalized_block(slot, &value?)?)?;
                    *next_slot = slot.checked_add(1).ok_or("slot overflow")?;
                }
            }
            // Empty/skipped slots advance only this attempt's scan. Keep the
            // retry cursor at the last applied block: an incomplete range can
            // omit its tail, and that tail must be fetched again on retry.
            if report_progress {
                // Numeric replay progress is not a readiness assertion. The
                // exact finalized account-cut reconciliation still follows.
                eprintln!("indexer replay progress: range_start={scan} range_end={end} next_slot={next_slot} target_slot={tip}");
            }
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
    refreshing: bool,
}
impl Published {
    fn finish_failed_refresh(&mut self, error: &(dyn Error + Send + Sync + 'static)) {
        self.available = false;
        // Waiting for a verified local writer prefix is still the same logical
        // refresh, including its two-second polling sleeps. HTTP keeps its one
        // bounded deadline and cannot read the previously published index.
        self.refreshing = error.is::<archive_source::ArchivePending>();
    }
}
#[derive(Clone)]
struct HttpState {
    state: Arc<RwLock<Published>>,
    config: Arc<Config>,
    updated: watch::Receiver<()>,
}
// Leave headroom under the control client's thirty-second indexer timeout. Waiting
// adds no RPC calls and never exposes the previous cut while a refresh runs.
const READY_WAIT: Duration = Duration::from_secs(20);
async fn ready_state(s: &HttpState, timeout: Duration) -> Option<OwnedRwLockReadGuard<Published>> {
    let mut updated = s.updated.clone();
    tokio::time::timeout(timeout, async {
        loop {
            let state = s.state.clone().read_owned().await;
            if updated.has_changed().is_err() {
                return None;
            }
            if state.available {
                return Some(state);
            }
            if !state.refreshing {
                return None;
            }
            drop(state);
            // watch retains a completed refresh even if publication raced the
            // state read; a lost wakeup must not turn success into a timeout.
            if updated.changed().await.is_err() {
                return None;
            }
        }
    })
    .await
    .ok()
    .flatten()
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":{"code":"indexer_unavailable","message":"Finalized history or account reconciliation is incomplete","retriable":true}}))).into_response()
}
fn invalid() -> Response {
    (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"invalid_path","message":"The requested note path is unavailable","retriable":false}}))).into_response()
}
async fn root(State(s): State<HttpState>) -> Response {
    let Some(state) = ready_state(&s, READY_WAIT).await else {
        return unavailable();
    };
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
    let Some(state) = ready_state(&s, READY_WAIT).await else {
        return unavailable();
    };
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
    let Some(state) = ready_state(&s, READY_WAIT).await else {
        return unavailable();
    };
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
    serve_source(cfg, None).await
}
/// Explicit local archive mode. RPC still authenticates the finalized account
/// cut and block anchor; it never supplies a missing full history block.
pub async fn serve_with_archive(
    cfg: Config,
    archive: impl FinalizedArchiveSource + 'static,
) -> Result<()> {
    serve_source(cfg, Some(Box::new(archive))).await
}
async fn serve_source(
    cfg: Config,
    mut archive: Option<Box<dyn FinalizedArchiveSource>>,
) -> Result<()> {
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
        refreshing: false,
    }));
    let (updated, changes) = watch::channel(());
    let shared = HttpState {
        state: state.clone(),
        config: config.clone(),
        updated: changes,
    };
    let worker = tokio::spawn(async move {
        let mut index = Indexer::new(program, pool);
        let mut next = config.start_slot;
        let mut archive_refresh = ArchiveRefresh::default();
        loop {
            {
                let mut published = state.write().await;
                published.available = false;
                published.refreshing = true;
            }
            let result = if let Some(source) = archive.as_mut() {
                rpc.refresh_from_archive(
                    &config,
                    &mut index,
                    &mut next,
                    source.as_mut(),
                    &mut archive_refresh,
                )
                .await
            } else {
                rpc.refresh(&config, &mut index, &mut next).await
            };
            if result.is_ok() {
                *state.write().await = Published {
                    index: index.clone(),
                    available: true,
                    refreshing: false,
                };
            }
            // Never log raw RPC errors: URLs can contain provider credentials.
            else if let Err(error) = result {
                state.write().await.finish_failed_refresh(error.as_ref());
                // Typed replay errors contain only compile-time descriptions.
                // Never interpolate an arbitrary transport error or RPC URL.
                let category = refresh_error_category(error.as_ref());
                if let Some(source) = archive.as_ref() {
                    eprintln!(
                        "{}",
                        archive_refresh.failure_diagnostic(source.as_ref(), next, &category)
                    );
                }
                eprintln!("indexer paused: next_slot={next} category={category}");
            }
            updated.send_replace(());
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
    #[test]
    fn refresh_failure_categories_preserve_known_reasons_and_redact_arbitrary_errors() {
        for (input, expected) in [
            (
                "local archive is not yet complete",
                "local archive incomplete",
            ),
            (
                "local archive account cut expired",
                "local archive account cut expired",
            ),
            (
                "pool profile/genesis mismatch",
                "pool profile genesis mismatch",
            ),
            ("block anchor mismatch", "block anchor mismatch"),
            ("RPC HTTP error", "RPC HTTP error"),
            (
                "https://rpc.invalid/?key=SECRET",
                "runtime reconciliation unavailable",
            ),
            (
                "local archive incomplete SECRET",
                "runtime reconciliation unavailable",
            ),
        ] {
            let error: Box<dyn Error + Send + Sync> = input.into();
            assert_eq!(refresh_error_category(error.as_ref()), expected);
            assert!(!refresh_error_category(error.as_ref()).contains("SECRET"));
        }
        let typed: Box<dyn Error + Send + Sync> = crate::Error::State.into();
        assert_eq!(
            refresh_error_category(typed.as_ref()),
            crate::Error::State.to_string()
        );
    }
    #[test]
    fn rpc_failure_diagnostic_has_only_static_labels_and_numeric_fields() {
        for method in [
            "getBlock",
            "getBlocks",
            "getSlot",
            "getGenesisHash",
            "getMultipleAccounts",
            "getLatestBlockhash",
            "PRIVATE_METHOD https://rpc.invalid/?key=SECRET",
        ] {
            for phase in [
                RpcFailurePhase::Send,
                RpcFailurePhase::Http,
                RpcFailurePhase::Body,
                RpcFailurePhase::EnvelopeId,
                RpcFailurePhase::RpcError,
                RpcFailurePhase::ResultMissing,
            ] {
                let mut diagnostic =
                    RpcFailureDiagnostic::new(method, phase, Duration::from_millis(123));
                diagnostic.http_status = Some(429);
                diagnostic.rpc_code = Some(-32005);
                diagnostic.timeout = true;
                diagnostic.cooldown_seconds = Some(10);
                let text = serde_json::to_string(&diagnostic).unwrap();
                let value: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(value["event"], "archive_rpc_failure");
                assert_eq!(
                    value["method"],
                    if method.starts_with("PRIVATE_") {
                        "other"
                    } else {
                        method
                    }
                );
                assert_eq!(value["http_status"], 429);
                assert_eq!(value["rpc_code"], -32005);
                assert_eq!(value["elapsed_ms"], 123);
                assert_eq!(value["timeout"], true);
                assert_eq!(value["cooldown_seconds"], 10);
                assert_eq!(value.as_object().unwrap().len(), 8);
                assert!(
                    !text.contains("PRIVATE_")
                        && !text.contains("https://")
                        && !text.contains("SECRET")
                );
            }
        }
    }
    #[test]
    fn rpc_retry_after_delta_seconds_are_bounded_and_invalid_values_use_fallback() {
        for (value, expected) in [
            (None, 10),
            (Some(""), 10),
            (Some("invalid"), 10),
            (Some("Wed, 21 Oct 2015 07:28:00 GMT"), 10),
            (Some("-1"), 10),
            (Some("+9"), 10),
            (Some("0"), 1),
            (Some("1"), 1),
            (Some("10"), 10),
            (Some(" 12 "), 12),
            (Some("999"), 60),
            (Some("18446744073709551615"), 60),
            (Some("18446744073709551616"), 10),
        ] {
            let mut headers = reqwest::header::HeaderMap::new();
            if let Some(value) = value {
                headers.insert(reqwest::header::RETRY_AFTER, value.parse().unwrap());
            }
            assert_eq!(rate_limit_delay(&headers), Duration::from_secs(expected));
        }
    }
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
        let (_updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: true,
                refreshing: false,
            })),
            config: Arc::new(config),
            updated: changes,
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
        let (_updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: false,
            })),
            config: Arc::new(config),
            updated: changes,
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

    #[tokio::test]
    async fn archive_source_failure_revokes_ready_index_and_public_endpoints() {
        struct Broken;
        impl FinalizedArchiveSource for Broken {
            fn refresh(&mut self) -> ArchiveSourceResult<()> {
                Err("private source failure".into())
            }
            fn first(&self) -> Option<(u64, u64)> {
                None
            }
            fn tail(&self) -> Option<(u64, Bytes32)> {
                None
            }
            fn replay_range(
                &self,
                _: u64,
                _: u64,
                _: &mut dyn FnMut(&crate::FinalizedBlock) -> ArchiveSourceResult<()>,
            ) -> ArchiveSourceResult<()> {
                panic!("failed source must not replay")
            }
        }
        let (mut index, config) = fixture();
        assert!(index.is_ready());
        let result = ArchiveRpc::new(config.rpc_url.clone())
            .unwrap()
            .refresh_from_archive(
                &config,
                &mut index,
                &mut config.start_slot.clone(),
                &mut Broken,
                &mut ArchiveRefresh::default(),
            )
            .await;
        assert!(result.is_err());
        assert!(!index.is_ready());
        let (_updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: result.is_ok(),
                refreshing: false,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        assert_eq!(
            root(State(shared.clone())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            snapshot(State(shared)).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn healthy_refresh_waits_for_reconciled_publication_instead_of_immediate_503() {
        let (index, config) = fixture();
        std::fs::create_dir_all(&config.snapshots_directory).unwrap();
        let directory = config.snapshots_directory.clone();
        let (updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: true,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        let root_request = tokio::spawn(root(State(shared.clone())));
        let path_request = tokio::spawn(note_path(State(shared.clone()), Path("0".into())));
        let snapshot_request = tokio::spawn(snapshot(State(shared.clone())));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!root_request.is_finished());
        assert!(!path_request.is_finished());
        assert!(!snapshot_request.is_finished());
        // The worker publishes only after ArchiveRpc::refresh has checked the
        // exact captured account cut. HTTP must not use the retained old index.
        {
            let mut state = shared.state.write().await;
            assert!(state.index.is_ready());
            state.available = true;
            state.refreshing = false;
        }
        updated.send_replace(());
        for request in [root_request, path_request, snapshot_request] {
            assert_eq!(request.await.unwrap().status(), StatusCode::OK);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn pending_prefix_waits_across_poll_notifications_and_returns_only_the_new_cut() {
        let (index, config) = fixture();
        let old = index.replay_state().unwrap();
        let mut fresh = index.clone();
        fresh
            .apply_block(&crate::FinalizedBlock {
                finalized: true,
                slot: old.slot + 1,
                parent_slot: old.slot,
                blockhash: [77; 32],
                previous_blockhash: old.blockhash,
                block_time: old.slot + 1,
                transactions: Vec::new(),
            })
            .unwrap();
        // API fixture only; real account-cut validation remains covered by
        // tests/runtime.rs. Even a ready retained index must never be served.
        fresh.reconcile(&fresh.replay_state().unwrap()).unwrap();
        let (updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: true,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        let request = tokio::spawn(root(State(shared.clone())));
        for _ in 0..2 {
            shared
                .state
                .write()
                .await
                .finish_failed_refresh(&archive_source::ArchivePending);
            updated.send_replace(());
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!request.is_finished());
            assert!(!shared.state.read().await.available);
        }
        *shared.state.write().await = Published {
            index: fresh,
            available: true,
            refreshing: false,
        };
        updated.send_replace(());
        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["slot"], (old.slot + 1).to_string());
    }

    #[tokio::test]
    async fn repeated_pending_notifications_do_not_extend_the_http_deadline() {
        let (index, config) = fixture();
        let (updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: true,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        let deadline = Duration::from_millis(80);
        let started = tokio::time::Instant::now();
        let waiting = ready_state(&shared, deadline);
        tokio::pin!(waiting);
        let mut notices = 0;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                tokio::select! {
                    result = &mut waiting => {
                        assert!(result.is_none());
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(5)) => {
                        shared.state.write().await.finish_failed_refresh(&archive_source::ArchivePending);
                        updated.send_replace(());
                        notices += 1;
                    }
                }
            }
        })
        .await
        .expect("pending notifications must not restart the request deadline");
        assert!(started.elapsed() >= deadline);
        assert!(notices >= 2);
        assert!(!shared.state.read().await.available);
    }

    #[tokio::test]
    async fn pending_then_hard_error_wakes_http_without_returning_the_old_cut() {
        for error in [
            "RPC response error",
            "local archive source unavailable",
            "local archive account cut expired",
            "block anchor mismatch",
            // Exact matching display text still lacks the trusted error type.
            "local archive is not yet complete",
        ] {
            let (index, config) = fixture();
            let (updated, changes) = watch::channel(());
            let shared = HttpState {
                state: Arc::new(RwLock::new(Published {
                    index,
                    available: false,
                    refreshing: true,
                })),
                config: Arc::new(config),
                updated: changes,
            };
            shared
                .state
                .write()
                .await
                .finish_failed_refresh(&archive_source::ArchivePending);
            let request = tokio::spawn(root(State(shared.clone())));
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(!request.is_finished());
            let error: Box<dyn Error + Send + Sync> = error.into();
            shared
                .state
                .write()
                .await
                .finish_failed_refresh(error.as_ref());
            updated.send_replace(());
            let response = tokio::time::timeout(Duration::from_secs(1), request)
                .await
                .expect("hard failures wake the waiter immediately")
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let state = shared.state.read().await;
            assert!(state.index.is_ready());
            assert!(!state.available && !state.refreshing);
        }
    }

    #[tokio::test]
    async fn failed_refresh_wakes_waiters_without_serving_the_previously_ready_cut() {
        let (index, config) = fixture();
        let (updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: true,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        let request = tokio::spawn(root(State(shared.clone())));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!request.is_finished());
        shared.state.write().await.refreshing = false;
        updated.send_replace(());
        assert_eq!(
            request.await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(
            shared.state.read().await.index.is_ready(),
            "retained old data is not an admission source"
        );
        assert_eq!(
            root(State(shared)).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn waiting_is_bounded_and_a_completed_publication_cannot_lose_its_notification() {
        let (index, config) = fixture();
        let (updated, changes) = watch::channel(());
        let shared = HttpState {
            state: Arc::new(RwLock::new(Published {
                index,
                available: false,
                refreshing: true,
            })),
            config: Arc::new(config),
            updated: changes,
        };
        assert!(ready_state(&shared, Duration::from_millis(10))
            .await
            .is_none());
        assert!(!shared.state.read().await.available);
        {
            let mut state = shared.state.write().await;
            state.available = true;
            state.refreshing = false;
        }
        updated.send_replace(());
        assert!(ready_state(&shared, Duration::from_millis(10))
            .await
            .is_some());
        drop(updated);
        assert!(
            ready_state(&shared, Duration::from_millis(10))
                .await
                .is_none(),
            "worker loss withdraws even the retained last successful cut"
        );
    }
}
