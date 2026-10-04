//! OA-org wire contract retained from the pinned Ethereum adapter and browser
//! verifier flow. The configured issuer, verifier, station and inference URLs
//! are pinned; response-provided URLs never choose a network destination.
use super::*;
use serde_json::{json, Value};
#[derive(Deserialize)]
struct Created {
    source: String,
    #[serde(default)]
    replayed: bool,
    key: String,
    key_hash: String,
    credit_limit: Box<RawValue>,
    duration_minutes: u64,
    expires_at_unix: u64,
    station_id: String,
    station_recently_attested: bool,
    station_signature: String,
    org_signature: String,
    verifier_url: String,
    openrouter_api_base: String,
}
#[derive(Deserialize)]
struct Recovered {
    source: String,
    version: u64,
    status: String,
    client_request_id: String,
    station_request_id: Option<String>,
    key_hash: Option<String>,
    credit_limit: Option<Box<RawValue>>,
    credit_limit_credits: Option<u64>,
    duration_minutes: Option<u64>,
    expires_at_unix: Option<u64>,
    station_id: Option<String>,
}
#[derive(Deserialize)]
struct Usage {
    source: String,
    version: u64,
    status: String,
    client_request_id: String,
    station_request_id: String,
    key_hash: String,
    usage_credits: Option<u128>,
    credit_limit_credits: Option<u64>,
    expires_at_unix: Option<u64>,
    closed_at_unix: Option<u64>,
    finalized_at_unix: Option<u64>,
    station_id: Option<String>,
    station_signature: Option<String>,
    org_signature: Option<String>,
}
impl DirectAdapter {
    fn oa_url(&self, path: &str) -> String {
        match &self.config {
            DirectConfig::Oa { issuer_base, .. } => format!("{issuer_base}/api/zkapi/{path}"),
            _ => unreachable!(),
        }
    }
    fn oa_body(&self, intent: &IssueIntent) -> Result<String> {
        ensure!(
            intent.ttl_seconds.is_multiple_of(60),
            "OA lease TTL requires whole minutes"
        );
        Ok(format!(
            r#"{{"client_request_id":"{}","credit_limit":{},"credit_limit_credits":{},"duration_minutes":{}}}"#,
            intent.request_id,
            intent.limit_usd(),
            intent.cap_micro,
            intent.ttl_seconds / 60
        ))
    }
    pub(super) async fn oa_create(&self, intent: &IssueIntent) -> Result<CreatedKey> {
        let (status, bytes) = self
            .request(
                Method::POST,
                self.oa_url("request_key"),
                Some(self.oa_body(intent)?),
                true,
            )
            .await?;
        // Even HTTP 4xx/429 is not sufficient to declare no issuance. Conservatively
        // retain UNKNOWN and use issuer recovery; never retry request_key.
        ensure!(status.is_success(), "OA issuance response uncertain");
        let response: Created = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OA issuance response"))?;
        valid_ref(&response.key_hash)?;
        let DirectConfig::Oa {
            verifier_base,
            inference_base,
            station_id,
            ..
        } = &self.config
        else {
            unreachable!()
        };
        // A malformed limit must prevent delivery without discarding the
        // already-issued management handle. The runtime persists this reference
        // before verification so the key can still be retired and reconciled.
        let applied_limit = decimal(&response.credit_limit)
            .ok()
            .and_then(|limit| {
                crate::quote::direct_charge(&[limit], MicroUsdc::new(intent.cap_micro).ok()?).ok()
            })
            .map(|charge| charge.normalized_usd);
        let deliverable = response.source == "oa_org"
            && !response.replayed
            && !response.key.is_empty()
            && response.key.len() <= 4096
            && !response.key.chars().any(char::is_whitespace)
            && response.station_id == *station_id
            && response.verifier_url == *verifier_base
            && response.openrouter_api_base == *inference_base
            && applied_limit.as_deref() == Some(intent.limit_usd().as_str())
            && response.duration_minutes == intent.ttl_seconds / 60
            && response.expires_at_unix > now_seconds()
            && response.expires_at_unix >= intent.expires_at().saturating_sub(30)
            && response.expires_at_unix <= intent.expires_at().saturating_add(65)
            && signature_hex(&response.station_signature)
            && signature_hex(&response.org_signature);
        let verification = json!({"verifier_url":response.verifier_url,"station_id":response.station_id,
            "station_recently_attested":response.station_recently_attested,"key_valid_till":response.expires_at_unix,
            "station_signature":response.station_signature,"org_signature":response.org_signature});
        Ok(CreatedKey {
            runtime_key: response.key,
            reference: KeyReference {
                key_ref: response.key_hash,
                expires_at: response.expires_at_unix,
                station_id: Some(response.station_id),
            },
            inference_base: inference_base.clone(),
            verification: Some(verification),
            deliverable,
        })
    }
    pub(super) async fn oa_verify(&self, created: &CreatedKey) -> Result<()> {
        let DirectConfig::Oa { verifier_base, .. } = &self.config else {
            unreachable!()
        };
        let evidence = created
            .verification
            .as_ref()
            .context("OA key evidence missing")?;
        let body = json!({"station_id":evidence["station_id"],"api_key":created.runtime_key,
            "key_valid_till":evidence["key_valid_till"],"station_signature":evidence["station_signature"],
            "org_signature":evidence["org_signature"]});
        let (status, bytes) = self
            .request(
                Method::POST,
                format!("{verifier_base}/submit_key"),
                Some(body.to_string()),
                false,
            )
            .await?;
        let response: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OA verifier response"))?;
        ensure!(
            status.is_success()
                && response.get("status").and_then(Value::as_str) == Some("verified"),
            "OA trusted verifier rejected key"
        );
        Ok(())
    }
    pub(super) async fn oa_recover(&self, intent: &IssueIntent) -> Result<Option<KeyReference>> {
        let (status, bytes) = self
            .request(
                Method::POST,
                self.oa_url("reconcile_key"),
                Some(self.oa_body(intent)?),
                true,
            )
            .await?;
        ensure!(status.is_success(), "OA recovery unavailable");
        let response: Recovered = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OA recovery response"))?;
        ensure!(
            response.source == "oa_org"
                && response.version == 1
                && response.client_request_id == intent.request_id.to_string(),
            "OA recovery identity mismatch"
        );
        if response.status == "unknown" {
            return Ok(None);
        }
        let DirectConfig::Oa { station_id, .. } = &self.config else {
            unreachable!()
        };
        let key_ref = response
            .key_hash
            .context("OA recovery key reference missing")?;
        valid_ref(&key_ref)?;
        let expires_at = response
            .expires_at_unix
            .context("OA recovery expiry missing")?;
        let limit = crate::quote::direct_charge(
            &[decimal(
                response
                    .credit_limit
                    .as_deref()
                    .context("OA recovery limit missing")?,
            )?],
            MicroUsdc::new(intent.cap_micro)?,
        )?;
        ensure!(
            response.status == "issued"
                && response.station_request_id.as_deref()
                    == Some(station_request_id(intent).as_str())
                && response.credit_limit_credits == Some(intent.cap_micro)
                && limit.normalized_usd == intent.limit_usd()
                && response.duration_minutes == Some(intent.ttl_seconds / 60)
                && response.station_id.as_deref() == Some(station_id)
                && expires_at >= intent.expires_at().saturating_sub(30)
                && expires_at <= intent.expires_at().saturating_add(65),
            "OA recovery lease mismatch"
        );
        Ok(Some(KeyReference {
            key_ref,
            expires_at,
            station_id: response.station_id,
        }))
    }
    pub(super) async fn oa_usage(
        &self,
        intent: &IssueIntent,
        reference: &KeyReference,
    ) -> Result<Option<DirectUsage>> {
        valid_ref(&reference.key_ref)?;
        let DirectConfig::Oa { station_id, .. } = &self.config else {
            unreachable!()
        };
        ensure!(
            reference.station_id.as_deref() == Some(station_id.as_str()),
            "OA receipt requires pinned station"
        );
        let mut body = self.oa_body(intent)?;
        body.pop();
        body.push_str(&format!(
            r#", "key_hash":"{}","expires_at_unix":{}}}"#,
            reference.key_ref, reference.expires_at
        ));
        let (status, bytes) = self
            .request(Method::POST, self.oa_url("key_usage"), Some(body), true)
            .await?;
        ensure!(status.is_success(), "OA final usage unavailable");
        let response: Usage = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OA usage response"))?;
        ensure!(
            response.source == "oa_org"
                && response.version == 1
                && response.client_request_id == intent.request_id.to_string()
                && response.station_request_id == station_request_id(intent)
                && response.key_hash == reference.key_ref,
            "OA usage identity mismatch"
        );
        if response.status == "pending" {
            return Ok(None);
        }
        let usage = response.usage_credits.context("OA usage missing")?;
        let closed = response.closed_at_unix.context("OA closed time missing")?;
        let finalized = response
            .finalized_at_unix
            .context("OA finalization missing")?;
        ensure!(
            response.status == "finalized"
                && response.credit_limit_credits == Some(intent.cap_micro)
                && response.expires_at_unix == Some(reference.expires_at)
                && response.station_id == reference.station_id
                && reference.station_id.is_some()
                && closed >= intent.requested_at
                && closed <= reference.expires_at
                && finalized >= closed
                && response
                    .station_signature
                    .as_deref()
                    .is_some_and(signature_hex)
                && response.org_signature.as_deref().is_some_and(signature_hex),
            "OA final receipt lease mismatch"
        );
        // As in pinned upstream, receipt signatures are validated structurally
        // over authenticated issuer transport. No invented detached-signature
        // message is used; external signing-key/payload acceptance remains G3.
        DirectUsage::from_usd(
            &[&micro_usd(usage)],
            intent,
            reference,
            "OA_SIGNED_RECEIPT",
            &bytes,
        )
        .map(Some)
    }
}
fn signature_hex(s: &str) -> bool {
    s.len() == 128 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn station_request_id(intent: &IssueIntent) -> String {
    hex::encode(crate::wire::sha256(
        format!("oa-org:zkapi:v1:{}", intent.request_id).as_bytes(),
    ))
}
