//! Finite HTTP carrier. This module owns no balances, reservations or receipts.
//! A durable, one-use dispatcher claim must precede `dispatch_once`.
mod http;
mod meter;
pub mod route;

use crate::wire::{self, ApiBindingV2, Tariff, Usage};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, Semaphore};

pub type HeaderPairs = Vec<(String, String)>;
pub const REQUEST_MEDIA: &str = "application/vnd.zkapi.http-request.v2";
pub const RESPONSE_MEDIA: &str = "application/vnd.zkapi.http-response.v2";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayProviderConfig {
    pub api: ApiBindingV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_file: Option<PathBuf>,
    pub transport_artifact_sha256: String,
    pub meter_artifact_sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestMetadata {
    pub version: String,
    pub binding_hash: String,
    pub method: String,
    pub target: String,
    pub headers: HeaderPairs,
    pub body_length: String,
}
pub struct PreparedRequest {
    pub api: ApiBindingV2,
    pub metadata: RequestMetadata,
    pub body: Vec<u8>,
    pub reservation_nano: u128,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub usage: Option<Vec<Usage>>,
    pub completion: Option<crate::receipts::CompletionEvidence>,
    pub evidence_digest: Option<String>,
    pub http_status: Option<u16>,
    pub error: Option<String>,
}
#[derive(Clone)]
pub struct HttpAdapter {
    config: GatewayProviderConfig,
    local: bool,
    credential: Option<String>,
    pub admission: Arc<Semaphore>,
}
pub fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(hex::encode(wire::sha256(&serde_jcs::to_vec(value)?)))
}
pub fn transport_artifact_sha256() -> String {
    hex::encode(wire::sha256(include_bytes!("http.rs")))
}
pub fn meter_artifact_sha256() -> String {
    hex::encode(wire::sha256(include_bytes!("meter.rs")))
}
pub fn provider_contract_sha256() -> String {
    hex::encode(wire::sha256(include_bytes!(
        "../../fixtures/gateway-meter-mappings.json"
    )))
}
pub fn number(value: &str) -> Result<usize> {
    Ok(usize::try_from(wire::uint(value)?)?)
}

