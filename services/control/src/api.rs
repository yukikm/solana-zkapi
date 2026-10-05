//! Axum control routes. Raw credentials and inference content are never persisted or logged.
use crate::{
    chain::ChainClient,
    config::ValidatedConfig,
    crypto,
    ledger::{
        self, Ledger, LedgerError, NewSession, PoolIdentity, QuoteRecord, SessionRecord,
        SettlementTarget,
    },
    quote,
    signer::{self, SignTarget},
    signer_client::SignerClient,
    wire::{self, ValidationError},
};
use axum::{
    body::Bytes,
    extract::{rejection::BytesRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;
use zkapi_solana_types::FieldElement;

pub struct App {
    pub config: ValidatedConfig,
    pub ledger: Ledger,
    pub chain: ChainClient,
    pub signer: SignerClient,
    pub providers: crate::provider_runtime::ProviderRuntime,
    rate: Mutex<(u64, u32)>,
}
#[derive(Debug)]
pub struct ApiError(pub(crate) StatusCode, pub(crate) &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0,Json(json!({"error":{"code":self.1,"message":self.1,"retriable":self.0==StatusCode::SERVICE_UNAVAILABLE}}))).into_response()
    }
}
impl From<ValidationError> for ApiError {
    fn from(e: ValidationError) -> Self {
        match e {
            ValidationError::Invalid(_) => Self(StatusCode::BAD_REQUEST, "invalid_request"),
            ValidationError::Unauthorized => Self(StatusCode::UNAUTHORIZED, "invalid_credential"),
            ValidationError::Unavailable(_) | ValidationError::TrustMismatch(_) => {
                Self(StatusCode::SERVICE_UNAVAILABLE, "chain_unavailable")
            }
            ValidationError::Conflict(m) => Self(
                StatusCode::CONFLICT,
                match m {
                    "exit consumed" => "exit_consumed",
                    "stale root" => "stale_root",
                    "quote expired" => "quote_expired",
                    _ => "state_conflict",
                },
            ),
            ValidationError::TooLarge => Self(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
        }
    }
}
impl From<LedgerError> for ApiError {
    fn from(e: LedgerError) -> Self {
        match e {
            LedgerError::Conflict(code) => Self(StatusCode::CONFLICT, code),
            LedgerError::Invalid(_) => Self(StatusCode::BAD_REQUEST, "invalid_request"),
            LedgerError::NotFound => Self(StatusCode::NOT_FOUND, "not_found"),
            _ => Self(StatusCode::SERVICE_UNAVAILABLE, "ledger_unavailable"),
        }
    }
}
type Result<T> = std::result::Result<T, ApiError>;
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "signer_unavailable")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs()
}
pub(crate) fn live_error(e: ValidationError) -> LedgerError {
    match e {
        ValidationError::Conflict("exit consumed") => LedgerError::Conflict("exit_consumed"),
        ValidationError::Conflict("stale root") => LedgerError::Conflict("stale_root"),
        ValidationError::Conflict(_) => LedgerError::Conflict("pool_paused"),
        _ => LedgerError::Unavailable("chain_unavailable"),
    }
}
fn body<T: serde::de::DeserializeOwned>(
    headers: &HeaderMap,
    bytes: std::result::Result<Bytes, BytesRejection>,
) -> Result<T> {
    if headers.get_all("content-type").iter().count() != 1
        || headers
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|s| s.split(';').next() != Some("application/json"))
        || headers
            .get("content-encoding")
            .is_some_and(|s| s != "identity")
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_content_type"));
    }
    wire::strict_parse(
        &bytes.map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"))?,
    )
    .map_err(Into::into)
}
fn credential(headers: &HeaderMap) -> Result<wire::ControlCredential> {
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(ValidationError::Unauthorized.into());
    }
    wire::parse_control_token(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(ValidationError::Unauthorized)?,
    )
    .map_err(Into::into)
}
fn hexfield(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}
fn signature_json(bytes: &[u8]) -> Result<Value> {
    if bytes.len() != 96 {
        return Err(unavailable());
    }
    Ok(
        json!({"r_x":format!("0x{}",hex::encode(&bytes[..32])),"r_y":format!("0x{}",hex::encode(&bytes[32..64])),"s":format!("0x{}",hex::encode(&bytes[64..]))}),
    )
}

