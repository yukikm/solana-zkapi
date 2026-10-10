//! Registered JSON API execution. Financial ownership remains with the existing
//! ledger, dispatch attempt and signer; this adapter only validates and meters.
use crate::{
    proxy::{self, DispatchDiagnostic, DispatchObservation, DispatchStage, RelayEvent},
    wire::{self, ApiBinding, Tariff, Usage},
};
use anyhow::{ensure, Context, Result};
use axum::body::Bytes;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    net::IpAddr,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiProviderConfig {
    pub api: ApiBinding,
    pub credential_file: PathBuf,
}

/// Exact transient request bytes; never persisted or included in Debug output.
pub struct PreparedRequest {
    pub api: ApiBinding,
    pub reservation_nano: u128,
    pub body: Vec<u8>,
}

pub fn validate(api: &ApiBinding, raw: &[u8], tariff: &Tariff) -> Result<PreparedRequest> {
    wire::validate_api_binding(api)?;
    crate::quote::validate_tariff(tariff)?;
    ensure!(
        tariff.api.as_ref() == Some(api) && tariff.pricing_basis == "fixed_request",
        "API tariff binding"
    );
    proxy::parse_json(raw, wire::uint(&api.request_max_bytes)? as usize)?;
    let reservation_nano = crate::quote::calculate_charge(
        tariff,
        &[Usage {
            unit: "requests".into(),
            count: "1".into(),
        }],
    )?;
    Ok(PreparedRequest {
        api: api.clone(),
        reservation_nano,
        body: raw.to_vec(),
    })
}

