/** Explicit recovery of one uncertain, zero-inference AUTH attempt. Clearance is
 * the authoritative fence; this module never treats missing DB rows as proof,
 * resubmits AUTH, imports a witness, or edits either SDK state machine. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {VersionedTransaction, type Connection} from '@solana/web3.js';
import {validateNoteJournal, type NoteJournal} from '../packages/sdk/src/control.ts';
import {parseField} from '../packages/sdk/src/encoding.ts';
import type {EncryptedJournal} from '../packages/sdk/src/journal.ts';
import type {NoteProver} from '../packages/sdk/src/prover.ts';
import {compileV0, recoverAttempt, restorePlan, type Attempt, type TransportRpc, type V0Wallet} from '../packages/sdk/src/transport.ts';
import type {VerifiedManifest} from '../packages/sdk/src/trust.ts';
import {WalletClient, type WalletRoles, type WalletOperation} from '../packages/sdk/src/wallet.ts';
import type {WalletChain} from '../packages/sdk/src/wallet-chain.ts';

const NOTE = 'note';
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface DevnetClearanceRecoveryContext {
  manifest: VerifiedManifest;
  prover: NoteProver;
  /** The failed send_unknown AUTH journal. This helper only reads/locks it. */
  journal: EncryptedJournal<NoteJournal>;
  /** Caller opens the existing pre-AUTH journal. Missing state must fail, not import. */
  staleJournal: EncryptedJournal<NoteJournal>;
  chain: WalletChain;
  connection: Pick<Connection, 'getGenesisHash'>;
  wallets: readonly V0Wallet[];
  roles: WalletRoles;
  pinnedFetch: typeof fetch;
  /** Existing durable wire/fee/no-resend guard, bound to staleJournal. */
  rpcFor(journal: EncryptedJournal<NoteJournal>): TransportRpc;
  /** Checked between bounded SDK calls; never race/cancel a financial mutation. */
  waitMs?: number;
}

/** Structural identity guard, independently testable without proving or RPC.
 * Native inspect supplies the nullifier after validating the private state. */
export function verifyClearanceRecoveryIdentity(main: NoteJournal, stale: NoteJournal,
  manifest: VerifiedManifest, nullifier: string): void {
  validateNoteJournal(main); validateNoteJournal(stale); parseField(nullifier);
  assert.ok(main.witness && stale.witness, 'existing full witnesses required');
  assert.ok(main.wallet?.status === 'active' && !main.wallet.operation, 'main financial operation must remain inactive');
  assert.equal(main.history.length, 0, 'settled authorization is not this recovery case');
  assert.ok(main.pending?.phase === 'send_unknown', 'one existing uncertain AUTH required');
  assert.equal(main.pending.operations.length, 0, 'inference operations forbid this recovery');
  assert.ok(stale.pending === null, 'stale journal must have no control session');
  assert.equal(stale.history.length, 0, 'stale journal must precede AUTH');
  assert.ok(isDeepStrictEqual(main.witness, stale.witness), 'stale witness identity differs');
  assert.ok(isDeepStrictEqual(main.state, stale.state), 'stale private state differs');
  const request = main.pending.prepared.request;
  assert.ok(main.pending.exactRequest === JSON.stringify(request), 'saved AUTH bytes differ');
  assert.equal(request.authorization.pool, manifest.pool);
  assert.equal(request.authorization.deployment_id, manifest.deployment_id);
  assert.equal(request.authorization.mode, 'proxy');
  assert.equal(request.quote.body.pool, manifest.pool);
  assert.equal(request.quote.body.deployment_id, manifest.deployment_id);
  assert.equal(request.quote.body.control_api_origin, manifest.control_api_origin);
  assert.equal(request.quote.body.inference_api_origin, manifest.inference_api_origin);
  assert.equal(request.quote.body.provider, 'openai');
  assert.ok(isDeepStrictEqual(request.quote.body.models, ['i05-local-only']));
  assert.equal(main.pending.prepared.tariff.model, 'i05-local-only');
  assert.equal(main.pending.prepared.tariff.tariff_hash, request.quote.body.tariff_hash);
  assert.ok(manifest.tariff_hashes.includes(request.quote.body.tariff_hash));
  assert.equal(request.public_inputs.length, 12); request.public_inputs.forEach(parseField);
  assert.equal(request.public_inputs[8], nullifier, 'old RP nullifier differs from witness state');
  assert.ok(stale.wallet && ['active', 'closed'].includes(stale.wallet.status));
  assert.ok(stale.wallet.history.every(op => op.kind === 'mutual_close') && stale.wallet.history.length <= 1,
    'unexpected prior stale-wallet operation');
  if (stale.wallet.status === 'active') assert.equal(stale.wallet.history.length, 0);
  else assert.ok(!stale.wallet.operation && stale.wallet.history.length === 1);
  const operation = stale.wallet.operation ?? stale.wallet.history[0];
  if (operation) assert.ok(operation.kind === 'mutual_close' && ['proving', 'ready'].includes(operation.phase),
    'only the existing non-rejected mutual close can resume');
  if (stale.wallet.clearance) assert.equal(stale.wallet.clearance.nullifier, nullifier);
}