impl App {
    /// Schema migration is a separate command/credential; startup only verifies it.
    pub async fn connect(config: ValidatedConfig, database_url: &str) -> anyhow::Result<Arc<Self>> {
        config.validate_database(database_url)?;
        let providers = crate::provider_runtime::ProviderRuntime::connect(
            &config.runtime.providers,
            config.runtime.local_test_only,
        )
        .await?;
        let chain = ChainClient::new(
            config.runtime.primary_rpc.clone(),
            config.runtime.secondary_rpc.clone(),
            config.runtime.indexer_origin.clone(),
            config.trusted.clone(),
        )?;
        let chain_ready = match chain.startup().await {
            Ok(()) => true,
            Err(ValidationError::Unavailable(_) | ValidationError::Conflict("pool paused")) => {
                false
            }
            Err(error) => return Err(error.into()),
        };
        let identity = PoolIdentity {
            pool: config.signer.pool,
            deployment_id: config.binding.deployment_id.clone(),
            manifest_hash: wire::hash(&config.runtime.trusted_manifest_hash)?,
            authorization_config: json!({"signer":config.signer}),
        };
        let ledger = Ledger::connect(database_url, &identity).await?;
        let signer = SignerClient {
            socket: config.runtime.signer_socket.clone(),
        };
        // Pool registration precedes signer startup in local provisioning. Never
        // accept until its independent journal and this primary reconcile.
        signer.reconcile(&config.signer).await?;
        for tariff in &config.runtime.tariffs {
            ledger
                .store_tariff(
                    wire::hash(&tariff.tariff_hash)?,
                    &wire::jcs(&quote::tariff_body(tariff)?)?,
                )
                .await?;
        }
        ledger
            .set_accepting(
                chain_ready && !crate::provider_runtime::abandoned_owner_exists(&ledger).await?,
            )
            .await?;
        Ok(Arc::new(Self {
            config,
            ledger,
            chain,
            signer,
            providers,
            rate: Mutex::new((0, 0)),
        }))
    }
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/zkapi/v1/config", get(config))
            .route("/zkapi/v1/catalog", get(catalog))
            .route("/zkapi/v1/attestation", get(attestation))
            .route("/zkapi/v1/tariffs/{hash}", get(tariff))
            .route("/zkapi/v1/quotes", post(issue_quote))
            .route("/zkapi/v1/sessions", post(create_session))
            .route("/zkapi/v1/sessions/{id}", get(session_status))
            .route("/zkapi/v1/sessions/{id}/close", post(close_session))
            .route(
                "/zkapi/v1/sessions/{id}/operations/{operation}",
                get(operation_status),
            )
            .route("/zkapi/v1/sessions/{id}/receipts", get(receipts))
            .route("/zkapi/v1/withdraw/clearance", post(clearance))
            .route("/zkapi/v1/nullifiers/{nullifier}", get(nullifier_status))
            .fallback(|| async { ApiError(StatusCode::NOT_FOUND, "unsupported_endpoint") })
            .layer(DefaultBodyLimit::max(16 * 1024))
            .with_state(self.clone())
            .merge(crate::inference::router(self.clone()))
    }
    async fn authenticate(&self, id: Uuid, headers: &HeaderMap) -> Result<SessionRecord> {
        let token = credential(headers)?;
        if token.request_id != id {
            return Err(ValidationError::Unauthorized.into());
        }
        let s = self.ledger.session(id).await?;
        if !bool::from(token.secret_hash.ct_eq(&s.control_secret_hash)) {
            return Err(ValidationError::Unauthorized.into());
        }
        Ok(s)
    }
    async fn limit(&self) -> Result<()> {
        let mut rate = self.rate.lock().await;
        let t = now();
        if rate.0 != t {
            *rate = (t, 0)
        }
        rate.1 += 1;
        if rate.1 > 60 {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
        }
        Ok(())
    }
    pub async fn status(&self, s: &SessionRecord) -> Result<Value> {
        let mut v = json!({"request_id":s.request_id.to_string(),"mode":s.mode,"state":s.state,"cap_micro_usdc":s.cap_micro.to_string()});
        if let Some(t) = s.activated_at {
            v["issued_at"] = t.to_string().into();
        }
        if let Some(t) = s.expires_at {
            v["expires_at"] = t.to_string().into();
        }
        if s.state == "SETTLED" {
            let r = self.ledger.settlement(s.request_id).await?;
            let sig = r.state_signature.ok_or_else(unavailable)?;
            signer::verify_signature(
                &self.config.signer.state_key,
                r.target.signature_message,
                &sig,
            )
            .map_err(|_| unavailable())?;
            v["settlement"] = json!({"charge_micro_usdc":r.target.charge_micro.to_string(),"next_commitment":{"x":hexfield(&r.target.next_commitment_x),"y":hexfield(&r.target.next_commitment_y)},"next_anchor":hexfield(&r.target.next_anchor),"blind_delta_srv":hexfield(&r.target.blind_delta),"next_state_signature":signature_json(&sig)?});
        }
        Ok(v)
    }
    pub async fn advance(&self, id: Uuid) -> Result<()> {
        self.ledger.recover_abandoned_operations(id).await?;
        self.ledger.recover_abandoned_direct(id).await?;
        let mut s = self.ledger.session(id).await?;
        if s.mode != "proxy" && s.state == "ACTIVE" {
            let n = FieldElement::from_bytes(s.nullifier).map_err(|_| unavailable())?;
            if let Err(error) = self.chain.assert_live(n, None).await {
                if matches!(error, ValidationError::Conflict("exit consumed")) {
                    self.ledger
                        .record_exit(id, "exit_during_direct_use")
                        .await?;
                }
                s = self.ledger.close(id).await?;
            }
        }
        if s.mode != "proxy" && s.state == "RESERVED" && s.writer_epoch < self.ledger.writer_epoch()
        {
            s = self.ledger.close(id).await?;
        }
        if s.state == "RESERVED" && s.mode == "proxy" && !s.close_requested {
            let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
            let n = FieldElement::from_bytes(s.nullifier).map_err(|_| unavailable())?;
            match self
                .ledger
                .activate_proxy(
                    id,
                    wire::uint(&request.quote.body.session_ttl_seconds)? as i64,
                    || async {
                        self.chain
                            .assert_live(n, None)
                            .await
                            .map(|_| ())
                            .map_err(live_error)
                    },
                )
                .await
            {
                Ok(v) => s = v,
                Err(LedgerError::Conflict("exit_consumed")) => {
                    self.ledger.record_exit(id, "exit_consumed").await?;
                    s = self.ledger.session(id).await?
                }
                Err(e) => return Err(e.into()),
            }
        }
        if s.state == "ACTIVE"
            && (s.close_requested || s.expires_at.is_some_and(|t| now() >= t as u64))
        {
            s = self.ledger.close(id).await?;
        }
        if matches!(s.state.as_str(), "DRAINING" | "RECONCILING") {
            self.recover_provider_operations(&s)
                .await
                .map_err(|_| unavailable())?;
            for operation in self.ledger.operations_for_session(id).await? {
                if operation.state == "RESERVED" {
                    let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
                    let receipt_id = Uuid::new_v4();
                    let b = crate::receipts::ReceiptBody {
                        version: "1".into(),
                        receipt_id: receipt_id.to_string(),
                        deployment_id: self.config.binding.deployment_id.clone(),
                        pool: self.config.binding.pool.clone(),
                        request_id: id.to_string(),
                        operation_id: Some(operation.operation_id.to_string()),
                        billing_effect: "charge".into(),
                        related_receipt_hash: None,
                        observed_at: now().to_string(),
                        evidence_kind: "NOT_DISPATCHED".into(),
                        provider_request_id: None,
                        provider_evidence_digest: None,
                        tariff_hash: request.quote.body.tariff_hash,
                        usage: vec![],
                        provider_reported_usd: None,
                        reservation_nano_usdc: operation.reservation_nano.to_string(),
                        observed_nano_usdc: Some("0".into()),
                        charged_nano_usdc: "0".into(),
                        operator_loss_nano_usdc: Some("0".into()),
                        reason: "not_dispatched".into(),
                    };
                    let signed = crate::receipts::Receipt::sign(b, &self.config.receipt_key)
                        .map_err(|_| unavailable())?;
                    let record = ledger::ReceiptRecord {
                        sequence: 0,
                        receipt_id,
                        request_id: id,
                        operation_id: Some(operation.operation_id),
                        billing_effect: "charge".into(),
                        canonical_body: signed.body.canonical_bytes().map_err(|_| unavailable())?,
                        receipt_hash: wire::hash(&signed.receipt_hash)?,
                        signature: Some(wire::base64_exact::<64>(&signed.signature)?.to_vec()),
                    };
                    self.ledger
                        .complete_operation(
                            id,
                            operation.operation_id,
                            ledger::OperationOutcome::NotDispatched,
                            &record,
                        )
                        .await?;
                }
            }
        }
        if s.mode != "proxy"
            && matches!(
                s.state.as_str(),
                "ISSUING" | "ISSUANCE_UNKNOWN" | "DRAINING" | "RECONCILING"
            )
        {
            self.advance_direct(&s).await.map_err(|_| unavailable())?;
            s = self.ledger.session(id).await?;
        }
        if s.state == "DRAINING" && s.mode == "proxy" {
            s = self.ledger.reconcile(id).await?;
        }
        if s.state == "RECONCILING" {
            let request: wire::SessionCreate = wire::strict_parse(&s.request_transcript)?;
            let charge = zkapi_solana_types::amount::settle_session(
                [s.charged_nano],
                self.config.binding.cap,
            )
            .map_err(|_| unavailable())?;
            let d = signer::prepare_settlement(
                self.config.signer.binding,
                s.nullifier,
                *request.public_inputs[10].as_bytes(),
                *request.public_inputs[11].as_bytes(),
                charge.get(),
            )
            .map_err(|_| unavailable())?;
            let target = SettlementTarget {
                charge_micro: d.charge_micro,
                next_anchor: d.next_anchor,
                next_commitment_x: d.next_commitment_x,
                next_commitment_y: d.next_commitment_y,
                blind_delta: d.blind_delta,
                anchor_randomness: d.anchor_randomness,
                signature_message: d.signature_message,
                message_digest: d.message_digest,
            };
            match self.ledger.prepare_settlement(id, &target).await {
                Ok(_) => {}
                Err(LedgerError::Conflict("settlement_target_conflict")) => {}
                Err(e) => return Err(e.into()),
            }
            crate::faults::checkpoint("sign_pending");
            s = self.ledger.session(id).await?;
        }
        if s.state == "SIGN_PENDING" {
            let r = self.ledger.settlement(id).await?;
            let sig = self
                .signer
                .sign(
                    SignTarget::Settlement { request_id: id },
                    &self.config.signer.state_key,
                    r.target.signature_message,
                )
                .await
                .map_err(|_| unavailable())?;
            crate::faults::checkpoint("signature");
            self.ledger.save_settlement_signature(id, &sig).await?;
            crate::faults::checkpoint("settled");
        }
        Ok(())
    }
    pub async fn recover(&self) -> Result<()> {
        if self.signer.reconcile(&self.config.signer).await.is_err() {
            self.ledger.set_accepting(false).await?;
            return Err(unavailable());
        }
        // Chain health gates new work, not completion of already accepted work.
        // Keep recovering frozen settlement/clearance targets during an outage.
        let chain_health = self.chain.startup().await;
        let old_owner = crate::provider_runtime::abandoned_owner_exists(&self.ledger)
            .await
            .map_err(|_| unavailable())?;
        self.ledger
            .set_accepting(chain_health.is_ok() && !old_owner)
            .await?;
        for s in self.ledger.pending_sessions().await? {
            let _ = self.advance(s.request_id).await;
        }
        for c in self.ledger.pending_clearances().await? {
            let signature = self
                .signer
                .sign(
                    SignTarget::Clearance {
                        nullifier: c.nullifier,
                    },
                    &self.config.signer.clearance_key,
                    c.signature_message,
                )
                .await
                .map_err(|_| unavailable())?;
            self.ledger
                .save_clearance_signature(c.nullifier, &signature)
                .await?;
        }
        chain_health?;
        Ok(())
    }
}
async fn config(State(a): State<Arc<App>>) -> Json<Value> {
    Json(a.config.runtime.manifest.clone())
}
async fn catalog(State(a): State<Arc<App>>) -> Json<Value> {
    let timestamp = now();
    let mut models = Vec::new();
    for t in &a.config.runtime.tariffs {
        if !quote::tariff_valid_at(t, timestamp).unwrap_or(false) {
            continue;
        }
        let mode = match t.provider {
            wire::Provider::Oa => wire::Mode::DirectOa,
            wire::Provider::Openrouter if t.model == "*" => wire::Mode::DirectOpenrouter,
            _ => wire::Mode::Proxy,
        };
        if !a.adapter_available(&mode, &t.provider, &t.model).await {
            continue;
        }
        let endpoints = a
            .config
            .runtime
            .providers
            .proxy
            .iter()
            .filter(|p| p.provider == t.provider)
            .flat_map(|p| &p.models)
            .find(|m| m.model == t.model)
            .map(|m| m.endpoints.iter().map(|e| e.path()).collect::<Vec<_>>())
            .unwrap_or_default();
        models.push(json!({"model":t.model,"provider":t.provider,"modes":[mode],"endpoints":endpoints,"modalities":["text"],"tariff_hash":t.tariff_hash}));
    }
    Json(json!({"models":models}))
}
async fn attestation(State(a): State<Arc<App>>) -> Json<Value> {
    let mut value = json!({"deployment_id":a.config.binding.deployment_id,"manifest_hash":a.config.runtime.trusted_manifest_hash,"direct_oa_enabled":false});
    if let Some(crate::direct::DirectConfig::Oa {
        issuer_base,
        verifier_base,
        ..
    }) = a
        .config
        .runtime
        .providers
        .direct
        .iter()
        .find(|d| d.provider() == wire::Provider::Oa)
    {
        value["direct_oa_enabled"] = true.into();
        value["issuer"] = issuer_base.clone().into();
        value["verifier"] = verifier_base.clone().into();
        value["evidence"] =
            "Configured issuer/verifier pins; live provider acceptance remains required".into();
    }
    Json(value)
}
async fn tariff(State(a): State<Arc<App>>, Path(hash): Path<String>) -> Result<Json<Value>> {
    wire::hash(&hash)?;
    let t = a
        .config
        .runtime
        .tariffs
        .iter()
        .find(|t| t.tariff_hash == hash)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "tariff_not_found"))?;
    Ok(Json(serde_json::to_value(t).map_err(|_| unavailable())?))
}
async fn issue_quote(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    bytes: std::result::Result<Bytes, BytesRejection>,
) -> Result<Json<wire::Quote>> {
    a.limit().await?;
    let r: wire::QuoteRequest = body(&headers, bytes)?;
    if r.mode == wire::Mode::DirectOa {
        let ttl = wire::uint(r.session_ttl_seconds.as_deref().unwrap_or("60"))?;
        if ttl == 0 || ttl > 300 || !ttl.is_multiple_of(60) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "unsupported_lease_duration",
            ));
        }
    }
    if r.models.len() != 1
        || !a
            .adapter_available(&r.mode, &r.provider, &r.models[0])
            .await
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "adapter_unavailable"));
    }
    let timestamp = now();
    let t = a
        .config
        .runtime
        .tariffs
        .iter()
        .find(|t| {
            t.provider == r.provider
                && r.models == [t.model.clone()]
                && quote::tariff_valid_at(t, timestamp).unwrap_or(false)
        })
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "adapter_unavailable"))?;
    let q = quote::issue_quote(&r, t, &a.config.binding, timestamp, &a.config.quote_key)?;
    a.ledger
        .store_quote(&QuoteRecord {
            quote_id: wire::uuid(&q.body.quote_id)?,
            quote_hash: wire::hash(&q.quote_hash)?,
            canonical_body: wire::jcs(&q.body)?,
            signature: wire::base64_exact::<64>(&q.signature)?.to_vec(),
            tariff_hash: wire::hash(&q.body.tariff_hash)?,
            expires_at: wire::uint(&q.body.expires_at)?
                .try_into()
                .map_err(|_| unavailable())?,
        })
        .await?;
    Ok(Json(q))
}
async fn create_session(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    bytes: std::result::Result<Bytes, BytesRejection>,
) -> Result<Response> {
    let r: wire::SessionCreate = body(&headers, bytes)?;
    let c = credential(&headers)?;
    let v = quote::validate_binding(&r, &c, &a.config.binding)?;
    match a.ledger.session(v.request_id).await {
        Ok(s) => {
            if s.request_digest != v.digest || s.request_transcript != v.transcript {
                return Err(ApiError(StatusCode::CONFLICT, "idempotency_conflict"));
            }
            return Ok((StatusCode::OK, Json(a.status(&s).await?)).into_response());
        }
        Err(LedgerError::NotFound) => {}
        Err(e) => return Err(e.into()),
    }
    if !a
        .adapter_available(
            &r.authorization.mode,
            &r.quote.body.provider,
            &r.quote.body.models[0],
        )
        .await
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "adapter_unavailable"));
    }
    let saved = a.ledger.quote(wire::uuid(&r.quote.body.quote_id)?).await?;
    if saved.canonical_body != v.quote_body
        || saved.quote_hash != v.quote_hash
        || saved.signature != wire::base64_exact::<64>(&r.quote.signature)?
    {
        return Err(ApiError(StatusCode::CONFLICT, "quote_conflict"));
    }
    let tariff = a
        .config
        .runtime
        .tariffs
        .iter()
        .find(|t| t.tariff_hash == r.quote.body.tariff_hash)
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "tariff_not_found"))?;
    a.limit().await?;
    crypto::verify_request(&r.public_inputs, &v.proof)?;
    let obs = a
        .chain
        .assert_live(v.nullifier, Some(r.public_inputs[3]))
        .await?;
    quote::validate_new(&r, tariff, now(), obs.root.root)?;
    a.signer
        .reconcile(&a.config.signer)
        .await
        .map_err(|_| unavailable())?;
    let n = NewSession {
        request_id: v.request_id,
        nullifier: *v.nullifier.as_bytes(),
        quote_id: wire::uuid(&r.quote.body.quote_id)?,
        request_digest: v.digest,
        request_transcript: v.transcript,
        control_secret_hash: v.control_hash,
        proxy_secret_hash: v.proxy_hash,
        mode: r.authorization.mode.as_str().into(),
        provider: r.quote.body.provider.as_str().into(),
        cap_micro: r.quote.body.cap_micro_usdc.get(),
        max_concurrency: 4,
    };
    a.ledger
        .reserve_session(&n, || async {
            a.chain
                .assert_live(v.nullifier, Some(r.public_inputs[3]))
                .await
                .map(|_| ())
                .map_err(live_error)
        })
        .await?;
    crate::faults::checkpoint("reserved");
    if r.authorization.mode != wire::Mode::Proxy {
        let app = a.clone();
        // The owner continues retirement/recovery even if the initial caller disconnects.
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = app.issue_direct(v.request_id).await;
            // Own cancellation from the moment an issued key exists, including
            // while it waits in the channel for the HTTP handler. A successful
            // send only transfers ownership; it does not prove delivery.
            let delivery = result.as_ref().ok().and_then(|key| {
                key.as_ref().map(|_| DirectDelivery {
                    app: app.clone(),
                    id: v.request_id,
                    complete: false,
                })
            });
            // Dropping a failed send drops the guard. Duplicate creation returns
            // None and must never close the original caller's live session.
            let _ = tx.send((result, delivery));
        });
        let (key, delivery) =
            match tokio::time::timeout(std::time::Duration::from_secs(45), rx).await {
                Ok(result) => result,
                Err(_) => {
                    a.ledger.close(v.request_id).await?;
                    return Ok((
                        StatusCode::ACCEPTED,
                        Json(a.status(&a.ledger.session(v.request_id).await?).await?),
                    )
                        .into_response());
                }
            }
            .map_err(|_| unavailable())?;
        let key =
            key.map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "provider_unavailable"))?;
        let mut status = a.status(&a.ledger.session(v.request_id).await?).await?;
        if let Some(key) = key {
            status["provider_key"] = key.runtime_key.into();
            status["provider_api_origin"] = key.inference_base.into();
            return direct_response(delivery.expect("key delivery guard"), status);
        }
        return Ok((StatusCode::CREATED, Json(status)).into_response());
    }
    a.advance(v.request_id).await?;
    // Exit racing activation causes a challenger outbox and stops further usage.
    if let Err(e) = a.chain.assert_live(v.nullifier, None).await {
        if matches!(e, ValidationError::Conflict("exit consumed")) {
            a.ledger
                .record_exit(v.request_id, "exit_before_return")
                .await?;
        }
        a.ledger.close(v.request_id).await?;
        return Err(e.into());
    }
    Ok((
        StatusCode::CREATED,
        Json(a.status(&a.ledger.session(v.request_id).await?).await?),
    )
        .into_response())
}