/// Configuration is operator-owned and quote-bound. Local fixtures cannot use
/// DNS names; real destinations must be HTTPS and resolve only to public IPs.
pub fn validate_origin(api: &ApiBinding, local: bool) -> Result<Url> {
    wire::validate_api_binding(api)?;
    let origin = Url::parse(&api.origin)?;
    if local {
        ensure!(
            origin.scheme() == "http"
                && origin
                    .host_str()
                    .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "API fixture must use numeric loopback HTTP"
        );
    } else {
        ensure!(origin.scheme() == "https", "API origin requires HTTPS");
        if let Some(ip) = origin
            .host_str()
            .and_then(|s| s.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        {
            ensure!(proxy::public_ip(ip), "API origin must be public");
        }
    }
    let target = Url::parse(&format!("{}{}", api.origin, api.path))?;
    ensure!(
        target.origin() == origin.origin() && target.path() == api.path && target.query().is_none(),
        "API path must be canonical"
    );
    Ok(origin)
}

pub struct HttpAdapter {
    api: ApiBinding,
    client: Client,
    credential: String,
}

impl HttpAdapter {
    pub async fn connect(config: &ApiProviderConfig, local: bool) -> Result<Self> {
        let origin = validate_origin(&config.api, local)?;
        crate::egress::private_file(&config.credential_file)?;
        let credential = crate::provider_runtime::read_credential(&config.credential_file)?;
        reqwest::header::HeaderValue::from_str(&credential)?;
        let mut builder = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15));
        if !local {
            let host = origin.host_str().context("API host")?;
            let addresses: Vec<_> = tokio::net::lookup_host((
                host,
                origin.port_or_known_default().context("API port")?,
            ))
            .await?
            .collect();
            ensure!(
                !addresses.is_empty() && addresses.iter().all(|a| proxy::public_ip(a.ip())),
                "API DNS must resolve only to public addresses"
            );
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        Ok(Self {
            api: config.api.clone(),
            client: builder.build()?,
            credential,
        })
    }

    pub async fn dispatch_once(
        &self,
        request: PreparedRequest,
        relay: Option<mpsc::Sender<RelayEvent>>,
    ) -> DispatchObservation {
        let started = Instant::now();
        let mut observation = DispatchObservation {
            provider_request_id: None,
            usage: None,
            evidence_digest: None,
            http_status: None,
            downstream_dropped: false,
            response_started: false,
            diagnostic: DispatchDiagnostic {
                stage: DispatchStage::Configuration,
                elapsed_ms: 0,
                completed: false,
                timed_out: false,
            },
        };
        let mut relay = relay;
        let outcome = tokio::time::timeout(
            Duration::from_secs(wire::uint(&self.api.timeout_seconds).unwrap_or(1)),
            self.dispatch_inner(request, &mut observation, &mut relay),
        )
        .await;
        observation.diagnostic.elapsed_ms =
            started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        observation.diagnostic.timed_out = outcome.is_err();
        if !matches!(outcome, Ok(Ok(()))) {
            observation.usage = None;
            observation.evidence_digest = None;
            emit(
                &mut relay,
                RelayEvent::Head {
                    status: 502,
                    provider_request_id: None,
                    content_type: "application/json",
                },
                &mut observation,
            )
            .await;
            emit(
                &mut relay,
                RelayEvent::Data(Bytes::from_static(
                    br#"{"error":{"code":"api_result_unknown"}}"#,
                )),
                &mut observation,
            )
            .await;
        }
        observation
    }

    async fn dispatch_inner(
        &self,
        request: PreparedRequest,
        observation: &mut DispatchObservation,
        relay: &mut Option<mpsc::Sender<RelayEvent>>,
    ) -> Result<()> {
        ensure!(request.api == self.api, "API descriptor mismatch");
        observation.diagnostic.stage = DispatchStage::RequestTransport;
        let mut response = self
            .client
            .post(format!("{}{}", self.api.origin, self.api.path))
            .bearer_auth(&self.credential)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("accept-encoding", "identity")
            .body(request.body)
            .send()
            .await?;
        let status = response.status().as_u16();
        observation.http_status = Some(status);
        observation.diagnostic.stage = DispatchStage::UpstreamStatus;
        let (count, response_status, bytes) = if response.status().is_success() {
            observation.diagnostic.stage = DispatchStage::ContentEncoding;
            ensure!(
                response
                    .headers()
                    .get("content-encoding")
                    .is_none_or(|v| v == "identity"),
                "API encoding"
            );
            observation.diagnostic.stage = DispatchStage::ContentType;
            ensure!(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(';').next())
                    == Some("application/json"),
                "API response type"
            );
            let limit = wire::uint(&self.api.response_max_bytes)? as usize;
            let mut bytes = Vec::new();
            observation.diagnostic.stage = DispatchStage::ResponseRead;
            while let Some(chunk) = response.chunk().await? {
                if bytes.len().saturating_add(chunk.len()) > limit {
                    observation.diagnostic.stage = DispatchStage::ResponseLimit;
                    anyhow::bail!("API response limit");
                }
                bytes.extend_from_slice(&chunk);
            }
            observation.diagnostic.stage = DispatchStage::JsonDecode;
            proxy::parse_json(&bytes, limit)?;
            ("1", status, bytes)
        } else {
            // The signed tariff charges only completed successful JSON replies.
            // Never relay an upstream error body that might echo credentials.
            (
                "0",
                502,
                br#"{"error":{"code":"api_upstream_rejected"}}"#.to_vec(),
            )
        };
        observation.usage = Some(vec![Usage {
            unit: "requests".into(),
            count: count.into(),
        }]);
        observation.evidence_digest = Some(wire::digest(
            &serde_json::json!({"api": self.api, "status": status.to_string(), "usage": observation.usage}),
        )?);
        observation.diagnostic.stage = DispatchStage::Complete;
        observation.diagnostic.completed = true;
        emit(
            relay,
            RelayEvent::Head {
                status: response_status,
                provider_request_id: None,
                content_type: "application/json",
            },
            observation,
        )
        .await;
        observation.response_started = true;
        emit(relay, RelayEvent::Data(Bytes::from(bytes)), observation).await;
        Ok(())
    }
}

async fn emit(
    relay: &mut Option<mpsc::Sender<RelayEvent>>,
    event: RelayEvent,
    observation: &mut DispatchObservation,
) {
    if let Some(tx) = relay {
        if !matches!(
            tokio::time::timeout(Duration::from_millis(250), tx.send(event)).await,
            Ok(Ok(()))
        ) {
            observation.downstream_dropped = true;
            *relay = None;
        }
    }
}
