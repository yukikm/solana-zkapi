//! Authenticated envelope admission and detached use of the existing ledger.
use super::*;
use crate::{
    api::App,
    inference::{boundary, credential, operation_headers, single},
    ledger::{self, NewOperation, OperationOutcome},
};
use axum::{
    body::Body,
    extract::{OriginalUri, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use subtle::ConstantTimeEq;
use uuid::Uuid;
fn error(status: StatusCode, code: &str, id: Option<Uuid>, operation: Option<Uuid>) -> Response {
    let mut response = (
        status,
        Json(json!({"code":code,"request_id":id,"operation_id":operation})),
    )
        .into_response();
    if let (Some(id), Some(op)) = (id, operation) {
        operation_headers(&mut response, id, op)
    }
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
pub async fn execute(
    State(app): State<Arc<App>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if uri.query().is_some()
        || !boundary(&app, &headers)
        || single(&headers, "content-type") != Some(REQUEST_MEDIA)
        || single(&headers, "accept") != Some(RESPONSE_MEDIA)
        || headers.contains_key("content-encoding")
    {
        return error(StatusCode::BAD_REQUEST, "invalid_envelope", None, None);
    }
    let token = match credential(&headers, false) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::UNAUTHORIZED, "invalid_credential", None, None),
    };
    let operation = match single(&headers, "idempotency-key").map(wire::uuid) {
        Some(Ok(v)) => v,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_envelope", None, None),
    };
    let id = token.request_id;
    let fail = |status, code| error(status, code, Some(id), Some(operation));
    let session = match app.ledger.session(id).await {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::UNAUTHORIZED, "invalid_credential"),
    };
    if session.mode != "proxy"
        || session
            .proxy_secret_hash
            .is_none_or(|h| !bool::from(h.ct_eq(&wire::sha256(&token.secret))))
    {
        return fail(StatusCode::UNAUTHORIZED, "invalid_credential");
    }
    let saved: wire::SessionCreate = match wire::strict_parse(&session.request_transcript) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable"),
    };
    let Some(api) = saved.quote.body.api.as_ref().and_then(|a| a.v2()).cloned() else {
        return fail(StatusCode::BAD_REQUEST, "unsupported_capability");
    };
    if uri.path() != wire::api_path(&api) {
        return fail(StatusCode::BAD_REQUEST, "invalid_envelope");
    }
    let Some(tariff) = app
        .config
        .runtime
        .tariffs
        .iter()
        .find(|t| t.tariff_hash == saved.quote.body.tariff_hash)
        .cloned()
    else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable");
    };
    let Some((_, admission)) = app.providers.gateway_admission.iter().find(|p| p.0 == api) else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable");
    };
    let Ok(permit) = admission.clone().try_acquire_owned() else {
        return fail(StatusCode::TOO_MANY_REQUESTS, "concurrency_limit");
    };
    if !app.providers.rate_limit(id, None).await {
        return fail(StatusCode::TOO_MANY_REQUESTS, "concurrency_limit");
    }
    // Authentication and bounded admission precede reading any uploaded bytes.
    let limit = 4 + 65536 + number(&api.limits.request_bytes).unwrap_or(0);
    let raw = match tokio::time::timeout(
        std::time::Duration::from_secs(wire::uint(&api.limits.header_seconds).unwrap_or(1).min(30)),
        axum::body::to_bytes(request.into_body(), limit),
    )
    .await
    {
        Ok(Ok(v)) => v,
        _ => return fail(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"),
    };
    let prepared = match parse_envelope(&raw, &api, &tariff) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "invalid_envelope"),
    };
    drop(permit); // Upload admission must not block recovery of a dispatched operation.
    let hmac = match wire::operation_hmac_v2(
        &token.secret,
        &app.config.binding.deployment_id,
        &app.config.binding.pool,
        &id.to_string(),
        &operation.to_string(),
        &prepared.metadata.binding_hash,
        &tariff.tariff_hash,
        &prepared.metadata.method,
        &prepared.metadata.target,
        &prepared.metadata.headers,
        &prepared.body,
    ) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "invalid_envelope"),
    };
    match app.ledger.operation(id, operation).await {
        Ok(old) => {
            return fail(
                StatusCode::CONFLICT,
                if old.request_hmac != hmac || old.endpoint != uri.path() {
                    "idempotency_conflict"
                } else if matches!(old.state.as_str(), "DONE" | "WAIVED_OPERATOR_LOSS") {
                    "response_not_replayable"
                } else {
                    "operation_in_progress"
                },
            )
        }
        Err(ledger::LedgerError::NotFound) => {}
        Err(_) => return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable"),
    }
    if !app
        .api_available(saved.quote.body.api.as_ref().unwrap())
        .await
    {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable");
    }
    let adapter = app
        .providers
        .gateway
        .iter()
        .find(|p| p.0 == api)
        .map(|p| p.1.clone());
    let dispatcher = app.providers.dispatcher.clone();
    if adapter.is_none() && dispatcher.is_none() {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable");
    }
    let op = match app
        .ledger
        .reserve_operation(&NewOperation {
            request_id: id,
            operation_id: operation,
            request_hmac: hmac,
            endpoint: uri.path().into(),
            model: String::new(),
            reservation_nano: prepared.reservation_nano,
        })
        .await
    {
        Ok(v) => v,
        Err(e) => {
            let (status, code) = match e {
                ledger::LedgerError::Conflict("budget_exhausted") => {
                    (StatusCode::PAYMENT_REQUIRED, "budget_exhausted")
                }
                ledger::LedgerError::Conflict("concurrency_limit") => {
                    (StatusCode::TOO_MANY_REQUESTS, "concurrency_limit")
                }
                ledger::LedgerError::Conflict(code) => (StatusCode::CONFLICT, code),
                _ => (StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable"),
            };
            return fail(status, code);
        }
    };
    let (tx, rx) = mpsc::channel(1);
    let worker = app.clone();
    let secret = zeroize::Zeroizing::new(token.secret);
    tokio::spawn(async move {
        let mut downstream = Some(tx);
        let mut terminal = false;
        let result: Result<()> = async {
            let n = zkapi_solana_types::FieldElement::from_bytes(session.nullifier)?;
            let started = std::time::Instant::now();
            let attempt = worker
                .ledger
                .begin_dispatch(id, operation, worker.providers.owner(), || async {
                    worker
                        .chain
                        .assert_live(n, None)
                        .await
                        .map(|_| ())
                        .map_err(crate::api::live_error)
                })
                .await?;
            if worker.ledger.claim_dispatch(&attempt).await.is_err() {
                worker
                    .ledger
                    .finish_attempt(
                        &attempt,
                        wire::sha256(b"gateway owner stopped before egress"),
                    )
                    .await?;
                anyhow::bail!("dispatch claim denied")
            }
            let budget = std::time::Duration::from_secs(wire::uint(&api.limits.execution_seconds)?)
                .saturating_sub(started.elapsed());
            let (provider_tx, mut provider_rx) = mpsc::channel::<Vec<u8>>(1);
            let forward = async {
                while let Some(bytes) = provider_rx.recv().await {
                    if matches!(bytes.first(), Some(4 | 5)) {
                        terminal = true;
                    }
                    emit(&mut downstream, bytes).await;
                }
            };
            let dispatch = async {
                if let Some(dispatcher) = dispatcher {
                    dispatcher
                        .gateway(attempt.clone(), prepared, *secret, Some(provider_tx))
                        .await
                } else {
                    Ok(adapter
                        .context("gateway adapter")?
                        .dispatch_once(prepared, Some(provider_tx), budget)
                        .await)
                }
            };
            let (observation, ()) = tokio::join!(dispatch, forward);
            let observation = observation?;
            worker
                .ledger
                .finish_attempt(
                    &attempt,
                    wire::sha256(b"one-shot gateway future returned; no retry"),
                )
                .await?;
            if let Some(code) = &observation.error {
                terminal = true;
                emit(
                    &mut downstream,
                    frame(
                        5,
                        &serde_jcs::to_vec(
                            &json!({"code":code,"request_id":id,"operation_id":operation}),
                        )?,
                    ),
                )
                .await;
            }
            if let Some(usage) = &observation.usage {
                let observed = crate::quote::calculate_charge(&tariff, usage)?;
                let receipt = worker.gateway_receipt(&session, &op, Some(&observation), &tariff)?;
                worker
                    .ledger
                    .complete_operation(
                        id,
                        operation,
                        OperationOutcome::Metered {
                            observed_nano: observed,
                        },
                        &receipt,
                    )
                    .await?;
            } else {
                worker.ledger.mark_operation_unknown(id, operation).await?;
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            if !terminal {
                emit(&mut downstream,frame(5,&serde_jcs::to_vec(&json!({"code":"upstream_transport_error","request_id":id,"operation_id":operation})).unwrap())).await;
            }
            let _ = worker.ledger.mark_operation_unknown(id, operation).await;
            let _ = worker.ledger.close(id).await;
        }
        drop(downstream);
        let _ = worker.advance(id).await;
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), rx))
    });
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", RESPONSE_MEDIA)
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap();
    operation_headers(&mut response, id, operation);
    response
}
impl App {
    pub(crate) fn gateway_receipt(
        &self,
        s: &ledger::SessionRecord,
        op: &ledger::OperationRecord,
        observation: Option<&Observation>,
        tariff: &Tariff,
    ) -> Result<ledger::ReceiptRecord> {
        let api = tariff
            .api
            .as_ref()
            .and_then(|a| a.v2())
            .context("gateway receipt binding")?;
        let usage = observation.and_then(|o| o.usage.as_ref());
        let observed = usage
            .map(|u| crate::quote::calculate_charge(tariff, u))
            .transpose()?;
        let charged = observed.unwrap_or(0).min(op.reservation_nano);
        self.sign_provider_receipt(crate::receipts::ReceiptBody {
            gateway: Some(crate::receipts::GatewayReceiptFields::for_operation(
                api,
                &op.request_hmac,
                observation.and_then(|o| o.completion.clone()),
            )?),
            version: "3".into(),
            receipt_id: Uuid::new_v4().to_string(),
            deployment_id: self.config.binding.deployment_id.clone(),
            pool: self.config.binding.pool.clone(),
            request_id: s.request_id.to_string(),
            operation_id: Some(op.operation_id.to_string()),
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: crate::provider_runtime::now().to_string(),
            evidence_kind: if observed.is_some() {
                "PROXY_USAGE"
            } else {
                "UNKNOWN_OPERATOR_LOSS"
            }
            .into(),
            provider_request_id: None,
            provider_evidence_digest: observation.and_then(|o| o.evidence_digest.clone()),
            tariff_hash: tariff.tariff_hash.clone(),
            usage: usage
                .map(|u| {
                    u.iter()
                        .map(|u| crate::receipts::UsageUnit {
                            unit: u.unit.clone(),
                            count: u.count.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            provider_reported_usd: None,
            reservation_nano_usdc: op.reservation_nano.to_string(),
            observed_nano_usdc: observed.map(|v| v.to_string()),
            charged_nano_usdc: charged.to_string(),
            operator_loss_nano_usdc: observed.map(|v| (v - charged).to_string()),
            reason: if observed.is_some() {
                "metered"
            } else {
                "waived_unknown"
            }
            .into(),
        })
    }
}
