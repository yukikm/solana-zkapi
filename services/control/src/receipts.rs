//! Signed, prompt-free billing evidence. Signatures attest operator records, not inference correctness.
use anyhow::{bail, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageUnit {
    pub unit: String,
    pub count: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptBody {
    pub version: String,
    pub receipt_id: String,
    pub deployment_id: String,
    pub pool: String,
    pub request_id: String,
    pub operation_id: Option<String>,
    pub billing_effect: String,
    pub related_receipt_hash: Option<String>,
    pub observed_at: String,
    pub evidence_kind: String,
    pub provider_request_id: Option<String>,
    pub provider_evidence_digest: Option<String>,
    pub tariff_hash: String,
    pub usage: Vec<UsageUnit>,
    pub provider_reported_usd: Option<String>,
    pub reservation_nano_usdc: String,
    pub observed_nano_usdc: Option<String>,
    pub charged_nano_usdc: String,
    pub operator_loss_nano_usdc: Option<String>,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub body: ReceiptBody,
    pub receipt_hash: String,
    pub signature: String,
}

fn uint(s: &str) -> Result<u128> {
    ensure!(
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0')),
        "noncanonical integer"
    );
    let n: u128 = s.parse()?;
    ensure!(n < 10u128.pow(38), "NUMERIC(38,0) overflow");
    Ok(n)
}
fn hash(s: &str) -> Result<()> {
    ensure!(
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid digest"
    );
    Ok(())
}
fn uuid(s: &str) -> Result<()> {
    let id = Uuid::parse_str(s)?;
    ensure!(
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == s,
        "UUIDv4 required"
    );
    Ok(())
}
impl ReceiptBody {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            matches!(self.version.as_str(), "1" | "2") && !self.deployment_id.is_empty(),
            "receipt version/deployment"
        );
        uuid(&self.receipt_id)?;
        uuid(&self.request_id)?;
        if let Some(id) = &self.operation_id {
            uuid(id)?;
        }
        if self.version == "2" {
            ensure!(
                self.operation_id.is_some() && self.provider_reported_usd.is_none(),
                "generic receipt scope"
            );
        }
        let pool = bs58::decode(&self.pool).into_vec()?;
        ensure!(
            pool.len() == 32 && bs58::encode(pool).into_string() == self.pool,
            "pool encoding"
        );
        hash(&self.tariff_hash)?;
        for h in [&self.related_receipt_hash, &self.provider_evidence_digest]
            .into_iter()
            .flatten()
        {
            hash(h)?;
        }
        ensure!(uint(&self.observed_at)? <= u64::MAX as u128, "timestamp");
        ensure!(
            self.provider_request_id
                .as_ref()
                .is_none_or(|s| s.len() <= 256 && !s.chars().any(char::is_control)),
            "provider request ID"
        );
        let r = uint(&self.reservation_nano_usdc)?;
        let c = uint(&self.charged_nano_usdc)?;
        let observed = self.observed_nano_usdc.as_deref().map(uint).transpose()?;
        let loss = self
            .operator_loss_nano_usdc
            .as_deref()
            .map(uint)
            .transpose()?;
        ensure!(c <= r, "charge exceeds reservation");
        ensure!(self.usage.len() <= 6, "usage limit");
        let mut previous = "";
        for item in &self.usage {
            ensure!(
                ((self.version == "2"
                    && item.unit == "requests"
                    && matches!(item.count.as_str(), "0" | "1"))
                    || (self.version == "1"
                        && matches!(
                            item.unit.as_str(),
                            "input_tokens"
                                | "output_tokens"
                                | "cache_read_tokens"
                                | "cache_write_tokens"
                                | "cache_write_5m_tokens"
                                | "cache_write_1h_tokens"
                        )))
                    && item.unit.as_str() > previous,
                "usage order/unit"
            );
            ensure!(uint(&item.count)? <= i64::MAX as u128, "usage bound");
            previous = &item.unit;
        }
        if self.usage.iter().any(|u| u.unit == "cache_write_tokens") {
            ensure!(!self.usage.iter().any(|u|u.unit == "cache_write_5m_tokens" || u.unit == "cache_write_1h_tokens"), "overlapping cache usage");
        }
        match self.billing_effect.as_str() {
            "charge" => ensure!(
                self.related_receipt_hash.is_none() && self.reason != "late_usage",
                "charge relationship"
            ),
            "late_loss_observation" => ensure!(
                self.related_receipt_hash.is_some() && self.reason == "late_usage" && c == 0,
                "late loss relationship"
            ),
            _ => bail!("invalid billing effect"),
        }
        match self.reason.as_str() {
            "metered" | "late_usage" => {
                let o = observed.ok_or_else(|| anyhow::anyhow!("missing observation"))?;
                ensure!(
                    loss == Some(
                        o.checked_sub(c)
                            .ok_or_else(|| anyhow::anyhow!("negative loss"))?
                    ),
                    "loss mismatch"
                );
                if self.reason == "metered" {
                    ensure!(c == o.min(r), "charge mismatch");
                }
                match self.evidence_kind.as_str() {
                    "PROXY_USAGE" => ensure!(
                        self.operation_id.is_some()
                            && self.provider_reported_usd.is_none()
                            && (self.version == "1" || self.usage.len() == 1),
                        "proxy evidence mismatch"
                    ),
                    "OA_SIGNED_RECEIPT" | "OPENROUTER_USAGE" => {
                        ensure!(
                            self.operation_id.is_none()
                                && self.usage.is_empty()
                                && self.provider_evidence_digest.is_some(),
                            "direct evidence mismatch"
                        );
                        let usd = self
                            .provider_reported_usd
                            .as_ref()
                            .ok_or_else(|| anyhow::anyhow!("missing USD"))?;
                        ensure!(usd.len() <= 128 && !usd.is_empty(), "USD length");
                        let (whole, fraction) = usd
                            .split_once('.')
                            .map_or((usd.as_str(), None), |(w, f)| (w, Some(f)));
                        ensure!(
                            !whole.is_empty()
                                && whole.bytes().all(|b| b.is_ascii_digit())
                                && (whole == "0" || !whole.starts_with('0')),
                            "USD whole"
                        );
                        if let Some(f) = fraction {
                            ensure!(
                                !f.is_empty()
                                    && f.bytes().all(|b| b.is_ascii_digit())
                                    && !f.ends_with('0'),
                                "USD fraction"
                            );
                        }
                    }
                    _ => bail!("invalid measured evidence"),
                }
            }
            "not_dispatched" => ensure!(
                self.evidence_kind == "NOT_DISPATCHED"
                    && c == 0
                    && observed == Some(0)
                    && loss == Some(0)
                    && self.usage.is_empty()
                    && self.provider_reported_usd.is_none()
                    && self.provider_request_id.is_none()
                    && self.provider_evidence_digest.is_none(),
                "not-dispatched receipt"
            ),
            "waived_unknown" => ensure!(
                self.evidence_kind == "UNKNOWN_OPERATOR_LOSS"
                    && c == 0
                    && observed.is_none()
                    && loss.is_none()
                    && self.usage.is_empty()
                    && self.provider_reported_usd.is_none(),
                "unknown receipt"
            ),
            _ => bail!("invalid receipt reason"),
        }
        Ok(())
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        Ok(serde_jcs::to_vec(self)?)
    }
}
impl Receipt {
    pub fn sign(body: ReceiptBody, key: &SigningKey) -> Result<Self> {
        let bytes = body.canonical_bytes()?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        Ok(Self {
            body,
            receipt_hash: hex::encode(digest),
            signature: STANDARD.encode(key.sign(&digest).to_bytes()),
        })
    }
    pub fn verify(&self, key: &VerifyingKey) -> Result<()> {
        let bytes = self.body.canonical_bytes()?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        ensure!(hex::encode(digest) == self.receipt_hash, "receipt digest");
        let raw = STANDARD.decode(&self.signature)?;
        ensure!(
            STANDARD.encode(&raw) == self.signature,
            "signature encoding"
        );
        key.verify_strict(&digest, &Signature::from_slice(&raw)?)?;
        Ok(())
    }
}

