//! Native compatibility routes. Detached dispatch ownership survives downstream
//! disconnect; inference bytes never enter the control ledger.
use crate::{
    api::App,
    ledger::{self, NewOperation, OperationOutcome},
    proxy::{self, Endpoint, RelayEvent},
    wire,
};
use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::{convert::Infallible, net::SocketAddr, sync::Arc};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use uuid::Uuid;

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(infer))
        .route("/v1/responses", post(infer))
        .route("/v1/messages", post(infer))
        .route("/v1/messages/count_tokens", post(infer))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(app)
}
fn error(path: &str, status: StatusCode, code: &str) -> Response {
    let envelope = if path.starts_with("/v1/messages") {
        json!({"type":"error","error":{"type":"invalid_request_error","message":code}})
    } else {
        json!({"error":{"type":"invalid_request_error","code":code,"message":code}})
    };
    let mut response = (status, Json(envelope)).into_response();
    if let Ok(header) = HeaderValue::from_str(code) {
        response.headers_mut().insert("x-zkapi-error-code", header);
    }
    response
}
fn operation_headers(response: &mut Response, id: Uuid, operation: Uuid) {
    response.headers_mut().insert(
        "x-zkapi-operation-id",
        HeaderValue::from_str(&operation.to_string()).unwrap(),
    );
    response.headers_mut().insert(
        "x-zkapi-status-url",
        HeaderValue::from_str(&format!("/zkapi/v1/sessions/{id}/operations/{operation}")).unwrap(),
    );
}
fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    if headers.get_all(name).iter().count() != 1 {
        return None;
    }
    headers.get(name)?.to_str().ok()
}
fn boundary(app: &App, headers: &HeaderMap) -> bool {
    let Ok(expected) = reqwest::Url::parse(&app.config.binding.inference_api_origin) else {
        return false;
    };
    let authority = expected
        .as_str()
        .split_once("://")
        .unwrap()
        .1
        .trim_end_matches('/')
        .to_owned();
    if single(headers, "host") != Some(authority.as_str()) {
        return false;
    }
    if headers.contains_key("origin")
        && single(headers, "origin") != Some(app.config.binding.inference_api_origin.as_str())
        && single(headers, "origin") != Some(app.config.binding.control_api_origin.as_str())
    {
        return false;
    }
    true
}
fn credential(headers: &HeaderMap, anthropic: bool) -> wire::Result<wire::ProxyCredential> {
    let token = match (
        headers.contains_key("authorization"),
        headers.contains_key("x-api-key"),
    ) {
        (true, false) => single(headers, "authorization").and_then(|s| s.strip_prefix("Bearer ")),
        (false, true) if anthropic => single(headers, "x-api-key"),
        _ => None,
    }
    .ok_or(wire::ValidationError::Unauthorized)?;
    wire::parse_proxy_token(token)
}
async fn models(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !boundary(&app, &headers) {
        return error("/v1/models", StatusCode::BAD_REQUEST, "invalid_origin");
    }
    let timestamp = crate::provider_runtime::now();
    let data = app
        .config
        .runtime
        .providers
        .proxy
        .iter()
        .flat_map(|p| p.models.iter())
        .filter(|m| {
            app.config.runtime.tariffs.iter().any(|t| {
                t.provider == m.provider
                    && t.model == m.model
                    && crate::quote::tariff_valid_at(t, timestamp).unwrap_or(false)
            })
        })
        .map(|m| json!({"id":m.model,"object":"model","created":0,"owned_by":m.provider.as_str()}))
        .collect::<Vec<_>>();
    Json(json!({"object":"list","data":data})).into_response()
}
async fn infer(
    State(app): State<Arc<App>>,
    OriginalUri(uri): OriginalUri,
    ip: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>,
    headers: HeaderMap,
    bytes: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let path = uri.path();
    let fail = |status, code| error(path, status, code);
    if uri.query().is_some() || !boundary(&app, &headers) {
        return fail(StatusCode::BAD_REQUEST, "invalid_origin_or_query");
    }
    if single(&headers, "content-type").and_then(|v| v.split(';').next())
        != Some("application/json")
        || (headers.contains_key("content-encoding")
            && single(&headers, "content-encoding") != Some("identity"))
    {
        return fail(StatusCode::BAD_REQUEST, "invalid_content_type");
    }
    let endpoint = match Endpoint::from_path(path) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::NOT_FOUND, "unsupported_endpoint"),
    };
    let token = match credential(&headers, path.starts_with("/v1/messages")) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::UNAUTHORIZED, "invalid_credential"),
    };
    let operation = match single(&headers, "idempotency-key").map(wire::uuid) {
        Some(Ok(v)) => v,
        _ => return fail(StatusCode::BAD_REQUEST, "idempotency_key_required"),
    };
    let id = token.request_id;
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
    if !app
        .providers
        .rate_limit(id, ip.ok().map(|a| a.0.ip()))
        .await
    {
        return fail(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let raw = match bytes {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
    };
    let version = if path.starts_with("/v1/messages") {
        match single(&headers, "anthropic-version") {
            Some("2023-06-01") => "2023-06-01",
            _ => return fail(StatusCode::BAD_REQUEST, "unsupported_api_version"),
        }
    } else {
        if headers.contains_key("anthropic-version") {
            return fail(StatusCode::BAD_REQUEST, "unsupported_api_version");
        }
        ""
    };
    let hmac = match wire::operation_hmac(&token.secret, "POST", path, version, &raw) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::BAD_REQUEST, "invalid_request"),
    };
    // Recovery uses the saved keyed digest before current catalog/session checks.
    match app.ledger.operation(id, operation).await {
        Ok(old) => {
            let code = if old.request_hmac != hmac || old.endpoint != path {
                "idempotency_conflict"
            } else if matches!(old.state.as_str(), "DONE" | "WAIVED_OPERATOR_LOSS") {
                "response_not_replayable"
            } else {
                "operation_in_progress"
            };
            let mut response = fail(StatusCode::CONFLICT, code);
            operation_headers(&mut response, id, operation);
            return response;
        }
        Err(ledger::LedgerError::NotFound) => {}
        Err(_) => return fail(StatusCode::SERVICE_UNAVAILABLE, "ledger_unavailable"),
    }
    let request: wire::SessionCreate = match wire::strict_parse(&session.request_transcript) {
        Ok(v) => v,
        Err(_) => return fail(StatusCode::SERVICE_UNAVAILABLE, "ledger_unavailable"),
    };
    let provider = &request.quote.body.provider;
    if !app.providers.available(&app.ledger, provider).await {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "provider_suspended");
    }
    let Some(profile) = app
        .config
        .runtime
        .providers
        .proxy
        .iter()
        .filter(|p| p.provider == *provider)
        .flat_map(|p| &p.models)
        .find(|p| p.model == request.quote.body.models[0])
    else {
        return fail(StatusCode::BAD_REQUEST, "adapter_unavailable");
    };
    let Some(tariff) = app
        .config
        .runtime
        .tariffs
        .iter()
        .find(|t| t.tariff_hash == request.quote.body.tariff_hash)
        .cloned()
    else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "tariff_unavailable");
    };
    let prepared = match proxy::validate(endpoint, &raw, profile, &tariff) {
        Ok(p) => p,
        Err(proxy::ProxyError::TooLarge) => {
            return fail(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large")
        }
        Err(_) => return fail(StatusCode::BAD_REQUEST, "unsupported_metering"),
    };
    let adapter = app
        .providers
        .proxy
        .iter()
        .find(|(p, _)| p == provider)
        .map(|(_, a)| a.clone());
    let dispatcher = app.providers.dispatcher.clone();
    if adapter.is_none() && dispatcher.is_none() {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "adapter_unavailable");
    }
    let dispatch_provider = provider.clone();
    let op = match app
        .ledger
        .reserve_operation(&NewOperation {
            request_id: id,
            operation_id: operation,
            request_hmac: hmac,
            endpoint: path.into(),
            model: profile.model.clone(),
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
                ledger::LedgerError::Conflict("session_expired") => {
                    (StatusCode::GONE, "session_expired")
                }
                ledger::LedgerError::Conflict("concurrency_limit") => {
                    (StatusCode::TOO_MANY_REQUESTS, "concurrency_limit")
                }
                ledger::LedgerError::Conflict("count_tokens_rate_limit") => {
                    (StatusCode::TOO_MANY_REQUESTS, "count_tokens_rate_limit")
                }
                ledger::LedgerError::Conflict(code) => (StatusCode::CONFLICT, code),
                _ => (StatusCode::SERVICE_UNAVAILABLE, "ledger_unavailable"),
            };
            let mut response = fail(status, code);
            if status == StatusCode::CONFLICT {
                operation_headers(&mut response, id, operation);
            }
            return response;
        }
    };
    let (tx, mut rx) = mpsc::channel(32);
    let worker = app.clone();
    tokio::spawn(async move {
        let mut downstream = Some(tx);
        let result: anyhow::Result<()> = async {
            let n = zkapi_solana_types::FieldElement::from_bytes(session.nullifier)?;
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
                        wire::sha256(b"provider owner returned before egress"),
                    )
                    .await?;
                worker.ledger.mark_operation_unknown(id, operation).await?;
                anyhow::bail!("dispatch claim denied");
            }
            let streaming = prepared.streaming;
            let (provider_tx, mut provider_rx) = mpsc::channel(32);
            let forward = async {
                while let Some(event) = provider_rx.recv().await {
                    if let RelayEvent::Head {
                        provider_request_id: Some(reference),
                        ..
                    } = &event
                    {
                        // Retain lookup identity even while the downstream has
                        // disconnected and the upstream stream is still running.
                        let _ = worker
                            .ledger
                            .record_provider_request(id, operation, reference)
                            .await;
                    }
                    if streaming && matches!(&event, RelayEvent::Head { status: 200, .. }) {
                        let _ = worker.ledger.mark_streaming(id, operation).await;
                    }
                    if let Some(sender) = &downstream {
                        if !matches!(
                            tokio::time::timeout(
                                std::time::Duration::from_millis(250),
                                sender.send(event)
                            )
                            .await,
                            Ok(Ok(()))
                        ) {
                            downstream = None;
                        }
                    }
                }
            };
            let dispatch = async {
                if let Some(dispatcher) = dispatcher {
                    dispatcher
                        .proxy(
                            dispatch_provider,
                            attempt.clone(),
                            prepared,
                            Some(provider_tx),
                        )
                        .await
                } else {
                    Ok(adapter
                        .as_ref()
                        .expect("adapter checked")
                        .dispatch_once(prepared, Some(provider_tx))
                        .await)
                }
            };
            let (observation, ()) = tokio::join!(dispatch, forward);
            // A missing child response is uncertain: retain the unquiesced attempt.
            // Only a separately verified process fence may make it settleable.
            let observation = observation?;
            // Fixed enum/status/timing projection only: no provider body, error,
            // credential, request identity or billing fields enter diagnostics.
            eprintln!("{}", observation.diagnostic_event());
            // The network future has ended and owns no retry path. Only this owner
            // can attest finished; a replacement process cannot invent this evidence.
            worker
                .ledger
                .finish_attempt(
                    &attempt,
                    wire::sha256(b"one-shot provider future returned; no retry"),
                )
                .await?;
            if let Some(reference) = &observation.provider_request_id {
                worker
                    .ledger
                    .record_provider_request(id, operation, reference)
                    .await?;
            }
            if let Some(usage) = &observation.usage {
                let observed = crate::quote::calculate_charge(&tariff, usage)?;
                let receipt = worker.proxy_receipt(&session, &op, Some(&observation), &tariff)?;
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
            if result
                .as_ref()
                .err()
                .and_then(|e| e.downcast_ref::<ledger::LedgerError>())
                .is_some_and(|e| matches!(e, ledger::LedgerError::Conflict("exit_consumed")))
            {
                let _ = worker
                    .ledger
                    .record_exit(id, "exit_before_proxy_egress")
                    .await;
            }
            let _ = worker.ledger.mark_operation_unknown(id, operation).await;
            let _ = worker.ledger.close(id).await;
        }
        drop(downstream);
        let _ = worker.advance(id).await;
    });
    let (status, content_type) = match rx.recv().await {
        Some(RelayEvent::Head {
            status,
            content_type,
            ..
        }) => (status, content_type),
        _ => {
            let mut response = fail(StatusCode::SERVICE_UNAVAILABLE, "operation_unavailable");
            operation_headers(&mut response, id, operation);
            return response;
        }
    };
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Some(RelayEvent::Data(bytes)) => return Some((Ok::<_, Infallible>(bytes), rx)),
                Some(RelayEvent::Head { .. }) => {}
                None => return None,
            }
        }
    });
    let mut response = Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap();
    operation_headers(&mut response, id, operation);
    if status >= 400 {
        response.headers_mut().insert(
            "x-zkapi-error-code",
            HeaderValue::from_static("provider_unavailable"),
        );
    }
    response
}
