//! Provider composition. Configuration contains secret references; the ledger only
//! receives bounded usage metadata and keyed request digests.
use crate::{
    direct::DirectConfig,
    proxy::ModelProfile,
    wire::{Provider, Tariff},
};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    #[serde(default)]
    pub direct: Vec<DirectConfig>,
    #[serde(default)]
    pub proxy: Vec<ProxyProviderConfig>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyProviderConfig {
    pub provider: Provider,
    pub credential_file: PathBuf,
    /// Only numeric loopback origins are accepted for local acceptance fixtures.
    pub local_test_base: Option<String>,
    pub models: Vec<ModelProfile>,
}
impl ProviderConfig {
    pub fn supports_tariff(&self, tariff: &Tariff) -> Result<bool> {
        if tariff.pricing_basis == "provider_reported_usd" {
            return Ok(self.direct.iter().any(|d| d.provider() == tariff.provider));
        }
        if let Some(profile) = self
            .proxy
            .iter()
            .filter(|p| p.provider == tariff.provider)
            .flat_map(|p| &p.models)
            .find(|m| m.model == tariff.model)
        {
            profile.validate(tariff)?;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn validate(&self, tariffs: &[Tariff], local: bool) -> Result<()> {
        let mut seen = Vec::new();
        for direct in &self.direct {
            ensure!(
                !seen.contains(&direct.provider()),
                "duplicate direct provider"
            );
            seen.push(direct.provider());
            // Client construction validates pinned endpoints and owner-only credentials.
            let _ = crate::direct::DirectAdapter::new(direct.clone(), local)?;
            ensure!(
                tariffs
                    .iter()
                    .any(|t| t.provider == direct.provider() && t.model == "*"),
                "direct tariff missing"
            );
        }
        seen.clear();
        for proxy in &self.proxy {
            ensure!(
                !seen.contains(&proxy.provider) && !proxy.models.is_empty(),
                "duplicate or empty proxy provider"
            );
            seen.push(proxy.provider.clone());
            let mut models = Vec::new();
            for model in &proxy.models {
                ensure!(
                    model.provider == proxy.provider && !models.contains(&model.model),
                    "invalid or duplicate model"
                );
                models.push(model.model.clone());
                let matching: Vec<_> = tariffs
                    .iter()
                    .filter(|t| t.provider == model.provider && t.model == model.model)
                    .collect();
                ensure!(!matching.is_empty(), "model tariff missing");
                for t in matching {
                    model.validate(t)?;
                }
            }
            if proxy.local_test_base.is_some() {
                ensure!(local, "local provider origin forbidden");
            }
            let _ = read_credential(&proxy.credential_file)?;
        }
        Ok(())
    }
}

pub fn read_credential(path: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
            "provider credential must be owner-only"
        );
    }
    let credential = std::fs::read_to_string(path)?;
    ensure!(
        !credential.is_empty()
            && credential.len() <= 4096
            && !credential.chars().any(char::is_control),
        "invalid provider credential"
    );
    Ok(credential)
}

