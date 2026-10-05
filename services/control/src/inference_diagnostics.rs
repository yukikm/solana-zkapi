//! Fixed diagnostics before provider egress. No request identity, credential,
//! error text, account, prompt or response is accepted by the event schema.
use crate::{ledger::LedgerError, wire::ValidationError};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    BeginDispatch,
    ClaimDispatch,
}

fn chain_reason(error: &ValidationError) -> &'static str {
    match error {
        ValidationError::Unavailable("indexer not ready") => "indexer_not_ready",
        ValidationError::Unavailable("indexer transport") => "indexer_transport",
        ValidationError::Unavailable("indexer HTTP") => "indexer_http",
        ValidationError::Unavailable(
            "chain observation deadline" | "chain observation attempts",
        ) => "chain_observation_deadline",
        ValidationError::Unavailable(
            "indexer body"
            | "indexer root encoding"
            | "indexer counter"
            | "indexer pool/counter"
            | "indexer slot"
            | "indexer sequence"
            | "indexer blockhash",
        ) => "indexer_observation_invalid",
        ValidationError::Unavailable("RPC transport" | "RPC HTTP") => "rpc_unavailable",
        ValidationError::Unavailable("RPC stale context slot") => "rpc_context_stale",
        ValidationError::Unavailable(
            "RPC JSON" | "RPC response" | "RPC result" | "RPC context slot" | "RPC account missing",
        ) => "rpc_observation_invalid",
        ValidationError::Conflict("root changed during observation") => "root_changed",
        ValidationError::Conflict("pool paused") => "pool_paused",
        ValidationError::Conflict("exit consumed") => "exit_consumed",
        ValidationError::Conflict("stale root") => "stale_root",
        ValidationError::TrustMismatch(_) => "chain_trust_mismatch",
        _ => "chain_check_failed",
    }
}

fn ledger_reason(error: &LedgerError) -> &'static str {
    match error {
        LedgerError::Conflict("session_closed_or_expired") => "session_closed_or_expired",
        LedgerError::Conflict("dispatch_not_replayable") => "dispatch_not_replayable",
        LedgerError::Conflict("dispatch_owner_fenced") => "dispatch_owner_fenced",
        LedgerError::Unavailable("writer_connection_lost") => "writer_connection_lost",
        LedgerError::Unavailable("writer_fenced") => "writer_fenced",
        LedgerError::Database(_) => "database_unavailable",
        LedgerError::Conflict(_) => "ledger_conflict",
        LedgerError::Invalid(_) => "ledger_invalid",
        LedgerError::Unavailable(_) => "ledger_unavailable",
        LedgerError::NotFound => "record_not_found",
        LedgerError::MigrationMismatch => "migration_mismatch",
    }
}

