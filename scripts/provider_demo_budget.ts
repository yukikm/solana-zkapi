/** Read-only compatibility for request-bound demo rows. Frozen native campaign
 * sources retain their original pins; recovery must still count every row. */
import {demoBudgetTemplate as legacyDemoBudgetTemplate} from './i10_devnet_provider.ts';
import type {ProviderAcceptanceCase} from './provider_acceptance_client.ts';

function requireTrue(value: unknown): asserts value { if (!value) throw Error('invalid demo budget reservation'); }
export function recoveryDemoBudgetTemplate(value: Record<string, unknown>): string | null {
  if (value.kind !== 'explicit_direct_demo') return legacyDemoBudgetTemplate(value);
  const keys = ['case_id', 'kind', 'template_case_id', 'request_id', 'authorization_sha256', 'max_cost_micro_usdc', 'state'];
  requireTrue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  requireTrue(typeof value.request_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.request_id)
    && value.case_id === 'demo-auth-' + value.request_id && typeof value.authorization_sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.authorization_sha256)
    && ['openrouter-direct-plain', 'openrouter-direct-sse'].includes(value.template_case_id as string)
    && value.max_cost_micro_usdc === '1000000' && value.state === 'reserved_no_automatic_replay');
  return value.template_case_id as string;
}
export function validateRecoveryDemoCase(row: Record<string, unknown>, expected: ProviderAcceptanceCase): void {
  if (row.kind === 'explicit_direct_demo') {
    requireTrue(expected.mode === 'direct_openrouter' && expected.provider === 'openrouter'
      && ['openrouter-direct-plain', 'openrouter-direct-sse'].includes(expected.id)
      && expected.endpoint === 'chat_completions' && expected.tools === false
      && expected.stream === (expected.id === 'openrouter-direct-sse') && expected.max_cost_micro_usdc === '1000000');
  } else {
    requireTrue(expected.mode === 'proxy' && expected.provider === 'openai' && expected.endpoint === 'chat_completions'
      && !expected.stream && !expected.tools);
  }
}
