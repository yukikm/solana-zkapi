/** Local model configuration and real quote signatures; no live provider/chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { loadDaemonModels, type DaemonModelSource } from '../src/clientd-models.ts';
import { ControlClient, type ClientOptions, type Mode, type Quote, type Tariff } from '../src/control.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';

async function tariff(model: string, provider = 'openai', direct = false): Promise<Tariff> {
  const body = { version: '1', provider, model, pricing_basis: direct ? 'provider_reported_usd' : 'fixed_usage_rates',
    valid_from: '0', valid_until: '1000', rates: [], operator_fee_micro_usdc: '0' };
  return { ...body, tariff_hash: await sha256Hex(jcsBytes(body)) };
}
test('each configured proxy model selects its own pinned provider/API/tariff and verifies its quote', async () => {
  const files = new Map<string, Tariff>([
    ['openai.json', await tariff('gpt-example')],
    ['anthropic.json', await tariff('claude-example', 'anthropic')],
    ['openrouter.json', await tariff('openai/gpt-example', 'openrouter')],
  ]);
  const sources: DaemonModelSource[] = [
    { id: 'gpt-example', provider: 'openai', apis: ['chat', 'responses'], tariff: 'openai.json' },
    { id: 'claude-example', provider: 'anthropic', apis: ['messages', 'count_tokens'], tariff: 'anthropic.json' },
    { id: 'openai/gpt-example', provider: 'openrouter', apis: ['chat'], tariff: 'openrouter.json' },
  ];
  const pins = [...files.values()].map(value => value.tariff_hash);
  const models = await loadDaemonModels({ mode: 'proxy', models: sources }, pins, async path => files.get(path)!);
  const keys = generateKeyPairSync('ed25519'), requests: unknown[] = [];
  const context: ClientOptions['context'] = { deployment_id: 'fixture', pool: 'fixture', vault_binding: '0x' + '00'.repeat(32),
    state_key: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32)], cap_micro_usdc: '100',
    control_api_origin: 'https://control.invalid', inference_api_origin: 'https://proxy.invalid',
    quote_public_key: bs58.encode(keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    receipt_public_key: bs58.encode(new Uint8Array(32).fill(4)), request_vk_sha256: '00'.repeat(32), tariff_hashes: pins };
  const client = new ControlClient({ context, journal: {} as ClientOptions['journal'], verifier: {} as ClientOptions['verifier'], now: () => 100n,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init!.body)); requests.push(request);
      const selected = models.find(value => value.id === request.models[0])!;
      const body: Quote['body'] = { ...request, deployment_id: 'fixture', pool: 'fixture', quote_id: crypto.randomUUID(),
        tariff_hash: selected.tariff.tariff_hash, cap_micro_usdc: '100', issued_at: '100', expires_at: '220', max_concurrency: '4',
        control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin };
      const hash = await sha256Hex(jcsBytes(body));
      return Response.json({ body, quote_hash: hash, signature: sign(null, Buffer.from(hash, 'hex'), keys.privateKey).toString('base64') });
    },
  });
  for (const selected of models) {
    const quote = await client.quote({ mode: 'proxy', provider: selected.provider, models: [selected.id], session_ttl_seconds: '60' }, selected.tariff);
    assert.equal(quote.body.tariff_hash, selected.tariff.tariff_hash);
    assert.equal(quote.body.provider, selected.provider);
  }
  assert.equal(requests.length, 3);
  await assert.rejects(client.quote({ mode: 'proxy', provider: models[1].provider, models: [models[1].id], session_ttl_seconds: '60' }, models[0].tariff), /quote binding/);
});
test('legacy single proxy tariff stays compatible but cannot advertise unrelated models', async () => {
  const saved = await tariff('m'), read = async () => saved;
  const models = await loadDaemonModels({ mode: 'proxy', models: ['m'], tariff: 'legacy.json' }, [saved.tariff_hash], read);
  assert.deepEqual(models.map(({ id, provider, apis }) => ({ id, provider, apis })), [{ id: 'm', provider: 'openai', apis: ['chat', 'responses'] }]);
  await assert.rejects(loadDaemonModels({ mode: 'proxy', models: ['m', 'n'], tariff: 'legacy.json' }, [saved.tariff_hash], read), /tariff file for each proxy model/);
});
test('legacy direct wildcard tariff supports multiple concrete IDs with the same explicit provider', async () => {
  for (const [mode, provider, apis] of [
    ['direct_oa', 'oa', ['chat', 'responses']], ['direct_openrouter', 'openrouter', ['chat']],
  ] as const) {
    const saved = await tariff('*', provider, true);
    const models = await loadDaemonModels({ mode, models: ['m', 'n'], tariff: 'direct.json' }, [saved.tariff_hash], async () => saved);
    assert.deepEqual(models.map(model => model.apis), [apis, apis]);
    assert.deepEqual(models.map(model => model.tariff.model), ['*', '*']);
  }
});
test('startup rejects mixed, ambiguous, unsupported, mismatched, tampered and unpinned model configuration', async () => {
  const saved = await tariff('m'), model: DaemonModelSource = { id: 'm', provider: 'openai', apis: ['chat'], tariff: 'm.json' };
  const invalid = [
    { mode: 'proxy', models: [] },
    { mode: 'proxy', models: ['m'] },
    { mode: 'proxy', models: [model], tariff: 'legacy.json' },
    { mode: 'proxy', models: ['m', model] },
    { mode: 'proxy', models: [model, model] },
    { mode: 'proxy', models: [{ ...model, apis: ['chat', 'chat'] }] },
    { mode: 'proxy', models: [{ ...model, apis: ['messages'] }] },
    { mode: 'proxy', models: [{ ...model, provider: 'anthropic', apis: ['messages'] }] },
    { mode: 'proxy', models: [{ ...model, id: '*' }] },
    { mode: 'proxy', models: [{ ...model, id: 'n' }] },
    { mode: 'direct_oa', models: [model] },
    { mode: 'proxy', models: [{ ...model, surprise: true }] },
  ];
  for (const config of invalid) await assert.rejects(loadDaemonModels(config as Parameters<typeof loadDaemonModels>[0], [saved.tariff_hash], async () => saved));
  await assert.rejects(loadDaemonModels({ mode: 'proxy', models: [model] }, [], async () => saved), /not pinned/);
  await assert.rejects(loadDaemonModels({ mode: 'proxy', models: [model] }, [saved.tariff_hash], async () => ({ ...saved, operator_fee_micro_usdc: '1' })), /not pinned/);
  const wrongBasis = await tariff('m', 'openai', true);
  await assert.rejects(loadDaemonModels({ mode: 'proxy', models: [model] }, [wrongBasis.tariff_hash], async () => wrongBasis), /must agree/);
});
test('model configuration and returned tariffs do not retain mutable caller-owned values', async () => {
  const saved = await tariff('m'), config = { mode: 'proxy' as Mode, models: ['m'], tariff: 'm.json' }, pins = [saved.tariff_hash];
  let release!: () => void;
  const loading = loadDaemonModels(config, pins, async () => { await new Promise<void>(resolve => { release = resolve; }); return saved; });
  config.models[0] = 'n'; pins.length = 0; release();
  const models = await loading; saved.model = 'changed';
  assert.equal(models[0].id, 'm'); assert.equal(models[0].tariff.model, 'm');
});
