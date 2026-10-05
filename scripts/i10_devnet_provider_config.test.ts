/** Pure prepared-config checks using public plan data; no environment, keys,
 * provider requests, wallet, database, or budget mutation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {validatePreparedProviderConfig, validateProviderSelection} from './i10_devnet_provider.ts';
import {jcsBytes} from '../packages/sdk/src/trust.ts';

const publicPlan = JSON.parse(await readFile(new URL('../config/provider-acceptance.i10.json', import.meta.url), 'utf8'));
function fixture() {
  const plan = structuredClone(publicPlan);
  const proxyNames = [...new Set<string>(plan.cases.filter((c: any) => c.mode === 'proxy').map((c: any) => c.provider))].sort();
  // Exact shape written by provider_acceptance.py prepare(), with explicit
  // public fixture references. These files are never opened by this test.
  const providers = {proxy: proxyNames.map(provider => ({provider, credential_file: '/fixture/' + provider + '.credential',
    local_test_base: null, models: plan.models.filter((m: any) => m.profile?.provider === provider).map((m: any) => structuredClone(m.profile))})),
    direct: [{provider: 'openrouter', api_base: 'https://openrouter.ai/api/v1', inference_base: 'https://openrouter.ai/api/v1',
      credential_file: '/fixture/openrouter-management.credential', settlement_grace_seconds: 60}]};
  return {plan, providers};
}
const expected = {direct_openrouter: 'https://openrouter.ai/api/v1'};
const refused = /Provider acceptance incomplete/;

test('normalizer profile projection matches canonically independent of provider/model/object-key order', () => {
  const {plan, providers} = fixture();
  const second = {...plan.models.find((m: any) => m.profile?.provider === 'openai').profile, model: 'public-unused-profile-fixture'};
  plan.models.push({profile: second});
  providers.proxy.find(p => p.provider === 'openai')!.models.push(structuredClone(second));
  providers.proxy.reverse();
  for (const config of providers.proxy) config.models = config.models.reverse().map((p: any) => Object.fromEntries(Object.entries(p).reverse()));
  assert.deepEqual(validatePreparedProviderConfig(plan, providers), expected);
  const before = JSON.stringify({plan, providers});
  assert.deepEqual(validatePreparedProviderConfig(plan, providers), expected);
  assert.equal(JSON.stringify({plan, providers}), before, 'validation does not mutate plan/config');
});

test('context/output/cache/endpoint/model drift and missing/duplicate profiles fail closed', () => {
  const changes: [string, (profile: any, config: any) => void][] = [
    ['larger context', p => p.context_tokens++], ['smaller context', p => p.context_tokens--],
    ['larger output', p => p.max_output_tokens++], ['changed cache mode', p => p.cache_mode = 'inclusive_read_write'],
    ['different model', p => p.model += '-other'], ['different provider', p => p.provider = 'anthropic'],
    ['missing endpoint', p => p.endpoints.pop()], ['extra endpoint', p => p.endpoints.push('messages')],
    ['extra field', p => p.unreviewed_feature = true], ['missing field', p => delete p.context_tokens],
    ['missing model', (_p, c) => c.models.pop()], ['duplicate model', (p, c) => c.models.push(structuredClone(p))],
  ];
  for (const [name, change] of changes) {
    const {plan, providers} = fixture(), config = providers.proxy.find(p => p.provider === 'openai')!;
    change(config.models[0], config);
    assert.throws(() => validatePreparedProviderConfig(plan, providers), refused, name);
  }
});

test('unplanned/missing/duplicate providers and fixture routes are rejected', () => {
  const changes: [string, (p: any) => void][] = [
    ['unplanned proxy', p => p.proxy.push({...p.proxy[0], provider: 'fixture'})],
    ['missing proxy', p => p.proxy.pop()], ['duplicate proxy', p => p.proxy[1] = structuredClone(p.proxy[0])],
    ['local HTTP fixture', p => p.proxy[0].local_test_base = 'http://127.0.0.1:12345'],
    ['HTTPS fixture override', p => p.proxy[0].local_test_base = 'https://fixture.invalid'],
    ['omitted normalizer field', p => delete p.proxy[0].local_test_base],
    ['extra proxy option', p => p.proxy[0].retry = true], ['relative credential', p => p.proxy[0].credential_file = 'fixture'],
    ['unknown top field', p => p.fixture = true], ['missing direct', p => p.direct = []],
    ['extra direct', p => p.direct.push(structuredClone(p.direct[0]))],
    ['unplanned OA', p => p.direct[0] = {provider: 'oa'}],
    ['other management origin', p => p.direct[0].api_base = 'https://fixture.invalid'],
    ['other inference origin', p => p.direct[0].inference_base = 'https://fixture.invalid'],
    ['changed drain', p => p.direct[0].settlement_grace_seconds = 0],
    ['extra direct option', p => p.direct[0].retry = true],
  ];
  for (const [name, change] of changes) {
    const {plan, providers} = fixture(); change(providers);
    assert.throws(() => validatePreparedProviderConfig(plan, providers), refused, name);
  }
});

test('only profiles of selected providers are emitted, matching the normalizer', () => {
  const {plan, providers} = fixture();
  plan.cases = plan.cases.filter((c: any) => c.provider !== 'anthropic');
  providers.proxy = providers.proxy.filter(p => p.provider !== 'anthropic');
  assert.deepEqual(validatePreparedProviderConfig(plan, providers), expected);
  providers.proxy.push({provider: 'anthropic', credential_file: '/fixture/anthropic.credential', local_test_base: null,
    models: plan.models.filter((m: any) => m.profile?.provider === 'anthropic').map((m: any) => m.profile)});
  assert.throws(() => validatePreparedProviderConfig(plan, providers), refused);
});

test('an explicitly planned OA direct entry preserves exact normalizer fields and HTTPS pins', () => {
  const {plan, providers} = fixture();
  plan.cases.push({...plan.cases[0], id: 'oa-fixture', mode: 'direct_oa', provider: 'oa', endpoint: 'chat_completions'});
  const oa = {provider: 'oa', issuer_base: 'https://issuer.invalid/api', verifier_base: 'https://verifier.invalid/api',
    inference_base: 'https://inference.invalid/v1', station_id: 'public-fixture', credential_file: '/fixture/oa.credential'};
  (providers.direct as any[]).push(oa);
  assert.deepEqual(validatePreparedProviderConfig(plan, providers), {...expected, direct_oa: oa.inference_base});
  for (const key of ['issuer_base', 'verifier_base', 'inference_base']) {
    for (const invalid of ['http://127.0.0.1:12345', 'https://user:secret@fixture.invalid', 'https://fixture.invalid?override=1']) {
      const changed = structuredClone(providers); (changed.direct[1] as any)[key] = invalid;
      assert.throws(() => validatePreparedProviderConfig(plan, changed), refused);
    }
  }
});

function selectedFixture() {
  const {plan, providers} = fixture();
  const selection = {schema: 1, parent_plan_sha256: createHash('sha256').update(jcsBytes(plan)).digest('hex'),
    role: 'openai', profile: 'openai-native', case_ids: ['openai-responses-plain']};
  return {plan, providers, selection};
}
test('selected native and UI cases retain the full parent identity and exact selected tariff/profile', () => {
  const {plan, providers, selection} = selectedFixture();
  const before = JSON.stringify(plan), native = validateProviderSelection(plan, selection, 'openai-native');
  assert.deepEqual(native.cases.map(c => c.id), ['openai-responses-plain']);
  assert.equal(native.models.length, 1); assert.equal(native.models[0].tariff.provider, 'openai');
  assert.equal(native.models[0].tariff.tariff_hash, plan.models[0].tariff.tariff_hash);
  const prepared = {direct: [], proxy: providers.proxy.filter(p => p.provider === 'openai')};
  assert.deepEqual(validatePreparedProviderConfig(native, prepared), {});
  assert.throws(() => validatePreparedProviderConfig(native, providers), refused, 'full parent config cannot leak into subset');
  const ui = validateProviderSelection(plan, {...selection, profile: 'openai-ui', case_ids: ['openai-chat-plain']}, 'openai-ui');
  assert.deepEqual(ui.cases.map(c => c.id), ['openai-chat-plain']);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(plan.cases.length, 18); assert.equal(plan.budget_micro_usdc, '10000000');
});
test('selectors bind parent bytes, exact role/case IDs, canonical order and configuration profile', () => {
  const changes: [string, (s: any) => void][] = [
    ['different parent', s => s.parent_plan_sha256 = '00'.repeat(32)], ['wrong role', s => s.role = 'openrouter'],
    ['unknown role', s => s.role = 'fixture'], ['wrong profile', s => s.profile = 'openai-ui'],
    ['empty cases', s => s.case_ids = []], ['unknown case', s => s.case_ids = ['fixture']],
    ['duplicate case', s => s.case_ids.push(s.case_ids[0])],
    ['wrong provider case', s => s.case_ids = ['anthropic-messages-plain']],
    ['noncanonical order', s => s.case_ids = ['openai-responses-plain', 'openai-chat-plain']],
    ['extra selector field', s => s.extra_budget = '10000000'], ['wrong schema', s => s.schema = 2],
  ];
  for (const [name, change] of changes) {
    const {plan, selection} = selectedFixture(); change(selection);
    assert.throws(() => validateProviderSelection(plan, selection, 'openai-native'), refused, name);
  }
  const {plan, selection} = selectedFixture();
  plan.cases[0].max_cost_micro_usdc = '99999';
  assert.throws(() => validateProviderSelection(plan, selection, 'openai-native'), refused);
  const original = selectedFixture();
  assert.throws(() => validateProviderSelection(original.plan, {...original.selection, profile: '../escape'}, '../escape'), refused);
});