pub fn validate_config(config: &GatewayProviderConfig, local: bool, private: bool) -> Result<()> {
    wire::validate_api_binding_v2(&config.api)?;
    meter::validate_config(&config.api)?;
    let url = reqwest::Url::parse(&config.api.origin)?;
    if local {
        ensure!(
            url.scheme() == "http"
                && url
                    .host_str()
                    .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "gateway fixture origin"
        );
    } else {
        ensure!(url.scheme() == "https", "gateway HTTPS required");
        if let Some(ip) = url
            .host_str()
            .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
        {
            ensure!(crate::proxy::public_ip(ip), "gateway public origin");
        }
    }
    ensure!(
        config.transport_artifact_sha256 == transport_artifact_sha256()
            && config.api.transport.artifact_sha256 == config.transport_artifact_sha256,
        "gateway transport pin"
    );
    ensure!(
        config.meter_artifact_sha256 == meter_artifact_sha256()
            && config.api.meter.adapter.artifact_sha256 == config.meter_artifact_sha256,
        "gateway meter pin"
    );
    if config.api.meter.adapter.id != "fixed_http" {
        ensure!(
            config.api.meter.config["provider_contract_sha256"].as_str()
                == Some(provider_contract_sha256().as_str()),
            "gateway provider mapping pin"
        );
    }
    let auth = serde_json::to_value(&config.api.authentication)?;
    let scheme = auth["scheme"].as_str().context("authentication")?;
    ensure!(
        (scheme == "none") == config.credential_file.is_none(),
        "gateway credential policy"
    );
    if private {
        if let Some(path) = &config.credential_file {
            crate::egress::private_file(path)?;
            let secret = crate::provider_runtime::read_credential(path)?;
            if scheme == "basic" {
                let value: serde_json::Value = crate::proxy::parse_json(secret.as_bytes(), 4096)?;
                let username = value["username"].as_str().context("Basic username")?;
                let _ = value["password"].as_str().context("Basic password")?;
                ensure!(
                    value.as_object().is_some_and(|v| v.len() == 2) && !username.contains(':'),
                    "Basic credentials"
                );
            }
        }
    }
    Ok(())
}
impl HttpAdapter {
    pub fn connect(config: &GatewayProviderConfig, local: bool) -> Result<Self> {
        validate_config(config, local, true)?;
        Ok(Self {
            config: config.clone(),
            local,
            credential: config
                .credential_file
                .as_ref()
                .map(|p| crate::provider_runtime::read_credential(p))
                .transpose()?,
            admission: Arc::new(Semaphore::new(number(&config.api.limits.max_concurrency)?)),
        })
    }
    pub async fn dispatch_once(
        &self,
        request: PreparedRequest,
        mut relay: Option<mpsc::Sender<Vec<u8>>>,
        remaining: std::time::Duration,
    ) -> Observation {
        let mut result = Observation {
            usage: None,
            completion: None,
            evidence_digest: None,
            http_status: None,
            error: None,
        };
        let operation = self.dispatch_inner(request, &mut relay, &mut result);
        match tokio::time::timeout(remaining, operation).await {
            Ok(Ok(())) => {}
            status => {
                result.usage = None;
                result.completion = None;
                result.evidence_digest = None;
                result.error = Some(
                    if status.is_err() {
                        "execution_timeout"
                    } else {
                        "upstream_transport_error"
                    }
                    .into(),
                );
            }
        }
        result
    }
}
pub fn decode_value(value: &str) -> Result<Vec<u8>> {
    let bytes = STANDARD.decode(value)?;
    ensure!(STANDARD.encode(&bytes) == value, "canonical header Base64");
    ensure!(
        bytes.iter().all(|b| *b == b'\t' || (*b >= 32 && *b != 127)),
        "header controls"
    );
    Ok(bytes)
}
pub fn encode_value(value: &[u8]) -> String {
    STANDARD.encode(value)
}
pub fn trimmed(value: &[u8]) -> &[u8] {
    let start = value
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t'))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|b| !matches!(b, b' ' | b'\t'))
        .map(|n| n + 1)
        .unwrap_or(start);
    &value[start..end]
}
pub fn header_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$%&'*+-.^_`|~".contains(&b)
        })
}
pub fn reserved(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "expect"
            | "forwarded"
            | "idempotency-key"
    ) || name.starts_with("proxy-")
        || name.starts_with("x-zkapi-")
        || name.starts_with("x-forwarded-")
}
pub fn check_headers(headers: &HeaderPairs, api: &ApiBindingV2) -> Result<()> {
    ensure!(
        headers.len() <= number(&api.limits.header_pairs)?,
        "header pair limit"
    );
    let mut bytes = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for (name, value) in headers {
        ensure!(header_token(name), "header name");
        let value = decode_value(value)?;
        bytes = bytes
            .checked_add(name.len() + value.len())
            .context("header size")?;
        if matches!(
            name.as_str(),
            "content-type" | "content-encoding" | "content-length" | "host" | "authorization"
        ) {
            ensure!(seen.insert(name), "duplicate singleton header");
        }
    }
    ensure!(
        bytes <= number(&api.limits.header_bytes)?,
        "header byte limit"
    );
    Ok(())
}
pub fn header(headers: &HeaderPairs, name: &str) -> Result<Option<Vec<u8>>> {
    let values = headers.iter().filter(|p| p.0 == name).collect::<Vec<_>>();
    ensure!(values.len() <= 1, "singleton header");
    values.first().map(|p| decode_value(&p.1)).transpose()
}
pub fn parse_envelope(raw: &[u8], api: &ApiBindingV2, tariff: &Tariff) -> Result<PreparedRequest> {
    ensure!(raw.len() >= 4, "envelope prefix");
    let len = u32::from_be_bytes(raw[..4].try_into()?) as usize;
    ensure!(
        (1..=65536).contains(&len) && raw.len() >= 4 + len,
        "envelope metadata length"
    );
    let value = crate::proxy::parse_json(&raw[4..4 + len], 65536)?;
    ensure!(
        serde_jcs::to_vec(&value)? == raw[4..4 + len],
        "canonical envelope metadata"
    );
    let metadata: RequestMetadata = serde_json::from_value(value)?;
    validate_request(api, metadata, &raw[4 + len..], tariff)
}
pub fn validate_request(
    api: &ApiBindingV2,
    metadata: RequestMetadata,
    body: &[u8],
    tariff: &Tariff,
) -> Result<PreparedRequest> {
    wire::validate_api_binding_v2(api)?;
    crate::quote::validate_tariff(tariff)?;
    ensure!(
        tariff.api.as_ref().and_then(|a| a.v2()) == Some(api),
        "gateway tariff binding"
    );
    ensure!(
        metadata.version == "2" && metadata.binding_hash == digest(api)?,
        "gateway binding"
    );
    ensure!(
        number(&metadata.body_length)? == body.len()
            && body.len() <= number(&api.limits.request_bytes)?,
        "body length"
    );
    ensure!(
        !matches!(metadata.method.as_str(), "GET" | "HEAD") || body.is_empty(),
        "body forbidden"
    );
    check_target(&metadata.target, api)?;
    ensure!(
        api.routes.iter().any(|r| r.method == metadata.method
            && route_matches(&r.path, metadata.target.split('?').next().unwrap())),
        "route mismatch"
    );
    check_headers(&metadata.headers, api)?;
    let mut augmented = metadata.headers.clone();
    augmented.extend(api.headers.static_request.clone());
    check_headers(&augmented, api)?;
    let auth = serde_json::to_value(&api.authentication)?;
    let auth_field = auth["header"].as_str().unwrap_or("authorization");
    let mut names = std::collections::BTreeSet::new();
    let mut previous: Option<&str> = None;
    for (name, value) in &metadata.headers {
        ensure!(
            !reserved(name) && name != "authorization" && name != "cookie" && name != auth_field,
            "consumer credential/control header"
        );
        ensure!(
            !api.headers.request_reject.contains(name)
                && !api.headers.static_request.iter().any(|p| p.0 == *name),
            "rejected/colliding request header"
        );
        ensure!(
            previous.is_none_or(|p| p <= name.as_str()),
            "semantic header order"
        );
        previous = Some(name);
        let bytes = decode_value(value)?;
        ensure!(trimmed(&bytes) == bytes, "header whitespace normalization");
        if name == auth_field {
            ensure!(names.insert(name), "duplicate credential");
        }
    }
    ensure!(
        header(&augmented, "content-encoding")?.is_none_or(|v| v == b"identity"),
        "request encoding"
    );
    check_media(
        &augmented,
        &api.representation.request_media_types,
        body.is_empty(),
    )?;
    check_accept_encoding(&augmented, &api.representation.response_encodings)?;
    meter::validate_request(api, body)?;
    Ok(PreparedRequest {
        api: api.clone(),
        metadata,
        body: body.to_vec(),
        reservation_nano: crate::quote::calculate_reservation(tariff)?,
    })
}
pub fn check_media(headers: &HeaderPairs, allowed: &[String], empty: bool) -> Result<()> {
    if allowed == ["*"] {
        return Ok(());
    }
    let value = header(headers, "content-type")?;
    if empty && value.is_none() {
        return Ok(());
    }
    let value = value.context("content-type required")?;
    let media = std::str::from_utf8(&value)?
        .split(';')
        .next()
        .unwrap()
        .trim()
        .to_ascii_lowercase();
    ensure!(allowed.contains(&media), "media type");
    Ok(())
}
pub fn check_accept_encoding(headers: &HeaderPairs, allowed: &[String]) -> Result<()> {
    for (_, value) in headers.iter().filter(|p| p.0 == "accept-encoding") {
        let bytes = decode_value(value)?;
        let value = std::str::from_utf8(&bytes)?;
        for offered in value.split(',') {
            let mut parts = offered.trim().split(';');
            let coding = parts.next().unwrap().trim().to_ascii_lowercase();
            ensure!(!coding.is_empty() && coding != "*", "encoding negotiation");
            let mut nonzero = true;
            if let Some(param) = parts.next() {
                let q = param.trim().strip_prefix("q=").context("encoding q")?;
                let (whole, frac) = q.split_once('.').unwrap_or((q, ""));
                ensure!(
                    matches!(whole, "0" | "1")
                        && frac.len() <= 3
                        && frac.bytes().all(|b| b.is_ascii_digit())
                        && (whole == "0" || frac.bytes().all(|b| b == b'0')),
                    "encoding q value"
                );
                nonzero = whole == "1" || frac.bytes().any(|b| b != b'0');
            }
            ensure!(
                parts.next().is_none() && (!nonzero || allowed.contains(&coding)),
                "offered encoding"
            );
        }
    }
    Ok(())
}
pub fn check_target(target: &str, api: &ApiBindingV2) -> Result<()> {
    ensure!(
        target.len() <= number(&api.limits.target_bytes)?
            && target.starts_with('/')
            && !target.starts_with("//")
            && target.is_ascii(),
        "request target"
    );
    ensure!(
        !target
            .bytes()
            .any(|b| b <= 32 || b == 127 || b == b'#' || b == b'\\'),
        "target characters"
    );
    let bytes = target.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            ensure!(
                i + 2 < bytes.len()
                    && bytes[i + 1].is_ascii_hexdigit()
                    && bytes[i + 2].is_ascii_hexdigit(),
                "percent escape"
            );
            i += 3;
        } else {
            i += 1;
        }
    }
    let path = target.split('?').next().unwrap();
    let segments = path[1..].split('/').collect::<Vec<_>>();
    for (index, segment) in segments.iter().enumerate() {
        ensure!(
            !segment.is_empty() || index + 1 == segments.len(),
            "empty path segment"
        );
        let mut decoded = Vec::new();
        let b = segment.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                let n = u8::from_str_radix(&segment[i + 1..i + 3], 16)?;
                ensure!(
                    !matches!(n, b'/' | b'\\' | b'%') && n > 32 && n != 127,
                    "encoded path control"
                );
                decoded.push(n);
                i += 3;
            } else {
                decoded.push(b[i]);
                i += 1;
            }
        }
        ensure!(decoded != b"." && decoded != b"..", "dot path segment");
    }
    Ok(())
}
pub fn route_matches(route: &str, path: &str) -> bool {
    let left = route.split('/').collect::<Vec<_>>();
    let right = path.split('/').collect::<Vec<_>>();
    left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| {
            if a.starts_with('{') && a.ends_with('}') {
                !b.is_empty() && b.len() <= 256
            } else {
                *a == b
            }
        })
}
pub fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(5 + payload.len());
    bytes.push(tag);
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}
pub async fn emit(relay: &mut Option<mpsc::Sender<Vec<u8>>>, bytes: Vec<u8>) {
    // One frame is in flight. A slow consumer loses the relay; observation proceeds.
    if let Some(sender) = relay {
        if !matches!(
            tokio::time::timeout(std::time::Duration::from_millis(100), sender.send(bytes)).await,
            Ok(Ok(()))
        ) {
            *relay = None;
        }
    }
}