function sameAttempts(initial: readonly (Attempt | object)[], operation?: WalletOperation): void {
  assert.ok(operation || initial.length === 0, 'saved withdrawal disappeared');
  assert.ok(isDeepStrictEqual(operation?.attempts.slice(0, initial.length) ?? [], initial),
    'saved signed attempts were replaced');
}

/** Read-only evidence reconciliation after a completed SDK mutual close.
 * A closed buffer cannot prove historical upload progress. Instead require all
 * exact finalized plan steps, and link any finalized-expired upload to a later
 * finalized replacement of that SAME instruction. No missing financial receipt
 * or merely advanced offset is accepted, and old upload fees remain unknown. */
export async function verifyCompletedMutualAttempts(completed: WalletOperation, rpc: TransportRpc) {
  completed = structuredClone(completed);
  assert.ok(completed.kind === 'mutual_close' && completed.phase === 'ready' && !completed.current && completed.plan,
    'completed mutual-close plan required');
  const plan = await restorePlan(completed.plan);
  const attempts = completed.attempts as Attempt[];
  assert.equal(new Set(attempts.map(a => a.signature)).size, attempts.length, 'duplicate saved signature');
  assert.equal(attempts.filter(a => a.kind === 'execute').length, 1, 'one finalized execute required');
  const noSend: TransportRpc = {...rpc, sendRawTransaction: async () => { throw Error('receipt verification never sends'); }};
  const observed = [];
  for (const [index, attempt] of attempts.entries()) {
    assert.ok(['create', 'append', 'seal', 'execute'].includes(attempt.kind), 'unexpected completed mutual-close attempt');
    assert.ok(isDeepStrictEqual(attempt.plan, completed.plan), 'completed attempts must retain one exact plan');
    let height: number | undefined;
    const result = await recoverAttempt(attempt, {...noSend, finalizedBlockHeight: async () => {
      height = await rpc.finalizedBlockHeight();
      assert.ok(Number.isSafeInteger(height) && height >= 0, 'invalid finalized block height');
      return height;
    }}, false);
    const message = VersionedTransaction.deserialize(Buffer.from(attempt.wireHex, 'hex')).message;
    observed.push({attempt, index, result, height, message});
  }
  const successes = observed.filter(o => o.result.state === 'finalized');
  assert.equal(successes.length, plan.steps.length, 'every exact saved plan step must be finalized');
  assert.equal(completed.finalized.length, successes.length, 'finalized journal receipt count differs');
  const finalized = successes.map((o, stepIndex) => {
    assert.ok(o.result.state === 'finalized');
    const slot = o.result.slot;
    const step = plan.steps[stepIndex];
    assert.equal(o.attempt.kind, step.kind, 'finalized plan step order differs');
    assert.ok(Buffer.from(o.message.serialize()).equals(Buffer.from(
      compileV0(step.instruction, plan.feePayer, o.attempt.blockhash, plan.priorityFeeMicroLamports).message.serialize())),
    'finalized instruction or append offset differs');
    assert.equal(completed.finalized.filter(r => r.signature === o.attempt.signature && r.slot === slot).length, 1,
      'exact finalized receipt missing from journal');
    if (stepIndex > 0) {
      const previous = successes[stepIndex - 1].result;
      assert.ok(previous.state === 'finalized' && previous.slot <= o.result.slot, 'finalized receipt order differs');
    }
    return {signature:o.attempt.signature,kind:o.attempt.kind,slot:o.result.slot,
      wire_sha256:sha(Buffer.from(o.attempt.wireHex,'hex'))};
  });
  const superseded = [];
  for (const old of observed.filter(o => o.result.state !== 'finalized')) {
    assert.ok(old.result.state === 'expired_reconcile_required' && ['create', 'append', 'seal'].includes(old.attempt.kind),
      'exact saved attempt must be finalized or a finalized-expired upload with an exact replacement');
    assert.ok(old.height !== undefined && Number.isSafeInteger(old.height) && old.height > old.attempt.lastValidBlockHeight);
    const replacementIndex = successes.findIndex(next => {
      if (next.index <= old.index || next.attempt.kind !== old.attempt.kind
        || next.attempt.buffer !== old.attempt.buffer || next.attempt.planDigest !== old.attempt.planDigest
        || next.attempt.blockhash === old.attempt.blockhash
        || next.attempt.lastValidBlockHeight <= old.attempt.lastValidBlockHeight) return false;
      const normalized = VersionedTransaction.deserialize(Buffer.from(next.attempt.wireHex,'hex')).message;
      normalized.recentBlockhash = old.attempt.blockhash;
      return Buffer.from(normalized.serialize()).equals(Buffer.from(old.message.serialize()));
    });
    assert.ok(replacementIndex >= 0, 'expired upload requires a later finalized identical-step replacement');
    if (replacementIndex > 0) assert.ok(successes[replacementIndex - 1].index < old.index,
      'expired upload must follow the saved finalized prefix');
    const replacement = finalized[replacementIndex];
    superseded.push({signature:old.attempt.signature,kind:old.attempt.kind as 'create'|'append'|'seal',
      wire_sha256:sha(Buffer.from(old.attempt.wireHex,'hex')),buffer:old.attempt.buffer,plan_digest:old.attempt.planDigest,
      last_valid_block_height:old.attempt.lastValidBlockHeight,observed_finalized_block_height:old.height,
      replacement_signature:replacement.signature,replacement_slot:replacement.slot,
      replacement_wire_sha256:replacement.wire_sha256,status:'finalized_expired_upload_superseded' as const});
  }
  return {finalized,superseded};
}

