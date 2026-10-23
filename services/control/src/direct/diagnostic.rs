//! Closed, secret-free diagnostics. These are observations, never settlement evidence.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticStage {
    Request,
    Response,
    Decode,
    Validation,
    Dispatcher,
    Internal,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticReason {
    TransportError,
    Timeout,
    HttpRejected,
    ResponseBodyUnavailable,
    ResponseTooLarge,
    ResponseInvalid,
    RecoveryAmbiguous,
    RecoveryLimit,
    DispatcherUnavailable,
    ClaimStorageUnavailable,
    InternalError,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssuanceCertainty {
    Unknown,
    NotSent,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub stage: DiagnosticStage,
    pub reason_code: DiagnosticReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    pub issuance_certainty: IssuanceCertainty,
}
impl Diagnostic {
    pub fn unknown(
        stage: DiagnosticStage,
        reason_code: DiagnosticReason,
        http_status: Option<u16>,
    ) -> Self {
        Self {
            stage,
            reason_code,
            http_status,
            issuance_certainty: IssuanceCertainty::Unknown,
        }
    }
    pub fn from_error(
        error: &anyhow::Error,
        stage: DiagnosticStage,
        reason: DiagnosticReason,
    ) -> Self {
        error
            .downcast_ref::<Self>()
            .cloned()
            .unwrap_or_else(|| Self::unknown(stage, reason, None))
    }
    pub fn validate(&self) -> bool {
        self.http_status
            .is_none_or(|status| (100..=599).contains(&status))
    }
}
impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "direct provider diagnostic: {:?}/{:?}",
            self.stage, self.reason_code
        )
    }
}
impl std::error::Error for Diagnostic {}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    IssuanceUnknown,
    ProviderKeyAbsent,
    ProviderLookupFailed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoveryStatus {
    pub reason_code: RecoveryReason,
    pub requires_operator_action: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuance: Option<Diagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookup: Option<Diagnostic>,
}
impl RecoveryStatus {
    pub fn unknown() -> Self {
        Self {
            reason_code: RecoveryReason::IssuanceUnknown,
            requires_operator_action: true,
            issuance: None,
            lookup: None,
        }
    }
}
