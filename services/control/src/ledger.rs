//! Durable financial writer. Its advisory lock and every mutation share one connection.
//!
//! No provider calls are retried here. A committed dispatch is claimed at most once;
//! uncertain calls retain their reservations until observed completion or real fencing.
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls, Row, Transaction};
use uuid::Uuid;

pub type Hash = [u8; 32];
pub type Result<T> = std::result::Result<T, LedgerError>;
const MAX_NANO: u128 = 99_999_999_999_999_999_999_999_999_999_999_999_999;
const SESSION_SELECT: &str = "SELECT *,charged_nano::text AS charged_text,reserved_nano::text AS reserved_text FROM sessions WHERE pool=$1 AND request_id=$2";
const OP_SELECT: &str = "SELECT *,reservation_nano::text AS reservation_text,charged_nano::text AS charged_text,observed_cost_nano::text AS observed_text,operator_loss_nano::text AS loss_text FROM operations WHERE pool=$1 AND request_id=$2 AND operation_id=$3";

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("database unavailable")]
    Database(#[from] tokio_postgres::Error),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("record not found")]
    NotFound,
    #[error("migration checksum or version mismatch")]
    MigrationMismatch,
}

#[derive(Clone, Debug)]
pub struct PoolIdentity {
    pub pool: Hash,
    pub deployment_id: String,
    pub manifest_hash: Hash,
    pub authorization_config: Value,
}
#[derive(Clone, Debug)]
pub struct QuoteRecord {
    pub quote_id: Uuid,
    pub quote_hash: Hash,
    pub canonical_body: Vec<u8>,
    pub signature: Vec<u8>,
    pub tariff_hash: Hash,
    pub expires_at: i64,
}
#[derive(Clone, Debug)]
pub struct NewSession {
    pub request_id: Uuid,
    pub nullifier: Hash,
    pub quote_id: Uuid,
    pub request_digest: Hash,
    pub request_transcript: Vec<u8>,
    pub control_secret_hash: Hash,
    pub proxy_secret_hash: Option<Hash>,
    pub mode: String,
    pub provider: String,
    pub cap_micro: u64,
    pub max_concurrency: i16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub request_id: Uuid,
    pub nullifier: Hash,
    pub quote_id: Uuid,
    pub request_digest: Hash,
    pub request_transcript: Vec<u8>,
    pub control_secret_hash: Hash,
    pub proxy_secret_hash: Option<Hash>,
    pub mode: String,
    pub provider: String,
    pub state: String,
    pub close_requested: bool,
    pub cap_micro: u64,
    pub charged_nano: u128,
    pub reserved_nano: u128,
    pub active_operations: i16,
    pub max_concurrency: i16,
    pub activated_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// Provider management identifier only; never a usable runtime key.
    pub provider_key_ref: Option<String>,
    pub writer_epoch: i64,
}
#[derive(Clone, Debug)]
pub struct NewOperation {
    pub request_id: Uuid,
    pub operation_id: Uuid,
    pub request_hmac: Hash,
    pub endpoint: String,
    pub model: String,
    pub reservation_nano: u128,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperationRecord {
    pub request_id: Uuid,
    pub operation_id: Uuid,
    pub request_hmac: Hash,
    pub endpoint: String,
    pub model: String,
    pub state: String,
    pub reservation_nano: u128,
    pub charged_nano: u128,
    pub observed_cost_nano: Option<u128>,
    pub operator_loss_nano: u128,
    pub provider_request_id: Option<String>,
    pub dispatched_at: Option<i64>,
    pub reconcile_deadline: Option<i64>,
}
#[derive(Clone, Debug)]
pub struct ReceiptRecord {
    pub sequence: i64,
    pub receipt_id: Uuid,
    pub request_id: Uuid,
    pub operation_id: Option<Uuid>,
    pub billing_effect: String,
    pub canonical_body: Vec<u8>,
    pub receipt_hash: Hash,
    pub signature: Option<Vec<u8>>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementTarget {
    pub charge_micro: u64,
    pub next_anchor: Hash,
    pub next_commitment_x: Hash,
    pub next_commitment_y: Hash,
    pub blind_delta: Hash,
    pub anchor_randomness: Hash,
    pub signature_message: Hash,
    pub message_digest: Hash,
}
#[derive(Clone, Debug)]
pub struct SettlementRecord {
    pub request_id: Uuid,
    pub target: SettlementTarget,
    pub state_signature: Option<Vec<u8>>,
}
#[derive(Clone, Debug)]
pub struct ClearanceRecord {
    pub nullifier: Hash,
    pub signature_message: Hash,
    pub message_digest: Hash,
    pub signature: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchAttempt {
    pub attempt_id: Uuid,
    pub request_id: Uuid,
    pub operation_id: Option<Uuid>,
    pub owner_instance: Uuid,
    pub writer_epoch: i64,
}
/// Read-only ownership inventory. Neither a stale epoch nor this record authorizes
/// retry, reassignment, or marking an external sender as stopped.
#[derive(Clone, Debug)]
pub struct DispatchAttemptRecord {
    pub attempt: DispatchAttempt,
    pub kind: String,
    pub send_claimed: bool,
    pub finished: bool,
    pub fenced: bool,
}
impl DispatchAttemptRecord {
    pub fn quiesced(&self) -> bool {
        self.finished || self.fenced
    }
}
/// Evidence must be obtained by the supervisor only after actual process exit or egress fencing.
/// A timer, lease expiry, or database flag is not evidence of a stopped sender.
#[derive(Clone, Debug)]
pub struct FenceEvidence {
    pool: Hash,
    attempt_id: Uuid,
    owner_instance: Uuid,
    writer_epoch: i64,
    digest: Hash,
}
impl FenceEvidence {
    pub(crate) fn from_local_stop(
        pool: Hash,
        attempt_id: Uuid,
        owner_instance: Uuid,
        writer_epoch: i64,
        digest: Hash,
    ) -> Self {
        Self {
            pool,
            attempt_id,
            owner_instance,
            writer_epoch,
            digest,
        }
    }
    pub fn digest(&self) -> Hash {
        self.digest
    }
}
#[derive(Clone, Copy, Debug)]
pub enum OperationOutcome {
    Metered { observed_nano: u128 },
    NotDispatched,
    UnknownWaived,
}
#[derive(Clone, Copy, Debug)]
pub enum DirectOutcome {
    Metered { observed_nano: u128 },
    ConfirmedNotIssued,
}

#[derive(Clone)]
pub struct Ledger {
    inner: Arc<Writer>,
}
struct Writer {
    client: Mutex<Client>,
    healthy: Arc<AtomicBool>,
    pool: Hash,
    epoch: i64,
    backend_pid: i32,
    receipt_key: VerifyingKey,
}

const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/0001_ledger.sql")),
    (2, include_str!("../migrations/0002_invariants.sql")),
];

/// Run only with the migration credential. Runtime users have no DDL privileges.
pub async fn migrate(url: &str) -> Result<()> {
    let (mut client, connection) = tokio_postgres::connect(url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let tx = client.transaction().await?;
    tx.query_one("SELECT pg_advisory_xact_lock(7295637512400119)", &[])
        .await?;
    tx.batch_execute("CREATE TABLE IF NOT EXISTS control_migrations(version integer PRIMARY KEY,checksum bytea NOT NULL CHECK(octet_length(checksum)=32),applied_at timestamptz NOT NULL DEFAULT clock_timestamp())").await?;
    let existing = tx
        .query(
            "SELECT version,checksum FROM control_migrations ORDER BY version",
            &[],
        )
        .await?;
    if existing
        .iter()
        .enumerate()
        .any(|(i, r)| r.get::<_, i32>(0) != (i + 1) as i32)
    {
        return Err(LedgerError::MigrationMismatch);
    }
    for row in &existing {
        let version: i32 = row.get(0);
        let hash: Vec<u8> = row.get(1);
        let Some((_, sql)) = MIGRATIONS.iter().find(|(v, _)| *v == version) else {
            return Err(LedgerError::MigrationMismatch);
        };
        if hash.as_slice() != Sha256::digest(sql.as_bytes()).as_slice() {
            return Err(LedgerError::MigrationMismatch);
        }
    }
    for (version, sql) in MIGRATIONS {
        if !existing.iter().any(|r| r.get::<_, i32>(0) == *version) {
            tx.batch_execute(sql).await?;
            let checksum = Sha256::digest(sql.as_bytes()).to_vec();
            tx.execute(
                "INSERT INTO control_migrations(version,checksum) VALUES($1,$2)",
                &[version, &checksum],
            )
            .await?;
        }
    }
    tx.batch_execute(
        "GRANT SELECT ON control_migrations TO zkapi_control_writer,zkapi_control_reader",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Read-only verification for writer and independent signer startup/recovery audits.
pub async fn verify_schema<C: tokio_postgres::GenericClient + Sync>(client: &C) -> Result<()> {
    let versions = client
        .query(
            "SELECT version,checksum FROM control_migrations ORDER BY version",
            &[],
        )
        .await?;
    if versions.len() != MIGRATIONS.len()
        || versions
            .iter()
            .zip(MIGRATIONS)
            .any(|(row, (version, sql))| {
                row.get::<_, i32>(0) != *version
                    || row.get::<_, Vec<u8>>(1).as_slice()
                        != Sha256::digest(sql.as_bytes()).as_slice()
            })
    {
        return Err(LedgerError::MigrationMismatch);
    }
    Ok(())
}

impl Ledger {
    /// Acquiring a writer always increments epoch and disables new admission until recovery succeeds.
    pub async fn connect(url: &str, identity: &PoolIdentity) -> Result<Self> {
        let (mut client, connection) = tokio_postgres::connect(url, NoTls).await?;
        let healthy = Arc::new(AtomicBool::new(true));
        let health = healthy.clone();
        tokio::spawn(async move {
            let _ = connection.await;
            health.store(false, Ordering::Release);
        });
        verify_schema(&client).await?;
        let receipt_bytes: Hash =
            serde_json::from_value(identity.authorization_config["signer"]["receipt_key"].clone())
                .map_err(|_| LedgerError::Invalid("missing_pinned_receipt_key"))?;
        let receipt_key = VerifyingKey::from_bytes(&receipt_bytes)
            .map_err(|_| LedgerError::Invalid("invalid_pinned_receipt_key"))?;
        let lock_digest =
            Sha256::digest([b"zkapi-pool-writer-v1".as_slice(), identity.pool.as_slice()].concat());
        let lock_key = i64::from_be_bytes(lock_digest[..8].try_into().unwrap());
        let locked: bool = client
            .query_one("SELECT pg_try_advisory_lock($1)", &[&lock_key])
            .await?
            .get(0);
        if !locked {
            return Err(LedgerError::Unavailable("writer_already_active"));
        }
        let tx = client.transaction().await?;
        tx.execute("INSERT INTO pools(pool,deployment_id,manifest_hash,authorization_config) VALUES($1::bytea,$2,$3::bytea,$4) ON CONFLICT(pool) DO NOTHING",&[&&identity.pool[..],&identity.deployment_id,&&identity.manifest_hash[..],&identity.authorization_config]).await?;
        let row=tx.query_one("SELECT deployment_id,manifest_hash,authorization_config,writer_epoch FROM pools WHERE pool=$1 FOR UPDATE",&[&&identity.pool[..]]).await?;
        if row.get::<_, String>(0) != identity.deployment_id
            || row.get::<_, Vec<u8>>(1) != identity.manifest_hash
            || row.get::<_, Value>(2) != identity.authorization_config
        {
            return Err(LedgerError::Conflict("pool_identity_mismatch"));
        }
        let epoch:i64=tx.query_one("UPDATE pools SET writer_epoch=writer_epoch+1,accepting=false WHERE pool=$1 RETURNING writer_epoch",&[&&identity.pool[..]]).await?.get(0);
        let backend_pid: i32 = tx.query_one("SELECT pg_backend_pid()", &[]).await?.get(0);
        tx.commit().await?;
        Ok(Self {
            inner: Arc::new(Writer {
                client: Mutex::new(client),
                healthy,
                pool: identity.pool,
                epoch,
                backend_pid,
                receipt_key,
            }),
        })
    }
    pub fn pool(&self) -> Hash {
        self.inner.pool
    }
    pub fn writer_epoch(&self) -> i64 {
        self.inner.epoch
    }
    pub fn backend_pid(&self) -> i32 {
        self.inner.backend_pid
    }
    pub fn healthy(&self) -> bool {
        self.inner.healthy.load(Ordering::Acquire)
    }
    fn check_health(&self) -> Result<()> {
        if self.healthy() {
            Ok(())
        } else {
            Err(LedgerError::Unavailable("writer_connection_lost"))
        }
    }
    async fn lock_pool(&self, tx: &Transaction<'_>) -> Result<bool> {
        self.check_health()?;
        let row = tx
            .query_one(
                "SELECT writer_epoch,accepting FROM pools WHERE pool=$1 FOR UPDATE",
                &[&&self.inner.pool[..]],
            )
            .await?;
        if row.get::<_, i64>(0) != self.inner.epoch {
            return Err(LedgerError::Unavailable("writer_fenced"));
        }
        Ok(row.get(1))
    }
    pub async fn set_accepting(&self, accepting: bool) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        tx.execute(
            "UPDATE pools SET accepting=$2 WHERE pool=$1",
            &[&&self.inner.pool[..], &accepting],
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn store_tariff(&self, hash: Hash, canonical_body: &[u8]) -> Result<()> {
        if Sha256::digest(canonical_body).as_slice() != hash {
            return Err(LedgerError::Invalid("tariff_hash_mismatch"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        tx.execute("INSERT INTO tariffs(tariff_hash,canonical_body) VALUES($1::bytea,$2) ON CONFLICT DO NOTHING",&[&&hash[..],&canonical_body]).await?;
        let saved: Vec<u8> = tx
            .query_one(
                "SELECT canonical_body FROM tariffs WHERE tariff_hash=$1",
                &[&&hash[..]],
            )
            .await?
            .get(0);
        if saved != canonical_body {
            return Err(LedgerError::Conflict("tariff_conflict"));
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn store_quote(&self, q: &QuoteRecord) -> Result<()> {
        if Sha256::digest(&q.canonical_body).as_slice() != q.quote_hash || q.signature.len() != 64 {
            return Err(LedgerError::Invalid("invalid_quote"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        if !self.lock_pool(&tx).await? {
            return Err(LedgerError::Unavailable("pool_not_accepting"));
        }
        tx.execute("INSERT INTO quotes(pool,quote_id,quote_hash,canonical_body,signature,tariff_hash,expires_at) VALUES($1::bytea,$2,$3::bytea,$4,$5,$6::bytea,$7)",&[&&self.inner.pool[..],&q.quote_id,&&q.quote_hash[..],&q.canonical_body,&q.signature,&&q.tariff_hash[..],&q.expires_at]).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn quote(&self, id: Uuid) -> Result<QuoteRecord> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        let r = c
            .query_opt(
                "SELECT * FROM quotes WHERE pool=$1 AND quote_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        Ok(QuoteRecord {
            quote_id: id,
            quote_hash: bytes(&r, "quote_hash")?,
            canonical_body: r.get("canonical_body"),
            signature: r.get("signature"),
            tariff_hash: bytes(&r, "tariff_hash")?,
            expires_at: r.get("expires_at"),
        })
    }
    pub async fn session(&self, id: Uuid) -> Result<SessionRecord> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        session_row(
            &c.query_opt(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?
                .ok_or(LedgerError::NotFound)?,
        )
    }
    pub async fn reserve_session<F, Fut>(
        &self,
        n: &NewSession,
        live_check: F,
    ) -> Result<SessionRecord>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        if Sha256::digest(&n.request_transcript).as_slice() != n.request_digest
            || n.cap_micro == 0
            || n.cap_micro > 9_007_199_254_740_991
        {
            return Err(LedgerError::Invalid("invalid_session"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        if let Some(row) = tx
            .query_opt(
                &(SESSION_SELECT.to_owned() + " FOR UPDATE"),
                &[&&self.inner.pool[..], &n.request_id],
            )
            .await?
        {
            let s = session_row(&row)?;
            if s.request_digest != n.request_digest
                || s.control_secret_hash != n.control_secret_hash
                || s.request_transcript != n.request_transcript
                || s.nullifier != n.nullifier
                || s.quote_id != n.quote_id
                || s.proxy_secret_hash != n.proxy_secret_hash
                || s.mode != n.mode
                || s.provider != n.provider
                || s.cap_micro != n.cap_micro
                || s.max_concurrency != n.max_concurrency
            {
                return Err(LedgerError::Conflict("idempotency_conflict"));
            }
            tx.commit().await?;
            return Ok(s);
        }
        if !accepting {
            return Err(LedgerError::Unavailable("pool_not_accepting"));
        }
        if tx
            .query_opt(
                "SELECT kind FROM nullifier_reservations WHERE pool=$1 AND nullifier=$2",
                &[&&self.inner.pool[..], &&n.nullifier[..]],
            )
            .await?
            .is_some()
        {
            return Err(LedgerError::Conflict("nullifier_reserved"));
        }
        let q = tx
            .query_opt(
                "SELECT expires_at FROM quotes WHERE pool=$1 AND quote_id=$2",
                &[&&self.inner.pool[..], &n.quote_id],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        live_check().await?;
        let now: i64 = tx
            .query_one(
                "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
                &[],
            )
            .await?
            .get(0);
        if now >= q.get::<_, i64>(0) {
            return Err(LedgerError::Conflict("quote_expired"));
        }
        if tx
            .query_opt(
                "SELECT 1 FROM sessions WHERE pool=$1 AND quote_id=$2",
                &[&&self.inner.pool[..], &n.quote_id],
            )
            .await?
            .is_some()
        {
            return Err(LedgerError::Conflict("quote_used"));
        }
        tx.execute("INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'AUTH')",&[&&self.inner.pool[..],&&n.nullifier[..]]).await?;
        let proxy = n.proxy_secret_hash.map(|v| v.to_vec());
        let cap = n.cap_micro as i64;
        tx.execute("INSERT INTO sessions(pool,request_id,nullifier,quote_id,request_digest,request_transcript,control_secret_hash,proxy_secret_hash,mode,provider,state,cap_micro,max_concurrency,writer_epoch) VALUES($1::bytea,$2,$3::bytea,$4,$5::bytea,$6,$7::bytea,$8::bytea,$9,$10,'RESERVED',$11::bigint,$12,$13)",&[&&self.inner.pool[..],&n.request_id,&&n.nullifier[..],&n.quote_id,&&n.request_digest[..],&n.request_transcript,&&n.control_secret_hash[..],&proxy,&n.mode,&n.provider,&cap,&n.max_concurrency,&self.inner.epoch]).await?;
        let result = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &n.request_id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn activate_proxy<F, Fut>(
        &self,
        id: Uuid,
        ttl_seconds: i64,
        live_check: F,
    ) -> Result<SessionRecord>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        if !(1..=300).contains(&ttl_seconds) {
            return Err(LedgerError::Invalid("invalid_session_ttl"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.state == "ACTIVE" {
            tx.commit().await?;
            return Ok(s);
        }
        if s.state != "RESERVED" || s.mode != "proxy" || s.close_requested || !accepting {
            return Err(LedgerError::Conflict("session_not_activatable"));
        }
        live_check().await?;
        tx.execute("WITH t AS MATERIALIZED (SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS current_second) UPDATE sessions SET state='ACTIVE',activated_at=t.current_second,expires_at=t.current_second+$3,updated_at=clock_timestamp() FROM t WHERE pool=$1 AND request_id=$2 AND state='RESERVED'",&[&&self.inner.pool[..],&id,&ttl_seconds]).await?;
        let s = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(s)
    }
    pub async fn close(&self, id: Uuid) -> Result<SessionRecord> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.state != "SETTLED" && !s.close_requested {
            tx.execute("UPDATE sessions SET close_requested=true,state=CASE WHEN state='ACTIVE' THEN 'DRAINING' WHEN state='RESERVED' THEN 'RECONCILING' ELSE state END,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id]).await?;
        }
        let s = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(s)
    }
    /// Capture accepted evidence for the challenger and stop new use after observing an exit.
    pub async fn record_exit(&self, id: Uuid, reason: &str) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.state != "SETTLED" {
            tx.execute("UPDATE sessions SET close_requested=true,state=CASE WHEN state='ACTIVE' THEN 'DRAINING' WHEN state='RESERVED' THEN 'RECONCILING' ELSE state END,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id]).await?;
        }
        let key = format!("exit:{id}");
        let metadata = serde_json::json!({"request_id":id,"reason":reason});
        tx.execute("INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,'CHAIN_EXIT_OBSERVED',$3) ON CONFLICT DO NOTHING",&[&&self.inner.pool[..],&key,&metadata]).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn nullifier_kind(&self, n: Hash) -> Result<Option<String>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        Ok(c.query_opt(
            "SELECT kind FROM nullifier_reservations WHERE pool=$1 AND nullifier=$2",
            &[&&self.inner.pool[..], &&n[..]],
        )
        .await?
        .map(|r| r.get(0)))
    }
    pub async fn reserve_clearance(
        &self,
        n: Hash,
        message: Hash,
        digest: Hash,
    ) -> Result<ClearanceRecord> {
        if Sha256::digest(message).as_slice() != digest {
            return Err(LedgerError::Invalid("message_digest_mismatch"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        if let Some(r) = tx
            .query_opt(
                "SELECT * FROM clearances WHERE pool=$1 AND nullifier=$2",
                &[&&self.inner.pool[..], &&n[..]],
            )
            .await?
        {
            let record = clearance_row(&r)?;
            if record.signature_message != message || record.message_digest != digest {
                return Err(LedgerError::Conflict("clearance_conflict"));
            }
            tx.commit().await?;
            return Ok(record);
        }
        if !accepting {
            return Err(LedgerError::Unavailable("pool_not_accepting"));
        }
        if tx
            .query_opt(
                "SELECT 1 FROM nullifier_reservations WHERE pool=$1 AND nullifier=$2",
                &[&&self.inner.pool[..], &&n[..]],
            )
            .await?
            .is_some()
        {
            return Err(LedgerError::Conflict("nullifier_reserved"));
        }
        tx.execute("INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'CLEARANCE')",&[&&self.inner.pool[..],&&n[..]]).await?;
        tx.execute("INSERT INTO clearances(pool,nullifier,message_digest,signature_message) VALUES($1::bytea,$2::bytea,$3::bytea,$4)",&[&&self.inner.pool[..],&&n[..],&&digest[..],&&message[..]]).await?;
        let r = clearance_row(
            &tx.query_one(
                "SELECT * FROM clearances WHERE pool=$1 AND nullifier=$2",
                &[&&self.inner.pool[..], &&n[..]],
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn save_clearance_signature(
        &self,
        n: Hash,
        signature: &[u8],
    ) -> Result<ClearanceRecord> {
        if signature.len() != 96 {
            return Err(LedgerError::Invalid("invalid_signature_length"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let row = tx
            .query_opt(
                "SELECT * FROM clearances WHERE pool=$1 AND nullifier=$2 FOR UPDATE",
                &[&&self.inner.pool[..], &&n[..]],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        let r = clearance_row(&row)?;
        if r.signature.as_deref().is_some_and(|old| old != signature) {
            return Err(LedgerError::Conflict("signature_conflict"));
        }
        tx.execute(
            "UPDATE clearances SET signature=$3 WHERE pool=$1 AND nullifier=$2",
            &[&&self.inner.pool[..], &&n[..], &signature],
        )
        .await?;
        let r = clearance_row(
            &tx.query_one(
                "SELECT * FROM clearances WHERE pool=$1 AND nullifier=$2",
                &[&&self.inner.pool[..], &&n[..]],
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn pending_sessions(&self) -> Result<Vec<SessionRecord>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        c.query("SELECT *,charged_nano::text AS charged_text,reserved_nano::text AS reserved_text FROM sessions WHERE pool=$1 AND state<>'SETTLED' ORDER BY created_at,request_id",&[&&self.inner.pool[..]]).await?.iter().map(session_row).collect()
    }
    pub async fn pending_clearances(&self) -> Result<Vec<ClearanceRecord>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        c.query(
            "SELECT * FROM clearances WHERE pool=$1 AND signature IS NULL",
            &[&&self.inner.pool[..]],
        )
        .await?
        .iter()
        .map(clearance_row)
        .collect()
    }
    pub async fn operation(&self, id: Uuid, operation_id: Uuid) -> Result<OperationRecord> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        operation_row(
            &c.query_opt(OP_SELECT, &[&&self.inner.pool[..], &id, &operation_id])
                .await?
                .ok_or(LedgerError::NotFound)?,
        )
    }
    /// A replacement writer records old-epoch attempts as uncertain. It does not
    /// release their budget or invent evidence that the old sender has stopped.
    pub async fn recover_abandoned_operations(&self, id: Uuid) -> Result<u64> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        let changed=tx.execute("UPDATE operations o SET state='USAGE_UNKNOWN' FROM dispatch_attempts d WHERE o.pool=$1 AND o.request_id=$2 AND o.state IN ('DISPATCHING','STREAMING') AND d.pool=o.pool AND d.request_id=o.request_id AND d.operation_id=o.operation_id AND d.writer_epoch<>$3",&[&&self.inner.pool[..],&id,&self.inner.epoch]).await?;
        tx.commit().await?;
        Ok(changed)
    }
    /// The original creation response can no longer be delivered after writer
    /// restart. Preserve ownership and uncertainty; never infer nonissuance or
    /// fencing from the old epoch. An existing key reference is retained.
    pub async fn recover_abandoned_direct(&self, id: Uuid) -> Result<bool> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        let changed = if s.mode != "proxy" && s.state == "ISSUING" {
            tx.execute("UPDATE sessions s SET state='ISSUANCE_UNKNOWN',close_requested=true,updated_at=clock_timestamp() WHERE s.pool=$1::bytea AND s.request_id=$2 AND EXISTS (SELECT 1 FROM dispatch_attempts d WHERE d.pool=s.pool AND d.request_id=s.request_id AND d.kind='DIRECT_ISSUANCE' AND d.writer_epoch<>$3)", &[&&self.inner.pool[..], &id, &self.inner.epoch]).await? != 0
        } else {
            false
        };
        tx.commit().await?;
        Ok(changed)
    }
    /// Append-only, prompt-free recovery snapshots in the existing durable outbox.
    /// In particular, preserve final usage before deleting a direct provider key.
    pub async fn direct_checkpoint(&self, id: Uuid) -> Result<Option<Value>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        Ok(c.query_opt("SELECT metadata FROM outbox WHERE pool=$1::bytea AND event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$2 ORDER BY id DESC LIMIT 1", &[&&self.inner.pool[..], &id.to_string()]).await?.map(|r| r.get(0)))
    }
    pub async fn save_direct_checkpoint(
        &self,
        id: Uuid,
        expected: Option<&Value>,
        next: &Value,
    ) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.mode == "proxy" || matches!(s.state.as_str(), "SIGN_PENDING" | "SETTLED") {
            return Err(LedgerError::Conflict("direct_checkpoint_unavailable"));
        }
        validate_direct_checkpoint(&s, next)?;
        let previous: Option<Value> = tx.query_opt("SELECT metadata FROM outbox WHERE pool=$1::bytea AND event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$2 ORDER BY id DESC LIMIT 1", &[&&self.inner.pool[..], &id.to_string()]).await?.map(|r| r.get(0));
        if previous.as_ref() != expected {
            return Err(LedgerError::Conflict("direct_checkpoint_conflict"));
        }
        if previous.is_none()
            && (s.state != "RESERVED"
                || !next["reference"].is_null()
                || !next["disabled_at"].is_null()
                || !next["observation"].is_null()
                || !next["usage"].is_null()
                || next["deleted"] != false)
        {
            return Err(LedgerError::Invalid("direct_intent_must_precede_issuance"));
        }
        if let Some(old) = &previous {
            if old["intent"] != next["intent"]
                || (old["deleted"] == true && next["deleted"] != true)
                || ["reference", "disabled_at", "usage"]
                    .iter()
                    .any(|field| !old[*field].is_null() && old[*field] != next[*field])
            {
                return Err(LedgerError::Conflict("direct_checkpoint_immutable"));
            }
            if !old["observation"].is_null() {
                let old_observation = &old["observation"];
                let observation = &next["observation"];
                if observation.is_null()
                    || observation["observed_at"].as_u64() < old_observation["observed_at"].as_u64()
                    || (!old["usage"].is_null() && observation != old_observation)
                {
                    return Err(LedgerError::Conflict("direct_checkpoint_immutable"));
                }
                let previous: u128 = old_observation["usage"]["observed_nano"]
                    .as_str()
                    .ok_or(LedgerError::Invalid("invalid_direct_checkpoint"))?
                    .parse()
                    .map_err(|_| LedgerError::Invalid("invalid_direct_checkpoint"))?;
                let current: u128 = observation["usage"]["observed_nano"]
                    .as_str()
                    .ok_or(LedgerError::Invalid("invalid_direct_checkpoint"))?
                    .parse()
                    .map_err(|_| LedgerError::Invalid("invalid_direct_checkpoint"))?;
                if current < previous {
                    return Err(LedgerError::Conflict("direct_usage_regressed"));
                }
            }
            if old == next {
                tx.commit().await?;
                return Ok(());
            }
        }
        let key = format!("direct-checkpoint:{id}:{}", Uuid::new_v4());
        tx.execute("INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,'DIRECT_RECOVERY_CHECKPOINT',$3)", &[&&self.inner.pool[..], &key, &next]).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Management references are safe to retain; plaintext runtime keys are not.
    pub async fn provider_key_ref(&self, id: Uuid) -> Result<Option<String>> {
        Ok(self.session(id).await?.provider_key_ref)
    }
    pub async fn dispatch_attempts_for_session(
        &self,
        id: Uuid,
    ) -> Result<Vec<DispatchAttemptRecord>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        c.query("SELECT attempt_id,request_id,operation_id,owner_instance,writer_epoch,kind,send_claimed_at IS NOT NULL AS send_claimed,finished_at IS NOT NULL AS finished,fenced_at IS NOT NULL AS fenced FROM dispatch_attempts WHERE pool=$1::bytea AND request_id=$2 ORDER BY committed_at,attempt_id", &[&&self.inner.pool[..], &id]).await?.into_iter().map(|r| {
            Ok(DispatchAttemptRecord {
                attempt: DispatchAttempt {
                    attempt_id: r.get("attempt_id"),
                    request_id: r.get("request_id"),
                    operation_id: r.get("operation_id"),
                    owner_instance: r.get("owner_instance"),
                    writer_epoch: r.get("writer_epoch"),
                },
                kind: r.get("kind"),
                send_claimed: r.get("send_claimed"),
                finished: r.get("finished"),
                fenced: r.get("fenced"),
            })
        }).collect()
    }
    /// Persist the provider's lookup reference as soon as it is observed. It may
    /// only describe this already-dispatched operation and can never be replaced.
    pub async fn record_provider_request(
        &self,
        id: Uuid,
        operation_id: Uuid,
        provider_request_id: &str,
    ) -> Result<()> {
        if provider_request_id.is_empty()
            || provider_request_id.len() > 256
            || provider_request_id.chars().any(char::is_control)
        {
            return Err(LedgerError::Invalid("invalid_provider_request_id"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        let o = locked_operation(&tx, self.inner.pool, id, operation_id).await?;
        if !matches!(
            o.state.as_str(),
            "DISPATCHING" | "STREAMING" | "USAGE_UNKNOWN"
        ) {
            return Err(LedgerError::Conflict("operation_not_dispatched"));
        }
        if o.provider_request_id
            .as_deref()
            .is_some_and(|saved| saved != provider_request_id)
        {
            return Err(LedgerError::Conflict("provider_request_id_conflict"));
        }
        tx.execute("UPDATE operations SET provider_request_id=$4 WHERE pool=$1::bytea AND request_id=$2 AND operation_id=$3", &[&&self.inner.pool[..], &id, &operation_id, &provider_request_id]).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Read-only recovery inventory; returning a row never grants permission to resend.
    pub async fn operations_for_session(&self, id: Uuid) -> Result<Vec<OperationRecord>> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        c.query("SELECT *,reservation_nano::text AS reservation_text,charged_nano::text AS charged_text,observed_cost_nano::text AS observed_text,operator_loss_nano::text AS loss_text FROM operations WHERE pool=$1 AND request_id=$2 ORDER BY created_at,operation_id",&[&&self.inner.pool[..],&id]).await?.iter().map(operation_row).collect()
    }
    pub async fn reserve_operation(&self, n: &NewOperation) -> Result<OperationRecord> {
        check_nano(n.reservation_nano)?;
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, n.request_id).await?;
        if let Some(r) = tx
            .query_opt(
                &(OP_SELECT.to_owned() + " FOR UPDATE"),
                &[&&self.inner.pool[..], &n.request_id, &n.operation_id],
            )
            .await?
        {
            let o = operation_row(&r)?;
            return Err(LedgerError::Conflict(
                if o.request_hmac != n.request_hmac
                    || o.endpoint != n.endpoint
                    || o.model != n.model
                {
                    "idempotency_conflict"
                } else if matches!(o.state.as_str(), "DONE" | "WAIVED_OPERATOR_LOSS") {
                    "response_not_replayable"
                } else {
                    "operation_in_progress"
                },
            ));
        }
        require_active(&tx, &s, accepting).await?;
        let quote_body: Vec<u8> = tx
            .query_one(
                "SELECT canonical_body FROM quotes WHERE pool=$1 AND quote_id=$2",
                &[&&self.inner.pool[..], &s.quote_id],
            )
            .await?
            .get(0);
        let quote: Value = serde_json::from_slice(&quote_body)
            .map_err(|_| LedgerError::Invalid("invalid_saved_quote"))?;
        if s.mode != "proxy" {
            return Err(LedgerError::Invalid("proxy_session_required"));
        }
        if s.provider == "generic" {
            let body: crate::wire::QuoteBody = crate::wire::strict_parse(&quote_body)
                .map_err(|_| LedgerError::Invalid("invalid_saved_quote"))?;
            let tariff_hash = crate::wire::hash(&body.tariff_hash)
                .map_err(|_| LedgerError::Invalid("invalid_saved_quote"))?;
            let tariff_bytes: Vec<u8> = tx
                .query_one(
                    "SELECT canonical_body FROM tariffs WHERE tariff_hash=$1",
                    &[&&tariff_hash[..]],
                )
                .await?
                .get(0);
            if crate::wire::sha256(&tariff_bytes) != tariff_hash {
                return Err(LedgerError::Invalid("stored_tariff_digest_mismatch"));
            }
            let mut value: Value = serde_json::from_slice(&tariff_bytes)
                .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
            value
                .as_object_mut()
                .ok_or(LedgerError::Invalid("invalid_stored_tariff"))?
                .insert(
                    "tariff_hash".into(),
                    Value::String(body.tariff_hash.clone()),
                );
            let tariff: crate::wire::Tariff = serde_json::from_value(value)
                .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
            validate_generic_operation(&body, &tariff, n)?;
        } else {
            if quote.get("api").is_some()
                || !quote
                    .get("models")
                    .and_then(Value::as_array)
                    .is_some_and(|m| m.iter().any(|m| m.as_str() == Some(&n.model)))
            {
                return Err(LedgerError::Invalid("model_not_allowed"));
            }
            if !matches!(
                (s.provider.as_str(), n.endpoint.as_str()),
                ("anthropic", "/v1/messages")
                    | ("anthropic", "/v1/messages/count_tokens")
                    | ("openai", "/v1/chat/completions")
                    | ("openai", "/v1/responses")
                    | ("openrouter", "/v1/chat/completions")
            ) {
                return Err(LedgerError::Invalid("endpoint_not_allowed"));
            }
        }
        // Count estimates are free to the user, including any upstream cost.
        // The per-session bound survives process restarts and concurrent callers.
        if n.endpoint == "/v1/messages/count_tokens" {
            if n.reservation_nano != 0 {
                return Err(LedgerError::Invalid("count_tokens_must_be_free"));
            }
            let count: i64 = tx.query_one("SELECT count(*) FROM operations WHERE pool=$1 AND request_id=$2 AND endpoint='/v1/messages/count_tokens'", &[&&self.inner.pool[..], &n.request_id]).await?.get(0);
            if count >= 16 {
                return Err(LedgerError::Conflict("count_tokens_rate_limit"));
            }
        }
        if s.active_operations >= s.max_concurrency {
            return Err(LedgerError::Conflict("concurrency_limit"));
        }
        let total = s
            .charged_nano
            .checked_add(s.reserved_nano)
            .and_then(|v| v.checked_add(n.reservation_nano))
            .ok_or(LedgerError::Invalid("amount_overflow"))?;
        if total > u128::from(s.cap_micro) * 1000 {
            return Err(LedgerError::Conflict("budget_exhausted"));
        }
        let amount = n.reservation_nano.to_string();
        tx.execute("INSERT INTO operations(pool,request_id,operation_id,request_hmac,endpoint,model,state,reservation_nano) VALUES($1::bytea,$2,$3,$4::bytea,$5,$6,'RESERVED',$7::text::numeric)",&[&&self.inner.pool[..],&n.request_id,&n.operation_id,&&n.request_hmac[..],&n.endpoint,&n.model,&amount]).await?;
        tx.execute("UPDATE sessions SET reserved_nano=reserved_nano+$3::text::numeric,active_operations=active_operations+1,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&n.request_id,&amount]).await?;
        let op = operation_row(
            &tx.query_one(
                OP_SELECT,
                &[&&self.inner.pool[..], &n.request_id, &n.operation_id],
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(op)
    }
    /// I06 adapter contract: commit one issuance intent before any provider call.
    pub async fn begin_direct_issuance<F, Fut>(
        &self,
        id: Uuid,
        owner: Uuid,
        live_check: F,
    ) -> Result<DispatchAttempt>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if !accepting || s.state != "RESERVED" || s.mode == "proxy" || s.close_requested {
            return Err(LedgerError::Conflict("session_not_issuable"));
        }
        live_check().await?;
        let attempt = DispatchAttempt {
            attempt_id: Uuid::new_v4(),
            request_id: id,
            operation_id: None,
            owner_instance: owner,
            writer_epoch: self.inner.epoch,
        };
        tx.execute("INSERT INTO dispatch_attempts(attempt_id,pool,request_id,operation_id,kind,writer_epoch,owner_instance) VALUES($1,$2::bytea,$3,NULL,'DIRECT_ISSUANCE',$4,$5)",&[&attempt.attempt_id,&&self.inner.pool[..],&id,&self.inner.epoch,&owner]).await?;
        tx.execute("UPDATE sessions SET state='ISSUING',updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2 AND state='RESERVED'",&[&&self.inner.pool[..],&id]).await?;
        tx.commit().await?;
        Ok(attempt)
    }
    pub async fn mark_issuance_unknown(&self, id: Uuid) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.state == "ISSUING" {
            tx.execute("UPDATE sessions SET state='ISSUANCE_UNKNOWN',close_requested=true,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id]).await?;
        } else if s.state != "ISSUANCE_UNKNOWN" {
            return Err(LedgerError::Conflict("session_not_issuing"));
        }
        tx.commit().await?;
        Ok(())
    }
    /// Store only the provider's management reference. Persist it before the final
    /// chain check so cancellation cannot strand an issued key without its recovery
    /// reference. Unknown/closed issuance and a failed final check always drain.
    /// Activation never extends the provider's absolute key expiry.
    pub async fn resolve_direct_key<F, Fut>(
        &self,
        id: Uuid,
        key_ref: &str,
        ttl_seconds: i64,
        provider_expires_at: u64,
        live_check: F,
    ) -> Result<SessionRecord>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        if key_ref.is_empty()
            || key_ref.len() > 256
            || key_ref.chars().any(char::is_control)
            || !(1..=300).contains(&ttl_seconds)
        {
            return Err(LedgerError::Invalid("invalid_direct_key_reference"));
        }
        // Invalid provider metadata must not prevent retirement of a stored
        // management reference. A zero deadline drains; values beyond SQL's
        // timestamp integer range are bounded without extending a valid lease.
        let provider_expires_at = i64::try_from(provider_expires_at).unwrap_or(i64::MAX);
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.mode == "proxy" || !matches!(s.state.as_str(), "ISSUING" | "ISSUANCE_UNKNOWN") {
            return Err(LedgerError::Conflict("session_not_issuing"));
        }
        let saved_ref: Option<String> = tx
            .query_one(
                "SELECT provider_key_ref FROM sessions WHERE pool=$1 AND request_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?
            .get(0);
        if saved_ref.as_deref().is_some_and(|saved| saved != key_ref) {
            return Err(LedgerError::Conflict("direct_key_reference_conflict"));
        }
        tx.execute("UPDATE sessions SET provider_key_ref=$3,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id,&key_ref]).await?;
        tx.commit().await?;

        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        // An already-persisted reference means this is recovery, not the original
        // delivery attempt. Never activate or redeliver a key after such a retry.
        let eligible =
            saved_ref.is_none() && s.state == "ISSUING" && !s.close_requested && accepting;
        let check_error = if eligible {
            live_check().await.err()
        } else {
            None
        };
        let eligible = eligible && check_error.is_none();
        // The final RPC check and ledger lock can consume part of the provider
        // lease. Use one database clock observation to both reject an expired
        // key and cap the advertised session expiry to the signed deadline.
        tx.execute("WITH t AS MATERIALIZED (SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS current_second), decision AS (SELECT current_second,$4::boolean AND current_second<$6::bigint AS active FROM t) UPDATE sessions SET state=CASE WHEN d.active THEN 'ACTIVE' ELSE 'DRAINING' END,provider_key_ref=$3,close_requested=close_requested OR NOT d.active,activated_at=CASE WHEN d.active THEN d.current_second ELSE NULL END,expires_at=CASE WHEN d.active THEN LEAST(d.current_second+$5,$6) ELSE NULL END,updated_at=clock_timestamp() FROM decision d WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id,&key_ref,&eligible,&ttl_seconds,&provider_expires_at]).await?;
        let s = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?,
        )?;
        tx.commit().await?;
        if let Some(error) = check_error {
            return Err(error);
        }
        Ok(s)
    }
    /// I06 adapter must verify key nonexistence or disable/delete/final-usage, then supply
    /// its evidence digest. A finished issuance attempt alone does not prove key revocation.
    pub async fn complete_direct(
        &self,
        id: Uuid,
        outcome: DirectOutcome,
        stop_evidence: Hash,
        receipt: &ReceiptRecord,
    ) -> Result<SessionRecord> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.mode == "proxy"
            || !matches!(
                s.state.as_str(),
                "ISSUING" | "ISSUANCE_UNKNOWN" | "DRAINING" | "RECONCILING"
            )
        {
            return Err(LedgerError::Conflict("direct_not_reconcilable"));
        }
        let stopped:bool=tx.query_one("SELECT NOT EXISTS(SELECT 1 FROM dispatch_attempts WHERE pool=$1 AND request_id=$2 AND finished_at IS NULL AND fenced_at IS NULL)",&[&&self.inner.pool[..],&id]).await?.get(0);
        if !stopped {
            return Err(LedgerError::Conflict("dispatch_not_quiesced"));
        }
        let budget = u128::from(s.cap_micro) * 1000;
        let (charge, observed, loss, reason) = match outcome {
            DirectOutcome::Metered { observed_nano } => {
                check_nano(observed_nano)?;
                let charge = observed_nano.min(budget);
                (
                    charge,
                    Some(observed_nano),
                    Some(observed_nano - charge),
                    "metered",
                )
            }
            DirectOutcome::ConfirmedNotIssued => {
                let key: Option<String> = tx
                    .query_one(
                        "SELECT provider_key_ref FROM sessions WHERE pool=$1 AND request_id=$2",
                        &[&&self.inner.pool[..], &id],
                    )
                    .await?
                    .get(0);
                if key.is_some() || s.activated_at.is_some() {
                    return Err(LedgerError::Conflict("issued_key_requires_final_usage"));
                }
                (0, Some(0), Some(0), "not_dispatched")
            }
        };
        validate_receipt(
            receipt,
            self.inner.pool,
            id,
            None,
            charge,
            budget,
            observed,
            loss,
            reason,
        )?;
        insert_receipt(&tx, self.inner.pool, &self.inner.receipt_key, receipt).await?;
        let charge = charge.to_string();
        tx.execute("UPDATE sessions SET state='RECONCILING',close_requested=true,charged_nano=$3::text::numeric,direct_stop_evidence=$4::bytea,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id,&charge,&&stop_evidence[..]]).await?;
        let s = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(s)
    }
    /// Returns a new immutable attempt; never returns an old attempt as a retry permission.
    pub async fn begin_dispatch<F, Fut>(
        &self,
        id: Uuid,
        operation_id: Uuid,
        owner: Uuid,
        live_check: F,
    ) -> Result<DispatchAttempt>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        let op = locked_operation(&tx, self.inner.pool, id, operation_id).await?;
        if op.state != "RESERVED" {
            return Err(LedgerError::Conflict("dispatch_not_replayable"));
        }
        require_active(&tx, &s, accepting).await?;
        live_check().await?;
        require_active(&tx, &s, accepting).await?;
        let attempt = DispatchAttempt {
            attempt_id: Uuid::new_v4(),
            request_id: id,
            operation_id: Some(operation_id),
            owner_instance: owner,
            writer_epoch: self.inner.epoch,
        };
        tx.execute("INSERT INTO dispatch_attempts(attempt_id,pool,request_id,operation_id,kind,writer_epoch,owner_instance) VALUES($1,$2::bytea,$3,$4,'PROXY_INFERENCE',$5,$6)",&[&attempt.attempt_id,&&self.inner.pool[..],&id,&operation_id,&self.inner.epoch,&owner]).await?;
        tx.execute("UPDATE operations SET state='DISPATCHING',dispatched_at=floor(extract(epoch FROM clock_timestamp()))::bigint,reconcile_deadline=floor(extract(epoch FROM clock_timestamp()))::bigint+900 WHERE pool=$1 AND request_id=$2 AND operation_id=$3 AND state='RESERVED'",&[&&self.inner.pool[..],&id,&operation_id]).await?;
        tx.commit().await?;
        Ok(attempt)
    }
    /// A sender must claim immediately before egress. A lost response is not retried.
    pub async fn claim_dispatch(&self, attempt: &DispatchAttempt) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        let accepting = self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, attempt.request_id).await?;
        if !accepting
            || attempt.writer_epoch != self.inner.epoch
            || !matches!(
                (
                    attempt.operation_id.is_some(),
                    s.mode.as_str(),
                    s.state.as_str()
                ),
                (true, "proxy", "ACTIVE") | (false, "direct_oa" | "direct_openrouter", "ISSUING")
            )
            || s.close_requested
        {
            return Err(LedgerError::Conflict("dispatch_owner_fenced"));
        }
        if s.state == "ACTIVE" {
            require_active(&tx, &s, accepting).await?;
        }
        let changed=tx.execute("UPDATE dispatch_attempts a SET send_claimed_at=clock_timestamp() WHERE a.pool=$1 AND a.attempt_id=$2 AND a.owner_instance=$3 AND a.writer_epoch=$4 AND a.request_id=$5 AND a.operation_id IS NOT DISTINCT FROM $6 AND a.send_claimed_at IS NULL AND a.finished_at IS NULL AND a.fenced_at IS NULL AND (a.kind='DIRECT_ISSUANCE' OR EXISTS (SELECT 1 FROM operations o WHERE o.pool=a.pool AND o.request_id=a.request_id AND o.operation_id=a.operation_id AND o.state='DISPATCHING'))",&[&&self.inner.pool[..],&attempt.attempt_id,&attempt.owner_instance,&attempt.writer_epoch,&attempt.request_id,&attempt.operation_id]).await?;
        if changed != 1 {
            return Err(LedgerError::Conflict("dispatch_not_replayable"));
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn finish_attempt(&self, attempt: &DispatchAttempt, evidence: Hash) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, attempt.request_id).await?;
        // An inventory row from an old writer is not proof that its sender has
        // stopped. A replacement must use independently verified fence evidence.
        if attempt.writer_epoch != self.inner.epoch {
            return Err(LedgerError::Conflict("dispatch_owner_fenced"));
        }
        let changed=tx.execute("UPDATE dispatch_attempts SET finished_at=clock_timestamp(),finish_evidence_digest=$5::bytea WHERE pool=$1 AND attempt_id=$2 AND owner_instance=$3 AND writer_epoch=$4 AND request_id=$6 AND operation_id IS NOT DISTINCT FROM $7 AND finished_at IS NULL AND fenced_at IS NULL",&[&&self.inner.pool[..],&attempt.attempt_id,&attempt.owner_instance,&attempt.writer_epoch,&&evidence[..],&attempt.request_id,&attempt.operation_id]).await?;
        if changed != 1 {
            return Err(LedgerError::Conflict("attempt_finished_or_fenced"));
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn fence_attempt(
        &self,
        attempt: &DispatchAttempt,
        evidence: &FenceEvidence,
    ) -> Result<()> {
        if evidence.pool != self.inner.pool
            || evidence.attempt_id != attempt.attempt_id
            || evidence.owner_instance != attempt.owner_instance
            || evidence.writer_epoch != attempt.writer_epoch
        {
            return Err(LedgerError::Invalid("fence_evidence_identity_mismatch"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, attempt.request_id).await?;
        let changed=tx.execute("UPDATE dispatch_attempts SET fenced_at=clock_timestamp(),fence_evidence_digest=$5::bytea WHERE pool=$1 AND attempt_id=$2 AND owner_instance=$3 AND writer_epoch=$4 AND request_id=$6 AND operation_id IS NOT DISTINCT FROM $7 AND finished_at IS NULL AND fenced_at IS NULL",&[&&self.inner.pool[..],&attempt.attempt_id,&attempt.owner_instance,&attempt.writer_epoch,&&evidence.digest[..],&attempt.request_id,&attempt.operation_id]).await?;
        if changed != 1 {
            return Err(LedgerError::Conflict("attempt_finished_or_fenced"));
        }
        tx.commit().await?;
        Ok(())
    }
    /// Durable provider circuit breaker. Restarting the control process cannot
    /// clear unknown/loss counts. An explicit audited reset uses this same writer.
    pub async fn provider_available(&self, provider: &str) -> Result<bool> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        let count:i64=c.query_one("SELECT count(*) FROM operations o JOIN sessions s ON s.pool=o.pool AND s.request_id=o.request_id WHERE o.pool=$1 AND s.provider=$2 AND o.state IN ('USAGE_UNKNOWN','WAIVED_OPERATOR_LOSS') AND o.created_at>COALESCE((SELECT created_at FROM outbox WHERE pool=$1 AND event_type='PROVIDER_ADMISSION_RESET' AND metadata->>'provider'=$2 ORDER BY id DESC LIMIT 1),'-infinity'::timestamptz)",&[&&self.inner.pool[..],&provider]).await?.get(0);
        Ok(count < 3)
    }
    pub async fn reset_provider_admission(&self, provider: &str, evidence: Hash) -> Result<()> {
        if !matches!(
            provider,
            "oa" | "openai" | "anthropic" | "openrouter" | "generic"
        ) {
            return Err(LedgerError::Invalid("invalid_provider"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        // Every operation before the reset cut must be terminal. Otherwise an
        // older RESERVED/DISPATCHING operation could become unknown afterwards
        // while remaining excluded by provider_available's creation-time cut.
        let pending:bool=tx.query_one("SELECT EXISTS(SELECT 1 FROM operations o JOIN sessions s ON s.pool=o.pool AND s.request_id=o.request_id WHERE o.pool=$1 AND s.provider=$2 AND o.state NOT IN ('DONE','WAIVED_OPERATOR_LOSS'))",&[&&self.inner.pool[..],&provider]).await?.get(0);
        if pending {
            return Err(LedgerError::Unavailable("provider_reconciliation_pending"));
        }
        let metadata =
            serde_json::json!({"provider":provider,"evidence_digest":hex::encode(evidence)});
        tx.execute("INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,'PROVIDER_ADMISSION_RESET',$3)",&[&&self.inner.pool[..],&format!("provider-reset:{}",uuid::Uuid::new_v4()),&metadata]).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn mark_streaming(&self, id: Uuid, operation_id: Uuid) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        let op = locked_operation(&tx, self.inner.pool, id, operation_id).await?;
        if op.state == "DISPATCHING" {
            tx.execute("UPDATE operations SET state='STREAMING' WHERE pool=$1 AND request_id=$2 AND operation_id=$3 AND state='DISPATCHING'",&[&&self.inner.pool[..],&id,&operation_id]).await?;
        } else if op.state != "STREAMING" {
            return Err(LedgerError::Conflict("operation_not_dispatched"));
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn mark_operation_unknown(&self, id: Uuid, operation_id: Uuid) -> Result<()> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        let o = locked_operation(&tx, self.inner.pool, id, operation_id).await?;
        if matches!(o.state.as_str(), "DISPATCHING" | "STREAMING") {
            tx.execute("UPDATE operations SET state='USAGE_UNKNOWN' WHERE pool=$1 AND request_id=$2 AND operation_id=$3",&[&&self.inner.pool[..],&id,&operation_id]).await?;
        } else if o.state != "USAGE_UNKNOWN" {
            return Err(LedgerError::Conflict("operation_not_dispatched"));
        }
        tx.commit().await?;
        Ok(())
    }
    /// Atomically release budget, fix the final charge, and store its signed public receipt.
    pub async fn complete_operation(
        &self,
        id: Uuid,
        operation_id: Uuid,
        outcome: OperationOutcome,
        receipt: &ReceiptRecord,
    ) -> Result<OperationRecord> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        let o = locked_operation(&tx, self.inner.pool, id, operation_id).await?;
        if matches!(o.state.as_str(), "DONE" | "WAIVED_OPERATOR_LOSS") {
            return Err(LedgerError::Conflict("operation_terminal"));
        }
        let (charge, observed, loss, state, reason) = match outcome {
            OperationOutcome::NotDispatched => {
                if o.state != "RESERVED" {
                    return Err(LedgerError::Conflict("operation_may_have_dispatched"));
                }
                (0, Some(0), 0, "DONE", "not_dispatched")
            }
            OperationOutcome::Metered { observed_nano } => {
                check_nano(observed_nano)?;
                if !matches!(
                    o.state.as_str(),
                    "DISPATCHING" | "STREAMING" | "USAGE_UNKNOWN"
                ) {
                    return Err(LedgerError::Conflict("operation_not_dispatched"));
                }
                let c = observed_nano.min(o.reservation_nano);
                (c, Some(observed_nano), observed_nano - c, "DONE", "metered")
            }
            OperationOutcome::UnknownWaived => {
                if o.state != "USAGE_UNKNOWN" {
                    return Err(LedgerError::Conflict("operation_not_unknown"));
                }
                (0, None, 0, "WAIVED_OPERATOR_LOSS", "waived_unknown")
            }
        };
        if o.state!="RESERVED" && tx.query_one("SELECT EXISTS(SELECT 1 FROM dispatch_attempts WHERE pool=$1 AND request_id=$2 AND operation_id=$3 AND finished_at IS NULL AND fenced_at IS NULL)",&[&&self.inner.pool[..],&id,&operation_id]).await?.get::<_,bool>(0){return Err(LedgerError::Conflict("dispatch_not_quiesced"));}
        validate_receipt(
            receipt,
            self.inner.pool,
            id,
            Some(operation_id),
            charge,
            o.reservation_nano,
            observed,
            if observed.is_some() { Some(loss) } else { None },
            reason,
        )?;
        if matches!(outcome, OperationOutcome::Metered { .. }) {
            tx.execute("UPDATE operations SET state='METERED' WHERE pool=$1 AND request_id=$2 AND operation_id=$3",&[&&self.inner.pool[..],&id,&operation_id]).await?;
        }
        let charge_s = charge.to_string();
        let observed_s = observed.map(|v| v.to_string());
        let loss_s = loss.to_string();
        let reservation_s = o.reservation_nano.to_string();
        tx.execute("UPDATE operations SET state=$4,charged_nano=$5::text::numeric,observed_cost_nano=$6::text::numeric,operator_loss_nano=$7::text::numeric WHERE pool=$1 AND request_id=$2 AND operation_id=$3",&[&&self.inner.pool[..],&id,&operation_id,&state,&charge_s,&observed_s,&loss_s]).await?;
        tx.execute("UPDATE sessions SET reserved_nano=reserved_nano-$3::text::numeric,charged_nano=charged_nano+$4::text::numeric,active_operations=active_operations-1,updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id,&reservation_s,&charge_s]).await?;
        insert_receipt(&tx, self.inner.pool, &self.inner.receipt_key, receipt).await?;
        let o = operation_row(
            &tx.query_one(OP_SELECT, &[&&self.inner.pool[..], &id, &operation_id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(o)
    }
    pub async fn reconcile(&self, id: Uuid) -> Result<SessionRecord> {
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if s.state == "RECONCILING" {
            tx.commit().await?;
            return Ok(s);
        }
        if s.state != "DRAINING" || s.mode != "proxy" {
            return Err(LedgerError::Conflict("session_not_reconcilable"));
        }
        let pending:bool=tx.query_one("SELECT EXISTS(SELECT 1 FROM operations WHERE pool=$1 AND request_id=$2 AND state NOT IN ('DONE','WAIVED_OPERATOR_LOSS','USAGE_UNKNOWN'))",&[&&self.inner.pool[..],&id]).await?.get(0);
        if pending {
            return Err(LedgerError::Conflict("operations_pending"));
        }
        tx.execute("UPDATE sessions SET state='RECONCILING',updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2 AND state='DRAINING'",&[&&self.inner.pool[..],&id]).await?;
        let s = session_row(
            &tx.query_one(SESSION_SELECT, &[&&self.inner.pool[..], &id])
                .await?,
        )?;
        tx.commit().await?;
        Ok(s)
    }
    pub async fn prepare_settlement(
        &self,
        id: Uuid,
        target: &SettlementTarget,
    ) -> Result<SettlementRecord> {
        if Sha256::digest(target.signature_message).as_slice() != target.message_digest {
            return Err(LedgerError::Invalid("message_digest_mismatch"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, id).await?;
        if let Some(r) = tx
            .query_opt(
                "SELECT * FROM settlements WHERE pool=$1 AND request_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?
        {
            let stored = settlement_row(&r)?;
            if stored.target != *target {
                return Err(LedgerError::Conflict("settlement_target_conflict"));
            }
            tx.commit().await?;
            return Ok(stored);
        }
        let charge = i64::try_from(target.charge_micro)
            .map_err(|_| LedgerError::Invalid("invalid_charge"))?;
        tx.execute("INSERT INTO settlements(pool,request_id,charge_micro,next_anchor,next_commitment_x,next_commitment_y,blind_delta,anchor_randomness,signature_message,message_digest) VALUES($1::bytea,$2,$3::bigint,$4::bytea,$5::bytea,$6::bytea,$7::bytea,$8::bytea,$9,$10::bytea)",&[&&self.inner.pool[..],&id,&charge,&&target.next_anchor[..],&&target.next_commitment_x[..],&&target.next_commitment_y[..],&&target.blind_delta[..],&&target.anchor_randomness[..],&&target.signature_message[..],&&target.message_digest[..]]).await?;
        let changed=tx.execute("UPDATE sessions SET state='SIGN_PENDING',updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2 AND state='RECONCILING'",&[&&self.inner.pool[..],&id]).await?;
        if changed != 1 {
            return Err(LedgerError::Conflict("session_not_reconciling"));
        }
        let r = settlement_row(
            &tx.query_one(
                "SELECT * FROM settlements WHERE pool=$1 AND request_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn settlement(&self, id: Uuid) -> Result<SettlementRecord> {
        self.check_health()?;
        let c = self.inner.client.lock().await;
        settlement_row(
            &c.query_opt(
                "SELECT * FROM settlements WHERE pool=$1 AND request_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?
            .ok_or(LedgerError::NotFound)?,
        )
    }
    /// Caller verifies the role-pinned Baby-JubJub signature before calling this method.
    pub async fn save_settlement_signature(
        &self,
        id: Uuid,
        signature: &[u8],
    ) -> Result<SettlementRecord> {
        if signature.len() != 96 {
            return Err(LedgerError::Invalid("invalid_signature_length"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        let s = locked_session(&tx, self.inner.pool, id).await?;
        if !matches!(s.state.as_str(), "SIGN_PENDING" | "SETTLED") {
            return Err(LedgerError::Conflict("session_not_sign_pending"));
        }
        let r = settlement_row(
            &tx.query_one(
                "SELECT * FROM settlements WHERE pool=$1 AND request_id=$2 FOR UPDATE",
                &[&&self.inner.pool[..], &id],
            )
            .await?,
        )?;
        if let Some(old) = &r.state_signature {
            if old != signature {
                return Err(LedgerError::Conflict("signature_conflict"));
            }
            tx.commit().await?;
            return Ok(r);
        }
        tx.execute("UPDATE settlements SET state_signature=$3,signed_at=clock_timestamp() WHERE pool=$1 AND request_id=$2",&[&&self.inner.pool[..],&id,&signature]).await?;
        tx.execute("UPDATE sessions SET state='SETTLED',updated_at=clock_timestamp() WHERE pool=$1 AND request_id=$2 AND state='SIGN_PENDING'",&[&&self.inner.pool[..],&id]).await?;
        let r = settlement_row(
            &tx.query_one(
                "SELECT * FROM settlements WHERE pool=$1 AND request_id=$2",
                &[&&self.inner.pool[..], &id],
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(r)
    }
    /// Cursor belongs to this session, and never skips an unsigned predecessor.
    pub async fn receipts(
        &self,
        id: Uuid,
        after: Option<i64>,
        limit: i64,
    ) -> Result<Vec<ReceiptRecord>> {
        if !(1..=100).contains(&limit) {
            return Err(LedgerError::Invalid("invalid_receipt_limit"));
        }
        self.check_health()?;
        let c = self.inner.client.lock().await;
        let cursor = after.unwrap_or(0);
        if after.is_some() {
            let valid:bool=c.query_one("SELECT EXISTS(SELECT 1 FROM receipts WHERE pool=$1 AND request_id=$2 AND sequence=$3 AND signature IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM receipts WHERE pool=$1 AND request_id=$2 AND sequence<=$3 AND signature IS NULL)",&[&&self.inner.pool[..],&id,&cursor]).await?.get(0);
            if !valid {
                return Err(LedgerError::Invalid("invalid_receipt_cursor"));
            }
        }
        c.query("SELECT * FROM receipts WHERE pool=$1 AND request_id=$2 AND sequence>$3 AND signature IS NOT NULL AND sequence<COALESCE((SELECT min(sequence) FROM receipts WHERE pool=$1 AND request_id=$2 AND signature IS NULL),9223372036854775807) ORDER BY sequence LIMIT $4",&[&&self.inner.pool[..],&id,&cursor,&limit]).await?.iter().map(receipt_row).collect()
    }
    /// Late provider observations append an operator-only receipt; settled financial state stays fixed.
    pub async fn append_late_loss_receipt(&self, receipt: &ReceiptRecord) -> Result<()> {
        if receipt.billing_effect != "late_loss_observation" {
            return Err(LedgerError::Invalid("invalid_billing_effect"));
        }
        let mut c = self.inner.client.lock().await;
        let tx = c.transaction().await?;
        self.lock_pool(&tx).await?;
        locked_session(&tx, self.inner.pool, receipt.request_id).await?;
        let body: Value = serde_json::from_slice(&receipt.canonical_body)
            .map_err(|_| LedgerError::Invalid("invalid_receipt"))?;
        let related = body
            .get("related_receipt_hash")
            .and_then(Value::as_str)
            .ok_or(LedgerError::Invalid("missing_related_receipt"))?;
        let related =
            hex::decode(related).map_err(|_| LedgerError::Invalid("invalid_related_receipt"))?;
        if body.get("charged_nano_usdc").and_then(Value::as_str)!=Some("0") || tx.query_opt("SELECT 1 FROM receipts WHERE pool=$1 AND request_id=$2 AND receipt_hash=$3 AND operation_id IS NOT DISTINCT FROM $4 AND billing_effect='charge' AND signature IS NOT NULL",&[&&self.inner.pool[..],&receipt.request_id,&related,&receipt.operation_id]).await?.is_none(){return Err(LedgerError::Invalid("invalid_late_receipt"));}
        insert_receipt(&tx, self.inner.pool, &self.inner.receipt_key, receipt).await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn locked_session(tx: &Transaction<'_>, pool: Hash, id: Uuid) -> Result<SessionRecord> {
    session_row(
        &tx.query_opt(
            &(SESSION_SELECT.to_owned() + " FOR UPDATE"),
            &[&&pool[..], &id],
        )
        .await?
        .ok_or(LedgerError::NotFound)?,
    )
}
async fn locked_operation(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    op: Uuid,
) -> Result<OperationRecord> {
    operation_row(
        &tx.query_opt(
            &(OP_SELECT.to_owned() + " FOR UPDATE"),
            &[&&pool[..], &id, &op],
        )
        .await?
        .ok_or(LedgerError::NotFound)?,
    )
}
async fn require_active(tx: &Transaction<'_>, s: &SessionRecord, accepting: bool) -> Result<()> {
    let now: i64 = tx
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await?
        .get(0);
    if !accepting
        || s.state != "ACTIVE"
        || s.close_requested
        || s.expires_at.is_none_or(|expiry| now >= expiry)
    {
        return Err(LedgerError::Conflict("session_closed_or_expired"));
    }
    Ok(())
}
fn check_nano(v: u128) -> Result<()> {
    if v > MAX_NANO {
        Err(LedgerError::Invalid("amount_overflow"))
    } else {
        Ok(())
    }
}
fn bytes(row: &Row, key: &str) -> Result<Hash> {
    row.get::<_, Vec<u8>>(key)
        .try_into()
        .map_err(|_| LedgerError::Invalid("invalid_stored_field"))
}
fn amount(row: &Row, key: &str) -> Result<u128> {
    row.get::<_, String>(key)
        .parse()
        .map_err(|_| LedgerError::Invalid("invalid_stored_amount"))
}
/// The recovery journal only admits normalized, bounded accounting fields. It
/// cannot become an accidental storage route for provider responses or keys.
fn validate_direct_checkpoint(s: &SessionRecord, checkpoint: &Value) -> Result<()> {
    let invalid = || LedgerError::Invalid("invalid_direct_checkpoint");
    // deny_unknown_fields on every nested type excludes payloads and plaintext keys.
    let checkpoint: crate::direct::Checkpoint =
        serde_json::from_value(checkpoint.clone()).map_err(|_| invalid())?;
    checkpoint.intent.validate().map_err(|_| invalid())?;
    if checkpoint.intent.request_id != s.request_id || checkpoint.intent.cap_micro != s.cap_micro {
        return Err(invalid());
    }
    if let Some(reference) = &checkpoint.reference {
        if reference.key_ref.is_empty()
            || reference.key_ref.len() > 256
            || reference.key_ref.chars().any(char::is_control)
            || reference.station_id.as_ref().is_some_and(|station| {
                station.is_empty() || station.len() > 128 || station.chars().any(char::is_control)
            })
        {
            return Err(invalid());
        }
        if s.provider_key_ref
            .as_ref()
            .is_some_and(|saved| saved != &reference.key_ref)
        {
            return Err(LedgerError::Conflict("direct_key_reference_conflict"));
        }
    }
    if checkpoint.disabled_at.is_some() && checkpoint.reference.is_none() {
        return Err(invalid());
    }
    if checkpoint.deleted && checkpoint.usage.is_none() {
        return Err(invalid());
    }
    for usage in checkpoint.usage.iter().chain(
        checkpoint
            .observation
            .iter()
            .map(|observation| &observation.usage),
    ) {
        if checkpoint.disabled_at.is_none()
            || checkpoint
                .reference
                .as_ref()
                .is_none_or(|reference| reference.key_ref != usage.key_ref)
        {
            return Err(invalid());
        }
        let normalized = crate::quote::direct_charge(
            &[&usage.provider_reported_usd],
            zkapi_solana_types::MicroUsdc::new(s.cap_micro).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        if normalized.normalized_usd != usage.provider_reported_usd
            || normalized.observed_nano.to_string() != usage.observed_nano
        {
            return Err(invalid());
        }
        if !matches!(
            (s.provider.as_str(), usage.evidence_kind.as_str()),
            ("oa", "OA_SIGNED_RECEIPT") | ("openrouter", "OPENROUTER_USAGE")
        ) {
            return Err(invalid());
        }
        crate::wire::hash(&usage.evidence_digest).map_err(|_| invalid())?;
    }
    Ok(())
}

fn session_row(r: &Row) -> Result<SessionRecord> {
    Ok(SessionRecord {
        request_id: r.get("request_id"),
        nullifier: bytes(r, "nullifier")?,
        quote_id: r.get("quote_id"),
        request_digest: bytes(r, "request_digest")?,
        request_transcript: r.get("request_transcript"),
        control_secret_hash: bytes(r, "control_secret_hash")?,
        proxy_secret_hash: r
            .get::<_, Option<Vec<u8>>>("proxy_secret_hash")
            .map(|v| {
                v.try_into()
                    .map_err(|_| LedgerError::Invalid("invalid_stored_field"))
            })
            .transpose()?,
        mode: r.get("mode"),
        provider: r.get("provider"),
        state: r.get("state"),
        close_requested: r.get("close_requested"),
        cap_micro: r.get::<_, i64>("cap_micro") as u64,
        charged_nano: amount(r, "charged_text")?,
        reserved_nano: amount(r, "reserved_text")?,
        active_operations: r.get("active_operations"),
        max_concurrency: r.get("max_concurrency"),
        activated_at: r.get("activated_at"),
        expires_at: r.get("expires_at"),
        provider_key_ref: r.get("provider_key_ref"),
        writer_epoch: r.get("writer_epoch"),
    })
}
fn operation_row(r: &Row) -> Result<OperationRecord> {
    Ok(OperationRecord {
        request_id: r.get("request_id"),
        operation_id: r.get("operation_id"),
        request_hmac: bytes(r, "request_hmac")?,
        endpoint: r.get("endpoint"),
        model: r.get("model"),
        state: r.get("state"),
        reservation_nano: amount(r, "reservation_text")?,
        charged_nano: amount(r, "charged_text")?,
        observed_cost_nano: r
            .get::<_, Option<String>>("observed_text")
            .map(|v| {
                v.parse()
                    .map_err(|_| LedgerError::Invalid("invalid_stored_amount"))
            })
            .transpose()?,
        operator_loss_nano: amount(r, "loss_text")?,
        provider_request_id: r.get("provider_request_id"),
        dispatched_at: r.get("dispatched_at"),
        reconcile_deadline: r.get("reconcile_deadline"),
    })
}
fn receipt_row(r: &Row) -> Result<ReceiptRecord> {
    Ok(ReceiptRecord {
        sequence: r.get("sequence"),
        receipt_id: r.get("receipt_id"),
        request_id: r.get("request_id"),
        operation_id: r.get("operation_id"),
        billing_effect: r.get("billing_effect"),
        canonical_body: r.get("canonical_body"),
        receipt_hash: bytes(r, "receipt_hash")?,
        signature: r.get("signature"),
    })
}
fn clearance_row(r: &Row) -> Result<ClearanceRecord> {
    Ok(ClearanceRecord {
        nullifier: bytes(r, "nullifier")?,
        signature_message: bytes(r, "signature_message")?,
        message_digest: bytes(r, "message_digest")?,
        signature: r.get("signature"),
    })
}
fn settlement_row(r: &Row) -> Result<SettlementRecord> {
    Ok(SettlementRecord {
        request_id: r.get("request_id"),
        target: SettlementTarget {
            charge_micro: r.get::<_, i64>("charge_micro") as u64,
            next_anchor: bytes(r, "next_anchor")?,
            next_commitment_x: bytes(r, "next_commitment_x")?,
            next_commitment_y: bytes(r, "next_commitment_y")?,
            blind_delta: bytes(r, "blind_delta")?,
            anchor_randomness: bytes(r, "anchor_randomness")?,
            signature_message: bytes(r, "signature_message")?,
            message_digest: bytes(r, "message_digest")?,
        },
        state_signature: r.get("state_signature"),
    })
}
fn validate_generic_operation(
    body: &crate::wire::QuoteBody,
    tariff: &crate::wire::Tariff,
    operation: &NewOperation,
) -> Result<()> {
    crate::quote::quote_body_valid(body)
        .map_err(|_| LedgerError::Invalid("invalid_saved_quote"))?;
    crate::quote::validate_tariff(tariff)
        .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
    if body.provider != crate::wire::Provider::Generic
        || body.mode != crate::wire::Mode::Proxy
        || body.tariff_hash != tariff.tariff_hash
        || !crate::quote::quote_matches_tariff(body, tariff)
        || !operation.model.is_empty()
        || body
            .api
            .as_ref()
            .is_none_or(|api| operation.endpoint != crate::wire::api_path(api))
        || operation.reservation_nano
            != u128::from(
                crate::wire::uint(&tariff.rates[0].nano_usdc_numerator)
                    .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?,
            )
    {
        return Err(LedgerError::Invalid("generic_operation_scope_mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod generic_scope_tests {
    use super::*;
    use crate::wire::{ApiBinding, Mode, Provider, QuoteBody, Rate, Tariff};

    #[test]
    fn reservations_require_the_exact_frozen_generic_operation_and_price() {
        let api = ApiBinding {
            version: "1".into(),
            service: "catalog".into(),
            operation: "lookup".into(),
            method: "POST".into(),
            path: "/lookup".into(),
            origin: "http://127.0.0.1:9090".into(),
            request_max_bytes: "1024".into(),
            response_max_bytes: "1024".into(),
            timeout_seconds: "10".into(),
            billing: "http_2xx_json".into(),
        };
        let mut tariff = Tariff {
            tariff_hash: String::new(),
            version: "2".into(),
            provider: Provider::Generic,
            model: String::new(),
            api: Some(api.clone()),
            pricing_basis: "fixed_request".into(),
            valid_from: "1".into(),
            valid_until: "4000000000".into(),
            rates: vec![Rate {
                unit: "requests".into(),
                nano_usdc_numerator: "7000".into(),
                unit_denominator: "1".into(),
            }],
            operator_fee_micro_usdc: "0".into(),
        };
        tariff.tariff_hash = crate::quote::tariff_hash(&tariff).unwrap();
        let quote = QuoteBody {
            quote_id: Uuid::new_v4().to_string(),
            deployment_id: "local-test".into(),
            pool: bs58::encode([2; 32]).into_string(),
            mode: Mode::Proxy,
            provider: Provider::Generic,
            models: vec![],
            api: Some(api.clone()),
            tariff_hash: tariff.tariff_hash.clone(),
            cap_micro_usdc: zkapi_solana_types::MicroUsdc::new(1_000_000).unwrap(),
            issued_at: "100".into(),
            expires_at: "220".into(),
            session_ttl_seconds: "60".into(),
            max_concurrency: "4".into(),
            control_api_origin: "http://127.0.0.1:8788".into(),
            inference_api_origin: "http://127.0.0.1:8789".into(),
        };
        let mut operation = NewOperation {
            request_id: Uuid::new_v4(),
            operation_id: Uuid::new_v4(),
            request_hmac: [9; 32],
            endpoint: crate::wire::api_path(&api),
            model: String::new(),
            reservation_nano: 7000,
        };
        validate_generic_operation(&quote, &tariff, &operation).unwrap();
        for endpoint in [
            "/zkapi/v1/api/catalog/other",
            "/zkapi/v1/api/other/lookup",
            "/v1/chat/completions",
        ] {
            operation.endpoint = endpoint.into();
            assert!(validate_generic_operation(&quote, &tariff, &operation).is_err());
        }
        operation.endpoint = crate::wire::api_path(&api);
        operation.model = "pretend-model".into();
        assert!(validate_generic_operation(&quote, &tariff, &operation).is_err());
        operation.model.clear();
        for amount in [0, 6999, 7001] {
            operation.reservation_nano = amount;
            assert!(validate_generic_operation(&quote, &tariff, &operation).is_err());
        }
        operation.reservation_nano = 7000;
        let mut changed = quote.clone();
        changed.api.as_mut().unwrap().path = "/other".into();
        assert!(validate_generic_operation(&changed, &tariff, &operation).is_err());
        let mut changed = tariff.clone();
        changed.api.as_mut().unwrap().origin = "http://127.0.0.1:9091".into();
        changed.tariff_hash = crate::quote::tariff_hash(&changed).unwrap();
        assert!(validate_generic_operation(&quote, &changed, &operation).is_err());
    }
}

async fn insert_receipt(
    tx: &Transaction<'_>,
    pool: Hash,
    key: &VerifyingKey,
    r: &ReceiptRecord,
) -> Result<()> {
    if r.signature.as_ref().is_none_or(|s| s.len() != 64)
        || Sha256::digest(&r.canonical_body).as_slice() != r.receipt_hash
    {
        return Err(LedgerError::Invalid("invalid_receipt_signature_or_hash"));
    }
    let body: crate::receipts::ReceiptBody = serde_json::from_slice(&r.canonical_body)
        .map_err(|_| LedgerError::Invalid("invalid_receipt_body"))?;
    if body
        .canonical_bytes()
        .map_err(|_| LedgerError::Invalid("invalid_receipt_body"))?
        != r.canonical_body
    {
        return Err(LedgerError::Invalid("noncanonical_receipt_body"));
    }
    if body.receipt_id != r.receipt_id.to_string()
        || body.pool != bs58::encode(pool).into_string()
        || body.request_id != r.request_id.to_string()
        || body.operation_id != r.operation_id.map(|v| v.to_string())
        || body.billing_effect != r.billing_effect
    {
        return Err(LedgerError::Invalid("receipt_identity_mismatch"));
    }
    let identity=tx.query_one("SELECT p.deployment_id,q.tariff_hash,t.canonical_body,s.provider,s.mode,s.cap_micro,o.model,o.endpoint FROM pools p JOIN sessions s ON s.pool=p.pool JOIN quotes q ON q.pool=s.pool AND q.quote_id=s.quote_id JOIN tariffs t ON t.tariff_hash=q.tariff_hash LEFT JOIN operations o ON o.pool=s.pool AND o.request_id=s.request_id AND o.operation_id=$3 WHERE p.pool=$1 AND s.request_id=$2",&[&&pool[..],&r.request_id,&r.operation_id]).await?;
    if body.deployment_id != identity.get::<_, String>(0)
        || body.tariff_hash != hex::encode(identity.get::<_, Vec<u8>>(1))
    {
        return Err(LedgerError::Invalid("receipt_quote_mismatch"));
    }
    let tariff_bytes: Vec<u8> = identity.get(2);
    let tariff_hash: Vec<u8> = identity.get(1);
    if Sha256::digest(&tariff_bytes).as_slice() != tariff_hash {
        return Err(LedgerError::Invalid("stored_tariff_digest_mismatch"));
    }
    let mut tariff: Value = serde_json::from_slice(&tariff_bytes)
        .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
    tariff
        .as_object_mut()
        .ok_or(LedgerError::Invalid("invalid_stored_tariff"))?
        .insert(
            "tariff_hash".into(),
            Value::String(hex::encode(&tariff_hash)),
        );
    let tariff: crate::wire::Tariff = serde_json::from_value(tariff)
        .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
    crate::quote::validate_tariff(&tariff)
        .map_err(|_| LedgerError::Invalid("invalid_stored_tariff"))?;
    if tariff.provider.as_str() != identity.get::<_, String>(3) {
        return Err(LedgerError::Invalid("receipt_provider_mismatch"));
    }
    if identity.get::<_, String>(4) == "proxy"
        && tariff.model
            != identity
                .get::<_, Option<String>>(6)
                .ok_or(LedgerError::Invalid("missing_receipt_operation"))?
    {
        return Err(LedgerError::Invalid("receipt_model_mismatch"));
    }
    if let Some(api) = &tariff.api {
        if identity.get::<_, Option<String>>(7).as_deref()
            != Some(crate::wire::api_path(api).as_str())
        {
            return Err(LedgerError::Invalid("receipt_api_scope_mismatch"));
        }
    }
    crate::receipts::validate_tariff_math(&body, &tariff)
        .map_err(|_| LedgerError::Invalid("receipt_tariff_calculation_mismatch"))?;
    key.verify_strict(
        &r.receipt_hash,
        &Signature::from_slice(r.signature.as_ref().unwrap())
            .map_err(|_| LedgerError::Invalid("invalid_receipt_signature"))?,
    )
    .map_err(|_| LedgerError::Invalid("invalid_receipt_signature"))?;
    tx.execute("INSERT INTO receipts(receipt_id,pool,request_id,operation_id,billing_effect,canonical_body,receipt_hash,signature) VALUES($1,$2::bytea,$3,$4,$5,$6,$7::bytea,$8)",&[&r.receipt_id,&&pool[..],&r.request_id,&r.operation_id,&r.billing_effect,&r.canonical_body,&&r.receipt_hash[..],&r.signature]).await?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn validate_receipt(
    r: &ReceiptRecord,
    pool: Hash,
    id: Uuid,
    op: Option<Uuid>,
    charge: u128,
    reservation: u128,
    observed: Option<u128>,
    loss: Option<u128>,
    reason: &str,
) -> Result<()> {
    if r.request_id != id || r.operation_id != op || r.billing_effect != "charge" {
        return Err(LedgerError::Invalid("receipt_identity_mismatch"));
    }
    let b: Value = serde_json::from_slice(&r.canonical_body)
        .map_err(|_| LedgerError::Invalid("invalid_receipt"))?;
    let eq = |key: &str, value: &str| b.get(key).and_then(Value::as_str) == Some(value);
    let opt_eq = |key: &str, value: Option<u128>| match value {
        Some(v) => b.get(key).and_then(Value::as_str) == Some(v.to_string().as_str()),
        None => b.get(key).is_some_and(Value::is_null),
    };
    if !eq("request_id", &id.to_string())
        || !eq("pool", &bs58::encode(pool).into_string())
        || !eq("charged_nano_usdc", &charge.to_string())
        || !eq("reservation_nano_usdc", &reservation.to_string())
        || !eq("reason", reason)
        || !opt_eq("observed_nano_usdc", observed)
        || !opt_eq("operator_loss_nano_usdc", loss)
    {
        return Err(LedgerError::Invalid("receipt_accounting_mismatch"));
    }
    if b.get("operation_id")
        != Some(
            &op.map(|v| Value::String(v.to_string()))
                .unwrap_or(Value::Null),
        )
    {
        return Err(LedgerError::Invalid("receipt_operation_mismatch"));
    }
    Ok(())
}
