//! Strict public control wire. Financial integers are strings; generic JSON is
//! first walked without losing duplicate keys before typed deserialization.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde::{
    de::{self, DeserializeOwned, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};
use subtle::ConstantTimeEq;
use zkapi_solana_types::{FieldElement, MicroUsdc};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("invalid control input: {0}")]
    Invalid(&'static str),
    #[error("control credential rejected")]
    Unauthorized,
    #[error("chain observation unavailable: {0}")]
    Unavailable(&'static str),
    #[error("chain observation conflicts with trusted configuration: {0}")]
    TrustMismatch(&'static str),
    #[error("control state conflict: {0}")]
    Conflict(&'static str),
    #[error("request body exceeds configured limit")]
    TooLarge,
}
pub type Result<T> = std::result::Result<T, ValidationError>;
pub fn invalid(message: &'static str) -> ValidationError {
    ValidationError::Invalid(message)
}

struct StrictValue(serde_json::Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Strict;
        impl<'de> Visitor<'de> for Strict {
            type Value = StrictValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("strict JSON without duplicate keys or numbers")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(serde_json::Value::Null))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element::<StrictValue>()? {
                    v.push(x.0)
                }
                Ok(StrictValue(v.into()))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut v = serde_json::Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if k == "$serde_json::private::Number" || v.contains_key(&k) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    v.insert(k, a.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(v.into()))
            }
        }
        d.deserialize_any(Strict)
    }
}
pub fn strict_parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > 16 * 1024 {
        return Err(ValidationError::TooLarge);
    }
    std::str::from_utf8(bytes).map_err(|_| invalid("UTF-8"))?;
    let value: StrictValue = serde_json::from_slice(bytes)
        .map_err(|_| invalid("JSON syntax, duplicate key or numeric value"))?;
    serde_json::from_value(value.0).map_err(|_| invalid("wire fields"))
}
pub fn jcs<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_jcs::to_vec(value).map_err(|_| invalid("canonical JSON"))
}
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
pub fn digest<T: Serialize>(value: &T) -> Result<[u8; 32]> {
    Ok(sha256(&jcs(value)?))
}
pub fn uint(text: &str) -> Result<u64> {
    if text.is_empty()
        || !text.bytes().all(|b| b.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return Err(invalid("canonical integer"));
    }
    text.parse().map_err(|_| invalid("integer range"))
}
pub fn hash(text: &str) -> Result<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("SHA256 encoding"));
    }
    let mut out = [0; 32];
    hex::decode_to_slice(text, &mut out).map_err(|_| invalid("SHA256 encoding"))?;
    Ok(out)
}
pub fn pubkey(text: &str) -> Result<[u8; 32]> {
    let value: [u8; 32] = bs58::decode(text)
        .into_vec()
        .map_err(|_| invalid("public key"))?
        .try_into()
        .map_err(|_| invalid("public key length"))?;
    if bs58::encode(value).into_string() != text {
        return Err(invalid("public key encoding"));
    }
    Ok(value)
}
pub fn uuid(text: &str) -> Result<uuid::Uuid> {
    let value = uuid::Uuid::parse_str(text).map_err(|_| invalid("UUID"))?;
    if value.get_version_num() != 4
        || value.get_variant() != uuid::Variant::RFC4122
        || value.to_string() != text
    {
        return Err(invalid("canonical UUIDv4"));
    }
    Ok(value)
}
pub fn base64_exact<const N: usize>(text: &str) -> Result<[u8; N]> {
    let bytes: [u8; N] = STANDARD
        .decode(text)
        .map_err(|_| invalid("base64"))?
        .try_into()
        .map_err(|_| invalid("base64 length"))?;
    if STANDARD.encode(bytes) != text {
        return Err(invalid("canonical base64"));
    }
    Ok(bytes)
}
pub fn origin(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).map_err(|_| invalid("origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.origin().ascii_serialization() != value
    {
        return Err(invalid("canonical origin"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Proxy,
    DirectOa,
    DirectOpenrouter,
}
impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Proxy => "proxy",
            Self::DirectOa => "direct_oa",
            Self::DirectOpenrouter => "direct_openrouter",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Openrouter,
    Oa,
    Generic,
}
impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Openrouter => "openrouter",
            Self::Oa => "oa",
            Self::Generic => "generic",
        }
    }
}
/// Immutable operation terms carried by a generic quote and its tariff. These
/// terms extend the existing authorization hash without changing the proof.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApiBinding {
    pub version: String,
    pub service: String,
    pub operation: String,
    pub method: String,
    pub path: String,
    pub origin: String,
    pub request_max_bytes: String,
    pub response_max_bytes: String,
    pub timeout_seconds: String,
    pub billing: String,
}
pub fn api_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}
pub fn api_path(api: &ApiBinding) -> String {
    format!("/zkapi/v1/api/{}/{}", api.service, api.operation)
}
pub fn is_api_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/zkapi/v1/api/") else {
        return false;
    };
    let Some((service, operation)) = rest.split_once('/') else {
        return false;
    };
    api_identifier(service) && api_identifier(operation)
}
pub fn validate_api_binding(api: &ApiBinding) -> Result<()> {
    origin(&api.origin)?;
    if api.version != "1"
        || !api_identifier(&api.service)
        || !api_identifier(&api.operation)
        || api.method != "POST"
        || api.billing != "http_2xx_json"
        || !api.path.starts_with('/')
        || api.path.starts_with("//")
        || api.path.len() > 1024
        || api
            .path
            .bytes()
            .any(|b| !(b.is_ascii_alphanumeric() || b"/-._~".contains(&b)))
        || api.path.split('/').any(|s| matches!(s, "." | ".."))
        || !(1..=1_048_576).contains(&uint(&api.request_max_bytes)?)
        || !(1..=1_048_576).contains(&uint(&api.response_max_bytes)?)
        || !(1..=600).contains(&uint(&api.timeout_seconds)?)
    {
        return Err(invalid("API binding"));
    }
    Ok(())
}
pub fn scope_valid(
    mode: &Mode,
    provider: &Provider,
    models: &[String],
    api: Option<&ApiBinding>,
) -> Result<()> {
    if *provider == Provider::Generic {
        if *mode != Mode::Proxy || !models.is_empty() {
            return Err(invalid("generic API scope"));
        }
        validate_api_binding(api.ok_or(invalid("missing API binding"))?)
    } else {
        if api.is_some() {
            return Err(invalid("unexpected API binding"));
        }
        mode_models(mode, provider, models)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuoteRequest {
    pub mode: Mode,
    pub provider: Provider,
    #[serde(
        default,
        deserialize_with = "nonempty_models",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub models: Vec<String>,
    #[serde(
        default,
        deserialize_with = "optional_value_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub api: Option<ApiBinding>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_ttl_seconds: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QuoteBody {
    pub quote_id: String,
    pub deployment_id: String,
    pub pool: String,
    pub mode: Mode,
    pub provider: Provider,
    #[serde(
        default,
        deserialize_with = "nonempty_models",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub models: Vec<String>,
    #[serde(
        default,
        deserialize_with = "optional_value_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub api: Option<ApiBinding>,
    pub tariff_hash: String,
    pub cap_micro_usdc: MicroUsdc,
    pub issued_at: String,
    pub expires_at: String,
    pub session_ttl_seconds: String,
    pub max_concurrency: String,
    pub control_api_origin: String,
    pub inference_api_origin: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Quote {
    pub body: QuoteBody,
    pub quote_hash: String,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    pub version: String,
    pub deployment_id: String,
    pub pool: String,
    pub request_id: String,
    pub quote_hash: String,
    pub mode: Mode,
    pub control_secret_hash: String,
    #[serde(deserialize_with = "required_nullable")]
    pub proxy_secret_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub backend: String,
    pub proof: String,
}
impl Proof {
    pub fn bytes(&self) -> Result<[u8; 256]> {
        if self.backend != "groth16_bn254" {
            return Err(invalid("proof backend"));
        }
        base64_exact(&self.proof)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionCreate {
    pub authorization: Authorization,
    pub quote: Quote,
    pub public_inputs: [FieldElement; 12],
    pub proof: Proof,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClearanceRequest {
    pub nullifier: FieldElement,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rate {
    pub unit: String,
    pub nano_usdc_numerator: String,
    pub unit_denominator: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Tariff {
    pub tariff_hash: String,
    pub version: String,
    pub provider: Provider,
    #[serde(
        default,
        deserialize_with = "nonempty_model",
        skip_serializing_if = "String::is_empty"
    )]
    pub model: String,
    #[serde(
        default,
        deserialize_with = "optional_value_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub api: Option<ApiBinding>,
    pub pricing_basis: String,
    pub valid_from: String,
    pub valid_until: String,
    pub rates: Vec<Rate>,
    pub operator_fee_micro_usdc: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    pub unit: String,
    pub count: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub pool: String,
    pub root: FieldElement,
    pub slot: String,
    pub blockhash: String,
    pub sequence: String,
    pub next_note_id: String,
}

/// Never implements Debug/Serialize: callers retain only this digest in storage.
pub struct ControlCredential {
    pub request_id: uuid::Uuid,
    pub secret_hash: [u8; 32],
}
/// Only request-scoped memory contains the proxy secret used for the body HMAC.
pub struct ProxyCredential {
    pub request_id: uuid::Uuid,
    pub secret: [u8; 32],
}
impl Drop for ProxyCredential {
    fn drop(&mut self) {
        self.secret.fill(0);
    }
}
pub fn parse_proxy_token(token: &str) -> Result<ProxyCredential> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != "zkp1" || parts[2].len() != 43 {
        return Err(ValidationError::Unauthorized);
    }
    let request_id = uuid(parts[1]).map_err(|_| ValidationError::Unauthorized)?;
    let secret: [u8; 32] = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| ValidationError::Unauthorized)?
        .try_into()
        .map_err(|_| ValidationError::Unauthorized)?;
    if URL_SAFE_NO_PAD.encode(secret) != parts[2] {
        return Err(ValidationError::Unauthorized);
    }
    Ok(ProxyCredential { request_id, secret })
}
pub fn parse_control_token(header: &str) -> Result<ControlCredential> {
    let token = header
        .strip_prefix("Bearer ")
        .ok_or(ValidationError::Unauthorized)?;
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != "zkc1" || parts[2].len() != 43 {
        return Err(ValidationError::Unauthorized);
    }
    let request_id = uuid(parts[1]).map_err(|_| ValidationError::Unauthorized)?;
    let secret: [u8; 32] = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| ValidationError::Unauthorized)?
        .try_into()
        .map_err(|_| ValidationError::Unauthorized)?;
    if URL_SAFE_NO_PAD.encode(secret) != parts[2] {
        return Err(ValidationError::Unauthorized);
    }
    Ok(ControlCredential {
        request_id,
        secret_hash: sha256(&secret),
    })
}
pub fn credential_matches(
    credential: &ControlCredential,
    request_id: &str,
    expected: &str,
) -> Result<()> {
    if credential.request_id.to_string() != request_id
        || !bool::from(credential.secret_hash.ct_eq(&hash(expected)?))
    {
        return Err(ValidationError::Unauthorized);
    }
    Ok(())
}
pub fn mode_models(mode: &Mode, provider: &Provider, models: &[String]) -> Result<()> {
    let valid = match (mode, provider) {
        (Mode::DirectOa, Provider::Oa) | (Mode::DirectOpenrouter, Provider::Openrouter) => {
            models == ["*"]
        }
        (Mode::Proxy, Provider::Openai | Provider::Anthropic | Provider::Openrouter) => {
            models.len() == 1 && !models[0].is_empty() && models[0] != "*" && models[0].is_ascii()
        }
        _ => false,
    };
    if !valid || models.windows(2).any(|w| w[0] >= w[1]) {
        return Err(invalid("mode/provider/models"));
    }
    Ok(())
}
pub const UNITS: [&str; 6] = [
    "cache_read_tokens",
    "cache_write_1h_tokens",
    "cache_write_5m_tokens",
    "cache_write_tokens",
    "input_tokens",
    "output_tokens",
];
pub fn units<'a>(values: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut previous = None;
    for unit in values {
        if !UNITS.contains(&unit) || previous.is_some_and(|p| p >= unit) || !seen.insert(unit) {
            return Err(invalid("usage units"));
        }
        previous = Some(unit)
    }
    if seen.contains("cache_write_tokens")
        && (seen.contains("cache_write_1h_tokens") || seen.contains("cache_write_5m_tokens"))
    {
        return Err(invalid("mixed cache write prices"));
    }
    Ok(())
}

fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

fn optional_nonnull<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
fn optional_value_nonnull<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
// Omission denotes generic API scope; explicit empty legacy fields must not be
// normalized away before hashing an authenticated quote, tariff or transcript.
fn nonempty_models<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    let models = Vec::<String>::deserialize(d)?;
    if models.is_empty() {
        return Err(de::Error::custom("models must be nonempty when present"));
    }
    Ok(models)
}
fn nonempty_model<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    let model = String::deserialize(d)?;
    if model.is_empty() {
        return Err(de::Error::custom("model must be nonempty when present"));
    }
    Ok(model)
}

