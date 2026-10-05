/** Test-only orchestration over the existing SDK journals. The caller gates an
 * external native challengerd on escape-ready.json; this helper never constructs
 * a challenge, finalizes an escape, or rewrites financial journal state. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, open, readFile, rename} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Connection, PublicKey, VersionedTransaction} from '@solana/web3.js';
import {ControlClient, ControlHttpError, createCredentials, validateNoteJournal, verifiedClientContext,
  type NoteJournal, type Tariff} from '../packages/sdk/src/control.ts';
import {NativeSessionVerifier} from '../packages/sdk/src/control-node.ts';
import {parseField} from '../packages/sdk/src/encoding.ts';
import {EncryptedJournal, importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import {NoteProver} from '../packages/sdk/src/prover.ts';
import {discriminator, recoverAttempt, type Attempt, type TransportRpc, type V0Wallet} from '../packages/sdk/src/transport.ts';
import type {ArtifactBundle, VerifiedManifest} from '../packages/sdk/src/trust.ts';
import {WalletClient, type WalletRoles} from '../packages/sdk/src/wallet.ts';
import type {WalletChain, WalletSnapshot} from '../packages/sdk/src/wallet-chain.ts';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CIRCLE_DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const NOTE = 'note';

export interface DevnetChallengeContext {
  manifest: VerifiedManifest;
  artifacts: ArtifactBundle;
  prover: NoteProver;
  journal: EncryptedJournal<NoteJournal>;
  chain: WalletChain;
  connection: Connection;
  wallets: readonly V0Wallet[];
  roles: WalletRoles;
  pinnedFetch: typeof fetch;
  /** Must apply the caller's durable attempt, exact wire/signature, v0 size,
   * fee ceiling and no-resend checks to this particular journal. */
  rpcFor(journal: EncryptedJournal<NoteJournal>): TransportRpc;
  runDirectory: string;
  verifier: {path: string; sha256: string};
  /** Exact existing I05 local adapter tariff, already pinned in the manifest. */
  tariff: Tariff;
  /** Bounds the read-only restoration wait; default and maximum 600 seconds. */
  waitMs?: number;
}

export interface EscapeReady {
  schema: 1;
  pool: string;
  note_id: number;
  request_id: string;
  nullifier: string;
  escape_signature: string;
  escape_slot: number;
  deadline: string;
  escaped_root: string;
  escaped_sequence: string;
  historical_request_root: string;
  stale_sdk_pending_escape: true;
  external_challenger_may_start: true;
}

export interface DevnetChallengeReport {
  passed: true;
  scope: string;
  pool: string;
  note_id: number;
  request_id: string;
  proof_nullifier: string;
  receipt_ids: string[];
  inference_operations: 0;
  charge_micro_usdc: '0';
  signed_successor_verified: true;
  old_authorization_retained: true;
  stale_sdk_pending_escape: true;
  escape_signature: string;
  escape_slot: number;
  escape_deadline: string;
  historical_request_root: string;
  escaped_root: string;
  escaped_sequence: string;
  restored_root: string;
  restored_sequence: string;
  restored_slot: number;
  note_active: true;
  pending_cleared: true;
  exit_nullifier_consumed: true;
  exit_nullifier_observed_slot: number;
  challenge_sent_by_helper: false;
  daemon_receipt_join_required: true;
  live_provider_verified: false;
  release_gates_passed: [];
}

