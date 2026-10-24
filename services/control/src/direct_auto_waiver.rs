//! Opt-in operator-funded recovery for newly admitted, unknown direct issuance.
//! This policy authorizes an explicit waiver, never a claim of non-issuance.
use crate::{
    direct::Checkpoint,
    direct_waiver::{self, SignedApproval},
    ledger::Hash,
    wire,
};
use anyhow::{ensure, Context, Result};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use uuid::Uuid;

const POLICY_EVENT: &str = "DIRECT_AUTO_WAIVER_POLICY";
const POLICY_DEDUP: &str = "direct-auto-waiver-policy-v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AutoPolicy {
    pub version: String,
    pub applies_to_sessions_created_at_or_after: u64,
    pub grace_seconds: u64,
    pub accepts_all_unknown_provider_costs: bool,
}

impl AutoPolicy {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == "1" && self.accepts_all_unknown_provider_costs,
            "automatic waiver requires explicit operator cost acceptance"
        );
        ensure!(
            (1..253_402_300_000).contains(&self.applies_to_sessions_created_at_or_after),
            "automatic waiver cutoff is invalid"
        );
        ensure!(
            (direct_waiver::MIN_GRACE_SECONDS..=86_400).contains(&self.grace_seconds),
            "automatic waiver grace is invalid"
        );
        Ok(())
    }
    fn metadata(&self) -> Result<Value> {
        self.validate()?;
        Ok(json!({
            "scope": "direct_openrouter_unknown_operator_loss_v1",
            "policy": self,
            "policy_sha256": hex::encode(wire::sha256(&serde_jcs::to_vec(self)?))
        }))
    }
}

/// The sole writer pins one policy before admission. Restarts retain its exact
/// cutoff; turning the feature off does not remove the historical registration.
pub(crate) async fn register(tx: &Transaction<'_>, pool: Hash, policy: &AutoPolicy) -> Result<()> {
    let metadata = policy.metadata()?;
    if let Some(row) = tx
        .query_opt(
            "SELECT event_type,metadata FROM outbox WHERE pool=$1::bytea AND dedup_key=$2",
            &[&&pool[..], &POLICY_DEDUP],
        )
        .await?
    {
        ensure!(
            row.get::<_, String>(0) == POLICY_EVENT && row.get::<_, Value>(1) == metadata,
            "automatic waiver policy is already pinned"
        );
        return Ok(());
    }
    let now: i64 = tx
        .query_one(
            "SELECT ceil(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await?
        .get(0);
    ensure!(
        policy.applies_to_sessions_created_at_or_after >= u64::try_from(now)?,
        "first automatic waiver registration requires a future cutoff"
    );
    let existing_after_cutoff: bool = tx
        .query_one(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE pool=$1::bytea AND created_at>=to_timestamp($2::bigint::double precision))",
            &[&&pool[..], &i64::try_from(policy.applies_to_sessions_created_at_or_after)?],
        )
        .await?
        .get(0);
    ensure!(
        !existing_after_cutoff,
        "automatic waiver cutoff must exclude every existing session"
    );
    tx.execute(
        "INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,$3,$4)",
        &[&&pool[..], &POLICY_DEDUP, &POLICY_EVENT, &metadata],
    )
    .await?;
    Ok(())
}

async fn registered_metadata(
    tx: &Transaction<'_>,
    pool: Hash,
    policy: &AutoPolicy,
) -> Result<Value> {
    let metadata = policy.metadata()?;
    let row = tx
        .query_opt(
            "SELECT event_type,metadata FROM outbox WHERE pool=$1::bytea AND dedup_key=$2",
            &[&&pool[..], &POLICY_DEDUP],
        )
        .await?
        .context("automatic waiver policy is not registered")?;
    ensure!(
        row.get::<_, String>(0) == POLICY_EVENT && row.get::<_, Value>(1) == metadata,
        "automatic waiver policy registration mismatch"
    );
    Ok(metadata)
}

