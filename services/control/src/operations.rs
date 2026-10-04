//! Read-only operations boundary: restore witnesses, authenticated fences and a
//! private dashboard. This module never creates a second financial writer.
use crate::wire;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

pub fn local_database(value: &str) -> Result<()> {
    let config: tokio_postgres::Config = value.parse()?;
    ensure!(
        !config.get_hosts().is_empty(),
        "explicit local database required"
    );
    for host in config.get_hosts() {
        match host {
            tokio_postgres::config::Host::Unix(_) => {}
            tokio_postgres::config::Host::Tcp(h) => ensure!(
                h.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()),
                "local database required"
            ),
        }
    }
    ensure!(
        config.get_hostaddrs().iter().all(|a| a.is_loopback()),
        "local hostaddr required"
    );
    Ok(())
}
pub async fn readonly(value: &str) -> Result<tokio_postgres::Client> {
    local_database(value)?;
    let (db, connection) = tokio_postgres::connect(value, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    db.batch_execute("SET default_transaction_read_only=on")
        .await?;
    Ok(db)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryWitness {
    pub version: u32,
    pub pool: [u8; 32],
    pub wal_flush_lsn: String,
    pub database_system_id: String,
    pub captured_at: u64,
    pub rows: BTreeMap<String, String>,
    pub digest: String,
}
/// PostgreSQL LSN is two unsigned hexadecimal u32 halves, never a decimal or
/// lexicographic ordering. Require PostgreSQL's canonical uppercase rendering.
pub fn parse_lsn(value: &str) -> Result<u64> {
    let (high, low) = value.split_once('/').context("invalid WAL LSN")?;
    ensure!(
        !high.is_empty()
            && !low.is_empty()
            && high.len() <= 8
            && low.len() <= 8
            && high
                .bytes()
                .chain(low.bytes())
                .all(|b| b.is_ascii_hexdigit()),
        "invalid WAL LSN"
    );
    let high = u32::from_str_radix(high, 16)?;
    let low = u32::from_str_radix(low, 16)?;
    ensure!(format!("{high:X}/{low:X}") == value, "noncanonical WAL LSN");
    Ok((u64::from(high) << 32) | u64::from(low))
}
impl RecoveryWitness {
    fn body(&self) -> Result<Vec<u8>> {
        let mut body = serde_json::to_value(self)?;
        body.as_object_mut().unwrap().remove("digest");
        Ok(serde_jcs::to_vec(&body)?)
    }
    pub fn verify(&self) -> Result<()> {
        parse_lsn(&self.wal_flush_lsn)?;
        ensure!(
            !self.database_system_id.is_empty()
                && self.database_system_id.bytes().all(|b| b.is_ascii_digit()),
            "invalid database system identifier"
        );
        ensure!(
            self.version == 2 && self.digest == hex::encode(wire::sha256(&self.body()?)),
            "corrupt restore witness"
        );
        Ok(())
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        self.verify()?;
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(&serde_jcs::to_vec(self)?)?;
        f.sync_all()?;
        std::fs::File::open(path.parent().context("witness parent")?)?.sync_all()?;
        Ok(())
    }
}
/// Capture this witness on independently retained storage after stopping
/// admission. The witness covers acknowledged immutable rows, never plaintext
/// credentials or inference. WAL itself remains PostgreSQL's responsibility.
pub async fn capture(db: &mut tokio_postgres::Client, pool: [u8; 32]) -> Result<RecoveryWitness> {
    crate::ledger::verify_schema(db).await?;
    let tx = db
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    // Timestamp rendering is part of each row hash. Recovery observers may use
    // different local timezones, but must derive the same independently kept cut.
    tx.batch_execute("SET LOCAL TIME ZONE 'UTC'").await?;
    ensure!(
        !tx.query_one("SELECT accepting FROM pools WHERE pool=$1", &[&&pool[..]])
            .await?
            .get::<_, bool>(0),
        "stop admission before recovery checkpoint"
    );
    let mut rows = BTreeMap::new();
    let queries = [
      ("migrations","SELECT version::text AS key,encode(checksum,'hex') AS body FROM control_migrations ORDER BY version"),
      ("pools","SELECT encode(pool,'hex') AS key,row_to_json(p)::text AS body FROM pools p WHERE pool=$1"),
      ("tariffs","SELECT encode(tariff_hash,'hex') AS key,row_to_json(t)::text AS body FROM tariffs t WHERE EXISTS (SELECT 1 FROM quotes q WHERE q.pool=$1 AND q.tariff_hash=t.tariff_hash) ORDER BY tariff_hash"),
      ("nullifiers","SELECT encode(nullifier,'hex') AS key,row_to_json(n)::text AS body FROM nullifier_reservations n WHERE pool=$1 ORDER BY nullifier"),
      ("sessions","SELECT request_id::text AS key,row_to_json(s)::text AS body FROM sessions s WHERE pool=$1 ORDER BY request_id"),
      ("operations","SELECT request_id::text||':'||operation_id::text AS key,row_to_json(o)::text AS body FROM operations o WHERE pool=$1 ORDER BY request_id,operation_id"),
      ("attempts","SELECT attempt_id::text AS key,row_to_json(a)::text AS body FROM dispatch_attempts a WHERE pool=$1 ORDER BY attempt_id"),
      ("settlements","SELECT request_id::text AS key,row_to_json(s)::text AS body FROM settlements s WHERE pool=$1 ORDER BY request_id"),
      ("clearances","SELECT encode(nullifier,'hex') AS key,row_to_json(c)::text AS body FROM clearances c WHERE pool=$1 ORDER BY nullifier"),
      ("receipts","SELECT receipt_id::text AS key,row_to_json(r)::text AS body FROM receipts r WHERE pool=$1 ORDER BY receipt_id"),
      ("outbox","SELECT id::text AS key,row_to_json(o)::text AS body FROM outbox o WHERE pool=$1 ORDER BY id"),
      ("quotes","SELECT quote_id::text AS key,row_to_json(q)::text AS body FROM quotes q WHERE pool=$1 ORDER BY quote_id"),
      ("provider_evidence","SELECT evidence_id::text AS key,row_to_json(e)::text AS body FROM provider_evidence e WHERE pool=$1 ORDER BY evidence_id"),
      ("chain_checkpoints","SELECT encode(pool,'hex') AS key,row_to_json(c)::text AS body FROM chain_checkpoints c WHERE pool=$1"),
      ("chain_events","SELECT encode(signature,'hex')||':'||instruction_index::text||':'||event_index::text AS key,row_to_json(e)::text AS body FROM chain_events e WHERE pool=$1 ORDER BY signature,instruction_index,event_index"),
      ("chain_transactions","SELECT operation_id::text AS key,row_to_json(t)::text AS body FROM chain_transactions t WHERE pool=$1 ORDER BY operation_id"),
    ];
    for (table, sql) in queries {
        let fetched = if table == "migrations" {
            tx.query(sql, &[]).await?
        } else {
            tx.query(sql, &[&&pool[..]]).await?
        };
        for r in fetched {
            rows.insert(
                format!("{table}/{}", r.get::<_, String>(0)),
                hex::encode(wire::sha256(r.get::<_, String>(1).as_bytes())),
            );
        }
    }
    let wal_flush_lsn: String = tx
        .query_one("SELECT pg_current_wal_flush_lsn()::text", &[])
        .await?
        .get(0);
    // Requires pg_monitor only for the independently administered observer.
    let database_system_id: String = tx
        .query_one(
            "SELECT system_identifier::text FROM pg_control_system()",
            &[],
        )
        .await?
        .get(0);
    tx.commit().await?;
    let mut result = RecoveryWitness {
        version: 2,
        pool,
        wal_flush_lsn,
        database_system_id,
        captured_at: crate::provider_runtime::now(),
        rows,
        digest: String::new(),
    };
    result.digest = hex::encode(wire::sha256(&result.body()?));
    Ok(result)
}
pub async fn verify_restore(
    db: &mut tokio_postgres::Client,
    expected: &RecoveryWitness,
) -> Result<RecoveryWitness> {
    expected.verify()?;
    let actual = capture(db, expected.pool).await?;
    ensure!(
        actual.database_system_id == expected.database_system_id,
        "restore belongs to another PostgreSQL cluster"
    );
    ensure!(
        parse_lsn(&actual.wal_flush_lsn)? >= parse_lsn(&expected.wal_flush_lsn)?,
        "WAL has not reached the retained acknowledged checkpoint"
    );
    for (key, digest) in &expected.rows {
        ensure!(
            actual.rows.get(key) == Some(digest),
            "restored acknowledged row missing or changed: {key}"
        );
    }
    ensure!(
        actual
            .rows
            .iter()
            .filter(|(k, _)| k.starts_with("migrations/"))
            .eq(expected
                .rows
                .iter()
                .filter(|(k, _)| k.starts_with("migrations/"))),
        "migration checksum changed"
    );
    let live:i64=db.query_one("SELECT count(*) FROM dispatch_attempts WHERE pool=$1 AND finished_at IS NULL AND fenced_at IS NULL",&[&&expected.pool[..]]).await?.get(0);
    ensure!(live == 0, "unfenced dispatcher prevents restore admission");
    Ok(actual)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FenceCertificate {
    pub pool: [u8; 32],
    pub attempt_id: uuid::Uuid,
    pub owner_instance: uuid::Uuid,
    pub writer_epoch: i64,
    pub controller: String,
    pub resource_uid: String,
    pub process_terminated: bool,
    pub restart_denied: bool,
    pub egress_revoked: bool,
    pub observed_at: u64,
    pub signature: String,
}
impl FenceCertificate {
    pub fn signed_bytes(&self) -> Result<Vec<u8>> {
        let mut v = serde_json::to_value(self)?;
        v.as_object_mut().unwrap().remove("signature");
        Ok(serde_jcs::to_vec(&v)?)
    }
    /// Trusted controller key is installed independently of the certificate/DB.
    pub fn verify(&self, key: [u8; 32], now: u64) -> Result<crate::ledger::FenceEvidence> {
        use ed25519_dalek::Verifier;
        ensure!(
            self.process_terminated
                && self.restart_denied
                && self.egress_revoked
                && self.writer_epoch > 0
                && !self.resource_uid.is_empty()
                && !self.controller.is_empty()
                && self.observed_at <= now
                && now - self.observed_at <= 300,
            "incomplete or stale fence evidence"
        );
        let bytes = self.signed_bytes()?;
        ed25519_dalek::VerifyingKey::from_bytes(&key)?.verify(
            &bytes,
            &ed25519_dalek::Signature::from_slice(&hex::decode(&self.signature)?)?,
        )?;
        Ok(crate::ledger::FenceEvidence::from_local_stop(
            self.pool,
            self.attempt_id,
            self.owner_instance,
            self.writer_epoch,
            wire::sha256(&bytes),
        ))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminConfig {
    pub local_test_only: bool,
    pub listen: SocketAddr,
    pub database_url: String,
    pub pool: [u8; 32],
    pub bearer_file: PathBuf,
    pub allowed_peers: Vec<IpAddr>,
    #[serde(default)]
    pub health_file: Option<PathBuf>,
}
pub struct Dashboard {
    config: AdminConfig,
    token_hash: [u8; 32],
    db: tokio::sync::Mutex<tokio_postgres::Client>,
}
impl Dashboard {
    pub async fn connect(config: AdminConfig) -> Result<Arc<Self>> {
        ensure!(
            config.local_test_only
                && config.listen.ip().is_loopback()
                && !config.allowed_peers.is_empty()
                && config.allowed_peers.iter().all(IpAddr::is_loopback),
            "private admin listener required"
        );
        crate::egress::private_file(&config.bearer_file)?;
        let token = std::fs::read(&config.bearer_file)?;
        ensure!(
            token.len() >= 32 && token.len() <= 256 && token.iter().all(u8::is_ascii_alphanumeric),
            "strong separate admin token required"
        );
        let db = readonly(&config.database_url).await?;
        Ok(Arc::new(Self {
            config,
            token_hash: wire::sha256(&token),
            db: tokio::sync::Mutex::new(db),
        }))
    }
    pub fn router(self: Arc<Self>) -> axum::Router {
        use axum::routing::get;
        axum::Router::new()
            .route("/admin/v1/dashboard/summary", get(summary))
            .route("/admin/v1/dashboard/recent", get(recent))
            .route("/admin/v1/dashboard/events", get(events))
            .with_state(self)
    }
    fn authorized(&self, peer: SocketAddr, headers: &axum::http::HeaderMap) -> bool {
        use subtle::ConstantTimeEq;
        let values = headers.get_all("authorization");
        let mut iter = values.iter();
        let Some(value) = iter.next() else {
            return false;
        };
        if iter.next().is_some()
            || headers.contains_key("origin")
            || !self.config.allowed_peers.contains(&peer.ip())
        {
            return false;
        }
        let Some(token) = value.to_str().ok().and_then(|v| v.strip_prefix("Bearer ")) else {
            return false;
        };
        bool::from(self.token_hash.ct_eq(&wire::sha256(token.as_bytes())))
    }
    pub async fn snapshot(&self) -> Result<serde_json::Value> {
        let path = self
            .config
            .health_file
            .as_ref()
            .context("collector health required")?;
        crate::egress::private_file(path)?;
        ensure!(
            std::fs::metadata(path)?.len() <= 65536,
            "health report bound"
        );
        let health: crate::monitoring::Report = serde_json::from_slice(&std::fs::read(path)?)?;
        let now = crate::provider_runtime::now();
        ensure!(
            health.schema == 1
                && wire::pubkey(&health.pool)? == self.config.pool
                && health.sample.observed_at <= now
                && now - health.sample.observed_at <= 60
                && health.sources.get("chain").is_some_and(|s| s == "ready"),
            "chain monitoring unavailable"
        );
        let lag = health
            .sample
            .measurements
            .get("root_slot_lag")
            .context("root lag unavailable")?;
        wire::uint(lag)?;
        let mut connection = self.db.lock().await;
        let db = connection
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let counts = db.query_one("SELECT count(*) FILTER(WHERE state='ACTIVE'),count(*) FILTER(WHERE state IN ('DRAINING','RECONCILING','SIGN_PENDING')) FROM sessions WHERE pool=$1", &[&&self.config.pool[..]]).await?;
        let charged: String = db.query_one("SELECT COALESCE(sum(charge_micro),0)::text FROM settlements WHERE pool=$1 AND state_signature IS NOT NULL", &[&&self.config.pool[..]]).await?.get(0);
        let unknown: i64 = db
            .query_one(
                "SELECT count(*) FROM operations WHERE pool=$1 AND state='USAGE_UNKNOWN'",
                &[&&self.config.pool[..]],
            )
            .await?
            .get(0);
        db.commit().await?;
        Ok(
            serde_json::json!({"active_sessions":counts.get::<_,i64>(0).to_string(),
            "pending_settlements":counts.get::<_,i64>(1).to_string(), "charged_micro_usdc":charged,
            "root_lag_slots":lag,"unknown_operations":unknown.to_string()}),
        )
    }
}
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
fn json_response(value: serde_json::Value) -> Response {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(value),
    )
        .into_response()
}
async fn summary(
    State(d): State<Arc<Dashboard>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !d.authorized(peer, &headers) {
        return admin_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    match d.snapshot().await {
        Ok(v) => json_response(v),
        Err(_) => admin_error(StatusCode::SERVICE_UNAVAILABLE, "operations_unavailable"),
    }
}
fn admin_error(status: StatusCode, code: &'static str) -> Response {
    let mut response = crate::api::ApiError(status, code).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
}
async fn recent(
    State(d): State<Arc<Dashboard>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    query: std::result::Result<Query<PageQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if !d.authorized(peer, &headers) {
        return admin_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(Query(query)) = query else {
        return admin_error(StatusCode::BAD_REQUEST, "invalid_cursor");
    };
    let cursor = match query.cursor.as_deref().map(wire::uuid).transpose() {
        Ok(v) => v,
        Err(_) => return admin_error(StatusCode::BAD_REQUEST, "invalid_cursor"),
    };
    let db = d.db.lock().await;
    if let Some(cursor) = cursor {
        match db
            .query_opt(
                "SELECT 1 FROM sessions WHERE pool=$1 AND request_id=$2",
                &[&&d.config.pool[..], &cursor],
            )
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => return admin_error(StatusCode::BAD_REQUEST, "invalid_cursor"),
            Err(_) => {
                return admin_error(StatusCode::SERVICE_UNAVAILABLE, "operations_unavailable")
            }
        }
    }
    // Creation order is stable even as existing session state changes.
    let rows = db.query("SELECT s.request_id,s.state,floor(extract(epoch FROM s.updated_at))::bigint,st.charge_micro::text FROM sessions s LEFT JOIN settlements st ON st.pool=s.pool AND st.request_id=s.request_id AND st.state_signature IS NOT NULL WHERE s.pool=$1 AND ($2::uuid IS NULL OR (s.created_at,s.request_id)<(SELECT created_at,request_id FROM sessions WHERE pool=$1 AND request_id=$2)) ORDER BY s.created_at DESC,s.request_id DESC LIMIT 51", &[&&d.config.pool[..], &cursor]).await;
    match rows {
        Ok(rows) => {
            let next = (rows.len() > 50).then(|| rows[49].get::<_, uuid::Uuid>(0).to_string());
            let events: Vec<_> = rows.iter().take(50).map(|r| {
                let mut event = serde_json::json!({"timestamp":r.get::<_,i64>(2).to_string(),"kind":"session","request_id":r.get::<_,uuid::Uuid>(0),"state":r.get::<_,String>(1)});
                if let Some(charge) = r.get::<_,Option<String>>(3) { event["charge_micro_usdc"] = charge.into(); }
                event
            }).collect();
            json_response(serde_json::json!({"events":events,"next_cursor":next}))
        }
        Err(_) => admin_error(StatusCode::SERVICE_UNAVAILABLE, "operations_unavailable"),
    }
}
async fn events(
    State(d): State<Arc<Dashboard>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    query: std::result::Result<Query<PageQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if !d.authorized(peer, &headers) {
        return admin_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Ok(Query(query)) = query else {
        return admin_error(StatusCode::BAD_REQUEST, "invalid_cursor");
    };
    let cursor = match query.cursor.as_deref().map(wire::uint).transpose() {
        Ok(v) if v.is_none_or(|n| n <= i64::MAX as u64) => v.map(|n| n as i64),
        _ => return admin_error(StatusCode::BAD_REQUEST, "invalid_cursor"),
    };
    let db = d.db.lock().await;
    match db.query("SELECT id,event_type,floor(extract(epoch FROM created_at))::bigint,completed_at IS NOT NULL FROM outbox WHERE pool=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 51", &[&&d.config.pool[..],&cursor]).await {
        Ok(rows) => {
            let next = (rows.len()>50).then(||rows[49].get::<_,i64>(0).to_string());
            let events: Vec<_> = rows.iter().take(50).map(|r|serde_json::json!({"timestamp":r.get::<_,i64>(2).to_string(),"kind":r.get::<_,String>(1),"state":if r.get::<_,bool>(3) {"completed"} else {"pending"}})).collect();
            json_response(serde_json::json!({"events":events,"next_cursor":next}))
        },
        Err(_) => admin_error(StatusCode::SERVICE_UNAVAILABLE, "operations_unavailable"),
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthSample {
    pub observed_at: u64,
    pub measurements: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Alert {
    pub metric: String,
    pub severity: String,
    pub reason: String,
}
/// A collector supplies current measurements from independently checked services.
/// Missing/stale data cannot be converted to healthy zero. Amounts stay integers.
pub fn evaluate_health(
    sample: &HealthSample,
    previous: Option<&HealthSample>,
    now: u64,
) -> Result<Vec<Alert>> {
    let policy: serde_json::Value =
        serde_json::from_str(include_str!("../../../deploy/operations/monitoring.json"))?;
    let metrics = policy["metrics"].as_object().context("monitoring policy")?;
    ensure!(
        sample.measurements.keys().all(|m| metrics.contains_key(m)),
        "unknown monitoring metric"
    );
    let stale = sample.observed_at > now || now - sample.observed_at > 60;
    let mut alerts = Vec::new();
    for (metric, rules) in metrics {
        let mut emit = |severity: &str, reason: &str| {
            alerts.push(Alert {
                metric: metric.clone(),
                severity: severity.into(),
                reason: reason.into(),
            })
        };
        if stale {
            emit("page", "stale_measurement");
            continue;
        }
        let Some(raw) = sample.measurements.get(metric) else {
            emit("page", "missing_measurement");
            continue;
        };
        ensure!(
            !raw.is_empty()
                && raw.bytes().all(|b| b.is_ascii_digit())
                && (raw == "0" || !raw.starts_with('0')),
            "noncanonical monitoring integer"
        );
        let value: u128 = raw.parse()?;
        let threshold = |name: &str| -> Option<u128> {
            rules.get(name).and_then(|v| {
                v.as_u64()
                    .map(u128::from)
                    .or_else(|| v.as_str().and_then(|v| v.parse().ok()))
            })
        };
        for (rule, severity, below) in [
            ("warn", "warn", false),
            ("page", "page", false),
            ("emergency_below", "emergency", true),
            ("page_above", "page", false),
            ("warn_above", "warn", false),
            ("emergency_above", "emergency", false),
            ("page_below", "page", true),
        ] {
            if let Some(bound) = threshold(rule) {
                let breached = if below {
                    value < bound
                } else if rule.ends_with("above") {
                    value > bound
                } else {
                    value >= bound
                };
                if breached {
                    emit(severity, "threshold");
                }
            }
        }
        for (rule, severity) in [
            ("warn_increase", "warn"),
            ("page_increase", "page"),
            ("emergency_increase", "emergency"),
        ] {
            if let Some(bound) = threshold(rule) {
                let prior = previous
                    .filter(|p| p.observed_at <= sample.observed_at)
                    .and_then(|p| p.measurements.get(metric))
                    .and_then(|v| v.parse::<u128>().ok());
                match prior {
                    Some(old) if value >= old && value - old >= bound => {
                        emit(severity, "counter_increase")
                    }
                    Some(old) if value < old => emit("page", "counter_rollback"),
                    None if value > 0 => emit(severity, "counter_without_baseline"),
                    _ => {}
                }
            }
        }
    }
    Ok(alerts)
}