/// Observe an already-completed boundary exactly once. This cannot run a
/// provider, repeat a check, change an error, or authorize dispatch.
pub(crate) fn observe<T>(
    result: crate::ledger::Result<T>,
    stage: Stage,
    chain_error: Option<&ValidationError>,
    elapsed: Duration,
    emit: impl FnOnce(Value),
) -> crate::ledger::Result<T> {
    if let Err(error) = &result {
        let (stage, reason) = match (stage, chain_error) {
            (Stage::BeginDispatch, Some(error)) => ("chain_liveness", chain_reason(error)),
            (Stage::BeginDispatch, None) => ("begin_dispatch", ledger_reason(error)),
            (Stage::ClaimDispatch, _) => ("claim_dispatch", ledger_reason(error)),
        };
        emit(json!({
            "event": "proxy_pre_dispatch_stopped", "stage": stage, "reason": reason,
            "elapsed_ms": elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        }));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liveness_failure_is_distinct_from_admission_and_never_echoes_error_text() {
        let cases = [
            (
                ValidationError::Unavailable("indexer not ready"),
                "indexer_not_ready",
            ),
            (
                ValidationError::Unavailable("indexer transport"),
                "indexer_transport",
            ),
            (ValidationError::Unavailable("indexer HTTP"), "indexer_http"),
            (
                ValidationError::Unavailable("chain observation deadline"),
                "chain_observation_deadline",
            ),
            (
                ValidationError::Unavailable("indexer root encoding"),
                "indexer_observation_invalid",
            ),
            (ValidationError::Unavailable("RPC HTTP"), "rpc_unavailable"),
            (
                ValidationError::Unavailable("RPC stale context slot"),
                "rpc_context_stale",
            ),
            (
                ValidationError::Unavailable("RPC response"),
                "rpc_observation_invalid",
            ),
            (
                ValidationError::Conflict("root changed during observation"),
                "root_changed",
            ),
            (ValidationError::Conflict("pool paused"), "pool_paused"),
            (ValidationError::Conflict("exit consumed"), "exit_consumed"),
            (ValidationError::Conflict("stale root"), "stale_root"),
            (
                ValidationError::TrustMismatch("PRIVATE_RPC_URL_CANARY"),
                "chain_trust_mismatch",
            ),
            (
                ValidationError::Unavailable("PRIVATE_PROVIDER_CREDENTIAL_CANARY"),
                "chain_check_failed",
            ),
            (
                ValidationError::Conflict("PRIVATE_PROMPT_CANARY"),
                "chain_check_failed",
            ),
            (
                ValidationError::Invalid("PRIVATE_RESPONSE_CANARY"),
                "chain_check_failed",
            ),
            (ValidationError::Unauthorized, "chain_check_failed"),
            (ValidationError::TooLarge, "chain_check_failed"),
        ];
        for (cause, reason) in cases {
            let result = observe::<()>(
                Err(LedgerError::Unavailable("chain_unavailable")),
                Stage::BeginDispatch,
                Some(&cause),
                Duration::from_millis(17),
                |event| {
                    assert_eq!(
                        event,
                        json!({"event":"proxy_pre_dispatch_stopped", "stage":"chain_liveness", "reason":reason, "elapsed_ms":17})
                    );
                    assert!(!event.to_string().contains("PRIVATE_"));
                },
            );
            assert!(matches!(
                result,
                Err(LedgerError::Unavailable("chain_unavailable"))
            ));
        }
    }

    #[test]
    fn ledger_and_claim_failures_are_bounded_and_do_not_inherit_a_stale_chain_cause() {
        let cases = [
            (
                LedgerError::Conflict("session_closed_or_expired"),
                "session_closed_or_expired",
            ),
            (
                LedgerError::Conflict("dispatch_not_replayable"),
                "dispatch_not_replayable",
            ),
            (
                LedgerError::Conflict("dispatch_owner_fenced"),
                "dispatch_owner_fenced",
            ),
            (
                LedgerError::Unavailable("writer_connection_lost"),
                "writer_connection_lost",
            ),
            (LedgerError::Unavailable("writer_fenced"), "writer_fenced"),
            (
                LedgerError::Conflict("PRIVATE_ACCOUNT_CANARY"),
                "ledger_conflict",
            ),
            (
                LedgerError::Invalid("PRIVATE_TOKEN_CANARY"),
                "ledger_invalid",
            ),
            (
                LedgerError::Unavailable("PRIVATE_URL_CANARY"),
                "ledger_unavailable",
            ),
            (LedgerError::NotFound, "record_not_found"),
            (LedgerError::MigrationMismatch, "migration_mismatch"),
        ];
        for (error, reason) in cases {
            let expected = error.to_string();
            let result = observe::<()>(
                Err(error),
                Stage::ClaimDispatch,
                Some(&ValidationError::Unavailable("indexer not ready")),
                Duration::MAX,
                |event| {
                    assert_eq!(
                        event,
                        json!({"event":"proxy_pre_dispatch_stopped", "stage":"claim_dispatch", "reason":reason, "elapsed_ms":u64::MAX})
                    );
                    assert!(!event.to_string().contains("PRIVATE_"));
                },
            );
            assert_eq!(result.unwrap_err().to_string(), expected);
        }
    }

    #[test]
    fn completed_boundary_passes_through_unchanged_without_retry_or_extra_emission() {
        let mut completed_checks = 0;
        let mut events = Vec::new();
        let check = {
            completed_checks += 1;
            Err::<(), _>(LedgerError::Conflict("session_closed_or_expired"))
        };
        let result = observe(check, Stage::BeginDispatch, None, Duration::ZERO, |event| {
            events.push(event)
        });
        assert!(matches!(
            result,
            Err(LedgerError::Conflict("session_closed_or_expired"))
        ));
        assert_eq!(completed_checks, 1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["stage"], "begin_dispatch");
        let value = Box::new(3);
        let pointer = &*value as *const i32;
        let returned = observe(
            Ok(value),
            Stage::BeginDispatch,
            None,
            Duration::ZERO,
            |_| panic!("successful admission must not emit a stopped event"),
        )
        .unwrap();
        assert_eq!(&*returned as *const i32, pointer);
    }
}
