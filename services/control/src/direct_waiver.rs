//! Explicit, signed operator acceptance of unknown direct-provider costs.
//! This is neither provider non-issuance evidence nor proof of zero usage.
use crate::{
    direct::Checkpoint,
    ledger::{Hash, ReceiptRecord},
    receipts::{Receipt, ReceiptBody},
    wire,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_postgres::Transaction;
use uuid::Uuid;

const DOMAIN: &[u8] = b"zkapi-direct-unknown-waiver-v1\0";
pub const MIN_GRACE_SECONDS: u64 = 300;
const MAX_APPROVAL_AGE_SECONDS: u64 = 900;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApprovalBody {
    pub version: String,
    pub action: String,
    pub deployment_id: String,
    pub pool: String,
    pub manifest_hash: String,
    pub request_id: Uuid,
    pub request_digest: String,
    pub checkpoint_hash: String,
    pub attempts_hash: String,
    pub intent_expires_at: u64,
    pub grace_seconds: u64,
    pub approved_at: u64,
    pub review_evidence_sha256: String,
    pub receipt_id: Uuid,
    pub accepts_all_unknown_provider_costs: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedApproval {
    pub body: ApprovalBody,
    pub approval_hash: String,
    pub signature: String,
}
impl SignedApproval {
    /// Administrative approval timestamps are numeric u64 values, unlike the
    /// public control API's string-encoded financial wire fields. Deserialize
    /// directly into the closed typed schema, then require the exact JCS bytes
    /// emitted by planning. Serde rejects duplicate and unknown struct fields.
    pub fn from_canonical_bytes(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= 32768, "approval file too large");
        let approval: Self = serde_json::from_slice(bytes)?;
        validate_body(&approval.body)?;
        ensure!(
            serde_jcs::to_vec(&approval)? == bytes,
            "noncanonical approval file"
        );
        Ok(approval)
    }
    pub fn sign(body: ApprovalBody, key: &SigningKey) -> Result<Self> {
        validate_body(&body)?;
        let hash = wire::sha256(&serde_jcs::to_vec(&body)?);
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&hash);
        Ok(Self {
            body,
            approval_hash: hex::encode(hash),
            signature: STANDARD.encode(key.sign(&message).to_bytes()),
        })
    }
    pub fn verify(&self, key: [u8; 32]) -> Result<Hash> {
        validate_body(&self.body)?;
        let hash = wire::sha256(&serde_jcs::to_vec(&self.body)?);
        ensure!(
            self.approval_hash == hex::encode(hash),
            "approval digest mismatch"
        );
        let raw = STANDARD.decode(&self.signature)?;
        ensure!(
            STANDARD.encode(&raw) == self.signature,
            "approval signature encoding"
        );
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&hash);
        VerifyingKey::from_bytes(&key)?.verify_strict(&message, &Signature::from_slice(&raw)?)?;
        Ok(hash)
    }
}
fn validate_body(b: &ApprovalBody) -> Result<()> {
    ensure!(
        b.version == "1"
            && b.action == "waive_direct_unknown_operator_loss"
            && b.accepts_all_unknown_provider_costs,
        "explicit operator loss approval required"
    );
    ensure!(
        !b.deployment_id.is_empty()
            && b.request_id.get_version_num() == 4
            && b.receipt_id.get_version_num() == 4,
        "approval identity"
    );
    for h in [
        &b.pool,
        &b.manifest_hash,
        &b.request_digest,
        &b.checkpoint_hash,
        &b.attempts_hash,
        &b.review_evidence_sha256,
    ] {
        wire::hash(h)?;
    }
    ensure!(
        (MIN_GRACE_SECONDS..=86_400).contains(&b.grace_seconds),
        "approval grace"
    );
    ensure!(
        b.approved_at
            >= b.intent_expires_at
                .checked_add(b.grace_seconds)
                .context("approval time overflow")?,
        "original lease and grace have not expired"
    );
    Ok(())
}