/// Recompute a public receipt against the tariff frozen into its accepted quote.
/// Callers must separately compare that tariff and the receipt identities with
/// the session. Later price changes must never affect this calculation.
pub fn validate_tariff_math(body: &ReceiptBody, tariff: &crate::wire::Tariff) -> Result<()> {
    body.validate()?;
    crate::quote::validate_tariff(tariff)?;
    ensure!(
        body.tariff_hash == tariff.tariff_hash,
        "receipt tariff mismatch"
    );
    let fixed_request = tariff.pricing_basis == "fixed_request";
    ensure!(
        body.version == if fixed_request { "2" } else { "1" },
        "receipt tariff version mismatch"
    );
    let proxy = fixed_request || tariff.pricing_basis == "fixed_usage_rates";
    ensure!(
        proxy || body.reason != "waived_unknown",
        "direct usage cannot be automatically waived"
    );
    ensure!(
        proxy == body.operation_id.is_some(),
        "receipt pricing scope mismatch"
    );
    if fixed_request {
        ensure!(
            uint(&body.reservation_nano_usdc)?
                == u128::from(crate::wire::uint(&tariff.rates[0].nano_usdc_numerator)?),
            "fixed request reservation mismatch"
        );
    }
    if !matches!(body.reason.as_str(), "metered" | "late_usage") {
        return Ok(());
    }
    let expected = if proxy {
        ensure!(
            body.evidence_kind == "PROXY_USAGE" && body.provider_reported_usd.is_none(),
            "proxy pricing evidence mismatch"
        );
        let usage = body
            .usage
            .iter()
            .map(|u| crate::wire::Usage {
                unit: u.unit.clone(),
                count: u.count.clone(),
            })
            .collect::<Vec<_>>();
        crate::quote::calculate_charge(tariff, &usage)?
    } else {
        let evidence = match tariff.provider {
            crate::wire::Provider::Oa => "OA_SIGNED_RECEIPT",
            crate::wire::Provider::Openrouter => "OPENROUTER_USAGE",
            _ => bail!("direct tariff provider"),
        };
        ensure!(
            body.evidence_kind == evidence && body.usage.is_empty(),
            "direct pricing evidence mismatch"
        );
        let reservation = uint(&body.reservation_nano_usdc)?;
        ensure!(reservation % 1000 == 0, "direct cap units");
        let cap = zkapi_solana_types::MicroUsdc::new(u64::try_from(reservation / 1000)?)?;
        let usd = body
            .provider_reported_usd
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("direct USD missing"))?;
        let charge = crate::quote::direct_charge(&[usd], cap)?;
        ensure!(charge.normalized_usd == usd, "direct USD canonical value");
        charge.observed_nano
    };
    ensure!(
        body.observed_nano_usdc.as_deref().map(uint).transpose()? == Some(expected),
        "receipt pricing calculation mismatch"
    );
    Ok(())
}
