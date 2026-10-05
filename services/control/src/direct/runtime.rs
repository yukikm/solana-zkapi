//! Durable control-ledger integration; only the original HTTP create handler may
//! deliver `CreatedKey`. Callers detach issuance from client request cancellation.
use super::*;
use crate::ledger::Ledger;
use std::{future::Future, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct DirectRuntime {
    adapter: DirectAdapter,
    serial: Arc<Mutex<()>>,
}
#[derive(Clone, Debug)]
pub struct Finalization {
    pub usage: DirectUsage,
    pub stop_evidence: [u8; 32],
}
impl DirectRuntime {
    pub fn new(adapter: DirectAdapter) -> Self {
        Self {
            adapter,
            serial: Arc::new(Mutex::new(())),
        }
    }
    pub fn provider(&self) -> crate::wire::Provider {
        self.adapter.provider()
    }
    pub async fn issue<F, Fut>(
        &self,
        ledger: &Ledger,
        intent: IssueIntent,
        owner: Uuid,
        live_check: F,
    ) -> Result<Option<CreatedKey>>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = crate::ledger::Result<()>>,
    {
        let _guard = self.serial.lock().await;
        intent.validate()?;
        if ledger.direct_checkpoint(intent.request_id).await?.is_some() {
            return Ok(None);
        }
        // This is the provider lease's issuance clock, not the RP request_time
        // or quote timestamp. Start it after waiting for the dispatch slot so a
        // queued request cannot send an already-expired provider lease. Once
        // saved, recovery must retain this exact intent and never extend it.
        let mut intent = intent;
        intent.requested_at = now_seconds();
        let id = intent.request_id;
        let mut checkpoint = Checkpoint {
            intent,
            reference: None,
            disabled_at: None,
            observation: None,
            usage: None,
            deleted: false,
        };
        save(ledger, id, None, &checkpoint).await?;
        let attempt = ledger.begin_direct_issuance(id, owner, &live_check).await?;
        if let Err(error) = ledger.claim_dispatch(&attempt).await {
            ledger
                .finish_attempt(
                    &attempt,
                    crate::wire::sha256(b"direct issuance owner stopped before HTTP dispatch"),
                )
                .await?;
            return Err(error.into());
        }
        let created = self
            .adapter
            .create_for_attempt(&checkpoint.intent, &attempt)
            .await;
        let mut created = match created {
            Ok(created) => created,
            Err(_) => {
                ledger.mark_issuance_unknown(id).await?;
                ledger
                    .finish_attempt(
                        &attempt,
                        crate::wire::sha256(
                            b"direct issuance HTTP owner completed with uncertain outcome",
                        ),
                    )
                    .await?;
                return Ok(None);
            }
        };
        // Save the management handle before verifier or chain calls. This keeps
        // revocation recoverable if the verifier, client or process disappears.
        let previous = checkpoint.clone();
        checkpoint.reference = Some(created.reference.clone());
        save(ledger, id, Some(&previous), &checkpoint).await?;
        ledger
            .finish_attempt(
                &attempt,
                crate::wire::sha256(b"direct issuance HTTP owner completed"),
            )
            .await?;
        if self.adapter.verify_created(&created).await.is_err() {
            created.deliverable = false;
            ledger.close(id).await?;
        }
        let provider_expires_at = created.reference.expires_at;
        let remaining_ttl = provider_expires_at
            .saturating_sub(now_seconds())
            .min(checkpoint.intent.ttl_seconds)
            .max(1);
        let session = ledger
            .resolve_direct_key(
                id,
                &created.reference.key_ref,
                remaining_ttl as i64,
                provider_expires_at,
                || async {
                    live_check().await?;
                    if now_seconds() >= provider_expires_at {
                        return Err(crate::ledger::LedgerError::Unavailable(
                            "provider_key_expired",
                        ));
                    }
                    Ok(())
                },
            )
            .await?;
        if session.state == "ACTIVE" && created.deliverable && provider_expires_at > now_seconds() {
            Ok(Some(created))
        } else {
            ledger.close(id).await?;
            Ok(None)
        }
    }
    /// Resumes stop/usage/delete checkpoints. Never invokes create_key and never
    /// yields plaintext key material. Existing unquiesced attempts still block the
    /// ledger's final completion and signer, regardless of provider observations.
    pub async fn reconcile(&self, ledger: &Ledger, id: Uuid) -> Result<Option<Finalization>> {
        let _guard = self.serial.lock().await;
        let Some(value) = ledger.direct_checkpoint(id).await? else {
            return Ok(None);
        };
        let mut checkpoint: Checkpoint = serde_json::from_value(value)?;
        let session = ledger.session(id).await?;
        if !matches!(
            session.state.as_str(),
            "ISSUANCE_UNKNOWN" | "DRAINING" | "RECONCILING" | "ISSUING"
        ) {
            return Ok(None);
        }
        if checkpoint.reference.is_none() {
            let Some(reference) = self.adapter.recover_key(&checkpoint.intent).await? else {
                return Ok(None);
            };
            let previous = checkpoint.clone();
            checkpoint.reference = Some(reference);
            save(ledger, id, Some(&previous), &checkpoint).await?;
        }
        let reference = checkpoint.reference.as_ref().unwrap().clone();
        if matches!(session.state.as_str(), "ISSUING" | "ISSUANCE_UNKNOWN") {
            ledger.close(id).await?;
            ledger
                .resolve_direct_key(
                    id,
                    &reference.key_ref,
                    checkpoint.intent.ttl_seconds as i64,
                    reference.expires_at,
                    || async { Ok(()) },
                )
                .await?;
        }
        if checkpoint.disabled_at.is_none() {
            self.adapter.disable_key(&reference).await?;
            let previous = checkpoint.clone();
            checkpoint.disabled_at = Some(now_seconds());
            save(ledger, id, Some(&previous), &checkpoint).await?;
        }
        if checkpoint.usage.is_none() {
            let now = now_seconds();
            if let DirectConfig::Openrouter {
                settlement_grace_seconds,
                ..
            } = self.adapter.config
            {
                if checkpoint
                    .observation
                    .as_ref()
                    .is_some_and(|o| now < o.observed_at.saturating_add(settlement_grace_seconds))
                {
                    return Ok(None);
                }
            }
            let usage = self
                .adapter
                .read_usage(
                    &checkpoint.intent,
                    &reference,
                    checkpoint.disabled_at.unwrap(),
                    now,
                )
                .await?;
            let Some(usage) = usage else { return Ok(None) };
            if matches!(self.adapter.config, DirectConfig::Openrouter { .. }) {
                let stable = checkpoint
                    .observation
                    .as_ref()
                    .is_some_and(|o| o.usage.provider_reported_usd == usage.provider_reported_usd);
                if !stable {
                    if let Some(prior) = &checkpoint.observation {
                        ensure!(
                            decimal_cmp(
                                &usage.provider_reported_usd,
                                &prior.usage.provider_reported_usd
                            ) != std::cmp::Ordering::Less,
                            "direct usage decreased during reconciliation"
                        );
                    }
                    let previous = checkpoint.clone();
                    checkpoint.observation = Some(UsageObservation {
                        observed_at: now,
                        usage,
                    });
                    save(ledger, id, Some(&previous), &checkpoint).await?;
                    return Ok(None);
                }
            }
            let previous = checkpoint.clone();
            checkpoint.usage = Some(usage);
            // Critical ordering: exact final USD/evidence is durable BEFORE
            // deletion removes provider-side usage and a lost response can occur.
            save(ledger, id, Some(&previous), &checkpoint).await?;
        }
        if !checkpoint.deleted {
            self.adapter.delete_key(&reference).await?;
            let previous = checkpoint.clone();
            checkpoint.deleted = true;
            save(ledger, id, Some(&previous), &checkpoint).await?;
        }
        let evidence = crate::wire::sha256(&serde_jcs::to_vec(&checkpoint)?);
        Ok(Some(Finalization {
            usage: checkpoint.usage.unwrap(),
            stop_evidence: evidence,
        }))
    }
}
async fn save(ledger: &Ledger, id: Uuid, old: Option<&Checkpoint>, new: &Checkpoint) -> Result<()> {
    let expected = old.map(serde_json::to_value).transpose()?;
    ledger
        .save_direct_checkpoint(id, expected.as_ref(), &serde_json::to_value(new)?)
        .await?;
    Ok(())
}

fn decimal_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (ai, af) = a.split_once('.').unwrap_or((a, ""));
    let (bi, bf) = b.split_once('.').unwrap_or((b, ""));
    ai.len()
        .cmp(&bi.len())
        .then_with(|| ai.cmp(bi))
        .then_with(|| {
            let width = af.len().max(bf.len());
            let a = format!("{af:0<width$}");
            let b = format!("{bf:0<width$}");
            a.cmp(&b)
        })
}
