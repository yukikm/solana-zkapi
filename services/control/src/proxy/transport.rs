use super::{Endpoint, ModelProfile, PreparedRequest, ProxyError, Result, SseMeter};
use crate::wire::{Provider, Usage};
use axum::body::Bytes;
use reqwest::{header::HeaderValue, Client, Url};
use sha2::{Digest, Sha256};
use std::{net::IpAddr, time::Duration};
use tokio::sync::mpsc;

/// Deliberately neither Debug nor Serialize.
pub struct ServiceCredential(String);
impl ServiceCredential {
    pub fn new(value: String) -> Result<Self> {
        if value.is_empty() || value.len() > 4096 || HeaderValue::from_str(&value).is_err() {
            return Err(ProxyError::Configuration);
        }
        Ok(Self(value))
    }
}

/// An independently owned task consumes these events. Full/closed queues are
/// dropped, while the upstream reader continues to obtain final usage.
pub enum RelayEvent {
    Head {
        status: u16,
        provider_request_id: Option<String>,
        content_type: &'static str,
    },
    Data(Bytes),
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DispatchObservation {
    pub provider_request_id: Option<String>,
    pub usage: Option<Vec<Usage>>,
    /// Digest of normalized usage and provider identity, never response text.
    pub evidence_digest: Option<[u8; 32]>,
    pub http_status: Option<u16>,
    pub downstream_dropped: bool,
    response_started: bool,
}

pub struct HttpAdapter {
    client: Client,
    provider: Provider,
    origin: Url,
    credential: ServiceCredential,
    deadline: Duration,
}

impl HttpAdapter {
    /// Production targets are selected by provider, never by client input.
    /// Resolve once, pin only public addresses, disable system proxies and redirects.
    pub async fn production(provider: Provider, credential: ServiceCredential) -> Result<Self> {
        let host = match provider {
            Provider::Openai => "api.openai.com",
            Provider::Anthropic => "api.anthropic.com",
            Provider::Openrouter => "openrouter.ai",
            Provider::Oa => return Err(ProxyError::Configuration),
        };
        let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| ProxyError::Configuration)?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(ProxyError::Configuration);
        }
        let client = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ProxyError::Configuration)?;
        Ok(Self {
            client,
            provider,
            origin: Url::parse(&format!("https://{host}"))
                .map_err(|_| ProxyError::Configuration)?,
            credential,
            deadline: Duration::from_secs(600),
        })
    }

    /// Explicit loopback HTTP fixture. Hostnames, redirects and external IPs
    /// cannot turn this into a configurable production forwarding endpoint.
    pub fn local_fixture(
        provider: Provider,
        origin: &str,
        credential: ServiceCredential,
        deadline: Duration,
    ) -> Result<Self> {
        let url = Url::parse(origin).map_err(|_| ProxyError::Configuration)?;
        if provider == Provider::Oa
            || url.scheme() != "http"
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !url
                .host_str()
                .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback())
            || deadline.is_zero()
            || deadline > Duration::from_secs(600)
        {
            return Err(ProxyError::Configuration);
        }
        let client = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ProxyError::Configuration)?;
        Ok(Self {
            client,
            provider,
            origin: url,
            credential,
            deadline,
        })
    }

    /// Exactly one network request. The ledger's immutable send claim is a
    /// required precondition. Neither transport errors nor uncertain usage retry.
    pub async fn dispatch_once(
        &self,
        request: PreparedRequest,
        relay: Option<mpsc::Sender<RelayEvent>>,
    ) -> DispatchObservation {
        let mut observation = DispatchObservation {
            provider_request_id: None,
            usage: None,
            evidence_digest: None,
            http_status: None,
            downstream_dropped: false,
            response_started: false,
        };
        let mut relay = relay;
        let endpoint = request.endpoint;
        let streaming = request.streaming;
        let result = tokio::time::timeout(
            self.deadline,
            self.dispatch_inner(request, &mut relay, &mut observation),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            observation.usage = None;
            observation.evidence_digest = None;
            send_error(
                &mut relay,
                streaming,
                endpoint,
                !observation.response_started,
                &mut observation.downstream_dropped,
            );
        }
        observation
    }

    async fn dispatch_inner(
        &self,
        request: PreparedRequest,
        relay: &mut Option<mpsc::Sender<RelayEvent>>,
        observation: &mut DispatchObservation,
    ) -> Result<()> {
        if request.profile.provider != self.provider {
            return Err(ProxyError::Configuration);
        }
        let path = if self.provider == Provider::Openrouter {
            format!("/api{}", request.endpoint.path())
        } else {
            request.endpoint.path().to_owned()
        };
        let url = self
            .origin
            .join(&path)
            .map_err(|_| ProxyError::Configuration)?;
        let mut builder = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .header("accept-encoding", "identity");
        if self.provider == Provider::Anthropic {
            builder = builder
                .header("x-api-key", &self.credential.0)
                .header("anthropic-version", "2023-06-01");
        } else {
            builder = builder.bearer_auth(&self.credential.0);
        }
        let mut response = builder
            .body(request.upstream_body)
            .send()
            .await
            .map_err(|_| ProxyError::UsageUnknown)?;
        observation.http_status = Some(response.status().as_u16());
        observation.provider_request_id = response
            .headers()
            .get(if self.provider == Provider::Anthropic {
                "request-id"
            } else if self.provider == Provider::Openrouter {
                "x-generation-id"
            } else {
                "x-request-id"
            })
            .or_else(|| response.headers().get("x-request-id"))
            .and_then(|h| h.to_str().ok())
            .filter(|s| valid_id(s))
            .map(str::to_owned);
        if !response.status().is_success() {
            // Never expose provider errors: they can echo prompt, identity or keys.
            send_error(
                relay,
                request.streaming,
                request.endpoint,
                true,
                &mut observation.downstream_dropped,
            );
            return Ok(());
        }
        if response
            .headers()
            .get("content-encoding")
            .is_some_and(|h| h != "identity")
        {
            return Err(ProxyError::UsageUnknown);
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if request.streaming {
            if content_type != "text/event-stream" {
                return Err(ProxyError::UsageUnknown);
            }
            emit(
                relay,
                RelayEvent::Head {
                    status: 200,
                    provider_request_id: observation.provider_request_id.clone(),
                    content_type: "text/event-stream",
                },
                &mut observation.downstream_dropped,
            );
            observation.response_started = true;
            let mut meter = SseMeter::new(request.endpoint, request.profile);
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ProxyError::UsageUnknown)?
            {
                let frames = meter.push(&chunk);
                if observation.provider_request_id.is_none() {
                    observation.provider_request_id =
                        meter.provider_request_id().map(str::to_owned);
                }
                for frame in frames? {
                    emit_stream(
                        relay,
                        RelayEvent::Data(Bytes::from(frame)),
                        &mut observation.downstream_dropped,
                    )
                    .await;
                }
            }
            let (usage, id) = meter.finish()?;
            observation.usage = Some(usage);
            if observation.provider_request_id.is_none() {
                observation.provider_request_id = id;
            }
        } else {
            if content_type != "application/json" {
                return Err(ProxyError::UsageUnknown);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ProxyError::UsageUnknown)?
            {
                if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                    return Err(ProxyError::UsageUnknown);
                }
                bytes.extend_from_slice(&chunk);
            }
            let value =
                super::parse_json(&bytes, 8 * 1024 * 1024).map_err(|_| ProxyError::UsageUnknown)?;
            // Responses includes `error: null` on successful results.
            if value.get("error").is_some_and(|error| !error.is_null()) {
                return Err(ProxyError::UsageUnknown);
            }
            if request.endpoint == Endpoint::CountTokens {
                let n = value
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .filter(|n| *n <= i64::MAX as u64)
                    .ok_or(ProxyError::UsageUnknown)?;
                // Count tokens is operator-funded. It never becomes inference usage.
                let _ = n;
                observation.usage = Some(zero_usage(&request.profile));
            } else {
                observation.usage = Some(super::normalize_usage(
                    request.endpoint,
                    &request.profile,
                    value.get("usage").ok_or(ProxyError::UsageUnknown)?,
                )?);
                if let Some(id) = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|id| valid_id(id))
                {
                    if observation.provider_request_id.is_none() {
                        observation.provider_request_id = Some(id.into());
                    }
                }
                if observation.provider_request_id.is_none() {
                    return Err(ProxyError::UsageUnknown);
                }
            }
            emit(
                relay,
                RelayEvent::Head {
                    status: 200,
                    provider_request_id: observation.provider_request_id.clone(),
                    content_type: "application/json",
                },
                &mut observation.downstream_dropped,
            );
            observation.response_started = true;
            emit(
                relay,
                RelayEvent::Data(Bytes::from(bytes)),
                &mut observation.downstream_dropped,
            );
        }
        let evidence = serde_jcs::to_vec(&serde_json::json!({"provider_request_id": observation.provider_request_id,"usage":observation.usage})).map_err(|_| ProxyError::UsageUnknown)?;
        observation.evidence_digest = Some(Sha256::digest(evidence).into());
        Ok(())
    }

    /// Native synchronous inference lacks a universally safe final-usage lookup
    /// or confirmed cancellation contract. Never create a second inference.
    pub async fn lookup_usage(&self, _provider_request_id: &str) -> Option<Vec<Usage>> {
        None
    }
    pub async fn cancel(&self, _provider_request_id: &str) -> bool {
        false
    }
}

