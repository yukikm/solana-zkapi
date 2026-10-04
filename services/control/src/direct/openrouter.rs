// API contract: OpenRouter /api/v1/keys management API. Decimal lexemes are
// retained and summed exactly; usage and byok_usage are separate totals.
use super::*;
#[derive(Deserialize)]
struct KeyData {
    hash: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    limit: Option<Box<RawValue>>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    include_byok_in_limit: bool,
    #[serde(default)]
    limit_reset: Option<String>,
    disabled: bool,
    #[serde(default)]
    usage: Option<Box<RawValue>>,
    #[serde(default)]
    byok_usage: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
struct KeyEnvelope {
    data: KeyData,
}
#[derive(Deserialize)]
struct CreateEnvelope {
    key: String,
    data: KeyData,
}
#[derive(Deserialize)]
struct ListEnvelope {
    data: Vec<KeyData>,
}
impl DirectAdapter {
    fn or_url(&self) -> String {
        match &self.config {
            DirectConfig::Openrouter { api_base, .. } => format!("{api_base}/keys"),
            _ => unreachable!(),
        }
    }
    fn or_key_url(&self, reference: &KeyReference) -> Result<String> {
        valid_ref(&reference.key_ref)?;
        Ok(format!("{}/{}", self.or_url(), reference.key_ref))
    }
    pub(super) async fn or_create(&self, intent: &IssueIntent) -> Result<CreatedKey> {
        let expiry = unix_to_iso8601(intent.expires_at());
        // These substitutions consist only of validated UUID/timestamp/decimal
        // strings. The limit is a JSON number without any binary float roundtrip.
        let body = format!(
            r#"{{"name":"{}","limit":{},"expires_at":"{}","include_byok_in_limit":true,"limit_reset":null}}"#,
            intent.name(),
            intent.limit_usd(),
            expiry
        );
        let (status, bytes) = self
            .request(Method::POST, self.or_url(), Some(body), true)
            .await?;
        ensure!(
            status.is_success(),
            "OpenRouter issuance response uncertain"
        );
        let response: CreateEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OpenRouter issuance response"))?;
        valid_ref(&response.data.hash)?;
        let applied_limit = response
            .data
            .limit
            .as_deref()
            .and_then(|x| decimal(x).ok())
            .and_then(|x| {
                crate::quote::direct_charge(&[x], MicroUsdc::new(intent.cap_micro).ok()?).ok()
            })
            .map(|v| v.normalized_usd);
        let deliverable = !response.key.is_empty()
            && response.key.len() <= 4096
            && !response.key.chars().any(char::is_whitespace)
            && response.data.name == intent.name()
            && !response.data.disabled
            && applied_limit.as_deref() == Some(intent.limit_usd().as_str())
            && response
                .data
                .expires_at
                .as_deref()
                .is_some_and(|s| expiry_matches(s, &expiry))
            && response.data.include_byok_in_limit
            && response.data.limit_reset.is_none();
        Ok(CreatedKey {
            runtime_key: response.key,
            reference: KeyReference {
                key_ref: response.data.hash,
                expires_at: intent.expires_at(),
                station_id: None,
            },
            inference_base: self.inference_base().into(),
            verification: None,
            deliverable,
        })
    }
    pub(super) async fn or_recover(&self, intent: &IssueIntent) -> Result<Option<KeyReference>> {
        let mut offset = 0usize;
        let mut found = None;
        loop {
            let url = format!("{}?offset={offset}&include_disabled=true", self.or_url());
            let (status, bytes) = self.request(Method::GET, url, None, true).await?;
            ensure!(status.is_success(), "OpenRouter recovery unavailable");
            let page: ListEnvelope = serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("invalid OpenRouter recovery response"))?;
            if page.data.is_empty() {
                return Ok(found);
            }
            offset += page.data.len();
            ensure!(offset <= 10_000, "OpenRouter recovery pagination limit");
            for key in page.data {
                if key.name == intent.name() {
                    valid_ref(&key.hash)?;
                    ensure!(found.is_none(), "ambiguous OpenRouter issuance recovery");
                    // Even a misconfigured cap/expiry must be recoverable for
                    // revocation. Recovery can never activate this key.
                    found = Some(KeyReference {
                        key_ref: key.hash,
                        expires_at: intent.expires_at(),
                        station_id: None,
                    });
                }
            }
        }
    }
    pub(super) async fn or_disable(&self, reference: &KeyReference) -> Result<()> {
        let (status, bytes) = self
            .request(
                Method::PATCH,
                self.or_key_url(reference)?,
                Some(r#"{"disabled":true}"#.into()),
                true,
            )
            .await?;
        ensure!(status.is_success(), "OpenRouter disable unconfirmed");
        let response: KeyEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OpenRouter disable response"))?;
        ensure!(
            response.data.disabled && response.data.hash == reference.key_ref,
            "OpenRouter disable unconfirmed"
        );
        Ok(())
    }
    pub(super) async fn or_usage(
        &self,
        intent: &IssueIntent,
        reference: &KeyReference,
    ) -> Result<DirectUsage> {
        let (status, bytes) = self
            .request(Method::GET, self.or_key_url(reference)?, None, true)
            .await?;
        ensure!(status.is_success(), "OpenRouter usage unavailable");
        let response: KeyEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OpenRouter usage response"))?;
        ensure!(
            response.data.disabled && response.data.hash == reference.key_ref,
            "OpenRouter usage requires stopped matching key"
        );
        let usage = decimal(
            response
                .data
                .usage
                .as_deref()
                .context("OpenRouter usage missing")?,
        )?;
        let byok = decimal(
            response
                .data
                .byok_usage
                .as_deref()
                .context("OpenRouter BYOK usage missing")?,
        )?;
        DirectUsage::from_usd(
            &[usage, byok],
            intent,
            reference,
            "OPENROUTER_USAGE",
            &bytes,
        )
    }
    pub(super) async fn or_delete(&self, reference: &KeyReference) -> Result<()> {
        let (status, bytes) = self
            .request(Method::DELETE, self.or_key_url(reference)?, None, true)
            .await?;
        if matches!(status, StatusCode::NOT_FOUND | StatusCode::NO_CONTENT) {
            return Ok(());
        }
        ensure!(status.is_success(), "OpenRouter deletion unconfirmed");
        #[derive(Deserialize)]
        struct Deleted {
            deleted: bool,
        }
        let response: Deleted = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid OpenRouter deletion response"))?;
        ensure!(response.deleted, "OpenRouter deletion unconfirmed");
        Ok(())
    }
}
// Civil-from-days conversion retained from ethereum/zkapi pinned baseline.
pub fn unix_to_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}
fn expiry_matches(actual: &str, expected: &str) -> bool {
    actual == expected
        || expected
            .strip_suffix('Z')
            .is_some_and(|s| actual == format!("{s}.000Z"))
}