async function durable(path: string, value: unknown): Promise<void> {
  const file = await open(path + '.tmp', 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(path + '.tmp', path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function staleStore(run: string): Promise<{store: NativeJournalStore; key: CryptoKey}> {
  const directory = join(run, 'stale-challenge');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const keyPath = join(directory, 'private-journal-key.bin');
  try {
    const file = await open(keyPath, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); }
    finally { await file.close(); }
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return {store: await NativeJournalStore.open(join(directory, 'journal')),
    key: await importJournalKey(new Uint8Array(await readFile(keyPath)))};
}

/** Predicate only: the WalletChain already authenticates the finalized account
 * cut. An equal root alone cannot hide another remove/restore transition. */
export function challengeRestored(snapshot: WalletSnapshot, ready: EscapeReady): boolean {
  return snapshot.slot >= ready.escape_slot && snapshot.note?.note_id === ready.note_id
    && snapshot.note.status === 'active' && snapshot.pending === undefined
    && snapshot.root === ready.historical_request_root
    && BigInt(snapshot.sequence) === BigInt(ready.escaped_sequence) + 1n;
}

async function boundedRead<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'external challenger restoration deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('external challenger restoration deadline')), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Bounded retry only for a caller-supplied exact, durable control operation.
 * This helper is never used for inference, quote creation, proof generation or
 * cancellation. The SDK remains responsible for the saved AUTH and phase. */
export async function retrySavedControl<T>(operation: (signal: AbortSignal) => Promise<T>,
  deadline: number): Promise<T> {
  const expired = () => Error('zero-use settlement deadline; journal retained');
  for (;;) {
    const remaining = deadline - Date.now();
    if (!Number.isSafeInteger(remaining) || remaining <= 0) throw expired();
    try {
      // Bound HTTP inside the SDK instead of abandoning an in-flight SDK journal
      // commit. Its fetch signal is combined with this remaining deadline.
      const value = await operation(AbortSignal.timeout(remaining));
      if (Date.now() >= deadline) throw expired();
      return value;
    } catch (error) {
      const transient = error instanceof ControlHttpError
        ? [429, 502, 503, 504].includes(error.status)
        : error instanceof Error && (error.message === 'pinned service transport'
          || error instanceof TypeError && error.message === 'fetch failed'
          || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));
      if (!transient) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw expired();
      await delay(Math.min(1000, remaining));
    }
  }
}

export async function runDevnetChallenge(o: DevnetChallengeContext): Promise<DevnetChallengeReport> {
  const m = o.manifest;
  assert.equal(m.deployment_environment, 'devnet'); assert.equal(m.setup_profile, 'test_only');
  assert.equal(m.genesis_hash, DEVNET); assert.equal(m.mint, CIRCLE_DEVNET_USDC);
  assert.equal(m.challenge_seconds, '600');
  assert.ok(isAbsolute(o.runDirectory), 'absolute dedicated run directory required');
  const waitMs = o.waitMs ?? 600_000;
  assert.ok(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 600_000);
  assert.equal(o.tariff.provider, 'openai'); assert.equal(o.tariff.model, 'i05-local-only');
  assert.ok(m.tariff_hashes.includes(o.tariff.tariff_hash), 'local tariff must be manifest-pinned');
  const destination = o.roles.tokenOwner;
  assert.ok(destination && o.wallets.some(w => w.publicKey.toBase58() === destination));
  for (const role of Object.values(o.roles)) assert.equal(role, destination, 'dedicated same-owner test only');
  assert.equal(await o.connection.getGenesisHash(), DEVNET);
  const {store, key} = await staleStore(o.runDirectory);
  return store.withLock('i10-devnet-challenge-flow', async () => {
    const stale = new EncryptedJournal<NoteJournal>(store, key,
      {deploymentId: m.deployment_id, pool: m.pool}, validateNoteJournal);
    const staleRpc = o.rpcFor(stale);
    const staleWallet = new WalletClient({manifest: m, prover: o.prover, journal: stale,
      chain: o.chain, rpc: staleRpc, wallets: o.wallets, fetch: o.pinnedFetch});
    let main = (await o.journal.read(NOTE))?.value;
    assert.ok(main?.witness && main.wallet?.status === 'active' && !main.wallet.operation);
    assert.ok(main.history.length <= 1, 'dedicated single-authorization challenge flow required');
    if (!await stale.read(NOTE)) {
      assert.ok(main.history.length === 0 && main.pending === null, 'stale import must precede authorization');
      await staleWallet.importFinalized(NOTE, main.witness, main.state);
    }
    let old = (await stale.read(NOTE))!.value;
    assert.ok(old.witness && old.wallet && old.pending === null && old.history.length === 0);
    assert.ok(JSON.stringify(old.witness) === JSON.stringify(main.witness), 'stale witness identity mismatch');
    const identity = await o.prover.inspect(old.witness, old.state);
    const pool = await o.connection.getAccountInfoAndContext(new PublicKey(m.pool), {commitment: 'finalized'});
    assert.ok(pool.value);
    const context = await verifiedClientContext(m, DEVNET, {address: m.pool,
      owner: pool.value.owner.toBase58(), executable: pool.value.executable,
      lamports: BigInt(pool.value.lamports), data: pool.value.data,
      slot: BigInt(pool.context.slot), commitment: 'finalized'}, BigInt(pool.context.slot), o.artifacts);
    const verifier = new NativeSessionVerifier(o.verifier.path, o.verifier.sha256);
    const client = new ControlClient({context, journal: o.journal, verifier, fetch: o.pinnedFetch});
    if (main.history.length === 0 && main.pending === null) {
      assert.ok(JSON.stringify(main.state) === JSON.stringify(old.state), 'pre-session state mismatch');
      assert.equal(old.wallet.status, 'active'); assert.equal(old.wallet.operation, undefined);
      const snapshot = await o.chain.snapshot(old.witness.note_id, 'active');
      const quote = await client.quote({mode: 'proxy', provider: 'openai', models: [o.tariff.model], session_ttl_seconds: '60'}, o.tariff);
      const prepared = await o.prover.prepareSession(old.witness, main.state, snapshot.root,
        snapshot.siblings, quote, o.tariff, await createCredentials('proxy'));
      assert.equal(prepared.request.public_inputs[8], identity.nullifier);
      await client.prepare(NOTE, prepared, snapshot.root);
    }
    // Only the one durable authorization is submitted/recovered. No inference
    // method is called and no uncertain request is replaced with fresh secrets.
    const settlementDeadline = Date.now() + 120_000;
    for (;;) {
      main = (await o.journal.read(NOTE))!.value;
      if (!main.pending) break;
      assert.ok(main.history.length === 0 && main.pending.operations.length === 0);
      assert.equal(main.pending.prepared.request.public_inputs[8], identity.nullifier);
      assert.equal(main.pending.prepared.request.authorization.mode, 'proxy');
      assert.equal(main.pending.prepared.request.quote.body.provider, 'openai');
      assert.equal(main.pending.prepared.request.quote.body.models.length, 1);
      assert.equal(main.pending.prepared.request.quote.body.models[0], o.tariff.model);
      assert.equal(main.pending.prepared.tariff.tariff_hash, o.tariff.tariff_hash);
      assert.ok(Date.now() < settlementDeadline, 'zero-use settlement deadline; journal retained');
      const phase = main.pending.phase;
      await retrySavedControl(signal => {
        const bounded = new ControlClient({context, journal: o.journal, verifier,
          fetch: (url, init) => o.pinnedFetch(url, {...init,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal})});
        if (phase === 'prepared') return bounded.submit(NOTE);
        if (phase === 'active') return bounded.close(NOTE);
        return bounded.recover(NOTE);
      }, settlementDeadline);
      await delay(Math.min(250, Math.max(0, settlementDeadline - Date.now())));
    }
    assert.equal(main.history.length, 1);
    const settled = main.history[0];
    assert.ok(JSON.stringify(settled.previous) === JSON.stringify(old.state), 'authorization did not consume stale state');
    assert.equal(settled.prepared.request.authorization.mode, 'proxy');
    assert.equal(settled.prepared.request.quote.body.provider, 'openai');
    assert.equal(settled.prepared.tariff.tariff_hash, o.tariff.tariff_hash);
    assert.equal(settled.prepared.request.public_inputs[8], identity.nullifier);
    assert.equal(settled.operations.length, 0);
    assert.equal(settled.settlement.charge_micro_usdc, '0');
    const verified = await verifier.settle(context, settled.previous, settled.prepared,
      settled.settlement, settled.receipts, []);
    assert.ok(JSON.stringify(verified) === JSON.stringify(main.state), 'verified successor differs from main journal');
    assert.equal(main.state.balance_micro_usdc, old.state.balance_micro_usdc);
    assert.ok(main.state.anchor !== old.state.anchor, 'successor anchor did not advance');
    const historicalRoot = settled.prepared.request.public_inputs[3]; parseField(historicalRoot);
    if (old.wallet.status === 'active' && !old.wallet.operation) {
      const snapshot = await o.chain.snapshot(old.witness.note_id, 'active');
      assert.equal(snapshot.root, historicalRoot, 'dedicated pool changed before stale escape');
      await staleWallet.beginWithdrawal(NOTE, 'initiate_escape', destination, o.roles);
    }
    const escapeDeadline = Date.now() + 240_000;
    for (;;) {
      old = (await stale.read(NOTE))!.value;
      if (!old.wallet!.operation) break;
      assert.equal(old.wallet!.operation.kind, 'initiate_escape');
      assert.ok(Date.now() < escapeDeadline, 'stale escape deadline; exact SDK journal retained');
      const status = await staleWallet.advance(NOTE);
      if (status.state === 'proof_required') await staleWallet.resumeProof(NOTE);
      assert.notEqual(status.state, 'rejected', 'stale escape rejected; journal retained');
      assert.notEqual(status.state, 'expired_reconcile_required', 'uncertain stale escape requires explicit recovery');
      await delay(750);
    }
    assert.equal(old.wallet!.status, 'pending_escape');
    assert.equal(old.wallet!.history.length, 1);
    const escapedOperation = old.wallet!.history[0];
    assert.equal(escapedOperation.kind, 'initiate_escape');
    const execute = escapedOperation.attempts.filter(a => a.kind === 'execute');
    assert.equal(execute.length, 1);
    const attempt = execute[0] as Attempt;
    assert.equal(attempt.plan.operation, 'initiate_escape');
    assert.equal(attempt.plan.pool, m.pool); assert.equal(attempt.plan.programId, m.program_id);
    assert.equal(attempt.plan.expectedNoteId, old.witness!.note_id);
    assert.equal('0x' + attempt.plan.expectedRoot, historicalRoot);
    // Bind observations to the exact already signed layout-2 tree transition.
    // Tree public inputs start at the final 608 bytes: op, oldRoot, newRoot, id.
    const payload = Buffer.from(attempt.plan.payloadHex, 'hex');
    const expectedEscapedRoot = '0x' + payload.subarray(payload.length - 608 + 64, payload.length - 608 + 96).toString('hex');
    const expectedEscapedSequence = (BigInt(attempt.plan.snapshotSequence) + 1n).toString();
    const receipt = await recoverAttempt(attempt, staleRpc);
    assert.equal(receipt.state, 'finalized');
    assert.ok(receipt.state === 'finalized');
    assert.ok(escapedOperation.finalized.some(row => row.signature === attempt.signature && row.slot === receipt.slot));
    const transaction = await o.connection.getTransaction(attempt.signature, {commitment: 'finalized', maxSupportedTransactionVersion: 0});
    assert.ok(transaction?.meta && transaction.meta.err === null);
    assert.equal(transaction.slot, receipt.slot);
    assert.ok(Buffer.from(transaction.transaction.message.serialize()).equals(Buffer.from(VersionedTransaction.deserialize(Buffer.from(attempt.wireHex, 'hex')).message.serialize())));
    const [exit, bump] = PublicKey.findProgramAddressSync([
      Buffer.from('exit'), new PublicKey(m.pool).toBuffer(), parseField(identity.nullifier),
    ], new PublicKey(m.program_id));
    assert.equal(attempt.plan.financial.exit, exit.toBase58());
    const exitDiscriminator = Buffer.from(await discriminator('ExitNullifier', 'account'));
    const checkTombstone = (account: Awaited<ReturnType<Connection['getAccountInfo']>>) => {
      assert.ok(account);
      assert.equal(account.owner.toBase58(), m.program_id); assert.equal(account.executable, false);
      assert.equal(account.data.length, 11); assert.equal(account.data[8], 2);
      assert.equal(account.data[9], bump); assert.equal(account.data[10], 1);
      assert.ok(account.data.subarray(0, 8).equals(exitDiscriminator));
    };

    const readyPath = join(o.runDirectory, 'escape-ready.json');
    let ready: EscapeReady;
    try { ready = JSON.parse(await readFile(readyPath, 'utf8')) as EscapeReady; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The external daemon must remain in read-only prewarm mode until this
      // finalized SDK transition and independent Pending verification complete.
      const escaped = await o.chain.snapshot(old.witness!.note_id, 'zero', receipt.slot);
      assert.equal(escaped.note?.status, 'pending_escape'); assert.ok(escaped.pending);
      assert.equal(escaped.pending.nullifier, identity.nullifier);
      assert.equal(escaped.pending.balance_micro_usdc, old.state.balance_micro_usdc);
      assert.equal(escaped.pending.destinationOwner, destination);
      assert.notEqual(escaped.root, historicalRoot); assert.equal(escaped.root, expectedEscapedRoot);
      assert.equal(escaped.sequence, expectedEscapedSequence);
      assert.ok(BigInt(escaped.clock) < BigInt(escaped.pending.deadline));
      checkTombstone((await o.connection.getAccountInfoAndContext(exit,
        {commitment: 'finalized', minContextSlot: escaped.slot})).value);
      ready = {schema: 1, pool: m.pool, note_id: old.witness!.note_id,
        request_id: settled.prepared.request.authorization.request_id, nullifier: identity.nullifier,
        escape_signature: attempt.signature, escape_slot: receipt.slot, deadline: escaped.pending.deadline,
        escaped_root: escaped.root, escaped_sequence: escaped.sequence, historical_request_root: historicalRoot,
        stale_sdk_pending_escape: true, external_challenger_may_start: true};
      await durable(readyPath, ready);
    }
    assert.equal(ready.schema, 1); assert.equal(ready.pool, m.pool);
    assert.equal(ready.note_id, old.witness!.note_id); assert.equal(ready.nullifier, identity.nullifier);
    assert.equal(ready.request_id, settled.prepared.request.authorization.request_id);
    assert.equal(ready.escape_signature, attempt.signature); assert.equal(ready.escape_slot, receipt.slot);
    assert.equal(ready.historical_request_root, historicalRoot);
    assert.equal(ready.escaped_root, expectedEscapedRoot);
    assert.equal(ready.escaped_sequence, expectedEscapedSequence);
    assert.match(ready.deadline, /^[1-9][0-9]{0,19}$/);
    assert.ok(BigInt(ready.deadline) <= 0xffffffffffffffffn);
    assert.equal(ready.stale_sdk_pending_escape, true); assert.equal(ready.external_challenger_may_start, true);
    const waitDeadline = Date.now() + waitMs;
    let restored: WalletSnapshot;
    for (;;) {
      restored = await boundedRead(o.chain.snapshot(old.witness!.note_id, 'none', receipt.slot), waitDeadline);
      if (challengeRestored(restored, ready)) break;
      assert.equal(restored.note?.status, 'pending_escape', 'unexpected challenge chain transition');
      assert.equal(restored.pending?.nullifier, identity.nullifier);
      assert.ok(BigInt(restored.clock) < BigInt(ready.deadline), 'challenge deadline passed; no escape finalization is attempted');
      await boundedRead(delay(1000), waitDeadline);
    }
    assert.equal(restored.note!.registration_commitment, identity.registration_commitment);
    assert.equal(restored.note!.deposit_micro_usdc, old.witness!.deposit_micro_usdc);
    assert.equal(restored.note!.expiry, old.witness!.expiry);
    const tombstone = await boundedRead(o.connection.getAccountInfoAndContext(exit,
      {commitment: 'finalized', minContextSlot: restored.slot}), waitDeadline);
    checkTombstone(tombstone.value);
    const report: DevnetChallengeReport = {passed: true,
      scope: 'Public devnet stale SDK escape and externally gated native challenger restoration; exact daemon receipt provenance is joined separately by the caller',
      pool: m.pool, note_id: old.witness!.note_id, request_id: ready.request_id, proof_nullifier: identity.nullifier,
      receipt_ids: settled.receipts.map(r => r.body.receipt_id), inference_operations: 0, charge_micro_usdc: '0',
      signed_successor_verified: true, old_authorization_retained: true, stale_sdk_pending_escape: true,
      escape_signature: attempt.signature, escape_slot: receipt.slot, escape_deadline: ready.deadline,
      historical_request_root: historicalRoot, escaped_root: ready.escaped_root, escaped_sequence: ready.escaped_sequence,
      restored_root: restored.root, restored_sequence: restored.sequence, restored_slot: restored.slot,
      note_active: true, pending_cleared: true, exit_nullifier_consumed: true,
      exit_nullifier_observed_slot: tombstone.context.slot, challenge_sent_by_helper: false,
      daemon_receipt_join_required: true, live_provider_verified: false, release_gates_passed: []};
    await durable(join(o.runDirectory, 'challenge-observation.json'), report);
    return report;
  });
}