pub(crate) fn zero_usage(profile: &ModelProfile) -> Vec<Usage> {
    let units: &[&str] = match profile.cache_mode {
        super::CacheMode::InclusiveRead => &["cache_read_tokens", "input_tokens", "output_tokens"],
        super::CacheMode::InclusiveReadWrite => &[
            "cache_read_tokens",
            "cache_write_tokens",
            "input_tokens",
            "output_tokens",
        ],
        super::CacheMode::AnthropicSplit => &[
            "cache_read_tokens",
            "cache_write_1h_tokens",
            "cache_write_5m_tokens",
            "input_tokens",
            "output_tokens",
        ],
    };
    units
        .iter()
        .map(|s| Usage {
            unit: (*s).into(),
            count: "0".into(),
        })
        .collect()
}

fn emit(relay: &mut Option<mpsc::Sender<RelayEvent>>, event: RelayEvent, dropped: &mut bool) {
    if relay.as_ref().is_some_and(|tx| tx.try_send(event).is_err()) {
        *dropped = true;
        // A slow/disconnected consumer must not hold the metering reader open.
        *relay = None;
    }
}
async fn emit_stream(
    relay: &mut Option<mpsc::Sender<RelayEvent>>,
    event: RelayEvent,
    dropped: &mut bool,
) {
    if let Some(tx) = relay {
        // A network chunk can contain hundreds of SSE frames. Give the joined
        // relay task time to be scheduled and commit the response identity;
        // immediate try_send would truncate healthy bursty streams. A bounded
        // grace still prevents slow clients from blocking final metering.
        if !matches!(
            tokio::time::timeout(Duration::from_millis(250), tx.send(event)).await,
            Ok(Ok(()))
        ) {
            *dropped = true;
            *relay = None;
        }
    }
}
fn send_error(
    relay: &mut Option<mpsc::Sender<RelayEvent>>,
    streaming: bool,
    endpoint: Endpoint,
    headers: bool,
    dropped: &mut bool,
) {
    if headers {
        emit(
            relay,
            RelayEvent::Head {
                status: 502,
                provider_request_id: None,
                content_type: "application/json",
            },
            dropped,
        );
    }
    let body = if matches!(endpoint, Endpoint::Messages | Endpoint::CountTokens) {
        "{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Provider result unavailable; inspect operation status before taking further action.\"}}"
    } else {
        "{\"error\":{\"type\":\"upstream_error\",\"code\":\"usage_unknown\",\"message\":\"Provider result unavailable; inspect operation status before taking further action.\"}}"
    };
    let body = if streaming && !headers {
        format!("event: error\ndata: {body}\n\n")
    } else {
        body.to_owned()
    };
    emit(relay, RelayEvent::Data(Bytes::from(body)), dropped);
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_multicast()
                || v.is_unspecified()
                || v.octets()[0] == 0
                || v.octets()[0] >= 240
                || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
                || (v.octets()[0] == 198 && matches!(v.octets()[1], 18 | 19)))
        }
        IpAddr::V6(v) => v.to_ipv4_mapped().map(public_ip_v4).unwrap_or_else(|| {
            let s = v.segments();
            s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && s[1] == 0x0db8)
        }),
    }
}
fn public_ip_v4(ip: std::net::Ipv4Addr) -> bool {
    public_ip(IpAddr::V4(ip))
}