/// A status projection shares the exact eligibility gates with application but
/// does not require the original lease/grace deadline to have elapsed.
async fn covered_checkpoint(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    policy: &AutoPolicy,
) -> Result<Option<Checkpoint>> {
    registered_metadata(tx, pool, policy).await?;
    let cutoff = i64::try_from(policy.applies_to_sessions_created_at_or_after)?;
    let eligible: bool = tx.query_one(
        "SELECT s.mode='direct_openrouter' AND s.provider='openrouter' AND s.state='ISSUANCE_UNKNOWN' AND s.close_requested AND s.created_at>=to_timestamp($3::bigint::double precision) AND s.activated_at IS NULL AND s.expires_at IS NULL AND s.provider_key_ref IS NULL AND s.direct_stop_evidence IS NULL AND s.direct_waiver_evidence IS NULL AND s.charged_nano=0 AND s.reserved_nano=0 AND s.active_operations=0 AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.pool=s.pool AND o.request_id=s.request_id) AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.pool=s.pool AND r.request_id=s.request_id) AND NOT EXISTS(SELECT 1 FROM settlements t WHERE t.pool=s.pool AND t.request_id=s.request_id) AND EXISTS(SELECT 1 FROM dispatch_attempts a WHERE a.pool=s.pool AND a.request_id=s.request_id AND a.send_claimed_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM dispatch_attempts a WHERE a.pool=s.pool AND a.request_id=s.request_id AND (a.kind<>'DIRECT_ISSUANCE' OR a.operation_id IS NOT NULL OR (a.finished_at IS NULL AND a.fenced_at IS NULL))) FROM sessions s WHERE s.pool=$1::bytea AND s.request_id=$2",
        &[&&pool[..], &id, &cutoff],
    ).await?.get(0);
    if !eligible {
        return Ok(None);
    }
    let Some(row) = tx.query_opt(
        "SELECT metadata FROM outbox WHERE pool=$1::bytea AND event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$2 ORDER BY id DESC LIMIT 1",
        &[&&pool[..], &id.to_string()],
    ).await? else {
        return Ok(None);
    };
    let checkpoint: Checkpoint = serde_json::from_value(row.get(0))?;
    if checkpoint.reference.is_some()
        || checkpoint.disabled_at.is_some()
        || checkpoint.observation.is_some()
        || checkpoint.usage.is_some()
        || checkpoint.deleted
    {
        return Ok(None);
    }
    checkpoint.intent.validate()?;
    Ok(Some(checkpoint))
}

pub(crate) async fn covers(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    policy: &AutoPolicy,
) -> Result<bool> {
    if covered_checkpoint(tx, pool, id, policy).await?.is_none() {
        return Ok(false);
    }
    direct_waiver::validate_unknown_session(tx, pool, id).await?;
    Ok(true)
}

/// Called under the same sole-writer transaction that commits the approval.
/// Expected pending conditions return None; malformed evidence fails closed.
pub(crate) async fn prepare(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    policy: &AutoPolicy,
    provider_grace: u64,
    receipt_key: &SigningKey,
) -> Result<Option<SignedApproval>> {
    let Some(checkpoint) = covered_checkpoint(tx, pool, id, policy).await? else {
        return Ok(None);
    };
    let metadata = registered_metadata(tx, pool, policy).await?;
    let grace = policy.grace_seconds.max(provider_grace);
    ensure!(
        grace <= 86_400,
        "automatic waiver provider grace is too long"
    );
    let now: i64 = tx
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await?
        .get(0);
    checkpoint.intent.validate()?;
    if u64::try_from(now)?
        < checkpoint
            .intent
            .expires_at()
            .checked_add(grace)
            .context("automatic waiver expiry overflow")?
    {
        return Ok(None);
    }
    let review = wire::sha256(&serde_jcs::to_vec(&metadata)?);
    let body = direct_waiver::prepare(tx, pool, id, grace, review).await?;
    Ok(Some(SignedApproval::sign(body, receipt_key)?))
}

pub(crate) async fn record_application(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    policy: &AutoPolicy,
    approval: &SignedApproval,
) -> Result<()> {
    let metadata = registered_metadata(tx, pool, policy).await?;
    let review = hex::encode(wire::sha256(&serde_jcs::to_vec(&metadata)?));
    ensure!(
        approval.body.request_id == id && approval.body.review_evidence_sha256 == review,
        "automatic waiver audit binding mismatch"
    );
    tx.execute(
        "INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,'DIRECT_AUTO_WAIVER_APPLIED',$3)",
        &[&&pool[..], &format!("direct-auto-waiver-applied:{id}"), &json!({
            "request_id": id,
            "approval_hash": approval.approval_hash,
            "review_evidence_sha256": review,
            "registered_policy": metadata
        })],
    ).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_requires_explicit_acceptance_bounded_grace_and_cutoff() {
        let valid = AutoPolicy {
            version: "1".into(),
            applies_to_sessions_created_at_or_after: 1_800_000_000,
            grace_seconds: 300,
            accepts_all_unknown_provider_costs: true,
        };
        valid.validate().unwrap();
        for field in [
            "version",
            "applies_to_sessions_created_at_or_after",
            "grace_seconds",
            "accepts_all_unknown_provider_costs",
        ] {
            let mut value = serde_json::to_value(&valid).unwrap();
            value[field] = match field {
                "version" => json!("2"),
                "accepts_all_unknown_provider_costs" => json!(false),
                _ => json!(0),
            };
            let policy: AutoPolicy = serde_json::from_value(value).unwrap();
            assert!(policy.validate().is_err());
        }
        let mut unknown = serde_json::to_value(&valid).unwrap();
        unknown["waive_existing"] = json!(true);
        assert!(serde_json::from_value::<AutoPolicy>(unknown).is_err());
    }
}
