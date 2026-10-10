//! Native, bounded provider adapters. This module never owns financial state.
//! Callers must persist and claim the ledger attempt before `dispatch_once`, and
//! keep the dispatch future alive after the client disconnects.
mod request;
mod transport;
mod usage;

pub use request::{parse_json, validate, PreparedRequest};
pub(crate) use transport::public_ip;
pub use transport::{
    DispatchDiagnostic, DispatchObservation, DispatchStage, HttpAdapter, RelayEvent,
    ServiceCredential,
};
pub use usage::{normalize_usage, SseMeter};

use crate::wire::{Provider, Tariff, Usage};
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, ProxyError>;

/// Errors never retain provider text, request bodies, URLs, or credentials.
#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProxyError {
    #[error("invalid inference request")]
    InvalidRequest,
    #[error("unsupported inference capability or metering")]
    UnsupportedMetering,
    #[error("inference body exceeds configured limit")]
    TooLarge,
    #[error("provider usage is unknown")]
    UsageUnknown,
    #[error("invalid adapter configuration")]
    Configuration,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Endpoint {
    ChatCompletions,
    Responses,
    Messages,
    CountTokens,
}
impl Endpoint {
    pub fn path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "/v1/chat/completions",
            Self::Responses => "/v1/responses",
            Self::Messages => "/v1/messages",
            Self::CountTokens => "/v1/messages/count_tokens",
        }
    }
    pub fn from_path(path: &str) -> Result<Self> {
        match path {
            "/v1/chat/completions" => Ok(Self::ChatCompletions),
            "/v1/responses" => Ok(Self::Responses),
            "/v1/messages" => Ok(Self::Messages),
            "/v1/messages/count_tokens" => Ok(Self::CountTokens),
            _ => Err(ProxyError::UnsupportedMetering),
        }
    }
}

/// A deployment pins one documented usage schema per model. Profiles with
/// unverified extra charges must not be published in the catalog.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CacheMode {
    InclusiveRead,
    InclusiveReadWrite,
    AnthropicSplit,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile {
    pub provider: Provider,
    pub model: String,
    pub endpoints: Vec<Endpoint>,
    /// Published maximum input/context tokens; never a local tokenizer guess.
    pub context_tokens: u64,
    pub max_output_tokens: u64,
    pub cache_mode: CacheMode,
}
impl ModelProfile {
    pub fn validate(&self, tariff: &Tariff) -> Result<()> {
        use ProxyError::Configuration;
        crate::quote::validate_tariff(tariff).map_err(|_| Configuration)?;
        if self.model.is_empty()
            || self.model == "*"
            || !self.model.is_ascii()
            || self.provider != tariff.provider
            || self.model != tariff.model
            || tariff.pricing_basis != "fixed_usage_rates"
            || self.context_tokens == 0
            || self.context_tokens > i64::MAX as u64
            || self.max_output_tokens == 0
            || self.max_output_tokens > i64::MAX as u64
            || self.endpoints.is_empty()
        {
            return Err(Configuration);
        }
        let mut seen = Vec::new();
        for endpoint in &self.endpoints {
            let allowed = matches!(
                (&self.provider, endpoint),
                (
                    Provider::Openai,
                    Endpoint::ChatCompletions | Endpoint::Responses
                ) | (Provider::Openrouter, Endpoint::ChatCompletions)
                    | (
                        Provider::Anthropic,
                        Endpoint::Messages | Endpoint::CountTokens
                    )
            );
            if !allowed || seen.contains(endpoint) {
                return Err(Configuration);
            }
            seen.push(*endpoint);
        }
        if (self.provider == Provider::Anthropic) != (self.cache_mode == CacheMode::AnthropicSplit)
        {
            return Err(Configuration);
        }
        let expected: &[&str] = match self.cache_mode {
            CacheMode::InclusiveRead => &["cache_read_tokens", "input_tokens", "output_tokens"],
            CacheMode::InclusiveReadWrite => &[
                "cache_read_tokens",
                "cache_write_tokens",
                "input_tokens",
                "output_tokens",
            ],
            CacheMode::AnthropicSplit => &[
                "cache_read_tokens",
                "cache_write_1h_tokens",
                "cache_write_5m_tokens",
                "input_tokens",
                "output_tokens",
            ],
        };
        if tariff
            .rates
            .iter()
            .map(|r| r.unit.as_str())
            .collect::<Vec<_>>()
            != expected
        {
            return Err(Configuration);
        }
        Ok(())
    }
    pub fn calculate_charge(&self, tariff: &Tariff, usage: &[Usage]) -> Result<u128> {
        self.validate(tariff)?;
        crate::quote::calculate_charge(tariff, usage).map_err(|_| ProxyError::UsageUnknown)
    }
}
