/** Offline helper acceptance over the actual encrypted journal, WalletClient,
 * v0 signing and exact-message recovery. Prover, HTTP, finalized accounts and
 * receipts are synthetic; this does not prove public-chain/clearance validity. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {validateNoteJournal, type NoteJournal, type PreparedSession, type PrivateState} from '../packages/sdk/src/control.ts';
import {EncryptedJournal, importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import type {NoteProver} from '../packages/sdk/src/prover.ts';
import {buildUploadPlan, closePayload, discriminator, prepareAttempt, restorePlan,
  type Attempt, type FinalizedReceipt, type TransportRpc, type UploadPlan, type V0Wallet} from '../packages/sdk/src/transport.ts';
import {concat, OPERATIONS, u32, u64} from '../packages/sdk/src/layout2.ts';
import type {VerifiedManifest} from '../packages/sdk/src/trust.ts';
import type {WalletSnapshot} from '../packages/sdk/src/wallet-chain.ts';
import {runDevnetClearanceRecovery, verifyClearanceRecoveryIdentity, verifyCompletedMutualAttempts,
  type DevnetClearanceRecoveryContext} from './i10_devnet_clearance_recovery.ts';

const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/vault/genesis-a.json', import.meta.url), 'utf8'));
const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const publicKey = (hex: string) => new PublicKey(Buffer.from(hex, 'hex')).toBase58();
const nullifier: string = fixture.auth.withdrawal.public_inputs[11];
const registrationCommitment = '0x' + fixture.commitment;
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// This is explicitly a structural fixture, not a verifyManifest result.
const manifest = {deployment_id: 'clearance-recovery-fixture', deployment_environment: 'devnet', setup_profile: 'test_only',
  genesis_hash: genesis, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', challenge_seconds: '600',
  program_id: publicKey(fixture.program_id), pool: publicKey(fixture.pool), note_ttl_seconds: String(fixture.ttl),
  control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid',
  tariff_hashes: ['33'.repeat(32)]} as unknown as VerifiedManifest;
const signature = {r_x: field(9), r_y: field(10), s: field(11)};

function records(): {main: NoteJournal; stale: NoteJournal} {
  const state: PrivateState = {balance_micro_usdc: String(fixture.deposit), balance_blinding: field(3), note_leaf: field(4),
    commitment: {x: field(5), y: field(6)}, anchor: field(1), state_signature: null};
  const requestId = '12345678-1234-4123-8123-123456789012';
  const prepared: PreparedSession = {request: {authorization: {version: '1', deployment_id: manifest.deployment_id,
    pool: manifest.pool, request_id: requestId, quote_hash: '00'.repeat(32), mode: 'proxy',
    control_secret_hash: '11'.repeat(32), proxy_secret_hash: '22'.repeat(32)},
    quote: {body: {quote_id: requestId, deployment_id: manifest.deployment_id, pool: manifest.pool,
      mode: 'proxy', provider: 'openai', models: ['i05-local-only'], tariff_hash: manifest.tariff_hashes[0],
      cap_micro_usdc: '100', issued_at: '100', expires_at: '220', session_ttl_seconds: '60', max_concurrency: '4',
      control_api_origin: manifest.control_api_origin, inference_api_origin: manifest.inference_api_origin},
      quote_hash: '00'.repeat(32), signature: 'synthetic-quote'},
    public_inputs: Array.from({length: 12}, (_, i) => i === 8 ? nullifier : field(1)),
    proof: {backend: 'groth16_bn254', proof: 'synthetic-proof'}},
    control_token: 'zkc1.synthetic-token', proxy_token: 'zkp1.synthetic-token',
    tariff: {tariff_hash: manifest.tariff_hashes[0], version: '1', provider: 'openai', model: 'i05-local-only',
      pricing_basis: 'fixed_usage_rates', valid_from: '100', valid_until: '1000', rates: [], operator_fee_micro_usdc: '0'},
    rerandomization: field(13)};
  const stale: NoteJournal = {schema: 1, state, witness: {secret: field(2), note_id: 0,
    deposit_micro_usdc: String(fixture.deposit), expiry: String(fixture.expiry)},
    pending: null, history: [], wallet: {status: 'active', history: []}};
  const main = structuredClone(stale);
  main.pending = {prepared, exactRequest: JSON.stringify(prepared.request), phase: 'send_unknown', operations: []};
  return {main, stale};
}

async function uploadPrefix(plan: UploadPlan, offset: number) {
  return {address: plan.buffer, commitment: 'finalized' as const, owner: plan.programId, slot: 110,
    data: concat(await discriminator('PayloadBuffer', 'account'), Uint8Array.of(2, plan.bump), plan.uploader.toBytes(),
      Uint8Array.of(OPERATIONS[plan.operation].op), u32(plan.payload.length), plan.digest, u32(offset), Uint8Array.of(0),
      u64(plan.expires), plan.rentPayer.toBytes(), u32(plan.payload.length), plan.payload.slice(0, offset),
      new Uint8Array(plan.payload.length - offset), plan.nonce)};
}

async function setup(t: TestContext, clearanceStatus = 200, expireSecondAppend = false) {
  const directory = await mkdtemp(join(tmpdir(), 'i10-clearance-recovery-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const aes = await importJournalKey(new Uint8Array(32).fill(89));
  const open = async (name: string) => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(join(directory, name)),
    aes, {deploymentId: manifest.deployment_id, pool: manifest.pool}, validateNoteJournal);
  const journal = await open('main'), staleJournal = await open('stale');
  const initial = records(); await journal.create('note', initial.main); await staleJournal.create('note', initial.stale);
  const pair = Keypair.fromSeed(new Uint8Array(32).fill(1)), owner = pair.publicKey.toBase58();
  const roles = {uploader: owner, rentPayer: owner, feePayer: owner, payer: owner, tokenOwner: owner};
  const counts = {genesis: 0, inspect: 0, clearanceVerify: 0, tree: 0, withdrawal: 0, sign: 0, send: 0, snapshot: 0, blockhash: 0, buffer: 0};
  const requests: {url: string; body: unknown}[] = [];
  const receipts = new Map<string, FinalizedReceipt>();
  let closed = false, expiredAttempt: Attempt | undefined;
  const wallet: V0Wallet = {publicKey: pair.publicKey, supportedTransactionVersions: new Set([0]),
    async signTransaction(tx) {counts.sign++; tx.sign([pair]); return tx;}};
  const prover = {async inspect() {counts.inspect++; return {nullifier, registration_commitment: registrationCommitment};},
    async verifyClearance(n: string, s: typeof signature) {counts.clearanceVerify++; assert.equal(n, nullifier); assert.deepEqual({...s}, signature);},
    async tree() {counts.tree++; return structuredClone(fixture.trees[1]);},
    async withdrawal() {counts.withdrawal++; return structuredClone(fixture.auth.withdrawal);},
  } as unknown as NoteProver;
  const rpc: TransportRpc = {async signatureStatus() {return null;},
    async finalizedReceipt(sig) {return receipts.get(sig) ?? null;}, async finalizedBlockHeight() {return expiredAttempt ? 201 : 50;},
    async sendRawTransaction(bytes) {
      counts.send++;
      const tx = VersionedTransaction.deserialize(bytes), sig = bs58.encode(tx.signatures[0]);
      assert.equal(tx.version, 0); assert.ok(bytes.length <= 1232);
      assert.ok(!receipts.has(sig), 'no automatic repeat of a locally acknowledged transaction');
      const saved = (await staleJournal.read('note'))!.value.wallet!.operation!;
      const attempt = saved.attempts.find(a => a.signature === sig);
      assert.ok(attempt, 'signed bytes must be committed before sending');
      assert.equal(attempt.wireHex, Buffer.from(bytes).toString('hex'));
      if (expireSecondAppend && !expiredAttempt && attempt.kind === 'append'
        && saved.attempts.filter(a => a.kind === 'append').length === 2) {
        expiredAttempt = structuredClone(attempt as Attempt);
        return sig; // Simulated acknowledged submission, then finalized expiry without a receipt.
      }
      if (attempt.kind === 'execute') closed = true;
      receipts.set(sig, {signature: sig, message: tx.message.serialize(), slot: 101 + receipts.size, err: null});
      return sig;
    }};
  const context: DevnetClearanceRecoveryContext = {manifest, journal, staleJournal, prover, wallets: [wallet], roles,
    connection: {async getGenesisHash() {counts.genesis++; return genesis;}},
    pinnedFetch: async (url, init) => {
      requests.push({url: String(url), body: init?.body});
      assert.equal(String(url), manifest.control_api_origin + '/zkapi/v1/withdraw/clearance');
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), {nullifier});
      return Response.json(clearanceStatus === 200 ? {nullifier, signature} : {error: {code: 'nullifier_reserved'}}, {status: clearanceStatus});
    },
    chain: {async snapshot(noteId, path, minimumSlot): Promise<WalletSnapshot> {
      counts.snapshot++; assert.equal(noteId, 0);
      assert.equal(path, closed ? 'none' : 'active'); assert.ok(minimumSlot === undefined || minimumSlot <= 110);
      return {root: fixture.trees[1].public_inputs[closed ? 2 : 1], siblings: Array(32).fill(field(0)), slot: 110,
        sequence: closed ? '3' : '2', nextNoteId: 1, clock: String(fixture.now), paused: false, treasuryOwner: owner,
        note: {note_id: 0, registration_commitment: registrationCommitment, deposit_micro_usdc: String(fixture.deposit),
          expiry: String(fixture.expiry), status: closed ? 'closed' : 'active'}};
    }, async buffer(plan) {
      counts.buffer++; assert.ok(expiredAttempt, 'only the injected upload expiry permits buffer reconciliation');
      assert.equal(plan.buffer.toBase58(), expiredAttempt.buffer);
      return uploadPrefix(plan, plan.steps.filter(step => step.kind === 'append')[1].offset!);
    }, async blockhash() {counts.blockhash++; return {blockhash: new PublicKey(new Uint8Array(32).fill(expiredAttempt ? 8 : 7)).toBase58(),
      lastValidBlockHeight: expiredAttempt ? 400 : 200};}},
    rpcFor(j) {assert.ok(j === context.staleJournal); return rpc;}, waitMs: 15_000};
  return {context, initial, counts, requests, receipts, open, rpc, wallet, expired: () => expiredAttempt};
}

test('identity requires the same witness/state/N and one uncertain zero-inference AUTH', () => {
  const ok = records(); verifyClearanceRecoveryIdentity(ok.main, ok.stale, manifest, nullifier);
  const cases: [string, (main: NoteJournal, stale: NoteJournal) => void, RegExp][] = [
    ['witness', (_m, s) => {s.witness!.secret = field(17);}, /witness identity/],
    ['state', (_m, s) => {s.state.anchor = field(17);}, /private state/],
    ['nullifier', m => {m.pending!.prepared.request.public_inputs[8] = field(17); m.pending!.exactRequest = JSON.stringify(m.pending!.prepared.request);}, /nullifier differs/],
    ['inference', m => {m.pending!.operations.push({id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: '/v1/chat/completions',
      anthropicVersion: '', bodyBase64: Buffer.from('{}').toString('base64'), phase: 'send_unknown'});}, /inference operations/],
    ['phase', m => {m.pending!.phase = 'active';}, /uncertain AUTH/],
    ['stale session', (m, s) => {s.pending = structuredClone(m.pending);}, /no control session/],
    ['different saved bytes', m => {m.pending!.exactRequest += ' ';}, /authorization bytes changed/],
    ['wrong model', m => {m.pending!.prepared.request.quote.body.models = ['other']; m.pending!.exactRequest = JSON.stringify(m.pending!.prepared.request);}, /models|deep-equal/],
  ];
  for (const [name, mutate, error] of cases) {
    const {main, stale} = records(); mutate(main, stale);
    assert.throws(() => verifyClearanceRecoveryIdentity(main, stale, manifest, nullifier), error, name);
  }
});

test('identity failure leaves both actual encrypted journals unchanged before any network or signing', async t => {
  const h = await setup(t), saved = (await h.context.staleJournal.read('note'))!;
  saved.value.witness!.secret = field(17);
  await h.context.staleJournal.compareAndSwap('note', saved.revision, saved.value);
  const before = await h.context.journal.exportBackup('note'), staleBefore = await h.context.staleJournal.exportBackup('note');
  await assert.rejects(runDevnetClearanceRecovery(h.context), /witness identity/);
  assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.deepEqual(await h.context.staleJournal.exportBackup('note'), staleBefore);
  assert.equal(h.counts.genesis, 0); assert.equal(h.counts.snapshot, 0);
  assert.equal(h.counts.sign, 0); assert.equal(h.counts.send, 0); assert.deepEqual(h.requests, []);
});

test('authoritative clearance 409 preserves uncertain AUTH and stale mutual intent without fallback or sends', async t => {
  const h = await setup(t, 409), before = await h.context.journal.exportBackup('note');
  await assert.rejects(runDevnetClearanceRecovery(h.context), /clearance unavailable/);
  const main = (await h.context.journal.read('note'))!.value, stale = (await h.context.staleJournal.read('note'))!.value;
  assert.deepEqual(main, h.initial.main); assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.equal(stale.wallet!.status, 'active'); assert.deepEqual(stale.wallet!.history, []);
  assert.equal(stale.wallet!.operation!.kind, 'mutual_close'); assert.equal(stale.wallet!.operation!.phase, 'proving');
  assert.deepEqual(stale.wallet!.operation!.attempts, []); assert.equal(stale.wallet!.operation!.destinationOwner, h.context.roles.tokenOwner);
  assert.deepEqual(stale.wallet!.clearance, {nullifier, phase: 'requested'});
  assert.equal(stale.pending, null); assert.deepEqual(stale.history, []);
  assert.deepEqual(stale.state, h.initial.stale.state); assert.deepEqual(stale.witness, h.initial.stale.witness);
  // Reopen both encrypted stores, preserving the original mutual operation.
  h.context.journal = await h.open('main'); h.context.staleJournal = await h.open('stale');
  await assert.rejects(runDevnetClearanceRecovery(h.context), /clearance unavailable/);
  assert.deepEqual((await h.context.staleJournal.read('note'))!.value, stale);
  assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.equal(h.requests.length, 2); assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(h.counts.tree, 0); assert.equal(h.counts.withdrawal, 0); assert.equal(h.counts.clearanceVerify, 0);
  assert.equal(h.counts.sign, 0); assert.equal(h.counts.send, 0); assert.equal(h.counts.blockhash, 0);
});

test('real WalletClient completes local signed v0 mutual close and closed resume is read-only', async t => {
  const h = await setup(t), before = await h.context.journal.exportBackup('note');
  const result = await runDevnetClearanceRecovery(h.context);
  assert.equal(result.passed, true); assert.equal(result.main_journal_unchanged, true); assert.equal(result.auth_resubmitted, false);
  assert.equal(result.native_challenge_proved, false); assert.equal(result.I10_complete, false);
  assert.equal(result.balance_restoration_requires_caller_verification, true);
  assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.deepEqual((await h.context.journal.read('note'))!.value, h.initial.main);
  const closed = (await h.context.staleJournal.read('note'))!.value;
  assert.equal(closed.wallet!.status, 'closed'); assert.equal(closed.wallet!.operation, undefined);
  assert.equal(closed.wallet!.history.length, 1); assert.equal(closed.wallet!.history[0].kind, 'mutual_close');
  assert.deepEqual(closed.state, h.initial.stale.state); assert.deepEqual(closed.witness, h.initial.stale.witness);
  const kinds = result.finalized_attempts.map(a => a.kind);
  assert.deepEqual(kinds, ['create', 'append', 'append', 'seal', 'execute']);
  assert.equal(h.counts.sign, 5); assert.equal(h.counts.send, 5); assert.equal(h.receipts.size, 5);
  assert.equal(h.requests.length, 1); assert.equal(h.counts.withdrawal, 1); assert.equal(h.counts.tree, 1);
  const staleBefore = await h.context.staleJournal.exportBackup('note'), countsBefore = structuredClone(h.counts);
  h.context.journal = await h.open('main'); h.context.staleJournal = await h.open('stale');
  const resumed = await runDevnetClearanceRecovery(h.context);
  assert.deepEqual(resumed, result);
  assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.deepEqual(await h.context.staleJournal.exportBackup('note'), staleBefore);
  for (const key of ['sign', 'send', 'blockhash', 'tree', 'withdrawal'] as const) assert.equal(h.counts[key], countsBefore[key]);
  assert.equal(h.requests.length, 1);
  // A substituted receipt cannot make a closed journal pass verification.
  const execute = result.finalized_attempts.find(a => a.kind === 'execute')!;
  h.receipts.set(execute.signature, {...h.receipts.get(execute.signature)!, message: new Uint8Array([1])});
  await assert.rejects(runDevnetClearanceRecovery(h.context), /every exact saved plan step must be finalized/);
  assert.equal(h.counts.send, countsBefore.send); assert.equal(h.counts.sign, countsBefore.sign);
  assert.deepEqual(await h.context.journal.exportBackup('note'), before);
  assert.deepEqual(await h.context.staleJournal.exportBackup('note'), staleBefore);
});

test('expired second append is renewed from the verified prefix and retained through read-only closed resume', async t => {
  const h = await setup(t, 200, true), mainBefore = await h.context.journal.exportBackup('note');
  const result = await runDevnetClearanceRecovery(h.context);
  const old = h.expired()!;
  assert.ok(old); assert.equal(old.kind, 'append'); assert.equal(h.receipts.has(old.signature), false);
  const completed = (await h.context.staleJournal.read('note'))!.value.wallet!.history[0];
  assert.deepEqual(completed.attempts.map(a => a.kind), ['create', 'append', 'append', 'append', 'seal', 'execute']);
  assert.deepEqual(completed.attempts[2], old, 'the original signed attempt remains byte-for-byte');
  const replacement = completed.attempts[3] as Attempt;
  assert.deepEqual(replacement.plan, old.plan); assert.equal(replacement.buffer, old.buffer);
  assert.equal(replacement.planDigest, old.planDigest); assert.equal(replacement.kind, old.kind);
  assert.notEqual(replacement.signature, old.signature); assert.notEqual(replacement.blockhash, old.blockhash);
  assert.ok(replacement.lastValidBlockHeight > old.lastValidBlockHeight);
  const originalMessage = VersionedTransaction.deserialize(Buffer.from(old.wireHex, 'hex')).message;
  const replacementMessage = VersionedTransaction.deserialize(Buffer.from(replacement.wireHex, 'hex')).message;
  replacementMessage.recentBlockhash = originalMessage.recentBlockhash;
  assert.deepEqual(replacementMessage.serialize(), originalMessage.serialize(), 'only the blockhash/signature changes');
  assert.equal(h.counts.buffer, 1); assert.equal(h.counts.sign, 6); assert.equal(h.counts.send, 6);
  assert.equal(h.receipts.size, 5); assert.equal(result.finalized_attempts.length, 5);
  assert.equal(result.superseded_upload_attempts.length, 1);
  const superseded = result.superseded_upload_attempts[0];
  assert.equal(superseded.signature, old.signature); assert.equal(superseded.kind, 'append');
  assert.equal(superseded.replacement_signature, replacement.signature);
  assert.equal(superseded.status, 'finalized_expired_upload_superseded');
  assert.equal(superseded.last_valid_block_height, 200); assert.equal(superseded.observed_finalized_block_height, 201);
  assert.deepEqual(await h.context.journal.exportBackup('note'), mainBefore);
  const staleBefore = await h.context.staleJournal.exportBackup('note'), before = structuredClone(h.counts);
  h.context.journal = await h.open('main'); h.context.staleJournal = await h.open('stale');
  assert.deepEqual(await runDevnetClearanceRecovery(h.context), result);
  assert.deepEqual(await h.context.journal.exportBackup('note'), mainBefore);
  assert.deepEqual(await h.context.staleJournal.exportBackup('note'), staleBefore);
  for (const key of ['sign', 'send', 'blockhash', 'buffer', 'tree', 'withdrawal'] as const) assert.equal(h.counts[key], before[key]);
  assert.equal(h.requests.length, 1);
});

test('supersession refuses unresolved financial sends, unknown uploads and unrelated or failed replacements', async t => {
  const h = await setup(t, 200, true);
  await runDevnetClearanceRecovery(h.context);
  const completed = (await h.context.staleJournal.read('note'))!.value.wallet!.history[0];
  const old = completed.attempts[2] as Attempt, replacement = completed.attempts[3] as Attempt;
  const execute = completed.attempts.at(-1) as Attempt, plan = await restorePlan(old.plan);
  const beforeMain = await h.context.journal.exportBackup('note'), beforeStale = await h.context.staleJournal.exportBackup('note');
  const beforeSend = h.counts.send;
  const noSend: TransportRpc = {...h.rpc, async sendRawTransaction() {assert.fail('verifier cannot send');}};
  // Old execute is financial even when a higher finalized height proves expiry.
  await assert.rejects(verifyCompletedMutualAttempts(completed, {...noSend,
    finalizedReceipt: async sig => sig === execute.signature ? null : h.receipts.get(sig) ?? null,
    finalizedBlockHeight: async () => 401}));
  const close = await prepareAttempt(plan, await closePayload(plan),
    {blockhash: new PublicKey(new Uint8Array(32).fill(9)).toBase58(), lastValidBlockHeight: 200}, [h.wallet], {save: async () => {}});
  const withClose = structuredClone(completed); withClose.attempts.splice(-1, 0, close);
  await assert.rejects(verifyCompletedMutualAttempts(withClose, noSend));
  await assert.rejects(verifyCompletedMutualAttempts(completed, {...noSend,
    signatureStatus: async sig => sig === old.signature ? {slot: 109, err: null, confirmationStatus: 'confirmed'} : null}));
  await assert.rejects(verifyCompletedMutualAttempts(completed, {...noSend,
    signatureStatus: async sig => {if (sig === old.signature) throw Error('offline unavailable'); return null;}}));
  await assert.rejects(verifyCompletedMutualAttempts(completed, {...noSend, finalizedBlockHeight: async () => 200}));
  const makeReceipt = (attempt: Attempt): FinalizedReceipt => ({signature: attempt.signature,
    message: VersionedTransaction.deserialize(Buffer.from(attempt.wireHex, 'hex')).message.serialize(), slot: 103, err: null});
  const substitute = async (candidate: Attempt) => {
    const altered = structuredClone(completed); altered.attempts[3] = candidate;
    altered.finalized = altered.finalized.map(r => r.signature === replacement.signature ? {signature: candidate.signature, slot: 103} : r);
    await assert.rejects(verifyCompletedMutualAttempts(altered, {...noSend,
      finalizedReceipt: async sig => sig === candidate.signature ? makeReceipt(candidate) : h.receipts.get(sig) ?? null}));
  };
  const fresh = {blockhash: new PublicKey(new Uint8Array(32).fill(10)).toBase58(), lastValidBlockHeight: 500};
  // Genuine signed messages are valid for their own plan/step, but cannot replace this saved append.
  await substitute(await prepareAttempt(plan, plan.steps.filter(s => s.kind === 'append')[0], fresh,
    [h.wallet], {save: async () => {}}));
  const differentPlan = await buildUploadPlan({...plan, nonce: new Uint8Array(32).fill(63)});
  await substitute(await prepareAttempt(differentPlan, differentPlan.steps.filter(s => s.kind === 'append')[1], fresh,
    [h.wallet], {save: async () => {}}));
  await substitute({...replacement, lastValidBlockHeight: old.lastValidBlockHeight});
  await substitute({...old, lastValidBlockHeight: replacement.lastValidBlockHeight});
  await assert.rejects(verifyCompletedMutualAttempts(completed, {...noSend,
    finalizedReceipt: async sig => sig === replacement.signature
      ? {...h.receipts.get(sig)!, err: {InstructionError: [1, {Custom: 6000}]}} : h.receipts.get(sig) ?? null}));
  // A valid finalized subset cannot claim a complete upload sequence.
  const missingFirstAppend = structuredClone(completed);
  const missing = missingFirstAppend.attempts.splice(1, 1)[0];
  missingFirstAppend.finalized = missingFirstAppend.finalized.filter(row => row.signature !== missing.signature);
  await assert.rejects(verifyCompletedMutualAttempts(missingFirstAppend, noSend));
  const beforePrefix = structuredClone(completed);
  beforePrefix.attempts.splice(1, 0, beforePrefix.attempts.splice(2, 1)[0]);
  await assert.rejects(verifyCompletedMutualAttempts(beforePrefix, noSend), /finalized prefix/);
  const mutable = structuredClone(completed); let mutated = false;
  const detached = await verifyCompletedMutualAttempts(mutable, {...noSend, async signatureStatus() {
    if (!mutated) {mutated = true; mutable.attempts.length = 0; mutable.finalized.length = 0; mutable.kind = 'initiate_escape';}
    return null;
  }});
  assert.ok(mutated); assert.equal(detached.finalized.length, 5); assert.equal(detached.superseded.length, 1);
  assert.equal(h.counts.send, beforeSend);
  assert.deepEqual(await h.context.journal.exportBackup('note'), beforeMain);
  assert.deepEqual(await h.context.staleJournal.exportBackup('note'), beforeStale);
});
