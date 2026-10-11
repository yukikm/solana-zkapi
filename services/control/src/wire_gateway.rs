//! Authenticated finite HTTP contracts. Legacy binding and HMAC bytes remain unchanged.
use super::*;

pub type HeaderPairs = Vec<(String, String)>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
// Both bounded descriptors are value types throughout quote/tariff validation.
#[allow(clippy::large_enum_variant)]
pub enum VersionedApiBinding {
    V1(ApiBinding),
    V2(ApiBindingV2),
}
impl From<ApiBinding> for VersionedApiBinding {
    fn from(v: ApiBinding) -> Self {
        Self::V1(v)
    }
}
impl From<ApiBindingV2> for VersionedApiBinding {
    fn from(v: ApiBindingV2) -> Self {
        Self::V2(v)
    }
}
impl VersionedApiBinding {
    pub fn v1(&self) -> Option<&ApiBinding> {
        if let Self::V1(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn v2(&self) -> Option<&ApiBindingV2> {
        if let Self::V2(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn service(&self) -> &str {
        match self {
            Self::V1(v) => &v.service,
            Self::V2(v) => &v.service,
        }
    }
    pub fn operation(&self) -> &str {
        match self {
            Self::V1(v) => &v.operation,
            Self::V2(v) => &v.operation,
        }
    }
    pub fn origin(&self) -> &str {
        match self {
            Self::V1(v) => &v.origin,
            Self::V2(v) => &v.origin,
        }
    }
}
pub trait ApiEndpoint {
    fn endpoint(&self) -> String;
    fn validate(&self) -> Result<()>;
}
impl ApiEndpoint for ApiBinding {
    fn endpoint(&self) -> String {
        format!("/zkapi/v1/api/{}/{}", self.service, self.operation)
    }
    fn validate(&self) -> Result<()> {
        validate_api_binding_v1(self)
    }
}
impl ApiEndpoint for ApiBindingV2 {
    fn endpoint(&self) -> String {
        format!("/zkapi/v2/execute/{}/{}", self.service, self.operation)
    }
    fn validate(&self) -> Result<()> {
        validate_api_binding_v2(self)
    }
}
impl ApiEndpoint for VersionedApiBinding {
    fn endpoint(&self) -> String {
        match self {
            Self::V1(v) => v.endpoint(),
            Self::V2(v) => v.endpoint(),
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::V1(v) => v.validate(),
            Self::V2(v) => v.validate(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterPin {
    pub id: String,
    pub version: String,
    pub artifact_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpRoute {
    pub method: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HeaderPolicy {
    pub request: String,
    pub request_reject: Vec<String>,
    pub response: String,
    pub response_reject: Vec<String>,
    pub trailers: Vec<String>,
    pub static_request: HeaderPairs,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RepresentationPolicy {
    pub request_media_types: Vec<String>,
    pub response_media_types: Vec<String>,
    pub request_encoding: String,
    pub response_encodings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GatewayLimits {
    pub target_bytes: String,
    pub header_pairs: String,
    pub header_bytes: String,
    pub request_bytes: String,
    pub response_bytes: String,
    pub decoded_response_bytes: String,
    pub decode_ratio: String,
    pub parser_bytes: String,
    pub relay_buffer_bytes: String,
    pub header_seconds: String,
    pub idle_seconds: String,
    pub execution_seconds: String,
    pub max_concurrency: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "scheme", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthenticationPolicy {
    None { policy_id: String },
    Bearer { policy_id: String },
    ApiKeyHeader { policy_id: String, header: String },
    Basic { policy_id: String },
}
impl AuthenticationPolicy {
    pub fn policy_id(&self) -> &str {
        match self {
            Self::None { policy_id }
            | Self::Bearer { policy_id }
            | Self::ApiKeyHeader { policy_id, .. }
            | Self::Basic { policy_id } => policy_id,
        }
    }
    pub fn header(&self) -> Option<&str> {
        match self {
            Self::None { .. } => None,
            Self::ApiKeyHeader { header, .. } => Some(header),
            _ => Some("authorization"),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrivacyPolicy {
    pub identifiers: String,
    pub resources: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MeterResource {
    pub provider: String,
    pub model: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Meter {
    pub adapter: AdapterPin,
    #[serde(deserialize_with = "required_nullable")]
    pub resource: Option<MeterResource>,
    pub config: serde_json::Value,
    pub config_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Completion {
    pub kind: String,
    pub billable_statuses: Vec<u16>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GatewayRecovery {
    pub policy: String,
    pub reconciliation_seconds: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApiBindingV2 {
    pub version: String,
    pub service: String,
    pub operation: String,
    pub mode: String,
    pub transport: AdapterPin,
    pub origin: String,
    pub routes: Vec<HttpRoute>,
    pub query: String,
    pub headers: HeaderPolicy,
    pub representation: RepresentationPolicy,
    pub limits: GatewayLimits,
    pub authentication: AuthenticationPolicy,
    pub privacy: PrivacyPolicy,
    pub meter: Meter,
    pub completion: Completion,
    pub recovery: GatewayRecovery,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LlmMeterConfig {
    pub provider_contract_sha256: String,
    pub context_max_tokens: String,
    pub output_max_tokens: String,
    pub service_tier: String,
    pub extra_cost_policy: String,
}

pub fn unit_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
pub fn header_name(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$%&'*+-.^_`|~".contains(&b)
        })
}
pub fn header_value(value: &str) -> Result<Vec<u8>> {
    let raw = STANDARD
        .decode(value)
        .map_err(|_| invalid("header base64"))?;
    if STANDARD.encode(&raw) != value
        || raw.iter().any(|&b| b < 32 && b != 9 || b == 127)
        || raw.first().is_some_and(|b| matches!(b, 9 | 32))
        || raw.last().is_some_and(|b| matches!(b, 9 | 32))
    {
        return Err(invalid("canonical header value"));
    }
    Ok(raw)
}
pub fn singleton_header(name: &str) -> bool {
    matches!(
        name,
        "content-type" | "content-encoding" | "host" | "authorization" | "content-length"
    )
}
pub fn reserved_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
            | "host"
            | "content-length"
            | "expect"
            | "forwarded"
            | "idempotency-key"
            | "authorization"
            | "cookie"
    ) || name.starts_with("proxy-")
        || name.starts_with("x-zkapi-")
        || name.starts_with("x-forwarded-")
}
fn sorted_names(names: &[String]) -> Result<()> {
    if names.len() > 64
        || names.iter().any(|n| !header_name(n))
        || names.windows(2).any(|w| w[0] >= w[1])
    {
        return Err(invalid("header names"));
    }
    Ok(())
}
/// Provider response control fields never cross the local client boundary,
/// including in declared trailers.
pub fn response_control_header(name: &str) -> bool {
    matches!(
        name,
        "set-cookie"
            | "www-authenticate"
            | "content-security-policy"
            | "content-security-policy-report-only"
            | "strict-transport-security"
            | "x-frame-options"
            | "x-content-type-options"
            | "referrer-policy"
            | "permissions-policy"
            | "clear-site-data"
    ) || name.starts_with("access-control-")
        || name.starts_with("cross-origin-")
}
fn pin(pin: &AdapterPin, id: &str) -> Result<()> {
    if pin.id != id || pin.version != "1" {
        return Err(invalid("unsupported adapter"));
    }
    hash(&pin.artifact_sha256)?;
    Ok(())
}
fn range(v: &str, min: u64, max: u64) -> Result<()> {
    if !(min..=max).contains(&uint(v)?) {
        return Err(invalid("gateway limits"));
    }
    Ok(())
}
fn media_types(values: &[String]) -> Result<()> {
    if values == ["*"] {
        return Ok(());
    }
    if values.is_empty()
        || values.len() > 64
        || values.windows(2).any(|w| w[0] >= w[1])
        || values.iter().any(|s| {
            s.split_once('/').is_none_or(|(a, b)| {
                !header_name(a) || !header_name(b) || a.contains('*') || b.contains('*')
            })
        })
    {
        return Err(invalid("media types"));
    }
    Ok(())
}
/// Validates target spelling without letting a URL parser normalize it.
pub fn validate_raw_target(target: &str) -> Result<()> {
    if !target.starts_with('/')
        || target.starts_with("//")
        || !target.is_ascii()
        || target
            .bytes()
            .any(|b| b <= 32 || b == 127 || matches!(b, b'#' | b'\\'))
    {
        return Err(invalid("raw target"));
    }
    let bytes = target.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err(invalid("percent escape"));
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let path = target.split('?').next().unwrap();
    for (i, segment) in path.split('/').skip(1).enumerate() {
        if segment.is_empty() {
            if path != "/" && i + 1 < path[1..].split('/').count() {
                return Err(invalid("empty path segment"));
            }
            continue;
        }
        let mut decoded = Vec::new();
        let mut bytes = segment.as_bytes().iter().copied();
        while let Some(b) = bytes.next() {
            if b == b'%' {
                let h = bytes.next().unwrap();
                let l = bytes.next().unwrap();
                let d = (h as char).to_digit(16).unwrap() * 16 + (l as char).to_digit(16).unwrap();
                if matches!(d, 47 | 92 | 37) {
                    return Err(invalid("encoded path delimiter"));
                }
                decoded.push(d as u8);
            } else {
                decoded.push(b);
            }
        }
        if decoded == b"." || decoded == b".." || decoded.iter().any(|&b| b <= 32 || b == 127) {
            return Err(invalid("unsafe path segment"));
        }
    }
    Ok(())
}
pub fn route_matches(route: &HttpRoute, method: &str, target: &str) -> bool {
    if route.method != method || validate_raw_target(target).is_err() {
        return false;
    }
    let target = target.split('?').next().unwrap();
    let a: Vec<_> = route.path.split('/').collect();
    let b: Vec<_> = target.split('/').collect();
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            if a.starts_with('{') && a.ends_with('}') {
                !b.is_empty() && b.len() <= 256
            } else {
                *a == b
            }
        })
}
pub fn validate_api_binding_v2(api: &ApiBindingV2) -> Result<()> {
    origin(&api.origin)?;
    // HTTP is reserved for explicit runtime synthetic fixtures; public registration
    // additionally requires HTTPS and independently pinned installed artifacts.
    let url = reqwest::Url::parse(&api.origin).map_err(|_| invalid("gateway origin"))?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && url.host_str().is_some_and(|h| {
                h == "localhost"
                    || h.parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            }))
    {
        return Err(invalid("gateway HTTPS origin"));
    }
    if api.version != "2"
        || !api_identifier(&api.service)
        || !api_identifier(&api.operation)
        || api.mode != "proxy"
        || api.query != "preserve"
        || jcs(api)?.len() > 8192
    {
        return Err(invalid("gateway binding"));
    }
    pin(&api.transport, "http_finite")?;
    if api.routes.is_empty() || api.routes.len() > 32 {
        return Err(invalid("gateway routes"));
    }
    let mut previous = None;
    for route in &api.routes {
        let order = (&route.method, &route.path);
        if previous.is_some_and(|p| p >= order)
            || !matches!(
                route.method.as_str(),
                "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
            )
            || route.path.len() > 1024
            || route.path.contains('?')
        {
            return Err(invalid("gateway route"));
        }
        previous = Some(order);
        validate_raw_target(&route.path)?;
        let mut names = BTreeSet::new();
        for segment in route.path.split('/') {
            if segment.contains('{') || segment.contains('}') {
                let name = segment
                    .strip_prefix('{')
                    .and_then(|s| s.strip_suffix('}'))
                    .ok_or(invalid("route parameter"))?;
                if !api_identifier(name) || !names.insert(name) {
                    return Err(invalid("route parameter"));
                }
            }
        }
    }
    for (i, a) in api.routes.iter().enumerate() {
        for b in &api.routes[i + 1..] {
            let ap: Vec<_> = a.path.split('/').collect();
            let bp: Vec<_> = b.path.split('/').collect();
            if a.method == b.method
                && ap.len() == bp.len()
                && ap
                    .iter()
                    .zip(bp)
                    .all(|(a, b)| *a == b || a.starts_with('{') || b.starts_with('{'))
            {
                return Err(invalid("intersecting routes"));
            }
        }
    }
    let h = &api.headers;
    if h.request != "end_to_end" || h.response != "end_to_end" {
        return Err(invalid("header policy"));
    }
    sorted_names(&h.request_reject)?;
    sorted_names(&h.response_reject)?;
    sorted_names(&h.trailers)?;
    if h.trailers.iter().any(|n| {
        reserved_header(n)
            || response_control_header(n)
            || h.response_reject.contains(n)
            || n.starts_with("content-")
            || matches!(
                n.as_str(),
                "set-cookie" | "www-authenticate" | "cache-control" | "location"
            )
    }) {
        return Err(invalid("trailer policy"));
    }
    let l = &api.limits;
    range(&l.target_bytes, 1, 8192)?;
    range(&l.header_pairs, 1, 128)?;
    range(&l.header_bytes, 1, 32768)?;
    range(&l.request_bytes, 0, 1048576)?;
    range(&l.response_bytes, 0, 16777216)?;
    range(&l.decoded_response_bytes, 0, 67108864)?;
    range(&l.decode_ratio, 1, 64)?;
    range(&l.parser_bytes, 1, 1048576)?;
    range(&l.relay_buffer_bytes, 1, 1048576)?;
    range(&l.execution_seconds, 1, 600)?;
    range(&l.header_seconds, 1, uint(&l.execution_seconds)?)?;
    range(&l.idle_seconds, 1, uint(&l.execution_seconds)?)?;
    range(&l.max_concurrency, 1, 4)?;
    if !api_identifier(api.authentication.policy_id()) {
        return Err(invalid("authentication policy"));
    }
    if let AuthenticationPolicy::ApiKeyHeader { header, .. } = &api.authentication {
        if !header_name(header) || reserved_header(header) {
            return Err(invalid("credential header"));
        }
    }
    let mut size = 0;
    let mut prev = "";
    let mut seen = BTreeSet::new();
    for (n, v) in &h.static_request {
        if !header_name(n)
            || n.as_str() < prev
            || reserved_header(n)
            || api.authentication.header() == Some(n.as_str())
            || (singleton_header(n) && !seen.insert(n))
            || h.request_reject.contains(n)
        {
            return Err(invalid("static header"));
        }
        size += n.len() + header_value(v)?.len();
        prev = n;
    }
    if h.static_request.len() > uint(&l.header_pairs)? as usize
        || size > uint(&l.header_bytes)? as usize
    {
        return Err(invalid("static header limits"));
    }
    let rep = &api.representation;
    media_types(&rep.request_media_types)?;
    media_types(&rep.response_media_types)?;
    if rep.request_encoding != "identity"
        || !rep.response_encodings.iter().any(|e| e == "identity")
        || rep.response_encodings.windows(2).any(|w| w[0] >= w[1])
        || rep
            .response_encodings
            .iter()
            .any(|e| !matches!(e.as_str(), "identity" | "gzip" | "deflate" | "br"))
    {
        return Err(invalid("representation encoding"));
    }
    if !matches!(
        api.privacy.identifiers.as_str(),
        "allow" | "reject_by_meter"
    ) || !matches!(
        api.privacy.resources.as_str(),
        "stateless" | "shared_public"
    ) {
        return Err(invalid("privacy policy"));
    }
    let m = &api.meter;
    if hex::encode(digest(&m.config)?) != m.config_hash {
        return Err(invalid("meter config hash"));
    }
    hash(&m.config_hash)?;
    let statuses = &api.completion.billable_statuses;
    if statuses.len() > 400
        || statuses.iter().any(|s| !(200..=599).contains(s))
        || statuses.windows(2).any(|w| w[0] >= w[1])
    {
        return Err(invalid("completion statuses"));
    }
    match m.adapter.id.as_str() {
        "fixed_http" => {
            pin(&m.adapter, "fixed_http")?;
            if m.resource.is_some()
                || m.config != serde_json::json!({"exposure":"operator_upstream_cost"})
                || api.completion.kind != "http_complete"
                || api.privacy.identifiers != "allow"
            {
                return Err(invalid("fixed meter contract"));
            }
        }
        "openai_responses" | "anthropic_messages" => {
            pin(&m.adapter, &m.adapter.id)?;
            let provider = if m.adapter.id == "openai_responses" {
                "openai"
            } else {
                "anthropic"
            };
            let r = m.resource.as_ref().ok_or(invalid("meter resource"))?;
            if r.provider != provider
                || r.model.is_empty()
                || r.model.len() > 256
                || !r.model.is_ascii()
                || r.model.bytes().any(|b| b.is_ascii_control())
                || api.completion.kind != "provider_terminal_usage"
            {
                return Err(invalid("LLM meter contract"));
            }
            let c: LlmMeterConfig = serde_json::from_value(m.config.clone())
                .map_err(|_| invalid("LLM meter config"))?;
            hash(&c.provider_contract_sha256)?;
            range(&c.context_max_tokens, 1, i64::MAX as u64)?;
            range(&c.output_max_tokens, 1, i64::MAX as u64)?;
            if c.service_tier.is_empty()
                || c.service_tier.len() > 64
                || !c.service_tier.is_ascii()
                || c.service_tier.bytes().any(|b| b.is_ascii_control())
                || !matches!(
                    c.extra_cost_policy.as_str(),
                    "reject_unclassified" | "operator_absorbs_unpriced"
                )
            {
                return Err(invalid("LLM feature policy"));
            }
        }
        _ => return Err(invalid("unsupported meter")),
    }
    if api.recovery.policy != "finite_unknown_v1" || api.recovery.reconciliation_seconds != "900" {
        return Err(invalid("gateway recovery"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn operation_hmac_v2(
    proxy_secret: &[u8; 32],
    deployment_id: &str,
    pool: &str,
    authorization_id: &str,
    operation_id: &str,
    binding_hash: &str,
    tariff_hash: &str,
    method: &str,
    target: &str,
    headers: &HeaderPairs,
    body: &[u8],
) -> Result<[u8; 32]> {
    use hmac::{Hmac, Mac};
    if deployment_id.is_empty()
        || !matches!(
            method,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        )
        || body.len() > 1048576
        || target.len() > 8192
        || headers.len() > 128
        || matches!(method, "GET" | "HEAD") && !body.is_empty()
    {
        return Err(invalid("operation v2 limits"));
    }
    validate_raw_target(target)?;
    let mut previous = "";
    let mut bytes = 0;
    let mut singletons = BTreeSet::new();
    for (n, v) in headers {
        if !header_name(n)
            || n.as_str() < previous
            || reserved_header(n)
            || (singleton_header(n) && !singletons.insert(n))
        {
            return Err(invalid("semantic headers"));
        }
        bytes += n.len() + header_value(v)?.len();
        previous = n;
    }
    if bytes > 32768 {
        return Err(invalid("semantic header limit"));
    }
    let pool = pubkey(pool)?;
    let auth = uuid(authorization_id)?;
    let op = uuid(operation_id)?;
    let binding = hash(binding_hash)?;
    let tariff = hash(tariff_hash)?;
    let headers = jcs(headers)?;
    let parts: [&[u8]; 10] = [
        deployment_id.as_bytes(),
        &pool,
        auth.as_bytes(),
        op.as_bytes(),
        &binding,
        &tariff,
        method.as_bytes(),
        target.as_bytes(),
        &headers,
        body,
    ];
    let label = b"solana-zkapi-operation-v2";
    let mut frame = Vec::new();
    frame.extend_from_slice(&(label.len() as u16).to_be_bytes());
    frame.extend_from_slice(label);
    frame.extend_from_slice(&10u16.to_be_bytes());
    for part in parts {
        frame.extend_from_slice(
            &u32::try_from(part.len())
                .map_err(|_| invalid("operation v2 frame"))?
                .to_be_bytes(),
        );
        frame.extend_from_slice(part);
    }
    let mut d = Sha256::new();
    d.update(b"zkapi-proxy-body-v2");
    d.update(proxy_secret);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&d.finalize()).map_err(|_| invalid("operation v2 key"))?;
    mac.update(&frame);
    Ok(mac.finalize().into_bytes().into())
}
