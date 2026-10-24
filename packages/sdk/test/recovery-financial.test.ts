/** Shared financial journal integration: real journal/control/client gates, synthetic verifier/provider. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlClient, validateNoteJournal, type NoteJournal, type PreparedSession, type VerificationContext, type SessionVerifier } from '../src/control.ts';
import { ZkApiClient, type ClientComponents } from '../src/client.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { createRecoveryKit, createRecoveryStorage, restoreRecoveryStorage } from '../src/recovery.ts';
import { recoveryContext, recoveryEndpoint, recoveryNoteId, recoveryServer } from './recovery-fixture.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const requestId = '12345678-1234-4123-8123-123456789012';
const context: VerificationContext = {
  deployment_id: recoveryContext.deploymentId, pool: recoveryContext.pool, vault_binding: field(1), state_key: [field(2), field(3)], cap_micro_usdc: '100',
  control_api_origin: 'https://control.invalid', inference_api_origin: 'https://provider.invalid', quote_public_key: '00'.repeat(32), receipt_public_key: '00'.repeat(32),
  request_vk_sha256: '00'.repeat(32), tariff_hashes: ['33'.repeat(32)],
};
function prepared(): PreparedSession {
  return {
    request: {
      authorization: { version: '1', deployment_id: context.deployment_id, pool: context.pool, request_id: requestId, quote_hash: '00'.repeat(32), mode: 'direct_openrouter', control_secret_hash: '11'.repeat(32), proxy_secret_hash: null },
      quote: { body: { quote_id: 'synthetic-quote', deployment_id: context.deployment_id, pool: context.pool, mode: 'direct_openrouter', provider: 'openrouter', models: ['*'], tariff_hash: '33'.repeat(32), cap_micro_usdc: '100', issued_at: '100', expires_at: '200', session_ttl_seconds: '60', max_concurrency: '4', control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin }, quote_hash: '00'.repeat(32), signature: 'synthetic-signature' },
      public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'synthetic-proof-not-live-acceptance' },
    },
    control_token: 'zkc1.synthetic-exact-recovery-credential', proxy_token: null,
    tariff: { tariff_hash: '33'.repeat(32), version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd', valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' },
    rerandomization: field(13),
  };
}
function fundedNote(): NoteJournal {
  return {
    schema: 2,
    state: { balance_micro_usdc: '200', balance_blinding: field(3), note_leaf: field(4), commitment: { x: field(5), y: field(6) }, anchor: field(7), state_signature: { r_x: field(9), r_y: field(10), s: field(11) } },
    witness: { secret: field(2), note_id: 1, deposit_micro_usdc: '200', expiry: '9999999999' }, wallet: { status: 'active', history: [] }, pending: null, history: [],
  };
}
const verifier: SessionVerifier = { async prepare() {}, async settle() { throw new Error('synthetic fixture must not claim settlement'); } };

test('full validated NoteJournal survives migration and local deletion; restored pending AUTH blocks new chat without a replay', async t => {
  const server = await recoveryServer(t), directory = await mkdtemp(join(tmpdir(), 'zkapi-original-full-note-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalStore = await NativeJournalStore.open(directory), originalKey = await importJournalKey(new Uint8Array(32).fill(17));
  assert.equal(originalKey.extractable, false);
  const original = new EncryptedJournal<NoteJournal>(originalStore, originalKey, recoveryContext, validateNoteJournal);
  await original.create(recoveryNoteId, fundedNote());
  let controlCalls = 0;
  const noResponse: typeof fetch = async () => { controlCalls++; throw new Error('synthetic AUTH response lost'); };
  const control = new ControlClient({ context, journal: original, verifier, fetch: noResponse, now: () => 150n });
  await control.prepare(recoveryNoteId, prepared(), field(14));
  await assert.rejects(control.submit(recoveryNoteId), /response lost/);
  const expected = (await original.read(recoveryNoteId))!;
  assert.equal(expected.value.pending?.phase, 'send_unknown'); assert.equal(expected.value.pending?.exactRequest, JSON.stringify(prepared().request));
  assert.equal(controlCalls, 1);
  const kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext }), target = await createRecoveryStorage(kit, { fetch: server.fetch });
  const copied = await original.copyTo(recoveryNoteId, target);
  assert.equal(copied?.revision, expected.revision); assert.deepEqual(copied?.value, expected.value);
  assert.deepEqual((await original.read(recoveryNoteId))?.value, expected.value);
  await target.close(); await rm(directory, { recursive: true });
  const restored = await restoreRecoveryStorage(kit, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch });
  const journal = new EncryptedJournal<NoteJournal>(restored.store, restored.key, recoveryContext, validateNoteJournal);
  const recovered = (await journal.read(recoveryNoteId))!;
  assert.deepEqual(recovered.value, expected.value); assert.equal(recovered.revision, expected.revision);
  const restartedControl = new ControlClient({ context, journal, verifier, fetch: noResponse, now: () => 150n });
  await assert.rejects(restartedControl.prepare(recoveryNoteId, prepared(), field(14)), /unresolved authorization/);
  await assert.rejects(restartedControl.sendDirectOperation(recoveryNoteId, '12345678-1234-4123-8123-123456789013', '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","messages":[]}')), /active direct session/);
  const components = {
    store: restored.store, noteId: recoveryNoteId, mode: 'direct_openrouter',
    models: [{ id: 'fixture-model', provider: 'openrouter', apis: ['chat'], tariff: prepared().tariff }], control: restartedControl,
    wallet: {
      manifest: { deployment_id: context.deployment_id, pool: context.pool, cap_micro_usdc: '100', control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin },
      journal, prover: {}, chain: {}, rpc: {}, wallets: [{ publicKey: '11111111111111111111111111111111', supportedTransactionVersions: new Set([0]), async signTransaction() { assert.fail('restore prompted a wallet'); } }],
    },
  } as unknown as ClientComponents;
  const client = new ZkApiClient(components); t.after(() => client.dispose());
  const status = await client.status(); assert.equal(status.canRequest, false); assert.equal(status.session?.phase, 'send_unknown'); assert.equal(status.settledBalanceMicroUsdc, '200');
  await assert.rejects(client.chat({ operationId: '12345678-1234-4123-8123-123456789014', model: 'fixture-model', messages: [{ role: 'user', content: 'Must not be sent' }], maxOutputTokens: 1 }));
  assert.equal(controlCalls, 1, 'restoration/status/new chat must not resend AUTH or send inference');
  assert.deepEqual((await journal.read(recoveryNoteId))?.value, expected.value);
  client.dispose(); await restored.close();
});

test('enrollment rejects a conflicting backup instead of replacing a newer validated NoteJournal', async t => {
  const server = await recoveryServer(t), directory = await mkdtemp(join(tmpdir(), 'zkapi-copy-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory), await importJournalKey(new Uint8Array(32).fill(19)), recoveryContext, validateNoteJournal);
  await original.create(recoveryNoteId, fundedNote());
  const kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext }), target = await createRecoveryStorage(kit, { fetch: server.fetch });
  await original.copyTo(recoveryNoteId, target); await original.copyTo(recoveryNoteId, target);
  const remote = new EncryptedJournal<NoteJournal>(target.store, target.key, recoveryContext, validateNoteJournal);
  const successor = fundedNote(); successor.state.balance_micro_usdc = '199';
  await remote.compareAndSwap(recoveryNoteId, 1, successor);
  await assert.rejects(original.copyTo(recoveryNoteId, target));
  assert.deepEqual((await remote.read(recoveryNoteId))?.value, successor);
  assert.deepEqual((await original.read(recoveryNoteId))?.value, fundedNote()); await target.close();
});
