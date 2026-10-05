import test from 'node:test';
import assert from 'node:assert/strict';
import {failureCode} from './diagnostics.ts';
import {JournalConflictError, JournalIntegrityError} from '../../packages/sdk/src/journal.ts';
import {ProviderResponseError} from './provider-diagnostics.ts';

test('provider failure preserves finite HTTP/code diagnostics without upstream values', () => {
  assert.equal(failureCode(new ProviderResponseError(503, 'operation_unavailable')), 'api_http_503_operation_unavailable');
  for (const code of ['PRIVATE_API_KEY', '__proto__', ['provider_unavailable'], null])
    assert.equal(failureCode(new ProviderResponseError(502, code)), 'api_http_502_unknown');
  assert.equal(failureCode(new ProviderResponseError(NaN, 'invalid_request')), 'api_http_0_invalid_request');
});

test('diagnostics distinguish signing guards without echoing arbitrary data', () => {
  assert.equal(failureCode(Error('wallet changed transaction message')), 'wallet_message_changed');
  assert.equal(failureCode(Error('missing or invalid wallet signature')), 'wallet_signature_invalid');
  const unsupported = Error('private browser diagnostic'); unsupported.name = 'NotSupportedError';
  assert.equal(failureCode(unsupported), 'browser_crypto_unsupported');
  for (const value of [Error('https://rpc.invalid?api-key=secret'), Error('toString'), 'private text', {message:'wallet changed transaction message'}])
    assert.equal(failureCode(value), 'operation_failed');
});

test('saved-attempt recovery failures use exact finite labels and never echo details', () => {
  const guards = {
    'corrupt transaction journal': 'transaction_journal_invalid',
    'journal proof context mismatch': 'journal_proof_context_mismatch',
    'journal payload digest mismatch': 'journal_payload_mismatch',
    'signed message does not match journal plan': 'journal_signed_message_mismatch',
    'invalid canonical hex': 'journal_encoding_invalid',
    'missing buffer: finalized history reconciliation required': 'expired_upload_buffer_missing',
    'previous attempt is not finalized-expired': 'upload_expiry_unconfirmed',
    'fresh blockhash required': 'upload_blockhash_not_fresh',
    'stale finalized buffer observation': 'upload_buffer_observation_stale',
  };
  for (const [message, code] of Object.entries(guards)) {
    assert.equal(failureCode(Error(message)), code);
    assert.equal(failureCode(Error(message + ': private data')), 'operation_failed');
  }
  assert.equal(failureCode(new JournalConflictError()), 'journal_conflict');
  assert.equal(failureCode(new JournalIntegrityError('private journal details')), 'journal_integrity');
});

test('known browser exception names return fixed labels without their message', () => {
  const names = {
    OperationError: 'browser_crypto_operation_failed', DataCloneError: 'browser_clone_failed',
    AbortError: 'browser_operation_aborted', SecurityError: 'browser_security_restriction',
  };
  for (const [name, code] of Object.entries(names)) {
    assert.equal(failureCode(new DOMException('private browser diagnostic', name)), code);
  }
  for (const name of ['toString', '__proto__', 'constructor', 'private detail']) {
    assert.equal(failureCode(new DOMException('private browser diagnostic', name)), 'operation_failed');
  }
});