struct Snapshot {
    deployment: String,
    manifest: Vec<u8>,
    request_digest: Vec<u8>,
    checkpoint_hash: Hash,
    attempts_hash: Hash,
    intent_expires_at: u64,
    now: u64,
    cap_micro: u64,
    tariff_hash: Vec<u8>,
}
async fn snapshot(tx: &Transaction<'_>, pool: Hash, id: Uuid, finalized: bool) -> Result<Snapshot> {
    let row = tx.query_one("SELECT s.*,s.charged_nano::text AS charge,s.reserved_nano::text AS reserve,p.deployment_id,p.manifest_hash,q.tariff_hash,floor(extract(epoch FROM clock_timestamp()))::bigint AS current_second FROM sessions s JOIN pools p USING(pool) JOIN quotes q ON q.pool=s.pool AND q.quote_id=s.quote_id WHERE s.pool=$1::bytea AND s.request_id=$2", &[&&pool[..],&id]).await?;
    let state: String = row.get("state");
    ensure!(
        if finalized {
            matches!(state.as_str(), "RECONCILING" | "SIGN_PENDING" | "SETTLED")
        } else {
            state == "ISSUANCE_UNKNOWN"
        },
        "waiver state unavailable"
    );
    ensure!(
        row.get::<_, String>("mode") == "direct_openrouter"
            && row.get::<_, String>("provider") == "openrouter"
            && row.get::<_, bool>("close_requested"),
        "waiver requires closed OpenRouter direct session"
    );
    ensure!(
        row.get::<_, Option<i64>>("activated_at").is_none()
            && row.get::<_, Option<i64>>("expires_at").is_none()
            && row.get::<_, Option<String>>("provider_key_ref").is_none()
            && row
                .get::<_, Option<Vec<u8>>>("direct_stop_evidence")
                .is_none(),
        "waiver cannot replace known issuance or stopping evidence"
    );
    ensure!(
        row.get::<_, String>("charge") == "0"
            && row.get::<_, String>("reserve") == "0"
            && row.get::<_, i16>("active_operations") == 0
            && row.get::<_, Option<Vec<u8>>>("proxy_secret_hash").is_none(),
        "waiver accounting unavailable"
    );
    let digest: Vec<u8> = row.get("request_digest");
    ensure!(
        digest == wire::sha256(&row.get::<_, Vec<u8>>("request_transcript")),
        "accepted authorization digest mismatch"
    );
    let accepted: wire::SessionCreate =
        wire::strict_parse(&row.get::<_, Vec<u8>>("request_transcript"))?;
    ensure!(
        accepted.authorization.request_id == id.to_string()
            && accepted.authorization.mode == wire::Mode::DirectOpenrouter
            && accepted.authorization.pool == bs58::encode(pool).into_string()
            && accepted.authorization.deployment_id == row.get::<_, String>("deployment_id")
            && accepted.authorization.proxy_secret_hash.is_none()
            && accepted.quote.body.mode == wire::Mode::DirectOpenrouter
            && accepted.quote.body.provider == wire::Provider::Openrouter
            && accepted.quote.body.quote_id == row.get::<_, Uuid>("quote_id").to_string()
            && accepted.quote.body.cap_micro_usdc.get() == row.get::<_, i64>("cap_micro") as u64,
        "accepted direct authorization identity mismatch"
    );
    let reservation: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM nullifier_reservations r JOIN sessions s ON s.pool=r.pool AND s.nullifier=r.nullifier WHERE s.pool=$1::bytea AND s.request_id=$2 AND r.kind='AUTH')", &[&&pool[..],&id]).await?.get(0);
    ensure!(reservation, "original AUTH reservation missing");
    let ops: i64 = tx
        .query_one(
            "SELECT count(*) FROM operations WHERE pool=$1::bytea AND request_id=$2",
            &[&&pool[..], &id],
        )
        .await?
        .get(0);
    ensure!(ops == 0, "direct waiver cannot cover operations");
    if !finalized {
        let unavailable: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM receipts WHERE pool=$1::bytea AND request_id=$2) OR EXISTS(SELECT 1 FROM settlements WHERE pool=$1::bytea AND request_id=$2) OR EXISTS(SELECT 1 FROM direct_unknown_waivers WHERE pool=$1::bytea AND request_id=$2)", &[&&pool[..],&id]).await?.get(0);
        ensure!(
            !unavailable
                && row
                    .get::<_, Option<Vec<u8>>>("direct_waiver_evidence")
                    .is_none(),
            "waiver already finalized"
        );
    }
    let checkpoint: Value = tx.query_one("SELECT metadata FROM outbox WHERE pool=$1::bytea AND event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$2 ORDER BY id DESC LIMIT 1", &[&&pool[..],&id.to_string()]).await?.get(0);
    let cp: Checkpoint = serde_json::from_value(checkpoint.clone())?;
    cp.intent.validate()?;
    let cap_micro = u64::try_from(row.get::<_, i64>("cap_micro"))?;
    ensure!(
        cp.intent.request_id == id
            && cp.intent.cap_micro == cap_micro
            && cp.intent.ttl_seconds == wire::uint(&accepted.quote.body.session_ttl_seconds)?
            && cp.reference.is_none()
            && cp.disabled_at.is_none()
            && cp.observation.is_none()
            && cp.usage.is_none()
            && !cp.deleted,
        "waiver requires unchanged unknown issuance checkpoint"
    );
    // Epoch numeric values avoid connection timezone affecting the approval digest.
    let attempts: Value = tx.query_one("SELECT coalesce(jsonb_agg((to_jsonb(a)-'committed_at'-'send_claimed_at'-'finished_at'-'fenced_at') || jsonb_build_object('committed_at',extract(epoch FROM a.committed_at)::text,'send_claimed_at',extract(epoch FROM a.send_claimed_at)::text,'finished_at',extract(epoch FROM a.finished_at)::text,'fenced_at',extract(epoch FROM a.fenced_at)::text) ORDER BY a.attempt_id),'[]') FROM dispatch_attempts a WHERE pool=$1::bytea AND request_id=$2", &[&&pool[..],&id]).await?.get(0);
    let all = attempts.as_array().context("attempt inventory")?;
    ensure!(
        !all.is_empty()
            && all.iter().all(|a| a["kind"] == "DIRECT_ISSUANCE"
                && a["operation_id"].is_null()
                && ((!a["finished_at"].is_null() && !a["finish_evidence_digest"].is_null())
                    || (!a["fenced_at"].is_null() && !a["fence_evidence_digest"].is_null()))),
        "original issuance attempts must be quiesced"
    );
    Ok(Snapshot {
        deployment: row.get("deployment_id"),
        manifest: row.get("manifest_hash"),
        request_digest: digest,
        checkpoint_hash: wire::sha256(&serde_jcs::to_vec(&checkpoint)?),
        attempts_hash: wire::sha256(&serde_jcs::to_vec(&attempts)?),
        intent_expires_at: cp.intent.expires_at(),
        now: u64::try_from(row.get::<_, i64>("current_second"))?,
        cap_micro,
        tariff_hash: row.get("tariff_hash"),
    })
}
fn bind(b: &ApprovalBody, s: &Snapshot, pool: Hash, id: Uuid) -> Result<()> {
    ensure!(
        b.pool == hex::encode(pool)
            && b.request_id == id
            && b.deployment_id == s.deployment
            && b.manifest_hash == hex::encode(&s.manifest)
            && b.request_digest == hex::encode(&s.request_digest)
            && b.checkpoint_hash == hex::encode(s.checkpoint_hash)
            && b.attempts_hash == hex::encode(s.attempts_hash)
            && b.intent_expires_at == s.intent_expires_at,
        "approval no longer matches original evidence"
    );
    ensure!(
        s.now
            >= b.intent_expires_at
                .checked_add(b.grace_seconds)
                .context("expiry overflow")?,
        "lease and grace unavailable"
    );
    Ok(())
}
/// Read-only eligibility validation without asserting that a lease/grace deadline
/// has passed. Used only for prospective automatic-recovery status projection.
pub(crate) async fn validate_unknown_session(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
) -> Result<()> {
    snapshot(tx, pool, id, false).await?;
    Ok(())
}
/// Read-only plan. The caller signs after private review or an explicitly pinned
/// prospective operator-loss policy has checked this session's eligibility.
pub async fn prepare(
    tx: &Transaction<'_>,
    pool: Hash,
    id: Uuid,
    grace_seconds: u64,
    review_evidence_sha256: Hash,
) -> Result<ApprovalBody> {
    let s = snapshot(tx, pool, id, false).await?;
    let b = ApprovalBody {
        version: "1".into(),
        action: "waive_direct_unknown_operator_loss".into(),
        deployment_id: s.deployment.clone(),
        pool: hex::encode(pool),
        manifest_hash: hex::encode(&s.manifest),
        request_id: id,
        request_digest: hex::encode(&s.request_digest),
        checkpoint_hash: hex::encode(s.checkpoint_hash),
        attempts_hash: hex::encode(s.attempts_hash),
        intent_expires_at: s.intent_expires_at,
        grace_seconds,
        approved_at: s.now,
        review_evidence_sha256: hex::encode(review_evidence_sha256),
        receipt_id: Uuid::new_v4(),
        accepts_all_unknown_provider_costs: true,
    };
    validate_body(&b)?;
    bind(&b, &s, pool, id)?;
    Ok(b)
}
/// Called inside the sole-writer transaction before any financial mutation.
pub(crate) async fn validate_new(
    tx: &Transaction<'_>,
    pool: Hash,
    approval: &SignedApproval,
    key: [u8; 32],
) -> Result<()> {
    approval.verify(key)?;
    let s = snapshot(tx, pool, approval.body.request_id, false).await?;
    bind(&approval.body, &s, pool, approval.body.request_id)?;
    ensure!(
        approval.body.approved_at <= s.now
            && s.now - approval.body.approved_at <= MAX_APPROVAL_AGE_SECONDS,
        "approval must be reviewed and applied within 15 minutes"
    );
    Ok(())
}
/// Independently re-check the stored signed approval and original ledger evidence.
/// Freshness is measured at original application, so restarts remain idempotent.
pub async fn load_and_verify(
    tx: &Transaction<'_>,
    receipt_key: [u8; 32],
    pool: Hash,
    request_id: Uuid,
    expected_evidence: Hash,
) -> Result<ApprovalBody> {
    let r=tx.query_one("SELECT w.*,floor(extract(epoch FROM w.created_at))::bigint AS applied_at,s.direct_waiver_evidence FROM direct_unknown_waivers w JOIN sessions s USING(pool,request_id) WHERE w.pool=$1::bytea AND w.request_id=$2", &[&&pool[..],&request_id]).await?;
    let bytes: Vec<u8> = r.get("approval_body");
    let body: ApprovalBody = serde_json::from_slice(&bytes)?;
    ensure!(
        serde_jcs::to_vec(&body)? == bytes,
        "noncanonical stored approval"
    );
    let signature: Vec<u8> = r.get("approval_signature");
    let approval = SignedApproval {
        body,
        approval_hash: hex::encode(r.get::<_, Vec<u8>>("approval_hash")),
        signature: STANDARD.encode(signature),
    };
    ensure!(
        approval.verify(receipt_key)? == expected_evidence
            && r.get::<_, Option<Vec<u8>>>("direct_waiver_evidence")
                .as_deref()
                == Some(&expected_evidence[..])
            && r.get::<_, Uuid>("receipt_id") == approval.body.receipt_id,
        "waiver link mismatch"
    );
    let applied = u64::try_from(r.get::<_, i64>("applied_at"))?;
    ensure!(
        approval.body.approved_at <= applied
            && applied - approval.body.approved_at <= MAX_APPROVAL_AGE_SECONDS,
        "approval application time mismatch"
    );
    let s = snapshot(tx, pool, request_id, true).await?;
    bind(&approval.body, &s, pool, request_id)?;
    Ok(approval.body)
}
/// The receipt keeps observed cost and operator loss unknown; only user charge is zero.
pub async fn receipt(
    tx: &Transaction<'_>,
    pool: Hash,
    approval: &SignedApproval,
    key: &SigningKey,
) -> Result<ReceiptRecord> {
    let s = snapshot(tx, pool, approval.body.request_id, false).await?;
    let body = ReceiptBody {
        gateway: None,
        version: "1".into(),
        receipt_id: approval.body.receipt_id.to_string(),
        deployment_id: s.deployment,
        pool: bs58::encode(pool).into_string(),
        request_id: approval.body.request_id.to_string(),
        operation_id: None,
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: approval.body.approved_at.to_string(),
        evidence_kind: "UNKNOWN_OPERATOR_LOSS".into(),
        provider_request_id: None,
        provider_evidence_digest: Some(approval.approval_hash.clone()),
        tariff_hash: hex::encode(s.tariff_hash),
        usage: vec![],
        provider_reported_usd: None,
        reservation_nano_usdc: (u128::from(s.cap_micro) * 1000).to_string(),
        observed_nano_usdc: None,
        charged_nano_usdc: "0".into(),
        operator_loss_nano_usdc: None,
        reason: "waived_unknown".into(),
    };
    let r = Receipt::sign(body, key)?;
    Ok(ReceiptRecord {
        sequence: 0,
        receipt_id: approval.body.receipt_id,
        request_id: approval.body.request_id,
        operation_id: None,
        billing_effect: "charge".into(),
        canonical_body: r.body.canonical_bytes()?,
        receipt_hash: wire::hash(&r.receipt_hash)?,
        signature: Some(STANDARD.decode(&r.signature)?),
    })
}