/// Prompt-free proxy idempotency binding. Only this keyed digest, never the
/// secret, raw body or an unkeyed prompt hash, crosses into the ledger.
pub fn operation_hmac(
    proxy_secret: &[u8; 32],
    method: &str,
    path: &str,
    anthropic_version: &str,
    raw_body: &[u8],
) -> Result<[u8; 32]> {
    use hmac::{Hmac, Mac};
    if method != "POST"
        || !(is_api_path(path)
            || matches!(
                path,
                "/v1/chat/completions"
                    | "/v1/responses"
                    | "/v1/messages"
                    | "/v1/messages/count_tokens"
            ))
    {
        return Err(invalid("operation endpoint"));
    }
    let anthropic = matches!(path, "/v1/messages" | "/v1/messages/count_tokens");
    if !anthropic_version.is_ascii()
        || anthropic_version.bytes().any(|b| b.is_ascii_control())
        || (anthropic && anthropic_version.is_empty())
        || (!anthropic && !anthropic_version.is_empty())
    {
        return Err(invalid("operation API version"));
    }
    if raw_body.len() > 1024 * 1024 {
        return Err(ValidationError::TooLarge);
    }
    std::str::from_utf8(raw_body).map_err(|_| invalid("operation UTF-8"))?;
    let mut derivation = Sha256::new();
    derivation.update(b"zkapi-proxy-body-v1");
    derivation.update(proxy_secret);
    let key = derivation.finalize();
    let framed = zkapi_solana_types::binding::frame(
        zkapi_solana_types::binding::OPERATION_LABEL,
        &[
            method.as_bytes(),
            path.as_bytes(),
            anthropic_version.as_bytes(),
            raw_body,
        ],
    )
    .map_err(|_| invalid("operation frame"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| invalid("operation key"))?;
    mac.update(&framed);
    Ok(mac.finalize().into_bytes().into())
}
