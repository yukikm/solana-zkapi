/** Fixed public diagnostics only; upstream messages and credentials stay private. */
const codes = new Set(['provider_unavailable', 'operation_unavailable', 'operation_in_progress',
  'response_not_replayable', 'idempotency_conflict', 'rate_limited', 'invalid_request',
  'invalid_credential', 'adapter_unavailable']);
export function providerErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && codes.has(value) ? value : undefined;
}
export class ProviderResponseError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: unknown) {
    super('provider response unavailable');
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    this.code = providerErrorCode(code) ?? 'unknown';
  }
}