/// Bounded CLI diagnostics never include database URLs, authorization bytes or keys.
pub fn operator_error_category(error: &anyhow::Error) -> &'static str {
    let text = error.to_string();
    if text.contains("approval must be reviewed") {
        "approval_expired"
    } else if text.contains("lease") || text.contains("grace") {
        "lease_or_grace_pending"
    } else if text.contains("no longer matches") || text.contains("checkpoint") {
        "evidence_changed"
    } else if text.contains("quiesced") {
        "dispatch_not_quiesced"
    } else if text.contains("conflicting") || text.contains("already finalized") {
        "approval_conflict"
    } else if text.contains("writer") || text.contains("advisory") {
        "writer_unavailable"
    } else if text.contains("file") || text.contains("permission") {
        "private_approval_file_required"
    } else if text.contains("signature") || text.contains("digest") || text.contains("canonical") {
        "approval_invalid"
    } else if error.downcast_ref::<tokio_postgres::Error>().is_some() {
        "database_or_schema_unavailable"
    } else {
        "eligibility_or_configuration_refused"
    }
}

#[cfg(test)]
mod approval_file_tests {
    use super::*;

    fn signed_plan() -> SignedApproval {
        SignedApproval::sign(
            ApprovalBody {
                version: "1".into(),
                action: "waive_direct_unknown_operator_loss".into(),
                deployment_id: "local-approval-parser-regression".into(),
                pool: hex::encode([1; 32]),
                manifest_hash: hex::encode([2; 32]),
                request_id: Uuid::new_v4(),
                request_digest: hex::encode([3; 32]),
                checkpoint_hash: hex::encode([4; 32]),
                attempts_hash: hex::encode([5; 32]),
                intent_expires_at: 1_792_800_000,
                grace_seconds: 300,
                approved_at: 1_792_801_000,
                review_evidence_sha256: hex::encode([6; 32]),
                receipt_id: Uuid::new_v4(),
                accepts_all_unknown_provider_costs: true,
            },
            &SigningKey::from_bytes(&[7; 32]),
        )
        .unwrap()
    }

