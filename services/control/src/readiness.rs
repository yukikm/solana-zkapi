//! Read-only capability sampling. No admission, signing, reconciliation writes,
//! provider calls or recovery actions. Public output contains only finite states.
use crate::{api::App, chain, quote, wire};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{future::BoxFuture, FutureExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::Mutex,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
const CACHE_SECONDS: u64 = 5;
const MAX_BODY: usize = 65_536;
const CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Available,
    Enabled,
    Disabled,
    Stale,
    Paused,
    Unavailable,
    Invalid,
    Unreconciled,
    NotChecked,
}

#[derive(Clone, Debug, Serialize)]
pub struct Provider {
    provider: String,
    mode: String,
    model: String,
    tariff_hash: String,
    status: Capability,
}
#[derive(Clone, Debug, Serialize)]
pub struct Report {
    schema: u8,
    scope: &'static str,
    deployment_id: String,
    manifest_hash: String,
    started_at: u64,
    completed_at: u64,
    expires_at: u64,
    control: Capability,
    indexer: Capability,
    signer: Capability,
    providers: Vec<Provider>,
    provider_credit: Capability,
    operator_admission: Capability,
}
impl Report {
    fn for_app(app: &App) -> Self {
        let at = now();
        Self {
            schema: 1,
            scope: "read_only_capabilities",
            deployment_id: app.config.binding.deployment_id.clone(),
            manifest_hash: app.config.runtime.trusted_manifest_hash.clone(),
            started_at: at,
            completed_at: at,
            expires_at: at + CACHE_SECONDS,
            control: Capability::Available,
            indexer: Capability::Unavailable,
            signer: Capability::Unavailable,
            providers: vec![],
            provider_credit: Capability::NotChecked,
            operator_admission: Capability::NotChecked,
        }
    }
    pub fn available(&self) -> bool {
        self.control == Capability::Available
            && self.indexer == Capability::Available
            && self.signer == Capability::Available
            && !self.providers.is_empty()
            && self
                .providers
                .iter()
                .all(|p| p.status == Capability::Enabled)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
type Work = futures_util::future::Shared<BoxFuture<'static, Report>>;
#[derive(Default)]
pub struct Cache {
    work: Mutex<Option<Work>>,
}
impl Cache {
    // The spawned probe survives an HTTP disconnect and always has one deadline.
    // Concurrent callers share it; completed observations expire after five seconds.
    async fn get(&self, app: Arc<App>) -> Report {
        self.get_with(|| (sample(app.clone()).boxed(), Report::for_app(&app)))
            .await
    }
    async fn get_with(&self, factory: impl Fn() -> (BoxFuture<'static, Report>, Report)) -> Report {
        loop {
            let work = {
                let mut current = self.work.lock().await;
                if current
                    .as_ref()
                    .is_none_or(|v| v.peek().is_some_and(|r| now() >= r.expires_at))
                {
                    let (future, fallback) = factory();
                    let worker = tokio::spawn(future);
                    *current = Some(
                        async move {
                            worker.await.unwrap_or_else(|_| {
                                let mut failed = fallback;
                                failed.completed_at = now();
                                failed.expires_at = failed.completed_at + CACHE_SECONDS;
                                failed
                            })
                        }
                        .boxed()
                        .shared(),
                    );
                }
                current.as_ref().unwrap().clone()
            };
            let report = work.await;
            if now() < report.expires_at {
                return report;
            }
        }
    }
}
pub async fn endpoint(State(app): State<Arc<App>>) -> impl IntoResponse {
    let report = app.readiness.get(app.clone()).await;
    (
        if report.available() {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        [("cache-control", "no-store")],
        Json(report),
    )
}

async fn sample(app: Arc<App>) -> Report {
    let mut report = Report::for_app(&app);
    let signer = async {
        let expected = app.config.signer.digest().map_err(|_| ())?;
        signer_health(&app.signer.socket, &expected).await
    };
    let providers = async {
        let mut out = Vec::new();
        for tariff in &app.config.runtime.tariffs {
            let mode = match tariff.provider {
                wire::Provider::Oa => wire::Mode::DirectOa,
                wire::Provider::Openrouter if tariff.model == "*" => wire::Mode::DirectOpenrouter,
                _ => wire::Mode::Proxy,
            };
            let configured = match mode {
                wire::Mode::Proxy => {
                    app.config.runtime.providers.proxy.iter().any(|p| {
                        p.provider == tariff.provider
                            && p.models.iter().any(|m| m.model == tariff.model)
                    }) || app.config.runtime.enable_local_adapter
                        && tariff.provider == wire::Provider::Openai
                        && tariff.model == "i05-local-only"
                }
                wire::Mode::DirectOa | wire::Mode::DirectOpenrouter => {
                    tariff.model == "*"
                        && app
                            .providers
                            .direct
                            .iter()
                            .any(|(p, _)| p == &tariff.provider)
                }
            };
            // Unlike adapter_available's bool, retain DB failure as unavailable.
            let enabled = app
                .ledger
                .provider_available(tariff.provider.as_str())
                .await;
            let status = provider_status(
                configured,
                enabled.map_err(|_| ()),
                quote::tariff_valid_at(tariff, now()).unwrap_or(false),
            );
            out.push(Provider {
                provider: tariff.provider.as_str().into(),
                mode: serde_json::to_value(&mode)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .into(),
                model: tariff.model.clone(),
                tariff_hash: tariff.tariff_hash.clone(),
                status,
            });
        }
        out
    };
    let (indexer, signer, providers) = tokio::join!(
        tokio::time::timeout(
            PROBE_TIMEOUT,
            indexer_health(
                &app.config.runtime.primary_rpc,
                &app.config.runtime.indexer_origin,
                &app.config.trusted
            )
        ),
        tokio::time::timeout(Duration::from_secs(2), signer),
        tokio::time::timeout(Duration::from_secs(2), providers)
    );
    report.indexer = indexer
        .ok()
        .and_then(Result::ok)
        .unwrap_or(Capability::Unavailable);
    report.signer = signer
        .ok()
        .and_then(Result::ok)
        .unwrap_or(Capability::Unavailable);
    report.providers = providers.unwrap_or_default();
    report.completed_at = now();
    report.expires_at = report.completed_at + CACHE_SECONDS;
    report
}

fn provider_status(
    configured: bool,
    available: Result<bool, ()>,
    current_tariff: bool,
) -> Capability {
    match available {
        Err(_) => Capability::Unavailable,
        Ok(false) => Capability::Disabled,
        Ok(true) if !configured || !current_tariff => Capability::Disabled,
        Ok(true) => Capability::Enabled,
    }
}

async fn signer_health(path: &Path, expected: &[u8; 32]) -> Result<Capability, ()> {
    let mut stream = UnixStream::connect(path).await.map_err(|_| ())?;
    stream
        .write_all(b"{\"kind\":\"health\"}\n")
        .await
        .map_err(|_| ())?;
    let mut bytes = Vec::new();
    loop {
        if bytes.len() >= 4096 {
            return Err(());
        }
        let value = stream.read_u8().await.map_err(|_| ())?;
        if value == b'\n' {
            break;
        }
        bytes.push(value);
    }
    let value: Value = wire::strict_parse(&bytes).map_err(|_| ())?;
    if value["config_digest"] != hex::encode(expected) {
        return Ok(Capability::Invalid);
    }
    match value["reconciled"].as_bool() {
        Some(true) => Ok(Capability::Available),
        Some(false) => Ok(Capability::Unreconciled),
        None => Err(()),
    }
}
async fn bounded(response: reqwest::Response) -> Result<Value, ()> {
    if !response.status().is_success() {
        return Err(());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    // RPC accounts/context and JSON-RPC envelopes contain numeric fields. Use
    // the existing ChainClient RPC JSON representation, then validate every
    // security-relevant field below; the financial wire parser forbids numbers.
    serde_json::from_slice(&bytes).map_err(|_| ())
}
#[derive(Debug)]
struct RpcReadFailure {
    retryable: bool,
    reason: &'static str,
}
impl RpcReadFailure {
    fn permanent(reason: &'static str) -> Self {
        Self {
            retryable: false,
            reason,
        }
    }
    fn transient(reason: &'static str) -> Self {
        Self {
            retryable: true,
            reason,
        }
    }
}
async fn rpc_once(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    params: &Value,
) -> Result<Value, RpcReadFailure> {
    let id = uuid::Uuid::new_v4().to_string();
    let response = client
        .post(url)
        .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() || error.is_timeout() {
                RpcReadFailure::transient("transport")
            } else {
                RpcReadFailure::permanent("transport")
            }
        })?;
    if matches!(response.status().as_u16(), 500 | 502 | 503 | 504) {
        return Err(RpcReadFailure::transient("http_5xx"));
    }
    let value = bounded(response)
        .await
        .map_err(|_| RpcReadFailure::permanent("http_or_body"))?;
    if value["jsonrpc"] != "2.0" || value["id"] != id {
        return Err(RpcReadFailure::permanent("envelope"));
    }
    if let Some(error) = value.get("error") {
        // Agave: block unavailable/not yet available, or minimum bank not reached.
        // Skipped/pruned slots, rate limits and other errors are not retried.
        return Err(
            if matches!(error["code"].as_i64(), Some(-32004 | -32014 | -32016)) {
                RpcReadFailure::transient("bank_not_available")
            } else {
                RpcReadFailure::permanent("rpc_error")
            },
        );
    }
    let result = value
        .get("result")
        .cloned()
        .ok_or(RpcReadFailure::permanent("envelope"))?;
    if method == "getBlock" && result.is_null() {
        return Err(RpcReadFailure::transient("block_not_available"));
    }
    Ok(result)
}
async fn rpc(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    params: Value,
) -> Result<Value, ()> {
    if !matches!(
        method,
        "getGenesisHash" | "getBlock" | "getMultipleAccounts"
    ) {
        return Err(());
    }
    for attempt in 0..2 {
        match rpc_once(client, url, method, &params).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retry = attempt == 0 && error.retryable;
                // Finite diagnostics only: no URL, nonce, account, body or raw error.
                eprintln!(
                    "readiness_rpc_read method={method} reason={} retry={retry}",
                    error.reason
                );
                if !retry {
                    return Err(());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(())
}
fn tree_address(trusted: &chain::TrustedPool) -> Result<(solana_pubkey::Pubkey, u8), ()> {
    let program = solana_pubkey::Pubkey::from(wire::pubkey(&trusted.program_id).map_err(|_| ())?);
    let pool = wire::pubkey(&trusted.pool).map_err(|_| ())?;
    Ok(solana_pubkey::Pubkey::find_program_address(
        &[b"tree", &pool],
        &program,
    ))
}
fn account_data(value: &Value, owner: &str, size: usize) -> Result<Vec<u8>, ()> {
    if value["owner"] != owner
        || value["executable"] != false
        || value["data"].as_array().is_none_or(|v| v.len() != 2)
        || value["data"][1] != "base64"
    {
        return Err(());
    }
    let text = value["data"][0].as_str().ok_or(())?;
    let bytes = STANDARD.decode(text).map_err(|_| ())?;
    if bytes.len() != size || STANDARD.encode(&bytes) != text {
        return Err(());
    }
    Ok(bytes)
}
async fn indexer_health(
    rpc_url: &str,
    indexer: &str,
    trusted: &chain::TrustedPool,
) -> Result<Capability, ()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(24))
        .build()
        .map_err(|_| ())?;
    let root = bounded(
        client
            .get(format!(
                "{}/zkapi/v1/tree/root",
                indexer.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|_| ())?,
    )
    .await?;
    let root: wire::Root = serde_json::from_value(root).map_err(|_| ())?;
    if root.pool != trusted.pool || wire::uint(&root.next_note_id).map_err(|_| ())? > 1u64 << 32 {
        return Ok(Capability::Invalid);
    }
    let slot = wire::uint(&root.slot).map_err(|_| ())?;
    wire::uint(&root.sequence).map_err(|_| ())?;
    wire::pubkey(&root.blockhash).map_err(|_| ())?;
    let (tree, _) = tree_address(trusted)?;
    let account_params = json!([[trusted.pool,tree.to_string(),CLOCK],{"encoding":"base64","commitment":"finalized","minContextSlot":slot}]);
    let (genesis, block, mut accounts) = tokio::try_join!(
        rpc(&client, rpc_url, "getGenesisHash", json!([])),
        rpc(
            &client,
            rpc_url,
            "getBlock",
            json!([slot,{"commitment":"finalized","transactionDetails":"none","maxSupportedTransactionVersion":1,"rewards":false}])
        ),
        rpc(
            &client,
            rpc_url,
            "getMultipleAccounts",
            account_params.clone()
        )
    )?;
    // An RPC can briefly return Clock from an adjacent bank. Keep the exact
    // bank/Clock equality requirement: resample this read-only account cut once,
    // then apply every original validation below. No financial request is retried.
    if clock_context_mismatch(&accounts)? {
        accounts = rpc(&client, rpc_url, "getMultipleAccounts", account_params).await?;
    }
    // Match the SDK's independently captured finalized account-cut anchor.
    let observed = accounts["context"]["slot"].as_u64().ok_or(())?;
    if observed != slot {
        let anchor=rpc(&client,rpc_url,"getBlock",json!([observed,{"commitment":"finalized","transactionDetails":"none","maxSupportedTransactionVersion":1,"rewards":false}])).await?;
        wire::pubkey(anchor["blockhash"].as_str().ok_or(())?).map_err(|_| ())?;
    }
    validate_cut(trusted, &root, &genesis, &block, &accounts, now())
}
fn clock_context_mismatch(accounts: &Value) -> Result<bool, ()> {
    let observed = accounts["context"]["slot"].as_u64().ok_or(())?;
    let values = accounts["value"].as_array().ok_or(())?;
    if values.len() != 3 {
        return Err(());
    }
    let clock = account_data(
        &values[2],
        "Sysvar1111111111111111111111111111111111111",
        40,
    )?;
    Ok(u64::from_le_bytes(clock[..8].try_into().unwrap()) != observed)
}
fn validate_cut(
    trusted: &chain::TrustedPool,
    root: &wire::Root,
    genesis: &Value,
    block: &Value,
    accounts: &Value,
    wall: u64,
) -> Result<Capability, ()> {
    let slot = wire::uint(&root.slot).map_err(|_| ())?;
    if genesis != &trusted.genesis_hash || block["blockhash"] != root.blockhash {
        return Ok(Capability::Invalid);
    }
    let observed = accounts["context"]["slot"].as_u64().ok_or(())?;
    let values = accounts["value"].as_array().ok_or(())?;
    if observed < slot || values.len() != 3 {
        return Ok(Capability::Invalid);
    }
    let pool = chain::validate_pool_account(trusted, &values[0], observed).map_err(|_| ())?;
    let (_, bump) = tree_address(trusted)?;
    let tree = account_data(&values[1], &trusted.program_id, 66)?;
    if tree[..8] != sha2::Sha256::digest(b"account:TreeState")[..8]
        || tree[8] != 2
        || tree[9] != bump
        || tree[10..42] != *root.root.as_bytes()
        || u64::from_le_bytes(tree[42..50].try_into().unwrap())
            != wire::uint(&root.next_note_id).map_err(|_| ())?
        || u64::from_le_bytes(tree[50..58].try_into().unwrap())
            != wire::uint(&root.sequence).map_err(|_| ())?
    {
        return Ok(Capability::Invalid);
    }
    let bytes = account_data(
        &values[2],
        "Sysvar1111111111111111111111111111111111111",
        40,
    )?;
    let clock_slot = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let clock = i64::from_le_bytes(bytes[32..40].try_into().unwrap());
    let time = block["blockTime"].as_u64().ok_or(())?;
    if clock < 0 || clock_slot != observed || time > clock as u64 {
        return Ok(Capability::Invalid);
    }
    if (clock as u64).abs_diff(wall) > 120 || clock as u64 - time > 120 {
        return Ok(Capability::Stale);
    }
    Ok(if pool.paused {
        Capability::Paused
    } else {
        Capability::Available
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::{TcpListener, UnixListener};

    fn fixture() -> (chain::TrustedPool, wire::Root, Value, Value) {
        let program = [43u8; 32];
        let seed = [9u8; 32];
        let (pool, bump) = solana_pubkey::Pubkey::find_program_address(
            &[b"pool", &seed],
            &solana_pubkey::Pubkey::from(program),
        );
        let (genesis, mint, token) = ([42u8; 32], [44u8; 32], [45u8; 32]);
        let key = |v: &[u8]| bs58::encode(v).into_string();
        let trusted = chain::TrustedPool {
            deployment_environment: chain::DeploymentEnvironment::Local,
            public_devnet_profile_hash: None,
            program_id: key(&program),
            pool: pool.to_string(),
            genesis_hash: key(&genesis),
            mint: key(&mint),
            token_program: key(&token),
            vault_binding: zkapi_solana_types::binding::vault_binding(
                &genesis,
                &program,
                &pool.to_bytes(),
                &token,
                &mint,
            ),
            state_key: crate::crypto::role_key(&crate::crypto::deployment_keys::STATE_KEY).unwrap(),
            clearance_key: crate::crypto::role_key(&crate::crypto::deployment_keys::CLEARANCE_KEY)
                .unwrap(),
            cap_micro_usdc: zkapi_solana_types::MicroUsdc::new(1_000_000).unwrap(),
            note_ttl_seconds: "3600".into(),
            challenge_seconds: "1800".into(),
            circuit_profile_hash: chain::PROFILE_HASH.into(),
        };
        trusted.validate().unwrap();
        let mut raw = vec![0u8; 422];
        raw[..8].copy_from_slice(&sha2::Sha256::digest(b"account:PoolConfig")[..8]);
        raw[8] = 2;
        raw[9] = bump;
        raw[10..42].copy_from_slice(&genesis);
        raw[42..74].copy_from_slice(&mint);
        raw[74..106].copy_from_slice(&token);
        raw[106] = 6;
        raw[107..139].copy_from_slice(trusted.vault_binding.as_bytes());
        for (i, field) in trusted
            .state_key
            .iter()
            .chain(trusted.clearance_key.iter())
            .enumerate()
        {
            raw[203 + 32 * i..235 + 32 * i].copy_from_slice(field.as_bytes());
        }
        raw[331..339].copy_from_slice(&3600u64.to_le_bytes());
        raw[339..347].copy_from_slice(&1800u64.to_le_bytes());
        raw[347..355].copy_from_slice(&1_000_000u64.to_le_bytes());
        raw[356..358].copy_from_slice(&[1, 1]);
        raw[358..390].copy_from_slice(&hex::decode(chain::PROFILE_HASH).unwrap());
        raw[390..422].copy_from_slice(&seed);
        let at = now();
        let mut clock = [0u8; 40];
        clock[..8].copy_from_slice(&110u64.to_le_bytes());
        clock[32..].copy_from_slice(&(at as i64).to_le_bytes());
        let account = |data: &[u8], owner: &str| json!({"owner":owner,"executable":false,"lamports":1,"rentEpoch":0,"data":[STANDARD.encode(data),"base64"]});
        let mut tree = [0u8; 66];
        tree[..8].copy_from_slice(&sha2::Sha256::digest(b"account:TreeState")[..8]);
        tree[8] = 2;
        tree[9] = tree_address(&trusted).unwrap().1;
        let accounts = json!({"context":{"slot":110},"value":[account(&raw,&trusted.program_id),account(&tree,&trusted.program_id),account(&clock,"Sysvar1111111111111111111111111111111111111")]});
        let root = wire::Root {
            pool: trusted.pool.clone(),
            root: zkapi_solana_types::FieldElement::ZERO,
            slot: "100".into(),
            blockhash: key(&[7u8; 32]),
            sequence: "0".into(),
            next_note_id: "0".into(),
        };
        let block = json!({"blockhash":root.blockhash,"blockTime":at-1});
        (trusted, root, block, accounts)
    }
    #[test]
    fn clock_and_finalized_identity_are_required_before_available() {
        let (trusted, root, block, accounts) = fixture();
        let genesis = json!(trusted.genesis_hash);
        let wall = block["blockTime"].as_u64().unwrap() + 1;
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &block, &accounts, wall),
            Ok(Capability::Available)
        );
        let mut old = block.clone();
        old["blockTime"] = (wall - 121).into();
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &old, &accounts, wall),
            Ok(Capability::Stale)
        );
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &block, &accounts, wall + 121),
            Ok(Capability::Stale)
        );
        for (g, b, a) in [
            (json!("wrong"), block.clone(), accounts.clone()),
            (
                genesis.clone(),
                json!({"blockhash":"wrong","blockTime":wall}),
                accounts.clone(),
            ),
            (genesis.clone(), block.clone(), {
                let mut a = accounts.clone();
                a["context"]["slot"] = 99.into();
                a
            }),
            (genesis.clone(), block.clone(), {
                let mut a = accounts.clone();
                a["value"][2]["owner"] = "PRIVATE_CANARY".into();
                a
            }),
        ] {
            assert_ne!(
                validate_cut(&trusted, &root, &g, &b, &a, wall),
                Ok(Capability::Available)
            );
        }
        for index in [0, 8, 9, 10, 42, 50] {
            let mut changed = accounts.clone();
            let mut data = STANDARD
                .decode(changed["value"][1]["data"][0].as_str().unwrap())
                .unwrap();
            data[index] ^= 1;
            changed["value"][1]["data"][0] = STANDARD.encode(data).into();
            assert_eq!(
                validate_cut(&trusted, &root, &genesis, &block, &changed, wall),
                Ok(Capability::Invalid)
            );
        }
        let mut future = block.clone();
        future["blockTime"] = (wall + 1).into();
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &future, &accounts, wall),
            Ok(Capability::Invalid)
        );
        let mut bad_clock = accounts.clone();
        let mut clock = STANDARD
            .decode(bad_clock["value"][2]["data"][0].as_str().unwrap())
            .unwrap();
        clock[..8].copy_from_slice(&111u64.to_le_bytes());
        bad_clock["value"][2]["data"][0] = STANDARD.encode(clock).into();
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &block, &bad_clock, wall),
            Ok(Capability::Invalid)
        );
        let mut paused = accounts.clone();
        let mut raw = STANDARD
            .decode(paused["value"][0]["data"][0].as_str().unwrap())
            .unwrap();
        raw[355] = 1;
        paused["value"][0]["data"][0] = STANDARD.encode(raw).into();
        assert_eq!(
            validate_cut(&trusted, &root, &genesis, &block, &paused, wall),
            Ok(Capability::Paused)
        );
    }

    #[tokio::test]
    async fn loopback_rpc_nonce_and_read_only_method_envelope_are_enforced() {
        let (trusted, root, block, accounts) = fixture();
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let wrong = Arc::new(AtomicUsize::new(0));
        let app=axum::Router::new().route("/zkapi/v1/tree/root",axum::routing::get({let root=root.clone();move||{let root=root.clone();async move{Json(root)}}}))
            .route("/rpc",axum::routing::post({let calls=calls.clone();let wrong=wrong.clone();let genesis=trusted.genesis_hash.clone();move |Json(v):Json<Value>|{
                let calls=calls.clone();let wrong=wrong.clone();let genesis=genesis.clone();let block=block.clone();let accounts=accounts.clone();
                async move {let method=v["method"].as_str().unwrap().to_owned();calls.lock().await.push(method.clone());
                    uuid::Uuid::parse_str(v["id"].as_str().unwrap()).unwrap();
                    let value=match method.as_str(){
                        "getGenesisHash"=>{assert_eq!(v["params"],json!([]));json!(genesis)},
                        "getBlock"=>{assert!([100,110].contains(&v["params"][0].as_u64().unwrap()));assert_eq!(v["params"],json!([v["params"][0],{"commitment":"finalized","transactionDetails":"none","maxSupportedTransactionVersion":1,"rewards":false}]));block},
                        "getMultipleAccounts"=>{assert_eq!(v["params"][0].as_array().unwrap().len(),3);assert_eq!(v["params"][0][2],CLOCK);assert_eq!(v["params"][1],json!({"encoding":"base64","commitment":"finalized","minContextSlot":100}));accounts},
                        _=>panic!("unexpected RPC method"),};
                    Json(json!({"jsonrpc":"2.0","id":if wrong.load(Ordering::SeqCst)>0{json!("wrong-nonce")}else{v["id"].clone()},"result":value}))
                }
            }}));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert_eq!(
            indexer_health(&format!("{origin}/rpc"), &origin, &trusted).await,
            Ok(Capability::Available)
        );
        let mut methods = calls.lock().await.clone();
        methods.sort();
        assert_eq!(
            methods,
            [
                "getBlock",
                "getBlock",
                "getGenesisHash",
                "getMultipleAccounts"
            ]
        );
        wrong.store(1, Ordering::SeqCst);
        assert!(indexer_health(&format!("{origin}/rpc"), &origin, &trusted)
            .await
            .is_err());
        assert!(calls.lock().await.len() <= 7, "no automatic RPC retries");
        server.abort();
    }
    #[tokio::test]
    async fn inconsistent_clock_cut_is_resampled_once_without_relaxing_validation() {
        let (trusted, root, block, accounts) = fixture();
        let mode = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let router = axum::Router::new()
            .route("/zkapi/v1/tree/root", axum::routing::get({
                let root = root.clone();
                move || { let root = root.clone(); async move { Json(root) } }
            }))
            .route("/rpc", axum::routing::post({
                let mode = mode.clone(); let reads = reads.clone(); let calls = calls.clone();
                let genesis = trusted.genesis_hash.clone();
                move |Json(request): Json<Value>| {
                    let mode = mode.load(Ordering::SeqCst);
                    calls.fetch_add(1, Ordering::SeqCst);
                    let mut value = match request["method"].as_str().unwrap() {
                        "getGenesisHash" => json!(genesis),
                        "getBlock" => block.clone(),
                        "getMultipleAccounts" => {
                            assert_eq!(request["params"][1], json!({"encoding":"base64","commitment":"finalized","minContextSlot":100}));
                            let read = reads.fetch_add(1, Ordering::SeqCst);
                            let mut value = accounts.clone();
                            if read == 0 || mode == 1 {
                                let mut clock = STANDARD.decode(value["value"][2]["data"][0].as_str().unwrap()).unwrap();
                                clock[..8].copy_from_slice(&111u64.to_le_bytes());
                                value["value"][2]["data"][0] = STANDARD.encode(clock).into();
                            }
                            if read == 1 && mode == 2 {
                                let mut tree = STANDARD.decode(value["value"][1]["data"][0].as_str().unwrap()).unwrap();
                                tree[10] ^= 1;
                                value["value"][1]["data"][0] = STANDARD.encode(tree).into();
                            }
                            if mode == 3 { value["value"][2]["owner"] = "invalid".into(); }
                            value
                        }
                        _ => panic!("unexpected read"),
                    };
                    let response = if mode == 4 && request["method"] == "getMultipleAccounts" {
                        (StatusCode::TOO_MANY_REQUESTS, Json(json!({})))
                    } else {
                        value = json!({"jsonrpc":"2.0","id":request["id"],"result":value});
                        (StatusCode::OK, Json(value))
                    };
                    async move { response }
                }
            }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        for (case, expected, account_reads) in [
            (0, Ok(Capability::Available), 2),
            (1, Ok(Capability::Invalid), 2),
            (2, Ok(Capability::Invalid), 2),
            (3, Err(()), 1),
            (4, Err(()), 1),
        ] {
            mode.store(case, Ordering::SeqCst);
            reads.store(0, Ordering::SeqCst);
            calls.store(0, Ordering::SeqCst);
            assert_eq!(
                indexer_health(&format!("{origin}/rpc"), &origin, &trusted).await,
                expected
            );
            assert_eq!(reads.load(Ordering::SeqCst), account_reads);
            assert!(calls.load(Ordering::SeqCst) <= 5);
        }
        server.abort();
    }
    #[tokio::test]
    async fn transient_rpc_reads_have_one_retry_and_never_retry_invalid_or_financial_calls() {
        let mode = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let router = axum::Router::new().route("/rpc", axum::routing::post({
            let mode = mode.clone(); let calls = calls.clone();
            move |Json(v): Json<Value>| {
                let mode = mode.load(Ordering::SeqCst);
                let call = calls.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if mode == 1 || mode == 0 && call == 0 {
                    (StatusCode::SERVICE_UNAVAILABLE, json!({}))
                } else if mode == 2 && call == 0 || mode == 3 {
                    (StatusCode::OK, json!({"jsonrpc":"2.0","id":v["id"],"error":{"code":if mode==2{-32016}else{-32007},"message":"PRIVATE_CANARY"}}))
                } else if mode == 4 {
                    (StatusCode::TOO_MANY_REQUESTS, json!({}))
                } else if mode == 5 {
                    (StatusCode::OK, json!({"jsonrpc":"2.0","id":"wrong","result":true}))
                } else {
                    (StatusCode::OK, json!({"jsonrpc":"2.0","id":v["id"],"result":if mode==6&&call==0{Value::Null}else{json!({"blockhash":"fixture"})}}))
                };
                async move { (status, Json(body)) }
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/rpc", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        for (case, success, count) in [
            (0, true, 2),
            (1, false, 2),
            (2, true, 2),
            (3, false, 1),
            (4, false, 1),
            (5, false, 1),
            (6, true, 2),
        ] {
            mode.store(case, Ordering::SeqCst);
            calls.store(0, Ordering::SeqCst);
            assert_eq!(
                rpc(&client, &url, "getBlock", json!([])).await.is_ok(),
                success
            );
            assert_eq!(calls.load(Ordering::SeqCst), count);
        }
        calls.store(0, Ordering::SeqCst);
        assert!(rpc(&client, &url, "sendTransaction", json!([]))
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        mode.store(1, Ordering::SeqCst);
        calls.store(0, Ordering::SeqCst);
        assert!(tokio::time::timeout(
            Duration::from_millis(100),
            rpc(&client, &url, "getBlock", json!([]))
        )
        .await
        .is_err());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "no background retry after cancellation"
        );
        server.abort();
    }
    #[tokio::test]
    async fn malformed_and_oversized_rpc_and_signer_envelopes_are_rejected() {
        let router = axum::Router::new()
            .route(
                "/large",
                axum::routing::get(|| async { vec![b'x'; MAX_BODY + 1] }),
            )
            .route(
                "/malformed",
                axum::routing::get(|| async { "PRIVATE_RPC_BODY" }),
            )
            .route(
                "/unavailable",
                axum::routing::get(|| async {
                    (StatusCode::SERVICE_UNAVAILABLE, "PRIVATE_RPC_BODY")
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for path in ["large", "malformed", "unavailable"] {
            assert!(
                bounded(client.get(format!("{origin}/{path}")).send().await.unwrap())
                    .await
                    .is_err()
            );
        }
        server.abort();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            for body in [
                vec![b'x'; 4097],
                b"{\"reconciled\":true,\"reconciled\":false}\n".to_vec(),
                b"PRIVATE_SIGNER_BODY\n".to_vec(),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let b = stream.read_u8().await.unwrap();
                    request.push(b);
                    if b == b'\n' {
                        break;
                    }
                }
                assert_eq!(request, b"{\"kind\":\"health\"}\n");
                let _ = stream.write_all(&body).await;
            }
        });
        for _ in 0..3 {
            assert!(signer_health(&path, &[5; 32]).await.is_err());
        }
        task.await.unwrap();
    }
    #[tokio::test]
    async fn signer_health_only_is_bound_and_failure_is_not_healthy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("health.sock");
        assert!(signer_health(&path, &[5; 32]).await.is_err());
        let listener = UnixListener::bind(&path).unwrap();
        let task = tokio::spawn(async move {
            for (reconciled, digest) in [
                (true, hex::encode([5; 32])),
                (false, hex::encode([5; 32])),
                (true, "PRIVATE_CANARY".into()),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let b = socket.read_u8().await.unwrap();
                    request.push(b);
                    if b == b'\n' {
                        break;
                    }
                }
                assert_eq!(request, b"{\"kind\":\"health\"}\n");
                socket
                    .write_all(
                        format!(
                            "{}\n",
                            json!({"reconciled":reconciled,"config_digest":digest})
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        for expected in [
            Capability::Available,
            Capability::Unreconciled,
            Capability::Invalid,
        ] {
            assert_eq!(signer_health(&path, &[5; 32]).await, Ok(expected));
        }
        task.await.unwrap();
    }
    fn report() -> Report {
        let at = now();
        Report {
            schema: 1,
            scope: "read_only_capabilities",
            deployment_id: "fixture".into(),
            manifest_hash: "aa".repeat(32),
            started_at: at,
            completed_at: at,
            expires_at: at + 5,
            control: Capability::Available,
            indexer: Capability::Available,
            signer: Capability::Available,
            providers: vec![Provider {
                provider: "openrouter".into(),
                mode: "direct_openrouter".into(),
                model: "*".into(),
                tariff_hash: "bb".repeat(32),
                status: Capability::Enabled,
            }],
            provider_credit: Capability::NotChecked,
            operator_admission: Capability::NotChecked,
        }
    }
    #[test]
    fn disabled_provider_and_unknown_capabilities_never_pass_checked_scope() {
        assert_eq!(provider_status(true, Ok(true), true), Capability::Enabled);
        assert_eq!(provider_status(true, Ok(false), true), Capability::Disabled);
        assert_eq!(provider_status(false, Ok(true), true), Capability::Disabled);
        assert_eq!(provider_status(true, Ok(true), false), Capability::Disabled);
        assert_eq!(
            provider_status(true, Err(()), true),
            Capability::Unavailable
        );
        let mut v = report();
        assert!(v.available());
        v.providers[0].status = Capability::Disabled;
        assert!(!v.available());
        v.providers.clear();
        assert!(!v.available());
        let text = serde_json::to_string(&v).unwrap();
        assert!(
            text.contains("\"provider_credit\":\"not_checked\"")
                && text.contains("\"operator_admission\":\"not_checked\"")
        );
        assert!(!text.contains("config_digest") && !text.contains("socket"));
    }
    #[tokio::test]
    async fn late_worker_panic_terminates_with_fresh_unavailable_cache() {
        let cache = Cache::default();
        let count = Arc::new(AtomicUsize::new(0));
        let mut fallback = report();
        fallback.started_at = now() - 10;
        fallback.completed_at = now() - 10;
        fallback.expires_at = now() - 5;
        fallback.indexer = Capability::Unavailable;
        fallback.signer = Capability::Unavailable;
        fallback.providers.clear();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            cache.get_with(|| {
                let count = count.clone();
                (
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        panic!("synthetic worker failure")
                    }
                    .boxed(),
                    fallback.clone(),
                )
            }),
        )
        .await
        .unwrap();
        assert!(!result.available());
        assert!(result.expires_at > now());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let cached = cache
            .get_with(|| panic!("failed sample must remain cached"))
            .await;
        assert_eq!(cached.completed_at, result.completed_at);
    }
    #[tokio::test]
    async fn shared_probe_survives_waiter_cancellation_and_expired_cache_resamples() {
        let cache = Arc::new(Cache::default());
        let count = Arc::new(AtomicUsize::new(0));
        let call = |cache: Arc<Cache>, count: Arc<AtomicUsize>| {
            tokio::spawn(async move {
                cache
                    .get_with(|| {
                        let count = count.clone();
                        (
                            async move {
                                count.fetch_add(1, Ordering::SeqCst);
                                tokio::time::sleep(Duration::from_millis(30)).await;
                                report()
                            }
                            .boxed(),
                            report(),
                        )
                    })
                    .await
            })
        };
        let first = call(cache.clone(), count.clone());
        tokio::time::sleep(Duration::from_millis(10)).await;
        first.abort();
        let second = call(cache.clone(), count.clone());
        let third = call(cache.clone(), count.clone());
        assert!(second.await.unwrap().available());
        assert!(third.await.unwrap().available());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(call(cache.clone(), count.clone())
            .await
            .unwrap()
            .available());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let mut old = report();
        old.expires_at = now();
        let completed = async move { old }.boxed().shared();
        completed.clone().await;
        *cache.work.lock().await = Some(completed);
        assert!(call(cache, count.clone()).await.unwrap().available());
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}