use crate::{
    api::App,
    ledger::{self, OperationRecord, ReceiptRecord, SessionRecord},
    receipts::{Receipt, ReceiptBody, UsageUnit},
    wire,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use uuid::Uuid;

pub struct ProviderRuntime {
    pub proxy: Vec<(Provider, Arc<crate::proxy::HttpAdapter>)>,
    pub direct: Vec<(Provider, crate::direct::DirectRuntime)>,
    owner: Uuid,
    // Ephemeral throttles hold no raw IP, credentials, prompt, or response.
    rates: Mutex<BTreeMap<[u8; 32], (u64, u32)>>,
    unknown: Mutex<BTreeMap<String, u32>>,
    salt: [u8; 32],
}
impl ProviderRuntime {
    pub async fn connect(config: &ProviderConfig, local: bool) -> Result<Self> {
        let mut proxy = Vec::new();
        for p in &config.proxy {
            let credential =
                crate::proxy::ServiceCredential::new(read_credential(&p.credential_file)?)?;
            let adapter = if let Some(base) = &p.local_test_base {
                ensure!(local, "local provider origin forbidden");
                crate::proxy::HttpAdapter::local_fixture(
                    p.provider.clone(),
                    base,
                    credential,
                    Duration::from_secs(600),
                )?
            } else {
                crate::proxy::HttpAdapter::production(p.provider.clone(), credential).await?
            };
            proxy.push((p.provider.clone(), Arc::new(adapter)));
        }
        let mut direct = Vec::new();
        for d in &config.direct {
            direct.push((
                d.provider(),
                crate::direct::DirectRuntime::new(crate::direct::DirectAdapter::new(
                    d.clone(),
                    local,
                )?),
            ));
        }
        Ok(Self {
            proxy,
            direct,
            owner: Uuid::new_v4(),
            rates: Mutex::new(BTreeMap::new()),
            unknown: Mutex::new(BTreeMap::new()),
            salt: rand::random(),
        })
    }
    pub fn owner(&self) -> Uuid {
        self.owner
    }
    pub async fn available(&self, provider: &Provider) -> bool {
        self.unknown
            .lock()
            .await
            .get(provider.as_str())
            .copied()
            .unwrap_or(0)
            < 3
    }
    pub async fn note_unknown(&self, provider: &Provider) {
        let mut counts = self.unknown.lock().await;
        *counts.entry(provider.as_str().into()).or_default() += 1;
    }
    pub async fn rate_limit(&self, session: Uuid, ip: Option<std::net::IpAddr>) -> bool {
        let minute = now() / 60;
        let mut keys = vec![wire::sha256(session.as_bytes())];
        if let Some(ip) = ip {
            let mut bytes = self.salt.to_vec();
            bytes.extend_from_slice(&(minute / 1440).to_le_bytes());
            bytes.extend_from_slice(ip.to_string().as_bytes());
            keys.push(wire::sha256(&bytes));
        }
        let mut rates = self.rates.lock().await;
        rates.retain(|_, (window, _)| *window == minute);
        if keys
            .iter()
            .any(|k| rates.get(k).is_some_and(|(_, n)| *n >= 60))
        {
            return false;
        }
        for k in keys {
            rates.entry(k).or_insert((minute, 0)).1 += 1;
        }
        true
    }
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// A new writer cannot clear another process's sending authority by changing an
/// epoch. Keep admission closed until every old attempt is finished or fenced.
pub(crate) async fn abandoned_owner_exists(ledger: &ledger::Ledger) -> Result<bool> {
    for s in ledger.pending_sessions().await? {
        if ledger
            .dispatch_attempts_for_session(s.request_id)
            .await?
            .iter()
            .any(|a| a.attempt.writer_epoch != ledger.writer_epoch() && !a.quiesced())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl App {
    pub(crate) async fn adapter_available(
        &self,
        mode: &wire::Mode,
        provider: &Provider,
        model: &str,
    ) -> bool {
        if self.config.runtime.enable_local_adapter
            && *mode == wire::Mode::Proxy
            && *provider == Provider::Openai
            && model == "i05-local-only"
        {
            return true;
        }
        if !self.providers.available(provider).await {
            return false;
        }
        match mode {
            wire::Mode::Proxy => self
                .config
                .runtime
                .providers
                .proxy
                .iter()
                .any(|p| p.provider == *provider && p.models.iter().any(|m| m.model == model)),
            wire::Mode::DirectOa | wire::Mode::DirectOpenrouter => {
                model == "*" && self.providers.direct.iter().any(|(p, _)| p == provider)
            }
        }
    }
    pub(crate) fn sign_provider_receipt(&self, body: ReceiptBody) -> Result<ReceiptRecord> {
        let receipt = Receipt::sign(body, &self.config.receipt_key)?;
        Ok(ReceiptRecord {
            sequence: 0,
            receipt_id: wire::uuid(&receipt.body.receipt_id)?,
            request_id: wire::uuid(&receipt.body.request_id)?,
            operation_id: receipt
                .body
                .operation_id
                .as_deref()
                .map(wire::uuid)
                .transpose()?,
            billing_effect: receipt.body.billing_effect.clone(),
            canonical_body: receipt.body.canonical_bytes()?,
            receipt_hash: wire::hash(&receipt.receipt_hash)?,
            signature: Some(wire::base64_exact::<64>(&receipt.signature)?.to_vec()),
        })
    }
    pub(crate) fn proxy_receipt(
        &self,
        s: &SessionRecord,
        op: &OperationRecord,
        observation: Option<&crate::proxy::DispatchObservation>,
        tariff: &Tariff,
    ) -> Result<ReceiptRecord> {
        let usage = observation.and_then(|o| o.usage.as_ref());
        let observed = usage
            .map(|u| crate::quote::calculate_charge(tariff, u))
            .transpose()?;
        let charged = observed.unwrap_or(0).min(op.reservation_nano);
        self.sign_provider_receipt(ReceiptBody {
            version: "1".into(),
            receipt_id: Uuid::new_v4().to_string(),
            deployment_id: self.config.binding.deployment_id.clone(),
            pool: self.config.binding.pool.clone(),
            request_id: s.request_id.to_string(),
            operation_id: Some(op.operation_id.to_string()),
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: now().to_string(),
            evidence_kind: if observed.is_some() {
                "PROXY_USAGE"
            } else {
                "UNKNOWN_OPERATOR_LOSS"
            }
            .into(),
            provider_request_id: observation
                .and_then(|o| o.provider_request_id.clone())
                .or_else(|| op.provider_request_id.clone()),
            provider_evidence_digest: observation.and_then(|o| o.evidence_digest).map(hex::encode),
            tariff_hash: tariff.tariff_hash.clone(),
            usage: usage
                .map(|u| {
                    u.iter()
                        .map(|u| UsageUnit {
                            unit: u.unit.clone(),
                            count: u.count.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            provider_reported_usd: None,
            reservation_nano_usdc: op.reservation_nano.to_string(),
            observed_nano_usdc: observed.map(|n| n.to_string()),
            charged_nano_usdc: charged.to_string(),
            operator_loss_nano_usdc: observed.map(|n| (n - charged).to_string()),
            reason: if observed.is_some() {
                "metered"
            } else {
                "waived_unknown"
            }
            .into(),
        })
    }
    pub(crate) async fn recover_provider_operations(&self, s: &SessionRecord) -> Result<()> {
        if s.mode != "proxy" || !matches!(s.state.as_str(), "DRAINING" | "RECONCILING") {
            return Ok(());
        }
        let attempts = self
            .ledger
            .dispatch_attempts_for_session(s.request_id)
            .await?;
        let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
        let tariff = self
            .config
            .runtime
            .tariffs
            .iter()
            .find(|t| t.tariff_hash == request.quote.body.tariff_hash)
            .ok_or_else(|| anyhow::anyhow!("accepted tariff unavailable"))?;
        for op in self.ledger.operations_for_session(s.request_id).await? {
            if op.state == "USAGE_UNKNOWN"
                && attempts
                    .iter()
                    .filter(|a| a.attempt.operation_id == Some(op.operation_id))
                    .all(|a| a.finished || a.fenced)
            {
                let receipt = self.proxy_receipt(s, &op, None, tariff)?;
                self.ledger
                    .complete_operation(
                        s.request_id,
                        op.operation_id,
                        ledger::OperationOutcome::UnknownWaived,
                        &receipt,
                    )
                    .await?;
            }
        }
        Ok(())
    }
}

impl App {
    pub(crate) async fn issue_direct(&self, id: Uuid) -> Result<Option<crate::direct::CreatedKey>> {
        let s = self.ledger.session(id).await?;
        let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
        let runtime = &self
            .providers
            .direct
            .iter()
            .find(|(p, _)| *p == request.quote.body.provider)
            .ok_or_else(|| anyhow::anyhow!("direct adapter unavailable"))?
            .1;
        let n = zkapi_solana_types::FieldElement::from_bytes(s.nullifier)?;
        let intent = crate::direct::IssueIntent {
            request_id: id,
            cap_micro: s.cap_micro,
            ttl_seconds: wire::uint(&request.quote.body.session_ttl_seconds)?,
            requested_at: now(),
        };
        let result = runtime
            .issue(&self.ledger, intent, self.providers.owner(), || async {
                self.chain
                    .assert_live(n, None)
                    .await
                    .map(|_| ())
                    .map_err(crate::api::live_error)
            })
            .await;
        if result.is_err() {
            if result
                .as_ref()
                .err()
                .and_then(|e| e.downcast_ref::<ledger::LedgerError>())
                .is_some_and(|e| matches!(e, ledger::LedgerError::Conflict("exit_consumed")))
            {
                self.ledger
                    .record_exit(id, "exit_during_direct_issuance")
                    .await?;
            }
            let _ = self.ledger.close(id).await;
        }
        result
    }
    pub(crate) async fn advance_direct(&self, s: &SessionRecord) -> Result<()> {
        let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
        let Some((_, runtime)) = self
            .providers
            .direct
            .iter()
            .find(|(p, _)| *p == request.quote.body.provider)
        else {
            return Ok(());
        };
        // A RESERVED session closed before any issuance intent/attempt is provably
        // unissued. Once an attempt exists, provider absence is not proof of zero.
        let attempts = self
            .ledger
            .dispatch_attempts_for_session(s.request_id)
            .await?;
        let finalization = if attempts.iter().all(|a| !a.send_claimed && a.quiesced())
            && s.close_requested
        {
            None
        } else {
            let Some(finalization) = runtime.reconcile(&self.ledger, s.request_id).await? else {
                return Ok(());
            };
            Some(finalization)
        };
        if !attempts.iter().all(|a| a.quiesced()) {
            return Ok(());
        }
        // A saved immutable direct receipt means complete_direct already committed.
        if !self
            .ledger
            .receipts(s.request_id, None, 1)
            .await?
            .is_empty()
        {
            return Ok(());
        }
        let observed = finalization
            .as_ref()
            .map(|f| f.usage.observed_nano.parse::<u128>())
            .transpose()?
            .unwrap_or(0);
        let reservation = u128::from(s.cap_micro) * 1000;
        let charged = observed.min(reservation);
        let receipt = self.sign_provider_receipt(ReceiptBody {
            version: "1".into(),
            receipt_id: Uuid::new_v4().to_string(),
            deployment_id: self.config.binding.deployment_id.clone(),
            pool: self.config.binding.pool.clone(),
            request_id: s.request_id.to_string(),
            operation_id: None,
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: now().to_string(),
            evidence_kind: finalization
                .as_ref()
                .map(|f| f.usage.evidence_kind.clone())
                .unwrap_or("NOT_DISPATCHED".into()),
            provider_request_id: None,
            provider_evidence_digest: finalization
                .as_ref()
                .map(|f| f.usage.evidence_digest.clone()),
            tariff_hash: request.quote.body.tariff_hash,
            usage: vec![],
            provider_reported_usd: finalization
                .as_ref()
                .map(|f| f.usage.provider_reported_usd.clone()),
            reservation_nano_usdc: reservation.to_string(),
            observed_nano_usdc: Some(observed.to_string()),
            charged_nano_usdc: charged.to_string(),
            operator_loss_nano_usdc: Some((observed - charged).to_string()),
            reason: if finalization.is_some() {
                "metered"
            } else {
                "not_dispatched"
            }
            .into(),
        })?;
        let (outcome, evidence) = match finalization {
            Some(f) => (
                ledger::DirectOutcome::Metered {
                    observed_nano: observed,
                },
                f.stop_evidence,
            ),
            None => (
                ledger::DirectOutcome::ConfirmedNotIssued,
                wire::sha256(b"direct session closed without any issuance attempt"),
            ),
        };
        self.ledger
            .complete_direct(s.request_id, outcome, evidence, &receipt)
            .await?;
        Ok(())
    }
}