struct DirectDelivery {
    app: Arc<App>,
    id: Uuid,
    complete: bool,
}
impl Drop for DirectDelivery {
    fn drop(&mut self) {
        if !self.complete {
            let app = self.app.clone();
            let id = self.id;
            tokio::spawn(async move {
                let _ = app.ledger.close(id).await;
                let _ = app.advance(id).await;
            });
        }
    }
}
fn direct_response(guard: DirectDelivery, value: Value) -> Result<Response> {
    let bytes = Bytes::from(serde_json::to_vec(&value).map_err(|_| unavailable())?);
    // HTTP body abandonment before EOF closes the lease. Socket delivery cannot
    // prove receipt at the client; missing-key recovery and provider expiry remain required.
    let stream =
        futures_util::stream::unfold((Some(bytes), guard), |(bytes, mut guard)| async move {
            match bytes {
                Some(bytes) => Some((Ok::<_, std::convert::Infallible>(bytes), (None, guard))),
                None => {
                    guard.complete = true;
                    None
                }
            }
        });
    Response::builder()
        .status(StatusCode::CREATED)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| unavailable())
}
async fn session_status(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let s = a.authenticate(wire::uuid(&id)?, &headers).await?;
    Ok(Json(a.status(&s).await?))
}
async fn close_session(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>)> {
    let id = wire::uuid(&id)?;
    a.authenticate(id, &headers).await?;
    a.ledger.close(id).await?;
    let _ = a.advance(id).await;
    Ok((
        StatusCode::ACCEPTED,
        Json(a.status(&a.ledger.session(id).await?).await?),
    ))
}
async fn clearance(
    State(a): State<Arc<App>>,
    headers: HeaderMap,
    bytes: std::result::Result<Bytes, BytesRejection>,
) -> Result<Json<Value>> {
    a.limit().await?;
    let r: wire::ClearanceRequest = body(&headers, bytes)?;
    a.signer
        .reconcile(&a.config.signer)
        .await
        .map_err(|_| unavailable())?;
    let n = *r.nullifier.as_bytes();
    let message =
        signer::clearance_message(a.config.signer.binding, n).map_err(|_| unavailable())?;
    let saved = a
        .ledger
        .reserve_clearance(n, message, wire::sha256(&message))
        .await?;
    let sig = if let Some(s) = saved.signature {
        s
    } else {
        let sig = a
            .signer
            .sign(
                SignTarget::Clearance { nullifier: n },
                &a.config.signer.clearance_key,
                message,
            )
            .await
            .map_err(|_| unavailable())?;
        a.ledger.save_clearance_signature(n, &sig).await?;
        sig
    };
    signer::verify_signature(&a.config.signer.clearance_key, message, &sig)
        .map_err(|_| unavailable())?;
    Ok(Json(
        json!({"nullifier":r.nullifier,"signature":signature_json(&sig)?}),
    ))
}
async fn nullifier_status(State(a): State<Arc<App>>, Path(n): Path<String>) -> Result<Json<Value>> {
    a.limit().await?;
    let field = n
        .parse::<FieldElement>()
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_nullifier"))?;
    let state = match a.chain.observe(field).await {
        Err(_) => "unknown",
        Ok(obs) if obs.exit_consumed => "exit_consumed",
        Ok(_) => match a.ledger.nullifier_kind(*field.as_bytes()).await? {
            Some(k) if k == "AUTH" => "authorized",
            Some(_) => "cleared",
            None => "unused",
        },
    };
    Ok(Json(json!({"nullifier":n,"state":state})))
}
fn receipt_value(r: &ledger::ReceiptRecord) -> Result<Value> {
    Ok(
        json!({"body":serde_json::from_slice::<Value>(&r.canonical_body).map_err(|_|unavailable())?,"receipt_hash":hex::encode(r.receipt_hash),"signature":STANDARD.encode(r.signature.as_ref().ok_or_else(unavailable)?)}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    cursor: Option<String>,
}
async fn receipts(
    State(a): State<Arc<App>>,
    Path(id): Path<String>,
    Query(cursor): Query<Cursor>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let id = wire::uuid(&id)?;
    a.authenticate(id, &headers).await?;
    let after = cursor
        .cursor
        .as_deref()
        .map(|s| {
            let value = wire::uint(s)?;
            i64::try_from(value).map_err(|_| wire::invalid("cursor"))
        })
        .transpose()?;
    let rows = a.ledger.receipts(id, after, 100).await?;
    let next = rows.last().map(|r| r.sequence.to_string());
    Ok(Json(
        json!({"receipts":rows.iter().map(receipt_value).collect::<Result<Vec<_>>>()?,"next_cursor":next}),
    ))
}
async fn operation_status(
    State(a): State<Arc<App>>,
    Path((id, operation)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let id = wire::uuid(&id)?;
    a.authenticate(id, &headers).await?;
    let o = a.ledger.operation(id, wire::uuid(&operation)?).await?;
    let mut v = json!({"request_id":id.to_string(),"operation_id":o.operation_id.to_string(),"state":o.state,"response_replayable":false});
    if matches!(o.state.as_str(), "DONE" | "WAIVED_OPERATOR_LOSS") {
        let mut after = None;
        let receipt = loop {
            let list = a.ledger.receipts(id, after, 100).await?;
            if let Some(r) = list
                .iter()
                .find(|r| r.operation_id == Some(o.operation_id) && r.billing_effect == "charge")
            {
                break r.clone();
            }
            if list.len() < 100 {
                return Err(unavailable());
            }
            after = list.last().map(|r| r.sequence);
        };
        let r = receipt_value(&receipt)?;
        v["charged_nano_usdc"] = o.charged_nano.to_string().into();
        v["tariff_hash"] = r["body"]["tariff_hash"].clone();
        v["usage"] = r["body"]["usage"].clone();
        v["provider_request_id"] = r["body"]["provider_request_id"].clone();
        v["receipt"] = r;
    }
    Ok(Json(v))
}
