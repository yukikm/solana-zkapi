/** One read-only PG snapshot joined to a parent-captured public UI observation.
 * No provider requests, chain RPC, log reads, AUTH, or mutable ledger actions. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey, verify} from 'node:crypto';
import {address,getAddressEncoder} from '@solana/kit';
import {jcsBytes, parseStrictJson} from '../packages/sdk/src/trust.ts';

const observationPath = 'docs/evidence/I10-repeat-demo-api-observation.json';
const beforePath = 'docs/evidence/I10-repeat-demo-before.json';
const budgetPath = 'target/i10-provider-acceptance/budget-state.json';
const outputPath = 'docs/evidence/I10-repeat-demo-api-runtime.json';
const sourcePath = 'scripts/i10_collect_repeat_api.ts';
const backend = 'target/i10-live-demo-backend';
const read = (path: string): any => parseStrictJson(readFileSync(path));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));
const integer = (value: unknown): bigint => { assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)); return BigInt(value); };
const uuid = (value: unknown): string => { assert.ok(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)); return value; };
let phase = 'observation';
try {
  // Bare #state only: this must never read a wallet export or encrypted journal.
  const ui = read(observationPath);
  assert.equal(ui.fixture_only, false); assert.equal(ui.wallet_status, 'active');
  assert.equal(ui.wallet, 'Phantom'); assert.equal(ui.session, null); assert.equal(ui.operation, null);
  assert.equal(ui.unresolved_transaction, null); assert.equal(ui.permanent_clearance, false);
  assert.equal(ui.provider_request_policy, 'explicit_demo'); assert.equal(ui.run_id, 'openai-ui');
  assert.ok(Number.isSafeInteger(ui.journal_revision) && ui.journal_revision > 0);
  assert.ok(Array.isArray(ui.verified_settlements) && [1, 2].includes(ui.verified_settlements.length));

  phase = 'budget_and_identity';
  const before = read(beforePath), budget = read(budgetPath), budgetHash = fileSha(budgetPath);
  assert.equal(before.budget.reservations.length, 5);
  assert.deepEqual(budget.identity, before.budget.identity);
  assert.deepEqual(budget.reservations.slice(0, 5), before.budget.reservations);
  const added = budget.reservations.slice(5);
  assert.equal(added.length, ui.verified_settlements.length);
  for (const [path, hash] of Object.entries(before.before_sha256)) {
    if (path !== budgetPath) assert.equal(fileSha(path), hash);
  }
  const requestIds = new Set<string>(), operationIds = new Set<string>();
  for (const row of added) {
    assert.deepEqual(Object.keys(row).sort(), ['case_id', 'kind', 'max_cost_micro_usdc', 'operation_id', 'request_id', 'state', 'template_case_id']);
    uuid(row.request_id); uuid(row.operation_id);
    assert.ok(!requestIds.has(row.request_id) && !operationIds.has(row.operation_id));
    requestIds.add(row.request_id); operationIds.add(row.operation_id);
    assert.equal(row.kind, 'explicit_demo'); assert.equal(row.template_case_id, 'openai-chat-plain');
    assert.equal(row.case_id, 'demo-' + row.operation_id); assert.equal(row.max_cost_micro_usdc, '19277');
    assert.equal(row.state, 'reserved_no_automatic_replay');
  }
  assert.deepEqual(new Set(ui.verified_settlements.map((row: any) => row.request_id)), requestIds);
  const control = read(`${backend}/control.json`), dispatcher = read(`${backend}/dispatcher.json`);
  assert.equal(ui.manifest_hash, control.manifest.manifest_hash); assert.equal(ui.pool, control.manifest.pool);
  assert.equal(ui.provider_plan_sha256, budget.identity.plan_sha256);
  const plan = read('config/provider-acceptance.i10.json'); assert.equal(sha(jcsBytes(plan)), budget.identity.plan_sha256);
  const db = Object.fromEntries((dispatcher.database_url as string).split(' ').map(part => part.split('=')));
  assert.equal(db.dbname, 'postgres'); assert.ok(db.host.startsWith(process.cwd() + '/target/'));
  assert.match(db.port, /^[0-9]{1,5}$/);
  const targets = added.map((row: any) => `('${uuid(row.request_id)}'::uuid,'${uuid(row.operation_id)}'::uuid)`).join(',');
  const sql = `WITH targets(request_id,operation_id) AS (VALUES ${targets}) SELECT json_build_object(
 'read_only',current_setting('default_transaction_read_only'),
 'cases',(SELECT json_agg(json_build_object(
  'request_id',t.request_id,'operation_id',t.operation_id,
  'session',(SELECT row_to_json(s) FROM (SELECT state,close_requested,cap_micro::text,charged_nano::text,reserved_nano::text,active_operations FROM sessions WHERE request_id=t.request_id) s),
  'operation_count',(SELECT count(*) FROM operations WHERE request_id=t.request_id),
  'operation',(SELECT row_to_json(o) FROM (SELECT state,reservation_nano::text,charged_nano::text,observed_cost_nano::text,operator_loss_nano::text,dispatched_at IS NOT NULL AS dispatched,provider_request_id IS NOT NULL AS provider_request_id_present FROM operations WHERE request_id=t.request_id AND operation_id=t.operation_id) o),
  'dispatch_attempts',(SELECT count(*) FROM dispatch_attempts WHERE request_id=t.request_id AND operation_id=t.operation_id),
  'finished_dispatch_attempts',(SELECT count(*) FROM dispatch_attempts WHERE request_id=t.request_id AND operation_id=t.operation_id AND finished_at IS NOT NULL),
  'provider_evidence',(SELECT count(*) FROM provider_evidence WHERE request_id=t.request_id AND operation_id=t.operation_id),
  'receipt_count',(SELECT count(*) FROM receipts WHERE request_id=t.request_id),
  'receipt',(SELECT json_build_object('body',encode(canonical_body,'base64'),'hash',encode(receipt_hash,'hex'),'signature',encode(signature,'base64')) FROM receipts WHERE request_id=t.request_id AND operation_id=t.operation_id),
  'settlement',(SELECT row_to_json(s) FROM (SELECT charge_micro::text,state_signature IS NOT NULL AS signed FROM settlements WHERE request_id=t.request_id) s)
 )) FROM targets t))`;

  phase = 'read_only_database';
  const output = execFileSync('/opt/homebrew/bin/psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', db.host, '-p', db.port,
    '-U', 'i10_devnet_test', '-d', 'postgres', '-c', sql], {env: {PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000'}, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe']});
  const observed = JSON.parse(output); assert.equal(observed.read_only, 'on');
  assert.equal(observed.cases.length, added.length);
  const receiptKey = new Uint8Array(getAddressEncoder().encode(address(control.manifest.receipt_public_key)));
  const key = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(receiptKey)]), format: 'der', type: 'spki'});
  let balance = 2_000_000n, totalCharge = 0n;
  const cases = [];
  phase = 'receipt_and_projection_verification';
  for (const history of ui.verified_settlements) {
    const matches = observed.cases.filter((row: any) => row.request_id === history.request_id); assert.equal(matches.length, 1);
    const row = matches[0]; assert.equal(added.find((entry: any) => entry.request_id === row.request_id)?.operation_id, row.operation_id);
    assert.equal(row.session.state, 'SETTLED'); assert.equal(row.session.close_requested, true);
    assert.equal(row.session.reserved_nano, '0'); assert.equal(row.session.active_operations, 0);
    assert.equal(row.operation_count, 1); assert.equal(row.operation.state, 'DONE'); assert.equal(row.operation.dispatched, true);
    assert.equal(row.dispatch_attempts, 1); assert.equal(row.finished_dispatch_attempts, 1); assert.equal(row.receipt_count, 1);
    // Proxy usage is authenticated by its signed receipt. The separate evidence
    // table may have no rows for this adapter; record its count without inventing one.
    assert.ok(Number.isSafeInteger(row.provider_evidence) && row.provider_evidence >= 0);
    const bytes = Buffer.from(row.receipt.body, 'base64'), body = parseStrictJson(bytes) as any;
    assert.deepEqual(Buffer.from(jcsBytes(body)), bytes); assert.equal(sha(bytes), row.receipt.hash);
    assert.ok(verify(null, Buffer.from(row.receipt.hash, 'hex'), key, Buffer.from(row.receipt.signature, 'base64')));
    assert.equal(body.request_id, row.request_id); assert.equal(body.operation_id, row.operation_id);
    assert.equal(body.pool, control.manifest.pool); assert.equal(body.deployment_id, control.manifest.deployment_id);
    assert.equal(body.billing_effect, 'charge'); assert.equal(body.evidence_kind, 'PROXY_USAGE'); assert.equal(body.reason, 'metered');
    const tariffs = plan.models.map((entry: any) => entry.tariff).filter((tariff: any) => tariff.tariff_hash === body.tariff_hash);
    assert.equal(tariffs.length, 1); const tariff = tariffs[0], {tariff_hash, ...tariffBody} = tariff;
    assert.equal(sha(jcsBytes(tariffBody)), tariff_hash); assert.equal(tariff.provider, 'openai');
    assert.equal(tariff.model, 'gpt-4o-mini-2024-07-18'); assert.equal(tariff.operator_fee_micro_usdc, '0');
    const units = new Map<string, bigint>();
    for (const entry of body.usage) { assert.ok(!units.has(entry.unit)); units.set(entry.unit, integer(entry.count)); }
    assert.equal(units.size, tariff.rates.length); let nano = 0n;
    for (const rate of tariff.rates) { assert.equal(rate.unit_denominator, '1'); assert.ok(units.has(rate.unit)); nano += units.get(rate.unit)! * integer(rate.nano_usdc_numerator); }
    assert.equal(nano.toString(), body.observed_nano_usdc); assert.equal(nano.toString(), body.charged_nano_usdc);
    assert.equal(nano.toString(), row.operation.observed_cost_nano); assert.equal(nano.toString(), row.operation.charged_nano);
    assert.equal(nano.toString(), row.session.charged_nano); assert.equal(body.operator_loss_nano_usdc, '0'); assert.equal(row.operation.operator_loss_nano, '0');
    const charge = (nano + 999n) / 1000n; assert.ok(charge > 0n);
    assert.equal(charge.toString(), row.settlement.charge_micro); assert.equal(row.settlement.signed, true);
    assert.equal(history.balance_before_micro_usdc, balance.toString()); assert.equal(history.charge_micro_usdc, charge.toString());
    assert.deepEqual(history.receipt_ids, [body.receipt_id]); assert.deepEqual(history.operation_ids, [row.operation_id]);
    assert.deepEqual(history.billing_effects, ['charge']); balance -= charge; totalCharge += charge;
    cases.push({request_id: row.request_id, operation_id: row.operation_id, session: row.session, operation: row.operation,
      counts: {operations: row.operation_count, committed_dispatch_attempts: row.dispatch_attempts, finished_dispatch_attempts: row.finished_dispatch_attempts,
        provider_evidence_rows: row.provider_evidence, receipts: row.receipt_count},
      receipt: {receipt_id: body.receipt_id, receipt_hash: row.receipt.hash, signature_verified: true, canonical_digest_verified: true,
        request_operation_pool_deployment_binding_verified: true, evidence_kind: body.evidence_kind, reason: body.reason,
        billing_effect: body.billing_effect, tariff_hash, model: tariff.model, usage: body.usage,
        observed_nano_usdc: body.observed_nano_usdc, charged_nano_usdc: body.charged_nano_usdc, operator_loss_nano_usdc: body.operator_loss_nano_usdc,
        fixed_integer_tariff_math_verified: true},
      settlement: {...row.settlement, integer_micro_rounding_verified: true, successor_signature_cryptographically_verified_by_collector: false},
      sdk_projection_match: true, balance_after_micro_usdc: balance.toString()});
  }
  assert.equal(ui.balance_micro_usdc, balance.toString());
  assert.equal(ui.response_observation.operation_id, cases.at(-1)!.operation_id);
  assert.equal(ui.response_observation.http_status, 200);
  assert.ok(Number.isSafeInteger(ui.response_observation.response_bytes) && ui.response_observation.response_bytes > 0);
  assert.match(ui.response_observation.response_sha256, /^[0-9a-f]{64}$/);
  phase = 'unchanged_budget_and_report';
  assert.equal(fileSha(budgetPath), budgetHash, 'budget changed during collection');
  const reserved = budget.reservations.reduce((sum: bigint, row: any) => sum + integer(row.max_cost_micro_usdc), 0n);
  assert.ok(reserved <= integer(budget.identity.budget_micro_usdc)); assert.ok(budget.reservations.length <= budget.identity.max_requests);
  const report = {schema: 1, collected_at_utc: new Date().toISOString(), fixture_only: false, cases,
    total_charge_micro_usdc: totalCharge.toString(), starting_micro_usdc: '2000000', remaining_micro_usdc: balance.toString(),
    ui_cross_check: {artifact: observationPath, sha256: fileSha(observationPath), journal_revision: ui.journal_revision,
      pending_session: null, pending_wallet_operation: null, response_observation: ui.response_observation,
      verified_successor_source: 'existing browser SDK verification represented by parent-captured public #state'},
    parent_budget: {identity: budget.identity, original_five_rows_unchanged: true, before_artifact: beforePath,
      immutable_before_file_hashes_verified: true, reservation_count: budget.reservations.length,
      reserved_micro_usdc: reserved.toString(), remaining_micro_usdc: (integer(budget.identity.budget_micro_usdc) - reserved).toString(),
      new_explicit_demo_reservations: added, budget_file_sha256: budgetHash},
    method: {database: 'one SELECT snapshot; default_transaction_read_only=on; statement_timeout=5000; bound exact session/operation UUIDs; no tokens/prompts/credentials/encrypted records read',
      receipt: 'SHA256 canonical public receipt body, Ed25519 manifest receipt key, request/operation/pool/deployment binding, integer frozen-tariff math and per-session micro rounding',
      logs: 'not read', collector_source: sourcePath, collector_source_sha256: fileSha(sourcePath), command: 'target/i08-toolchain/bin/node ' + sourcePath},
    collector_actions: {provider_or_AUTH_requests: 0, chain_RPC_or_sends: 0, PG_mutations: 0, config_budget_or_journal_mutations: 0},
    limitations: ['Dispatch counts come from the immutable ledger, not packet capture.', 'Only the latest response observation is retained in the public UI projection; it reports HTTP200 and a body digest, not independently verified provider text.',
      'The collector verifies receipt signatures and tariff math; successor signature validation remains the existing browser SDK verification, cross-checked through public projection.',
      'New explicit requests do not replay or modify any prior case. This does not establish withdrawal of the new note, full I10, hosted CI, G3 as a whole or G1-G4.'], release_gates_passed: []};
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: true,requests: cases.length,charge_micro_usdc: totalCharge.toString(),remaining_micro_usdc: balance.toString(),report: outputPath}));
} catch (error) {
  // Never emit exec errors, private configuration or unfiltered DB values.
  const sourceLine = error instanceof Error ? /i10_collect_repeat_api\.ts:(\d+):/.exec(error.stack ?? '')?.[1] : undefined;
  console.error(JSON.stringify({passed: false, phase, source_line: sourceLine})); process.exitCode = 1;
}