export async function runDevnetClearanceRecovery(o: DevnetClearanceRecoveryContext) {
  const m = o.manifest;
  assert.equal(m.deployment_environment, 'devnet'); assert.equal(m.setup_profile, 'test_only');
  assert.equal(m.genesis_hash, DEVNET); assert.equal(m.mint, USDC);
  assert.equal(m.challenge_seconds, '600');
  assert.ok(o.journal !== o.staleJournal, 'separate existing journals required');
  const owner = o.roles.tokenOwner;
  assert.ok(owner && o.wallets.some(w => w.publicKey.toBase58() === owner));
  for (const role of Object.values(o.roles)) assert.equal(role, owner, 'same-owner bounded test only');
  const waitMs = o.waitMs ?? 600_000;
  assert.ok(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 600_000);
  return o.journal.withNoteLock(NOTE, async () => {
    const backup = await o.journal.exportBackup(NOTE);
    const main = (await o.journal.read(NOTE))?.value;
    let stale = (await o.staleJournal.read(NOTE))?.value;
    assert.ok(main && stale && main.witness && stale.witness, 'existing recovery records required');
    const unchanged = async () => {
      const after = await o.journal.exportBackup(NOTE);
      assert.ok(isDeepStrictEqual(after, backup), 'main encrypted record changed');
      assert.ok(isDeepStrictEqual((await o.journal.read(NOTE))?.value, main), 'main semantic state changed');
    };
    try {
      const identity = await o.prover.inspect(structuredClone(stale.witness), structuredClone(stale.state));
      verifyClearanceRecoveryIdentity(main, stale, m, identity.nullifier);
      assert.equal(await o.connection.getGenesisHash(), DEVNET);
      const initialAttempts = structuredClone(stale.wallet!.operation?.attempts ?? stale.wallet!.history[0]?.attempts ?? []);
      let operationId = stale.wallet!.operation?.id ?? stale.wallet!.history[0]?.id;
      const rpc = o.rpcFor(o.staleJournal);
      const client = new WalletClient({manifest:m,prover:o.prover,journal:o.staleJournal,
        chain:o.chain,rpc,wallets:o.wallets,fetch:o.pinnedFetch});
      const deadline = Date.now() + waitMs;
      if (stale.wallet!.status === 'active' && !stale.wallet!.operation) {
        // reserve_clearance is the atomic fence against any delayed/racing AUTH.
        // Its rejection propagates immediately; there is no escape fallback.
        await client.beginWithdrawal(NOTE, 'mutual_close', owner, o.roles);
      }
      for (;;) {
        await unchanged();
        stale = (await o.staleJournal.read(NOTE))!.value;
        verifyClearanceRecoveryIdentity(main, stale, m, identity.nullifier);
        const operation = stale.wallet!.operation ?? stale.wallet!.history[0];
        assert.ok(operation, 'saved mutual close required');
        operationId ??= operation.id; assert.equal(operation.id, operationId);
        assert.equal(operation.destinationOwner, owner);
        assert.ok(isDeepStrictEqual(operation.roles, o.roles), 'saved withdrawal roles differ');
        sameAttempts(initialAttempts, operation);
        if (stale.wallet!.status === 'closed') break;
        assert.ok(Date.now() < deadline, 'mutual close wait budget exceeded; journals retained');
        const status = await client.advance(NOTE);
        assert.notEqual(status.state, 'rejected', 'finalized rejection requires explicit review');
        assert.notEqual(status.state, 'expired_reconcile_required', 'uncertain execute requires explicit recovery');
        if (status.state === 'proof_required') await client.resumeProof(NOTE);
        if (status.state !== 'complete') await delay(250);
      }
      const clearance = stale.wallet!.clearance;
      assert.ok(clearance?.phase === 'verified' && clearance.signature, 'verified clearance required');
      assert.equal(clearance.nullifier, identity.nullifier);
      await o.prover.verifyClearance(clearance.nullifier, clearance.signature);
      const completed = stale.wallet!.history[0];
      for (const saved of completed.attempts) {
        assert.notEqual(saved.kind, 'finalize'); const attempt = saved as Attempt;
        assert.equal(attempt.plan.operation, 'mutual_close'); assert.equal(attempt.plan.pool, m.pool);
        assert.equal(attempt.plan.programId, m.program_id); assert.equal(attempt.plan.expectedNoteId, stale.witness!.note_id);
        assert.equal(attempt.plan.financial.destinationOwner, owner);
      }
      const verifiedAttempts = await verifyCompletedMutualAttempts(completed, rpc);
      const receipts = verifiedAttempts.finalized;
      const execute = receipts.find(r => r.kind === 'execute')!;
      const closed = await o.chain.snapshot(stale.witness!.note_id, 'none', execute.slot);
      assert.ok(Number.isSafeInteger(closed.slot) && closed.slot >= execute.slot, 'closed account cut precedes receipt');
      assert.equal(closed.note?.status, 'closed'); assert.equal(closed.pending, undefined);
      assert.equal(closed.note.note_id, stale.witness!.note_id);
      assert.equal(closed.note.registration_commitment, identity.registration_commitment);
      assert.equal(closed.note.deposit_micro_usdc, stale.witness!.deposit_micro_usdc);
      assert.equal(closed.note.expiry, stale.witness!.expiry);
      await unchanged();
      return {schema:1,passed:true,scope:'Existing stale WalletClient mutual close after authoritative signed CLEARANCE fences the unchanged uncertain AUTH',
        pool:m.pool,note_id:stale.witness!.note_id,request_id:main.pending!.prepared.request.authorization.request_id,
        nullifier:identity.nullifier,inference_operations:0,auth_resubmitted:false,auth_request_sha256:sha(main.pending!.exactRequest),
        main_journal_head:backup.head,main_ciphertext_sha256:sha(backup.backup),main_journal_unchanged:true,
        clearance_signature_verified:true,existing_attempts_preserved:true,stale_wallet_closed:true,closed_slot:closed.slot,
        finalized_attempts:receipts,superseded_upload_attempts:verifiedAttempts.superseded,
        superseded_upload_scope:'Exact saved expired upload linked to a later finalized identical-step replacement; old receipt and fee are unverified',
        balance_restoration_requires_caller_verification:true,
        native_challenge_proved:false,I10_complete:false,release_gates_passed:[]};
    } finally { await unchanged(); }
  });
}
