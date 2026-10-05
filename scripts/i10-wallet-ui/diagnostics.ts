/** Only fixed local labels may leave the error boundary. Never echo upstream
 * messages, response bodies, credentials, or a private journal. */
import {ProviderResponseError} from './provider-diagnostics.ts';
export function failureCode(error: unknown): string {
  if (error instanceof ProviderResponseError) return `api_http_${error.status}_${error.code}`;
  if (!(error instanceof Error)) return 'operation_failed';
  const messages: Record<string, string> = {
    'wallet changed transaction message': 'wallet_message_changed',
    'wallet changed an existing signature': 'wallet_prior_signature_changed',
    'missing or invalid wallet signature': 'wallet_signature_invalid',
    'incorrect signature count': 'wallet_signature_count',
    'wallet signature not returned': 'wallet_signature_not_returned',
    'transaction exceeds 1232-byte v0 limit': 'transaction_size_limit',
    'transaction fee cap': 'transaction_fee_limit',
    'fee unavailable': 'fee_unavailable',
    'finalized rejection requires explicit review': 'finalized_rejection',
    'journal conflict': 'journal_conflict',
    'journal integrity error': 'journal_integrity',
    'corrupt transaction journal': 'transaction_journal_invalid',
    'journal proof context mismatch': 'journal_proof_context_mismatch',
    'journal payload digest mismatch': 'journal_payload_mismatch',
    'signed message does not match journal plan': 'journal_signed_message_mismatch',
    'invalid canonical hex': 'journal_encoding_invalid',
    'missing buffer: finalized history reconciliation required': 'expired_upload_buffer_missing',
    'previous attempt is not finalized-expired': 'upload_expiry_unconfirmed',
    'fresh blockhash required': 'upload_blockhash_not_fresh',
    'stale finalized buffer observation': 'upload_buffer_observation_stale',
    'provider response body missing': 'api_response_body_missing',
    'provider response limit': 'api_response_limit',
    'provider response invalid': 'api_response_invalid',
  };
  if (Object.hasOwn(messages, error.message)) return messages[error.message];
  const names: Record<string, string> = {
    NotSupportedError: 'browser_crypto_unsupported', DataError: 'browser_data_invalid',
    QuotaExceededError: 'browser_storage_full', InvalidStateError: 'browser_state_invalid',
    OperationError: 'browser_crypto_operation_failed', DataCloneError: 'browser_clone_failed',
    AbortError: 'browser_operation_aborted', SecurityError: 'browser_security_restriction',
    JournalConflictError: 'journal_conflict', JournalIntegrityError: 'journal_integrity',
  };
  return Object.hasOwn(names, error.name) ? names[error.name] : 'operation_failed';
}