    #[test]
    fn plan_serialization_round_trips_through_apply_parser_with_numeric_timestamps() {
        let plan = signed_plan();
        // These are exactly the bytes plan-direct-waiver writes and the parser
        // apply-direct-waiver invokes; the public API parser rejects this schema.
        let bytes = serde_jcs::to_vec(&plan).unwrap();
        assert!(wire::strict_parse::<SignedApproval>(&bytes).is_err());
        let applied = SignedApproval::from_canonical_bytes(&bytes).unwrap();
        assert_eq!(applied.body, plan.body);
        assert_eq!(applied.approval_hash, plan.approval_hash);
        assert_eq!(applied.signature, plan.signature);
        applied
            .verify(SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes())
            .unwrap();
    }

    #[test]
    fn apply_parser_rejects_duplicate_unknown_and_noncanonical_approval_files() {
        let plan = signed_plan();
        let canonical = String::from_utf8(serde_jcs::to_vec(&plan).unwrap()).unwrap();
        let duplicate_body = canonical.replacen(
            "\"grace_seconds\":300",
            "\"grace_seconds\":300,\"grace_seconds\":300",
            1,
        );
        let duplicate_outer = canonical.replacen(
            "{",
            &format!("{{\"approval_hash\":\"{}\",", plan.approval_hash),
            1,
        );
        let unknown_outer = canonical.replacen("{", "{\"unexpected\":true,", 1);
        let unknown_body = canonical.replacen(
            "\"grace_seconds\":300",
            "\"unexpected\":true,\"grace_seconds\":300",
            1,
        );
        let fractional_time =
            canonical.replacen("\"grace_seconds\":300", "\"grace_seconds\":300.5", 1);
        for bytes in [
            duplicate_body.as_bytes(),
            duplicate_outer.as_bytes(),
            unknown_outer.as_bytes(),
            unknown_body.as_bytes(),
            fractional_time.as_bytes(),
            format!("{canonical}\n").as_bytes(),
            &[b' '; 32769],
        ] {
            assert!(SignedApproval::from_canonical_bytes(bytes).is_err());
        }
    }
}
