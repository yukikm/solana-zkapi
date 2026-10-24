/** Copied into an isolated npm consumer by run_external_sdk_acceptance.py.
 * Every SDK import resolves through the installed tarball; service files are
 * separately copied local test fixtures. No checkout SDK source is imported. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRecoveryKit, createRecoveryStorage, openRecoveryStorage } from '@zkapi/solana-sdk/recovery';
import { saveRecoverySessionFile, loadRecoverySessionFile, writeRecoveryKitFile } from '@zkapi/solana-sdk/recovery-node';
import { EncryptedJournal } from '@zkapi/solana-sdk/journal';
import { ControlClient, validateNoteJournal } from '@zkapi/solana-sdk/control';
import { startRecoveryServer } from './recovery-service/server.mjs';

const field = n => '0x' + n.toString(16).padStart(64, '0');
const context = { deploymentId: 'installed-recovery-fixture', pool: 'fixture-pool', wallet: 'fixture-wallet' };
const verification = { deployment_id: context.deploymentId, pool: context.pool, vault_binding: field(1), state_key: [field(2), field(3)], cap_micro_usdc: '100',
  control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid', quote_public_key: '00'.repeat(32), receipt_public_key: '00'.repeat(32),
  request_vk_sha256: '00'.repeat(32), tariff_hashes: ['33'.repeat(32)] };
const requestId = '12345678-1234-4123-8123-123456789012';
function pendingNote() {
  const prepared = {
    request: { authorization: { version: '1', deployment_id: context.deploymentId, pool: context.pool, request_id: requestId, quote_hash: '00'.repeat(32), mode: 'direct_openrouter', control_secret_hash: '11'.repeat(32), proxy_secret_hash: null },
      quote: { body: { quote_id: 'fixture', deployment_id: context.deploymentId, pool: context.pool, mode: 'direct_openrouter', provider: 'openrouter', models: ['*'], tariff_hash: '33'.repeat(32), cap_micro_usdc: '100', issued_at: '100', expires_at: '200', session_ttl_seconds: '60', max_concurrency: '4', control_api_origin: verification.control_api_origin, inference_api_origin: verification.inference_api_origin }, quote_hash: '00'.repeat(32), signature: 'synthetic-signature' },
      public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'synthetic-proof-not-live-acceptance' } },
    control_token: 'zkc1.synthetic-control-token', proxy_token: null, rerandomization: field(13),
    tariff: { tariff_hash: '33'.repeat(32), version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd', valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' },
  };
  return { schema: 2, state: { balance_micro_usdc: '177', balance_blinding: field(3), note_leaf: field(4), commitment: { x: field(5), y: field(6) }, anchor: field(7), state_signature: { r_x: field(9), r_y: field(10), s: field(11) } },
    witness: { secret: field(2), note_id: 1, deposit_micro_usdc: '200', expiry: '9999999999' }, wallet: { status: 'active', history: [] }, history: [],
    pending: { prepared, exactRequest: JSON.stringify(prepared.request), phase: 'send_unknown', operations: [] } };
}

test('installed SDK restores validated financial custody in a fresh process after device deletion and fences its old owner', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zkapi-installed-recovery-'));
  const service = await startRecoveryServer({ directory: join(root, 'service'), host: '127.0.0.1', port: 0, allowedOrigins: ['https://fixture.invalid'], localTestOnly: true });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const original = join(root, 'original'), backup = join(root, 'independent-backup'), fresh = join(root, 'fresh');
  for (const directory of [original, backup, fresh]) await mkdir(directory, { mode: 0o700 });
  const kit = createRecoveryKit({ endpoint: `http://127.0.0.1:${service.address.port}/recovery/v1`, context });
  const kitFile = join(backup, 'recovery.json'); await writeRecoveryKitFile(kitFile, kit);
  const owner = await createRecoveryStorage(kit), savedSession = structuredClone(owner.session);
  await saveRecoverySessionFile(join(original, 'session.json'), owner.session);
  const journal = new EncryptedJournal(owner.store, owner.key, context, validateNoteJournal), note = pendingNote();
  const before = structuredClone(note); before.state.balance_micro_usdc = '200'; before.pending = null;
  await journal.create('note', before); await journal.compareAndSwap('note', 1, note);
  await owner.close(); await rm(original, { recursive: true });
  const program = `
    import {readRecoveryKitFile,saveRecoverySessionFile} from '@zkapi/solana-sdk/recovery-node';
    import {restoreRecoveryStorage} from '@zkapi/solana-sdk/recovery';
    import {EncryptedJournal} from '@zkapi/solana-sdk/journal';
    import {validateNoteJournal} from '@zkapi/solana-sdk/control';
    const kit=await readRecoveryKitFile(process.argv[1]);
    const storage=await restoreRecoveryStorage(kit,{previousOwnerStopped:true,expectedEndpoint:process.argv[3]});
    const record=await new EncryptedJournal(storage.store,storage.key,kit.context,validateNoteJournal).read('note');
    await saveRecoverySessionFile(process.argv[2],storage.session);await storage.close();
    process.stdout.write(JSON.stringify(record));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, kitFile, join(fresh, 'session.json'), `http://127.0.0.1:${service.address.port}/recovery/v1`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
  const restored = JSON.parse(stdout); assert.equal(restored.revision, 2); assert.deepEqual(restored.value, note);
  await assert.rejects(openRecoveryStorage(savedSession), error => error.code === 'ownership_changed');
  const storage = await openRecoveryStorage(await loadRecoverySessionFile(join(fresh, 'session.json')));
  const restarted = new EncryptedJournal(storage.store, storage.key, context, validateNoteJournal);
  let effects = 0;
  const control = new ControlClient({ context: verification, journal: restarted,
    verifier: { async prepare() { effects++; throw Error('unexpected proof'); }, async settle() { effects++; throw Error('unexpected settlement'); } },
    fetch: async () => { effects++; throw Error('unexpected financial network action'); } });
  await assert.rejects(control.prepare('note', note.pending.prepared, field(14)), /unresolved authorization/);
  await assert.rejects(control.sendDirectOperation('note', '12345678-1234-4123-8123-123456789013', '/v1/chat/completions', new TextEncoder().encode('{"messages":[]}')), /active direct session/);
  assert.equal(effects, 0); assert.deepEqual((await restarted.read('note')).value, note); await storage.close();
});
