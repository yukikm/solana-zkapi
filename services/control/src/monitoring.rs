//! Local read-only collection. Source failures remain missing measurements;
//! this process neither changes admission nor signs or submits transactions.
use crate::{
    operations::{Alert, HealthSample},
    signer::SignerConfig,
    wire,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    net::IpAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub local_test_only: bool,
    pub database_url: String,
    pub trusted: crate::chain::TrustedPool,
    pub rpc_url: String,
    pub indexer_origin: String,
    pub fee_payer: String,
    pub signer_socket: PathBuf,
    pub signer_config: SignerConfig,
    pub challenger_health_file: PathBuf,
    pub synchronous_replica_application: String,
    pub output_directory: PathBuf,
    pub interval_seconds: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub schema: u32,
    pub pool: String,
    pub sample: HealthSample,
    pub alerts: Vec<Alert>,
    pub sources: BTreeMap<String, String>,
    pub source_instances: BTreeMap<String, String>,
}
fn private_directory(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && metadata.permissions().mode() & 0o077 == 0,
        "private directory required"
    );
    Ok(())
}
fn local_url(text: &str) -> Result<()> {
    let url = reqwest::Url::parse(text)?;
    ensure!(
        url.scheme() == "http"
            && url.host_str().is_some_and(|h| h
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|a| a.is_loopback()))
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "explicit local HTTP origin required"
    );
    Ok(())
}
fn integer(value: &Value) -> Result<u64> {
    let raw = value.as_str().context("integer string")?;
    let n: u64 = raw.parse()?;
    ensure!(n.to_string() == raw, "canonical integer");
    Ok(n)
}
pub fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.local_test_only && (1..=30).contains(&self.interval_seconds),
            "local collector interval required"
        );
        crate::operations::local_database(&self.database_url)?;
        self.trusted.validate()?;
        self.signer_config.validate()?;
        wire::pubkey(&self.fee_payer)?;
        ensure!(
            wire::pubkey(&self.trusted.pool)? == self.signer_config.pool
                && self.trusted.vault_binding.as_bytes() == &self.signer_config.binding
                && self.trusted.cap_micro_usdc == self.signer_config.authorization.cap
                && self.trusted.state_key[0].as_bytes() == &self.signer_config.state_key.x
                && self.trusted.state_key[1].as_bytes() == &self.signer_config.state_key.y
                && self.trusted.clearance_key[0].as_bytes() == &self.signer_config.clearance_key.x
                && self.trusted.clearance_key[1].as_bytes() == &self.signer_config.clearance_key.y,
            "collector signer identity mismatch"
        );
        ensure!(
            !self.synchronous_replica_application.is_empty(),
            "replica identity required"
        );
        local_url(&self.rpc_url)?;
        local_url(&self.indexer_origin)?;
        private_directory(&self.output_directory)?;
        private_directory(self.signer_socket.parent().context("socket parent")?)?;
        Ok(())
    }
}
struct Collector {
    config: Config,
    http: reqwest::Client,
}
impl Collector {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let response = self
            .http
            .post(&self.config.rpc_url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await?
            .error_for_status()?;
        let value = bounded_json(response).await?;
        ensure!(
            value["jsonrpc"] == "2.0" && value["id"] == 1 && value.get("error").is_none(),
            "RPC envelope"
        );
        value.get("result").cloned().context("RPC result")
    }
    async fn ledger(&self) -> Result<BTreeMap<String, String>> {
        let mut connection = crate::operations::readonly(&self.config.database_url).await?;
        let db = connection
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let pool = self.config.signer_config.pool;
        let identity = db
            .query_one(
                "SELECT accepting,authorization_config FROM pools WHERE pool=$1",
                &[&&pool[..]],
            )
            .await?;
        let authorization: Value = identity.get(1);
        ensure!(
            authorization.get("signer") == Some(&serde_json::to_value(&self.config.signer_config)?),
            "collector ledger signing config mismatch"
        );
        let accepting: bool = identity.get(0);
        let row=db.query_one("SELECT count(*) FILTER(WHERE state='USAGE_UNKNOWN'),COALESCE(sum(operator_loss_nano),0)::text,count(*) FILTER(WHERE state='USAGE_UNKNOWN' AND reconcile_deadline<=extract(epoch FROM clock_timestamp())) FROM operations WHERE pool=$1", &[&&pool[..]]).await?;
        let attempts:i64=db.query_one("SELECT count(*) FROM dispatch_attempts WHERE pool=$1 AND finished_at IS NULL AND fenced_at IS NULL", &[&&pool[..]]).await?.get(0);
        let mut out = BTreeMap::from([
            ("usage_unknown".into(), row.get::<_, i64>(0).to_string()),
            ("operator_loss_nano_usdc".into(), row.get::<_, String>(1)),
            ("overdue_unknown".into(), row.get::<_, i64>(2).to_string()),
            ("unfenced_attempts".into(), attempts.to_string()),
            (
                "recovery_unfenced_attempts".into(),
                if accepting { 0 } else { attempts }.to_string(),
            ),
        ]);
        // Missing replica or hidden statistics is unavailable, never zero lag.
        // The monitoring DB role requires pg_monitor, without write privileges.
        let standby = db.query_opt("SELECT GREATEST(pg_wal_lsn_diff(pg_current_wal_flush_lsn(),flush_lsn),0)::text FROM pg_stat_replication WHERE application_name=$1 AND state='streaming' AND sync_state IN ('sync','quorum') AND flush_lsn IS NOT NULL", &[&self.config.synchronous_replica_application]).await?;
        if let Some(row) = standby {
            out.insert("database_replica_flush_lag_bytes".into(), row.get(0));
            out.insert(
                "database_synchronous_replica_unavailable".into(),
                "0".into(),
            );
        } else {
            out.insert(
                "database_synchronous_replica_unavailable".into(),
                "1".into(),
            );
        }
        db.commit().await?;
        Ok(out)
    }
    async fn chain(&self) -> Result<BTreeMap<String, String>> {
        let t = &self.config.trusted;
        ensure!(
            self.rpc("getGenesisHash", json!([])).await? == t.genesis_hash,
            "RPC genesis mismatch"
        );
        let root: wire::Root = serde_json::from_value(
            bounded_json(
                self.http
                    .get(format!(
                        "{}/zkapi/v1/tree/root",
                        self.config.indexer_origin.trim_end_matches('/')
                    ))
                    .send()
                    .await?
                    .error_for_status()?,
            )
            .await?,
        )?;
        ensure!(root.pool == t.pool, "indexer pool mismatch");
        let root_slot = wire::uint(&root.slot)?;
        wire::pubkey(&root.blockhash)?;
        let finalized = self
            .rpc("getSlot", json!([{"commitment":"finalized"}]))
            .await?
            .as_u64()
            .context("finalized slot")?;
        ensure!(finalized >= root_slot, "indexer ahead of finalized RPC");
        let block=self.rpc("getBlock",json!([root_slot,{"commitment":"finalized","transactionDetails":"none","rewards":false}])).await?;
        ensure!(
            block["blockhash"] == root.blockhash,
            "indexer finalized block mismatch"
        );
        let balance=self.rpc("getBalance",json!([self.config.fee_payer,{"commitment":"finalized","minContextSlot":finalized}])).await?;
        ensure!(
            balance["context"]["slot"]
                .as_u64()
                .is_some_and(|s| s >= finalized),
            "stale fee balance"
        );
        let mut out = BTreeMap::from([
            ("root_slot_lag".into(), (finalized - root_slot).to_string()),
            (
                "fee_payer_lamports".into(),
                balance["value"]
                    .as_u64()
                    .context("fee balance")?
                    .to_string(),
            ),
        ]);
        // Observe tree liability and escrow together in one finalized bank.
        let program = solana_pubkey::Pubkey::new_from_array(wire::pubkey(&t.program_id)?);
        let pool = wire::pubkey(&t.pool)?;
        let (tree, bump) = solana_pubkey::Pubkey::find_program_address(&[b"tree", &pool], &program);
        let (authority, _) =
            solana_pubkey::Pubkey::find_program_address(&[b"vault", &pool], &program);
        let token = wire::pubkey(&t.token_program)?;
        let mint = wire::pubkey(&t.mint)?;
        let ata_program = solana_pubkey::Pubkey::new_from_array(wire::pubkey(
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        )?);
        let (vault, _) = solana_pubkey::Pubkey::find_program_address(
            &[authority.as_ref(), &token, &mint],
            &ata_program,
        );
        let accounts=self.rpc("getMultipleAccounts",json!([[t.pool,tree.to_string(),vault.to_string()],{"commitment":"finalized","encoding":"base64","minContextSlot":finalized}])).await?;
        let slot = accounts["context"]["slot"]
            .as_u64()
            .context("account context")?;
        ensure!(slot >= finalized, "stale accounting accounts");
        let values = accounts["value"].as_array().context("account list")?;
        ensure!(values.len() == 3, "account count");
        crate::chain::validate_pool_account(t, &values[0], slot)?;
        let tree = account(&values[1], &t.program_id)?;
        ensure!(
            tree.len() == 66
                && tree[..8] == wire::sha256(b"account:TreeState")[..8]
                && tree[8..10] == [2, bump],
            "tree account layout"
        );
        if slot == root_slot {
            ensure!(
                tree[10..42] == *root.root.as_bytes()
                    && u64_at(&tree, 42) == wire::uint(&root.next_note_id)?
                    && u64_at(&tree, 50) == wire::uint(&root.sequence)?,
                "root account mismatch"
            );
        }
        let vault = account(&values[2], &t.token_program)?;
        ensure!(
            vault.len() == 165
                && vault[..32] == mint
                && vault[32..64] == authority.to_bytes()
                && vault[108] == 1
                && vault[72..76] == [0; 4]
                && vault[129..133] == [0; 4],
            "vault token identity"
        );
        out.insert(
            "escrow_invariant_violation".into(),
            u8::from(u64_at(&vault, 64) < u64_at(&tree, 58)).to_string(),
        );
        Ok(out)
    }
    async fn signer(&self) -> Result<(BTreeMap<String, String>, String)> {
        let mut stream = tokio::net::UnixStream::connect(&self.config.signer_socket).await?;
        stream.write_all(b"{\"kind\":\"health\"}\n").await?;
        let mut response = Vec::new();
        loop {
            ensure!(response.len() < 1024, "signer response bound");
            let byte = stream.read_u8().await?;
            if byte == b'\n' {
                break;
            }
            response.push(byte);
        }
        let value: Value = serde_json::from_slice(&response)?;
        ensure!(
            value["config_digest"] == hex::encode(self.config.signer_config.digest()?),
            "signer config mismatch"
        );
        let instance: uuid::Uuid = value["instance_id"]
            .as_str()
            .context("signer identity")?
            .parse()?;
        Ok((
            BTreeMap::from([
                (
                    "signer_reconciliation_failure".into(),
                    u8::from(!value["reconciled"].as_bool().context("signer health")?).to_string(),
                ),
                (
                    "signer_refused_requests_total".into(),
                    integer(&value["refused_requests_total"])?.to_string(),
                ),
            ]),
            instance.to_string(),
        ))
    }
    fn challenger(&self, now: u64) -> Result<BTreeMap<String, String>> {
        crate::egress::private_file(&self.config.challenger_health_file)?;
        ensure!(
            std::fs::metadata(&self.config.challenger_health_file)?.len() <= 65536,
            "challenger health size"
        );
        let v: Value =
            serde_json::from_slice(&std::fs::read(&self.config.challenger_health_file)?)?;
        let at = v["observed_at"].as_u64().context("challenger time")?;
        ensure!(
            v["schema"] == 1
                && v["pool"] == self.config.trusted.pool
                && at <= now
                && now - at <= 30
                && v["ready"] == true,
            "challenger health unavailable"
        );
        let mut out = BTreeMap::new();
        for (target, source) in [
            (
                "challenge_detection_to_send_seconds",
                "oldest_detection_to_send_seconds",
            ),
            ("tree_proof_failure_total", "proof_failure_total"),
            (
                "tree_root_conflict_reproves_total",
                "root_conflict_reproves_total",
            ),
        ] {
            out.insert(
                target.into(),
                v[source]
                    .as_u64()
                    .context("challenger counter")?
                    .to_string(),
            );
        }
        // No pending challenge has no deadline pressure. This sentinel comes
        // from a fresh ready daemon's explicit absence, never an absent source.
        let remaining = if v
            .get("minimum_pending_deadline")
            .context("challenge deadline presence")?
            .is_null()
        {
            u64::MAX
        } else {
            v["minimum_pending_deadline"]
                .as_u64()
                .context("challenge deadline")?
                .saturating_sub(now)
        };
        out.insert("challenge_remaining_seconds".into(), remaining.to_string());
        Ok(out)
    }
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn account(value: &Value, owner: &str) -> Result<Vec<u8>> {
    ensure!(
        value["owner"] == owner
            && value["executable"] == false
            && value["lamports"].as_u64().is_some_and(|n| n > 0)
            && value["data"][1] == "base64",
        "account metadata"
    );
    let text = value["data"][0].as_str().context("account data")?;
    let bytes = STANDARD.decode(text)?;
    ensure!(
        STANDARD.encode(&bytes) == text,
        "canonical account encoding"
    );
    Ok(bytes)
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 262144,
            "monitor response bound"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn collect(config: &Config, previous: Option<&Report>) -> Result<Report> {
    config.validate()?;
    let observed_at = now()?;
    let c = Collector {
        config: config.clone(),
        http: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?,
    };
    let (ledger, chain, signer) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(10), c.ledger()),
        tokio::time::timeout(Duration::from_secs(15), c.chain()),
        tokio::time::timeout(Duration::from_secs(5), c.signer())
    );
    let mut report = Report {
        schema: 1,
        pool: config.trusted.pool.clone(),
        sample: HealthSample {
            observed_at,
            measurements: BTreeMap::new(),
        },
        alerts: vec![],
        sources: BTreeMap::new(),
        source_instances: BTreeMap::new(),
    };
    for (name, result) in [
        ("ledger", ledger.ok().and_then(Result::ok)),
        ("chain", chain.ok().and_then(Result::ok)),
        ("challenger", c.challenger(now()?).ok()),
    ] {
        report.sources.insert(
            name.into(),
            if result.is_some() {
                "ready"
            } else {
                "unavailable"
            }
            .into(),
        );
        if let Some(values) = result {
            report.sample.measurements.extend(values)
        }
    }
    if let Some(previous) = previous.filter(|p| p.schema == 1 && p.pool == report.pool) {
        report.source_instances = previous.source_instances.clone();
    }
    report.sources.insert("signer".into(), "unavailable".into());
    if let Ok(Ok((values, instance))) = signer {
        let reconciled = values
            .get("signer_reconciliation_failure")
            .is_some_and(|v| v == "0");
        report.sample.measurements.extend(values);
        report.source_instances.insert("signer".into(), instance);
        report.sources.insert(
            "signer".into(),
            if reconciled {
                "ready"
            } else {
                "reconciliation_failed"
            }
            .into(),
        );
    }
    let previous = previous.filter(|p| p.schema == 1 && p.pool == report.pool);
    report.alerts =
        crate::operations::evaluate_health(&report.sample, previous.map(|p| &p.sample), now()?)?;
    if previous.is_some_and(|p| {
        p.source_instances.get("signer").is_some_and(|old| {
            report
                .source_instances
                .get("signer")
                .is_some_and(|new| new != old)
        })
    }) {
        report.alerts.push(Alert {
            metric: "signer_refused_requests_total".into(),
            severity: "page".into(),
            reason: "signer_restarted_counter_baseline".into(),
        });
    }
    Ok(report)
}
impl Report {
    pub fn save(&self, directory: &Path) -> Result<()> {
        private_directory(directory)?;
        let temporary = directory.join(format!(".health-{}", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(self)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, directory.join("health.json"))?;
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    }
}
pub async fn run(config: Config, watch: bool) -> Result<()> {
    use fs2::FileExt;
    config.validate()?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(config.output_directory.join("collector.lock"))?;
    lock.try_lock_exclusive()
        .context("collector already running")?;
    let path = config.output_directory.join("health.json");
    let mut previous = if path.exists() {
        crate::egress::private_file(&path)?;
        Some(serde_json::from_slice::<Report>(&std::fs::read(&path)?)?)
    } else {
        None
    };
    loop {
        let report = collect(&config, previous.as_ref()).await?;
        report.save(&config.output_directory)?;
        previous = Some(report);
        if !watch {
            break;
        }
        tokio::select! { _=tokio::signal::ctrl_c()=>break, _=tokio::time::sleep(Duration::from_secs(config.interval_seconds))=>{} }
    }
    Ok(())
}
