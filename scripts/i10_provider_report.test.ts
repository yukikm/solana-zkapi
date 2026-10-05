/** Offline immutable evidence tests: synthetic budgets, no provider or RPC. */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {retainCompletedProviderReport, saveProviderFailureDiagnostic} from './i10_devnet_provider.ts';
import {ProviderAcceptanceFailure, type ProviderAcceptanceDiagnostic} from './provider_acceptance_client.ts';
import {jcsBytes} from '../packages/sdk/src/trust.ts';

const reservation = (case_id: string, amount = '10') => ({case_id, max_cost_micro_usdc: amount, state: 'reserved_no_automatic_replay'});
function report(reservations = [reservation('profile-a')]) {
  const sum = reservations.reduce((n, entry) => n + BigInt(entry.max_cost_micro_usdc), 0n);
  return {schema: 1, passed: true, plan_sha256: 'ab'.repeat(32), campaign_id: 'fixture', pool: 'fixture-pool',
    source_sha256: {'fixture.ts': 'cd'.repeat(32)}, selection: {profile: 'profile-a', case_ids: ['profile-a']},
    cases: [{case_id: 'profile-a', reserved_micro_usdc: '10', request_id: 'fixture-request', inference_sends: 1}],
    budget: {identity: {schema: 1, campaign_id: 'fixture', plan_sha256: 'ab'.repeat(32), budget_micro_usdc: '100', max_requests: 5},
      reserved_micro_usdc: String(sum), remaining_micro_usdc: String(100n - sum), reservations,
      refunds_supported: false, inference_replays_supported: false}, full_g3_passed: false};
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'provider-immutable-report-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return join(dir, 'completed.json');
}

test('completed profile reuses original budget snapshot and exact report bytes after another profile reserves', async t => {
  const path = await fixture(t), saved = report();
  // Existing whitespace/order is part of immutable public evidence bytes.
  const bytes = JSON.stringify(saved, null, 4) + '\n\n';
  await writeFile(path, bytes, {mode: 0o600});
  const current = report([reservation('profile-a'), reservation('profile-b', '20')]);
  const reused = await retainCompletedProviderReport(path, current);
  assert.deepEqual(jcsBytes(reused), jcsBytes(saved)); assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(current.budget.reserved_micro_usdc, '30');
  assert.equal(reused.budget.reserved_micro_usdc, '10');
  assert.deepEqual(jcsBytes(await retainCompletedProviderReport(path, current)), jcsBytes(saved));
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('first completion is durable and a same-snapshot reopen does not rewrite it', async t => {
  const path = await fixture(t), current = report();
  assert.deepEqual(jcsBytes(await retainCompletedProviderReport(path, current)), jcsBytes(current));
  const bytes = await readFile(path);
  assert.deepEqual(jcsBytes(await retainCompletedProviderReport(path, current)), jcsBytes(current));
  assert.deepEqual(await readFile(path), bytes);
});

test('budget rollback, substitution, malformed arithmetic and mutable profile evidence fail without changing report', async t => {
  const path = await fixture(t), saved = report([reservation('profile-a'), reservation('profile-b', '20')]);
  await retainCompletedProviderReport(path, saved); const bytes = await readFile(path);
  const cases: ((v: ReturnType<typeof report>) => void)[] = [
    v => { v.cases[0].request_id = 'substituted'; },
    v => { v.source_sha256['fixture.ts'] = 'ef'.repeat(32); },
    v => { v.pool = 'other'; },
    v => { v.selection.profile = 'profile-b'; },
    v => { v.budget.identity.campaign_id = 'other'; },
    v => { v.budget.identity.plan_sha256 = 'ef'.repeat(32); },
    v => { v.budget.identity.budget_micro_usdc = '200'; v.budget.remaining_micro_usdc = '170'; },
    v => { v.budget.identity.max_requests = 6; },
    v => { v.budget.reservations.pop(); v.budget.reserved_micro_usdc = '10'; v.budget.remaining_micro_usdc = '90'; },
    v => { v.budget.reservations.reverse(); },
    v => { v.budget.reservations[1].case_id = 'substituted'; },
    v => { v.budget.reservations.push(reservation('profile-a')); v.budget.reserved_micro_usdc = '40'; v.budget.remaining_micro_usdc = '60'; },
    v => { v.budget.reservations[1].max_cost_micro_usdc = '21'; v.budget.reserved_micro_usdc = '31'; v.budget.remaining_micro_usdc = '69'; },
    v => { v.budget.refunds_supported = true; },
    v => { v.budget.inference_replays_supported = true; },
    v => { v.budget.remaining_micro_usdc = '80'; },
    v => { v.budget.reserved_micro_usdc = '030'; },
    v => { v.budget.identity.max_requests = 1; },
    v => { v.budget.reservations[0].state = 'refunded'; },
    v => { (v.budget as unknown as Record<string, unknown>).extra = true; },
  ];
  for (const mutate of cases) {
    const current = structuredClone(saved); mutate(current);
    await assert.rejects(retainCompletedProviderReport(path, current), /preserve SDK journal/);
    assert.deepEqual(await readFile(path), bytes);
  }
});

test('saved snapshot must include the completed profile case even if a later valid budget does', async t => {
  const path = await fixture(t), saved = report([]);
  const bytes = JSON.stringify(saved); await writeFile(path, bytes, {mode: 0o600});
  await assert.rejects(retainCompletedProviderReport(path, report()), /preserve SDK journal/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('failure checkpoint accepts only bounded fixed metadata and preserves original bytes', async t => {
  const path = await fixture(t);
  const diagnostic: ProviderAcceptanceDiagnostic = {schema: 1, stage: 'close', elapsed_ms: 12, control_http_status: 503,
    inference: {stage: 'response_status', elapsed_ms: 3, http_status: 502, service_error_code: 'provider_unavailable', response_bytes: 0,
      sdk_send_invoked: true}, settlement: 'unresolved', inference_replays: 0};
  const error = new ProviderAcceptanceFailure(diagnostic);
  error.message = 'PRIVATE_EXCEPTION_CANARY'; error.stack = 'PRIVATE_STACK_CANARY';
  await saveProviderFailureDiagnostic(path, 'profile-a', 'ab'.repeat(32), error);
  const bytes = await readFile(path, 'utf8'); assert.ok(!bytes.includes('PRIVATE_'));
  assert.equal(JSON.parse(bytes).passed, false); assert.equal(JSON.parse(bytes).full_g3_passed, false);
  const changes: ((d: ProviderAcceptanceDiagnostic) => void)[] = [
    d => { d.elapsed_ms = -1; }, d => { d.elapsed_ms = 2 ** 32; }, d => { d.control_http_status = 600; },
    d => { (d as unknown as Record<string, unknown>).raw_error = 'PRIVATE_ERROR'; },
    d => { d.inference!.elapsed_ms = 1.5; }, d => { d.inference!.response_bytes = 8 * 1024 * 1024 + 1; },
    d => { (d.inference as unknown as Record<string, unknown>).service_error_code = 'PRIVATE_HEADER'; },
    d => { (d as unknown as Record<string, unknown>).stage = 'PRIVATE_STAGE'; },
    d => { d.elapsed_ms = 13; }, // Even another valid event cannot replace the checkpoint.
  ];
  for (const change of changes) {
    const d = structuredClone(diagnostic); change(d);
    await assert.rejects(saveProviderFailureDiagnostic(path, 'profile-a', 'ab'.repeat(32), new ProviderAcceptanceFailure(d)));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});
