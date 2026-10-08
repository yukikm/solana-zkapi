//! Direct provider leases. No method retries issuance; recovery only observes the
//! original request. Runtime keys are never serialized into the control ledger.
mod oa;
mod openrouter;
mod runtime;
pub use runtime::{DirectRuntime, Finalization};

use anyhow::{ensure, Context, Result};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
use zkapi_solana_types::MicroUsdc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum DirectConfig {
    Openrouter {
        api_base: String,
        credential_file: PathBuf,
        inference_base: String,
        settlement_grace_seconds: u64,
    },
    Oa {
        issuer_base: String,
        credential_file: PathBuf,
        verifier_base: String,
        inference_base: String,
        station_id: String,
    },
}
impl DirectConfig {
    pub fn provider(&self) -> crate::wire::Provider {
        match self {
            Self::Openrouter { .. } => crate::wire::Provider::Openrouter,
            Self::Oa { .. } => crate::wire::Provider::Oa,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IssueIntent {
    pub request_id: Uuid,
    pub cap_micro: u64,
    pub ttl_seconds: u64,
    pub requested_at: u64,
}
impl IssueIntent {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.request_id.get_version_num() == 4
                && self.cap_micro > 0
                && self.cap_micro <= i64::MAX as u64
                && (1..=300).contains(&self.ttl_seconds),
            "invalid direct issuance intent"
        );
        self.requested_at
            .checked_add(self.ttl_seconds + 60)
            .context("expiry overflow")?;
        ensure!(self.requested_at < 253_402_300_000, "expiry out of range");
        Ok(())
    }
    pub fn name(&self) -> String {
        format!("zkapi-{}", self.request_id)
    }
    pub fn expires_at(&self) -> u64 {
        self.requested_at + self.ttl_seconds
    }
    fn limit_usd(&self) -> String {
        micro_usd(self.cap_micro as u128)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KeyReference {
    pub key_ref: String,
    pub expires_at: u64,
    pub station_id: Option<String>,
}
/// Intentionally neither Debug nor Serialize: contains a one-time plaintext key.
pub struct CreatedKey {
    pub runtime_key: String,
    pub reference: KeyReference,
    pub inference_base: String,
    pub verification: Option<serde_json::Value>,
    pub(crate) deliverable: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DirectUsage {
    pub provider_reported_usd: String,
    pub observed_nano: String,
    pub evidence_kind: String,
    pub evidence_digest: String,
    pub key_ref: String,
}
impl DirectUsage {
    fn from_usd(
        values: &[&str],
        intent: &IssueIntent,
        reference: &KeyReference,
        kind: &str,
        evidence: &[u8],
    ) -> Result<Self> {
        let charge = crate::quote::direct_charge(values, MicroUsdc::new(intent.cap_micro)?)?;
        Ok(Self {
            provider_reported_usd: charge.normalized_usd,
            observed_nano: charge.observed_nano.to_string(),
            evidence_kind: kind.into(),
            evidence_digest: hex::encode(crate::wire::sha256(evidence)),
            key_ref: reference.key_ref.clone(),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageObservation {
    pub observed_at: u64,
    pub usage: DirectUsage,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub intent: IssueIntent,
    pub reference: Option<KeyReference>,
    pub disabled_at: Option<u64>,
    pub observation: Option<UsageObservation>,
    pub usage: Option<DirectUsage>,
    pub deleted: bool,
}
#[derive(Clone)]
pub struct DirectAdapter {
    remote: Option<crate::egress::ClientConfig>,
    config: DirectConfig,
    http: Client,
    credential: String,
}
impl DirectAdapter {
    pub fn remote(config: DirectConfig, remote: crate::egress::ClientConfig) -> Self {
        Self {
            config,
            remote: Some(remote),
            http: Client::new(),
            credential: String::new(),
        }
    }
    async fn remote_call(&self, action: crate::egress::Action) -> Result<serde_json::Value> {
        self.remote
            .as_ref()
            .context("dispatcher required")?
            .call(
                crate::egress::Request {
                    provider: self.provider(),
                    action,
                },
                None,
            )
            .await
    }
    pub async fn create_for_attempt(
        &self,
        intent: &IssueIntent,
        attempt: &crate::ledger::DispatchAttempt,
    ) -> Result<CreatedKey> {
        if self.remote.is_none() {
            return self.create_key(intent).await;
        }
        let v = self
            .remote_call(crate::egress::Action::Create {
                intent: intent.clone(),
                attempt: attempt.clone(),
            })
            .await?;
        Ok(CreatedKey {
            runtime_key: v["runtime_key"].as_str().context("key unavailable")?.into(),
            reference: serde_json::from_value(v["reference"].clone())?,
            inference_base: v["inference_base"]
                .as_str()
                .context("base unavailable")?
                .into(),
            verification: if v["verification"].is_null() {
                None
            } else {
                Some(v["verification"].clone())
            },
            deliverable: v["deliverable"].as_bool().context("delivery unavailable")?,
        })
    }
    pub fn new(config: DirectConfig, local_test_only: bool) -> Result<Self> {
        let (base, path, inference) = match &config {
            DirectConfig::Openrouter {
                api_base,
                credential_file,
                inference_base,
                settlement_grace_seconds,
            } => {
                for url in [api_base, inference_base] {
                    ensure!(
                        url == "https://openrouter.ai/api/v1"
                            || local_test_only && numeric_loopback_http(url),
                        "OpenRouter origin must match the pinned management/inference API"
                    );
                }
                ensure!(
                    (local_test_only || *settlement_grace_seconds >= 5)
                        && *settlement_grace_seconds <= 86_400,
                    "invalid direct usage drain interval"
                );
                (api_base, credential_file, inference_base)
            }
            DirectConfig::Oa {
                issuer_base,
                credential_file,
                verifier_base,
                inference_base,
                station_id,
            } => {
                validate_url(verifier_base, local_test_only)?;
                ensure!(
                    !station_id.is_empty()
                        && station_id.len() <= 128
                        && !station_id.chars().any(char::is_control),
                    "invalid pinned OA station"
                );
                (issuer_base, credential_file, inference_base)
            }
        };
        validate_url(base, local_test_only)?;
        validate_url(inference, local_test_only)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
                "provider credential must be owner-only"
            );
        }
        let credential =
            std::fs::read_to_string(path).context("provider credential unavailable")?;
        ensure!(
            !credential.is_empty()
                && credential.len() <= 4096
                && !credential.chars().any(char::is_whitespace),
            "invalid provider credential"
        );
        let http = Client::builder()
            .timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()?;
        Ok(Self {
            remote: None,
            config,
            http,
            credential,
        })
    }
    pub fn provider(&self) -> crate::wire::Provider {
        self.config.provider()
    }
    pub fn inference_base(&self) -> &str {
        match &self.config {
            DirectConfig::Openrouter { inference_base, .. }
            | DirectConfig::Oa { inference_base, .. } => inference_base,
        }
    }
    pub async fn create_key(&self, intent: &IssueIntent) -> Result<CreatedKey> {
        ensure!(self.remote.is_none(), "immutable attempt required");
        intent.validate()?;
        match &self.config {
            DirectConfig::Openrouter { .. } => self.or_create(intent).await,
            DirectConfig::Oa { .. } => self.oa_create(intent).await,
        }
    }
    pub async fn verify_created(&self, created: &CreatedKey) -> Result<()> {
        if self.remote.is_some() {
            self.remote_call(crate::egress::Action::Verify {
                reference: created.reference.clone(),
                runtime_key: created.runtime_key.clone(),
                inference_base: created.inference_base.clone(),
                verification: created.verification.clone(),
                deliverable: created.deliverable,
            })
            .await?;
            return Ok(());
        }
        ensure!(
            created.deliverable && created.reference.expires_at > now_seconds(),
            "provider did not apply bounded lease"
        );
        if matches!(self.config, DirectConfig::Oa { .. }) {
            self.oa_verify(created).await?;
        }
        ensure!(
            created.reference.expires_at > now_seconds(),
            "provider key expired during verification"
        );
        Ok(())
    }
    /// Absence is UNKNOWN, never authorization to issue again or bill zero.
    pub async fn recover_key(&self, intent: &IssueIntent) -> Result<Option<KeyReference>> {
        if self.remote.is_some() {
            return Ok(serde_json::from_value(
                self.remote_call(crate::egress::Action::Recover {
                    intent: intent.clone(),
                })
                .await?,
            )?);
        }
        intent.validate()?;
        match &self.config {
            DirectConfig::Openrouter { .. } => self.or_recover(intent).await,
            DirectConfig::Oa { .. } => self.oa_recover(intent).await,
        }
    }
    /// OA key_usage performs retirement at the pinned issuer/station. It returns
    /// pending until its durable signed receipt and provider deletion are ready.
    pub async fn disable_key(&self, reference: &KeyReference) -> Result<()> {
        if self.remote.is_some() {
            self.remote_call(crate::egress::Action::Disable {
                reference: reference.clone(),
            })
            .await?;
            return Ok(());
        }
        match self.config {
            DirectConfig::Openrouter { .. } => self.or_disable(reference).await,
            DirectConfig::Oa { .. } => Ok(()),
        }
    }
    pub async fn read_usage(
        &self,
        intent: &IssueIntent,
        reference: &KeyReference,
        disabled_at: u64,
        now: u64,
    ) -> Result<Option<DirectUsage>> {
        if self.remote.is_some() {
            return Ok(serde_json::from_value(
                self.remote_call(crate::egress::Action::Usage {
                    intent: intent.clone(),
                    reference: reference.clone(),
                    disabled_at,
                    now,
                })
                .await?,
            )?);
        }
        match self.config {
            DirectConfig::Openrouter {
                settlement_grace_seconds,
                ..
            } => {
                if now < disabled_at.saturating_add(settlement_grace_seconds) {
                    return Ok(None);
                }
                self.or_usage(intent, reference).await.map(Some)
            }
            DirectConfig::Oa { .. } => self.oa_usage(intent, reference).await,
        }
    }
    pub async fn delete_key(&self, reference: &KeyReference) -> Result<()> {
        if self.remote.is_some() {
            self.remote_call(crate::egress::Action::Delete {
                reference: reference.clone(),
            })
            .await?;
            return Ok(());
        }
        match self.config {
            DirectConfig::Openrouter { .. } => self.or_delete(reference).await,
            DirectConfig::Oa { .. } => Ok(()),
        }
    }
    async fn request(
        &self,
        method: Method,
        url: String,
        body: Option<String>,
        credential: bool,
    ) -> Result<(StatusCode, Vec<u8>)> {
        let mut request = self.http.request(method, url);
        if credential {
            request = request.bearer_auth(&self.credential);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("direct provider transport unavailable"))?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("direct provider body unavailable"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= 1024 * 1024,
                "direct provider response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    }
}
fn validate_url(value: &str, local: bool) -> Result<()> {
    let url = Url::parse(value).context("invalid provider URL")?;
    let loopback = url
        .host_str()
        .and_then(|s| s.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    ensure!(
        (url.scheme() == "https" || local && loopback && url.scheme() == "http")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && !value.ends_with('/'),
        "unsafe provider URL"
    );
    Ok(())
}
fn valid_ref(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "invalid provider management reference"
    );
    Ok(())
}
fn decimal(raw: &RawValue) -> Result<&str> {
    // The provider schema specifies JSON numbers, never quoted strings. Keep
    // their original lexeme; serde_json::Number/f64 would lose billing digits.
    let value = raw.get();
    ensure!(
        !value.starts_with('"'),
        "provider USD must be a JSON number"
    );
    crate::quote::direct_charge(&[value], MicroUsdc::new(1)?)?;
    Ok(value)
}
fn micro_usd(micro: u128) -> String {
    if micro.is_multiple_of(1_000_000) {
        (micro / 1_000_000).to_string()
    } else {
        format!("{}.{:06}", micro / 1_000_000, micro % 1_000_000)
            .trim_end_matches('0')
            .into()
    }
}
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn numeric_loopback_http(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "http"
            && url
                .host_str()
                .and_then(|s| s.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback())
    })
}
