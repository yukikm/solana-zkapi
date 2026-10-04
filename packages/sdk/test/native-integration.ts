/** Explicit I08 integration runner: actual native crypto + encrypted journal,
 * with a deterministic HTTP response fixture (not a live provider/control E2E). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeSessionVerifier } from '../src/control-node.ts';
import { ControlClient, validateNoteJournal, type NoteJournal, type VerificationContext, type PrivateState,
  type PreparedSession, type Settlement, type Receipt } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';

const fixtureDir = resolve(process.env.ZKAPI_I08_FIXTURE_DIR ?? 'target/i08');
const binary = resolve(process.env.ZKAPI_I08_VERIFY_BINARY ?? 'apps/clientd/companion/target/debug/zkapi-client-verify');
const preparation = JSON.parse(await readFile(join(fixtureDir, 'prepare-command.json'), 'utf8')) as {
  context: VerificationContext; state: PrivateState; prepared: PreparedSession; now: string; root: string;
};
const settlement = JSON.parse(await readFile(join(fixtureDir, 'settlement-command.json'), 'utf8')) as {
  settlement: Settlement; receipts: Receipt[]; operations: string[];
};
const expected = JSON.parse(await readFile(join(fixtureDir, 'expected-next-state.json'), 'utf8'));
const hash = createHash('sha256').update(await readFile(binary)).digest('hex');
const verifier = new NativeSessionVerifier(binary, hash);

test('native bridge verifies real RP and signed successor; rejects artifact/proof/receipt tampering', async () => {
  const p = preparation, s = settlement;
  await verifier.prepare(p.context, p.state, p.prepared, p.now, p.root);
  // Strict JSON intentionally uses null prototypes; compare value content.
  assert.deepEqual(structuredClone(await verifier.settle(p.context, p.state, p.prepared, s.settlement, s.receipts, s.operations)), expected);
  await assert.rejects(new NativeSessionVerifier(binary, '00'.repeat(32)).prepare(p.context, p.state, p.prepared, p.now, p.root), /artifact/);
  const modified = structuredClone(p.prepared); modified.request.public_inputs[9] = '0x' + '00'.repeat(32);
  await assert.rejects(verifier.prepare(p.context, p.state, modified, p.now, p.root), /rejected/);
  await assert.rejects(verifier.settle(p.context, p.state, p.prepared, s.settlement, [], s.operations), /rejected/);
});

test('actual native verifier commits once after persisted unknown HTTP send and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-i08-native-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await importJournalKey(crypto.getRandomValues(new Uint8Array(32)));
  const p = preparation, s = settlement;
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(dir), key,
    { deploymentId: p.context.deployment_id, pool: p.context.pool }, validateNoteJournal);
  const journal = await open();
  await journal.create('note-local-only', { schema: 1, state: p.state, pending: null, history: [] });
  let firstBody: string | undefined, creates = 0;
  const status = (state: string) => ({ request_id: p.prepared.request.authorization.request_id, mode: p.prepared.request.authorization.mode,
    cap_micro_usdc: p.context.cap_micro_usdc, state, ...(state === 'SETTLED' ? { settlement: s.settlement } : {}) });
  const response = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
  const http: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/zkapi/v1/sessions') {
      creates++;
      const saved = (await journal.read('note-local-only'))!;
      assert.equal(saved.value.pending!.phase, 'send_unknown');
      assert.equal(init?.body, saved.value.pending!.exactRequest);
      if (creates === 1) { firstBody = String(init?.body); throw new Error('fixture: response lost after acceptance'); }
      assert.equal(init?.body, firstBody);
      return response(status('ACTIVE'));
    }
    if (path.endsWith('/close')) return response(status('SETTLED'));
    if (path.endsWith('/receipts')) return response(String(url).includes('?cursor=')
      ? { receipts: [], next_cursor: null } : { receipts: s.receipts, next_cursor: '100' });
    if (path.startsWith('/v1/')) return response({ fixture: 'body is delivered once; billing is in signed receipts' });
    throw new Error('unexpected fixture route');
  };
  const options = { context: p.context, journal, verifier, fetch: http, now: () => BigInt(p.now), allowLoopbackHttp: true };
  const first = new ControlClient(options);
  await first.prepare('note-local-only', p.prepared, p.root);
  await assert.rejects(first.submit('note-local-only'), /response lost/);
  const restarted = new ControlClient({ ...options, journal: await open() });
  await restarted.recover('note-local-only');
  for (const id of s.operations) {
    await restarted.prepareOperation('note-local-only', id, '/v1/chat/completions', new TextEncoder().encode('{"fixture":true}'));
    await restarted.sendOperation('note-local-only', id);
  }
  await restarted.close('note-local-only');
  const final = (await (await open()).read('note-local-only'))!;
  assert.deepEqual(final.value.state, expected); assert.equal(final.value.pending, null); assert.equal(final.value.history.length, 1);
  await assert.rejects(restarted.recover('note-local-only'), /no pending/);
  assert.equal(creates, 2);
});
