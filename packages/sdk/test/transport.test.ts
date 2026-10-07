import {createSolanaRpcWithFetch} from '../src/solana.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { address, AccountRole, getCompiledTransactionMessageEncoder, type Transaction, type TransactionMessageBytes, isSignerRole, isWritableRole } from '@solana/kit';
import { fixtureSigner, signWith, kitAddress, v0Message, type FixtureSigner, addressBytes, encodeTransaction, decodeTransaction } from './kit-helpers.ts';
import { SYSTEM_PROGRAM, transactionMessage, transactionSignature } from '../src/solana.ts';
import { encodeLayout2Args, fromHex, concat, hex, u32, u64, OPERATIONS } from '../src/layout2.ts';
import type { Operation } from '../src/layout2.ts';
import { buildUploadPlan, compileV0, closePayload, finalizeEscape, vaultAccounts, signV0, verifySignatures, discriminator,
  readBuffer, nextUploadStep, prepareAttempt, recoverAttempt, prepareFinalizationAttempt, recoverFinalizationAttempt, refreshExpiredUpload, restorePlan, connectionTransport, TRANSACTION_FORMATS,
  FINANCIAL_ACCOUNT_ORDER, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM } from '../src/transport.ts';
import type { UploadPlan, Step, V0Wallet, Attempt, BufferState, TransportRpc, FinalizedReceipt, SignatureStatus, FinalizationAttempt, SignedAttempt } from '../src/transport.ts';
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/a.json', import.meta.url), 'utf8'));
const keys = await Promise.all([1,10,11,12,13].map(seed=>fixtureSigner(new Uint8Array(32).fill(seed))));
const [payer, uploader, owner, rentPayer, feePayer] = keys;
const key = (hex: string) => kitAddress(fromHex(hex, 32));
const blockhash = { blockhash: kitAddress(new Uint8Array(32).fill(9)), lastValidBlockHeight: 100 };
const freshHash = { blockhash: kitAddress(new Uint8Array(32).fill(19)), lastValidBlockHeight: 200 };
const wallet = (keypair: FixtureSigner): V0Wallet => ({ publicKey:keypair.address,supportedTransactionVersions:new Set([0]),signTransaction:tx=>signWith(tx,[keypair]) });
const requiredWallets = (step: Step, fee = feePayer.address) => {
  const tx = compileV0(step.instruction, fee, blockhash.blockhash);
  return keys.filter(k => Object.hasOwn(tx.signatures,k.address)).map(wallet);
};
function payload(operation: Operation): Uint8Array {
  if (operation === 'deposit') return encodeLayout2Args({ operation, expectedId: 0, expectedRoot: fixture.trees[0].public_inputs[1], expiry: BigInt(fixture.expiry), commitment: '0x' + fixture.commitment, amount: BigInt(fixture.deposit), tree: fixture.trees[0] });
  if (operation === 'challenge_escape') return encodeLayout2Args({ operation, noteId: 0, auth: fixture.auth.request, tree: fixture.trees[2] });
  if (operation === 'claim_expired') return encodeLayout2Args({ operation, noteId: 0, tree: fixture.trees[1] });
  return encodeLayout2Args({ operation, auth: fixture.auth[operation === 'mutual_close' ? 'withdrawal' : 'escape'], tree: fixture.trees[1] });
}
async function planFor(operation: Operation = 'deposit', nonce = 1): Promise<UploadPlan> {
  const programId = key(fixture.program_id), pool = key(fixture.pool), mint = key(fixture.mint);
  return buildUploadPlan({ programId, pool, uploader: uploader.address, rentPayer: rentPayer.address, feePayer: feePayer.address,
    nonce: new Uint8Array(32).fill(nonce), expires: 3000003600n, operation, payload: payload(operation), snapshot: { slot: 27, sequence: 3n },
    financial: await vaultAccounts({ programId, pool, mint, noteId: 0, payer: payer.address, operation, tokenOwner: owner.address,
      destinationOwner: key(fixture.destination_owner), treasuryOwner: kitAddress(new Uint8Array(32).fill(8)), nullifier: fromHex(fixture.auth.escape.public_inputs[11].slice(2), 32) }) });
}
async function state(plan: UploadPlan, offset: number, sealed = false): Promise<BufferState> {
  return { address: plan.buffer, commitment: 'finalized', owner: plan.programId, slot: 50, data: concat(await discriminator('PayloadBuffer', 'account'), Uint8Array.of(2, plan.bump), addressBytes(plan.uploader),
    Uint8Array.of(OPERATIONS[plan.operation].op), u32(plan.payload.length), plan.digest, u32(offset), Uint8Array.of(sealed ? 1 : 0), u64(plan.expires), addressBytes(plan.rentPayer),
    u32(plan.payload.length), plan.payload.slice(0, offset), new Uint8Array(plan.payload.length - offset), plan.nonce) };
}
class Rpc implements TransportRpc {
  status: SignatureStatus | null = null; receipt: FinalizedReceipt | null = null; height = 50; fail = false; sendFail = false; sent: Uint8Array[] = [];
  async signatureStatus() { if (this.fail) throw new Error('rpc unavailable'); return this.status; }
  async finalizedReceipt() { return this.receipt; }
  async finalizedBlockHeight() { return this.height; }
  async sendRawTransaction(bytes: Uint8Array) { this.sent.push(bytes.slice()); if (this.sendFail) throw new Error('response lost'); return transactionSignature(decodeTransaction(bytes)); }
}
async function attemptFor(plan: UploadPlan, kind: Step['kind']) {
  const step = plan.steps.find(s => s.kind === kind)!;
  let saved: Attempt | undefined;
  const attempt = await prepareAttempt(plan, step, blockhash, requiredWallets(step), { save: async record => { saved = JSON.parse(JSON.stringify(record)); } });
  assert.deepEqual(saved, attempt);
  return attempt;
}
function receipt(attempt: SignedAttempt, err: unknown | null = null): FinalizedReceipt {
  return { message: new Uint8Array(decodeTransaction(fromHex(attempt.wireHex, attempt.wireHex.length / 2)).messageBytes), signature: attempt.signature, err, slot: 80 };
}

test('layout-2 encoding reuses canonical fields and matches independent fixture concatenation', () => {
  for (const operation of Object.keys(OPERATIONS) as Operation[]) {
    const bytes = payload(operation), tree = fixture.trees[operation === 'deposit' ? 0 : operation === 'challenge_escape' ? 2 : 1];
    const expectedTree = Buffer.concat([...tree.public_inputs.map((s: string) => Buffer.from(s.slice(2), 'hex')), Buffer.from(tree.proof_wire_hex, 'hex')]);
    assert.equal(bytes.length, OPERATIONS[operation].bytes);
    assert.deepEqual(Buffer.from(bytes.slice(-608)), expectedTree);
    if (operation === 'mutual_close') assert.deepEqual(Buffer.from(bytes.slice(0, 448)), Buffer.concat(fixture.auth.withdrawal.public_inputs.map((s: string) => Buffer.from(s.slice(2), 'hex'))));
  }
  assert.throws(() => encodeLayout2Args({ operation: 'claim_expired', noteId: 2 ** 32, tree: fixture.trees[1] }), /u32/);
  assert.throws(() => encodeLayout2Args({ operation: 'claim_expired', noteId: 0, tree: { ...fixture.trees[1], public_inputs: ['0x' + 'ff'.repeat(32), ...fixture.trees[1].public_inputs.slice(1)] } }), /field/);
});

test('all operation steps use real signed v0 <=1232 bytes with independent fee/payer/uploader/owner/rent', async () => {
  let maximum = 0;
  for (const operation of Object.keys(OPERATIONS) as Operation[]) {
    const plan = await planFor(operation);
    const steps = [...plan.steps, await closePayload(plan)];
    for (const step of steps) {
      const tx = await signV0(compileV0(step.instruction, plan.feePayer, blockhash.blockhash), requiredWallets(step));
      const bytes = encodeTransaction(tx); maximum = Math.max(maximum, bytes.length);
      assert.ok(bytes.length <= 1232); assert.equal(transactionMessage(tx).version, 0); assert.equal((transactionMessage(tx).version === 0 ? (transactionMessage(tx) as {addressTableLookups?: unknown[]}).addressTableLookups?.length ?? 0 : -1), 0);
      await verifySignatures(decodeTransaction(bytes));
    }
    const create = plan.steps[0].instruction;
    assert.deepEqual(create.accounts!.map(k => [isWritableRole(k.role), isSignerRole(k.role)]), [[true, false], [false, false], [false, true], [true, true], [false, false]]);
    assert.equal(create.accounts![3].address, rentPayer.address);
    const execute = plan.steps.at(-1)!.instruction;
    assert.equal(execute.accounts!.length, 21);
    assert.equal(execute.accounts![0].address, plan.buffer);
    assert.equal(execute.accounts![1].address, uploader.address);
    assert.equal(execute.accounts![2].address, rentPayer.address);
    for (let i = 0; i < FINANCIAL_ACCOUNT_ORDER.length; i++) assert.ok((execute.accounts![3 + i].address === plan.financial[FINANCIAL_ACCOUNT_ORDER[i]]));
    assert.equal(isSignerRole(execute.accounts![16].role), operation === 'deposit');
    assert.deepEqual(execute.data.subarray(8), plan.digest);
    assert.ok((execute.accounts![18].address === TOKEN_PROGRAM));
    assert.ok((execute.accounts![19].address === ASSOCIATED_TOKEN_PROGRAM));
    assert.ok((execute.accounts![20].address === SYSTEM_PROGRAM));
    const appended = plan.steps.filter(s => s.kind === 'append');
    assert.deepEqual(Buffer.concat(appended.map(s => s.instruction.data.subarray(16))), Buffer.from(plan.payload));
  }
  assert.equal(maximum, 1232); assert.deepEqual(TRANSACTION_FORMATS, ['v0_buffer', 'v0_inline_deposit_v1']);
});

test('generated instruction discriminators/account flags match compiler-backed IDL', async () => {
  const idl = JSON.parse(readFileSync(new URL('../../../docs/contracts/zkapi_vault.json', import.meta.url), 'utf8'));
  const plan = await planFor();
  const names = { create: 'create_payload', append: 'append_payload', seal: 'seal_payload', execute: 'execute_payload', close: 'close_payload' } as const;
  for (const step of [...plan.steps, await closePayload(plan)]) {
    const name = names[step.kind as keyof typeof names];
    const item = idl.instructions.find((i: { name: string }) => i.name === name);
    assert.ok(item, `${name} absent from IDL`);
    assert.deepEqual([...step.instruction.data.subarray(0, 8)], item.discriminator);
    const keys = step.kind === 'execute' ? step.instruction.accounts!.slice(0, 3) : step.instruction.accounts!;
    assert.deepEqual(keys.map(k => [isWritableRole(k.role), isSignerRole(k.role)]), item.accounts.map((a: { writable?: boolean; signer?: boolean }) => [a.writable ?? false, a.signer ?? false]));
  }
});

test('expected_digest binds signed execute even when same PDA is recreated', async () => {
  const plan = await planFor('mutual_close');
  const execute = plan.steps.at(-1)!;
  const signed = await signV0(compileV0(execute.instruction, plan.feePayer, blockhash.blockhash), requiredWallets(execute));
  const mutatedPayload = plan.payload.slice(); mutatedPayload[100] ^= 1;
  const replacement = await buildUploadPlan({ ...plan, payload: mutatedPayload });
  assert.ok((plan.buffer === replacement.buffer)); assert.notDeepEqual(plan.digest, replacement.digest);
  const changed = compileV0(replacement.steps.at(-1)!.instruction, plan.feePayer, blockhash.blockhash);
  await assert.rejects(verifySignatures({...changed,signatures:structuredClone(signed.signatures)}), /signature/);
});

test('wallet rejection, unsupported version, message mutation and dropped signature stop sending', async () => {
  const plan = await planFor(), step = plan.steps[0], tx = compileV0(step.instruction, plan.feePayer, blockhash.blockhash), wallets = requiredWallets(step);
  await assert.rejects(signV0(tx, [{ ...wallets[0], supportedTransactionVersions: new Set(['legacy']) }]), /advertise/);
  await assert.rejects(signV0(tx, [{ ...wallets[0], signTransaction: async () => { throw new Error('wallet rejected'); } }]), /rejected/);
  await assert.rejects(signV0(tx, [{ ...wallets[0], signTransaction: async tx => { return {...tx,messageBytes:getCompiledTransactionMessageEncoder().encode({...transactionMessage(tx),lifetimeToken:address(freshHash.blockhash)}) as TransactionMessageBytes}; } }]), /changed transaction/);
  await assert.rejects(signV0(tx, wallets.slice(0, 1)), /signature/);
  await assert.rejects(signV0(tx, [wallets[0], { ...wallets[1], signTransaction: async tx => { Object.values(tx.signatures).forEach(signature => (signature as Uint8Array|null)?.fill(0)); return tx; } }]), /existing signature/);
});

test('verified transactions are detached from references retained by wallets', async () => {
  const plan = await planFor(), step = plan.steps[0], wallets = requiredWallets(step);
  let retained: Transaction | undefined;
  const last = wallets.at(-1)!;
  wallets[wallets.length - 1] = { ...last, signTransaction: async tx => { retained = await last.signTransaction(tx); return retained; } };
  const signed = await signV0(compileV0(step.instruction, plan.feePayer, blockhash.blockhash), wallets);
  const reviewed = encodeTransaction(signed);
  (retained!.messageBytes as unknown as Uint8Array)[5] ^= 1;
  (Object.values(retained!.signatures)[0] as Uint8Array).fill(0);
  assert.deepEqual(encodeTransaction(signed), reviewed);
  await verifySignatures(signed);
});

test('durable journal contains exact payload, snapshot, signature and expiry before any send', async () => {
  const plan = await planFor(), attempt = await attemptFor(plan, 'create');
  assert.equal(attempt.plan.payloadHex, hex(plan.payload)); assert.equal(attempt.plan.snapshotSlot, 27); assert.equal(attempt.plan.snapshotSequence, '3');
  assert.equal(attempt.plan.expectedRoot, fixture.trees[0].public_inputs[1].slice(2)); assert.equal(attempt.plan.expectedNoteId, 0);
  const restored = await restorePlan(JSON.parse(JSON.stringify(attempt.plan)));
  assert.deepEqual(restored.payload, plan.payload); assert.ok((restored.buffer === plan.buffer));
  await assert.rejects(prepareAttempt(plan, plan.steps[0], blockhash, requiredWallets(plan.steps[0]), { save: async () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
});

test('wallet prompt edits cannot change the upload transaction or its persisted recovery context', async () => {
  const plan = await planFor(), step = plan.steps.at(-1)!, wallets = requiredWallets(step), hash = { ...blockhash };
  const expectedPayload = hex(plan.payload), expectedDigest = hex(plan.digest), expectedNonce = hex(plan.nonce);
  const expectedMessage = compileV0(step.instruction, plan.feePayer, hash.blockhash).messageBytes;
  const first = wallets[0];
  wallets[0] = { ...first, signTransaction: async tx => {
    plan.payload[0] ^= 1; plan.digest[0] ^= 1; plan.nonce[0] ^= 1;
    plan.financial.destinationOwner = payer.address; plan.feePayer = owner.address;
    plan.snapshot.slot = 999; plan.snapshot.sequence = 999n;
    step.kind = 'close'; step.instruction.data[8] ^= 1;
    Object.assign(hash, freshHash);
    return first.signTransaction(tx);
  } };
  let saved: Attempt | undefined;
  const attempt = await prepareAttempt(plan, step, hash, wallets, { save: async record => { saved = structuredClone(record); } });
  assert.deepEqual(saved, attempt);
  assert.equal(attempt.kind, 'execute'); assert.equal(attempt.plan.payloadHex, expectedPayload);
  assert.equal(attempt.planDigest, expectedDigest); assert.equal(attempt.plan.nonceHex, expectedNonce);
  assert.equal(attempt.plan.snapshotSlot, 27); assert.equal(attempt.plan.snapshotSequence, '3');
  assert.equal(attempt.blockhash, blockhash.blockhash); assert.equal(attempt.lastValidBlockHeight, blockhash.lastValidBlockHeight);
  assert.deepEqual(receipt(attempt).message, expectedMessage);
  const rpc = new Rpc(); rpc.receipt = receipt(attempt);
  assert.deepEqual(await recoverAttempt(saved!, rpc), { state: 'finalized', slot: 80 });
});

test('lost send response resends only the identical wire and recognizes finalized receipt', async () => {
  const plan = await planFor(), attempt = await attemptFor(plan, 'execute'), rpc = new Rpc();
  rpc.sendFail = true;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'unknown' });
  rpc.sendFail = false;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'pending' });
  assert.equal(rpc.sent.length, 2); assert.deepEqual(rpc.sent[0], rpc.sent[1]);
  rpc.receipt = receipt(attempt);
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'finalized', slot: 80 }); assert.equal(rpc.sent.length, 2);
});

test('RPC waits cannot substitute a different signed upload after journal validation', async () => {
  const attempt = await attemptFor(await planFor('deposit', 1), 'create');
  const replacement = await attemptFor(await planFor('deposit', 2), 'create');
  const expected = fromHex(attempt.wireHex, attempt.wireHex.length / 2), rpc = new Rpc();
  assert.notEqual(attempt.signature, replacement.signature);
  rpc.signatureStatus = async () => { Object.assign(attempt, replacement); return null; };
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'pending' });
  assert.deepEqual(rpc.sent, [expected]);
});

test('pending/unknown RPC state and missing buffer never become execute success or authorize new transaction', async () => {
  const plan = await planFor(), attempt = await attemptFor(plan, 'execute'), rpc = new Rpc();
  rpc.status = { slot: 77, confirmationStatus: 'confirmed', err: null }; rpc.height = 101;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'pending' }); assert.equal(rpc.sent.length, 0);
  rpc.status = null; rpc.fail = true;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'unknown' });
  rpc.fail = false;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'expired_reconcile_required' }); assert.equal(rpc.sent.length, 0);
  await assert.rejects(nextUploadStep(plan, null), /absent/);
  await assert.rejects(refreshExpiredUpload(attempt, rpc, null, freshHash, [], { save: async () => {} }), /finalized history/);
  rpc.receipt = { ...receipt(attempt), message: new Uint8Array([0]) };
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'unknown' });
});

test('finalized root/ID/expiry conflicts request fresh proofs and never rewrite existing authorization', async () => {
  const plan = await planFor('initiate_escape'), attempt = await attemptFor(plan, 'execute'), rpc = new Rpc();
  for (const code of [6006, 6007, 6008, 6011]) {
    const err = { InstructionError: [1, { Custom: code }] }; rpc.receipt = receipt(attempt, err);
    assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'rejected', slot: rpc.receipt.slot, error: err, needsNewProof: code !== 6011 });
  }
  assert.equal(rpc.sent.length, 0); assert.equal(hex(plan.payload), attempt.plan.payloadHex);
});

test('every upload crash boundary resumes from verified finalized prefix/seal state', async () => {
  const plan = await planFor('mutual_close');
  assert.equal((await nextUploadStep(plan, await state(plan, 0)))!.kind, 'append');
  for (const step of plan.steps.filter(s => s.kind === 'append')) {
    const next = await nextUploadStep(plan, await state(plan, step.endOffset!));
    assert.equal(next!.kind, step.endOffset === plan.payload.length ? 'seal' : 'append');
  }
  assert.equal((await nextUploadStep(plan, await state(plan, plan.payload.length, true)))!.kind, 'execute');
  const bad = await state(plan, plan.payload.length, true); bad.data[128] ^= 1;
  await assert.rejects(nextUploadStep(plan, bad), /differs/);
  const recreated = await planFor('mutual_close', 2);
  await assert.rejects(nextUploadStep(plan, await state(recreated, 0)), /differs|invalid/);
});

test('finalized-expired upload refreshes only after exact buffer reconciliation', async () => {
  const plan = await planFor('mutual_close'), step = plan.steps.find(s => s.kind === 'append')!, attempt = await attemptFor(plan, 'append'), rpc = new Rpc(); rpc.height = 101;
  let saved: Attempt | undefined;
  const next = await refreshExpiredUpload(attempt, rpc, await state(plan, step.offset!), freshHash, requiredWallets(step), { save: async a => { saved = a; } });
  assert.ok('signature' in next); assert.notEqual(next.signature, attempt.signature); assert.equal(saved!.blockhash, freshHash.blockhash); assert.equal(saved!.planDigest, attempt.planDigest);
  assert.deepEqual(rpc.sent, []);
  const advanced = await refreshExpiredUpload(attempt, rpc, await state(plan, step.endOffset!), freshHash, requiredWallets(step), { save: async () => { throw new Error('must not sign'); } });
  assert.ok('next' in advanced); assert.equal(advanced.next.kind, 'append'); assert.equal(advanced.next.offset, step.endOffset);
  await assert.rejects(refreshExpiredUpload(attempt, rpc, null, freshHash, [], { save: async () => {} }), /history/);
  rpc.height = 100;
  await assert.rejects(refreshExpiredUpload(attempt, rpc, await state(plan, 0), freshHash, [], { save: async () => {} }), /not finalized-expired/);
});

test('finalized buffer decoder rejects every header identity and inconsistent progress', async () => {
  const plan = await planFor(), good = await state(plan, plan.payload.length, true);
  for (const offset of [0, 8, 9, 10, 42, 43, 47, 79, 83, 84, 92, 124, good.data.length - 1]) {
    const bad = { ...good, data: good.data.slice() }; bad.data[offset] ^= 0x80;
    await assert.rejects(readBuffer(plan, bad), /buffer|digest/);
  }
  await assert.rejects(readBuffer(plan, { ...good, owner: SYSTEM_PROGRAM }), /invalid/);
  await assert.rejects(readBuffer(plan, { ...good, address: SYSTEM_PROGRAM }), /invalid/);
  await assert.rejects(readBuffer(plan, { ...good, slot: plan.snapshot.slot - 1 }), /invalid/);
});

for (const commitment of [undefined, 'confirmed'] as const) test(`Connection adapter keeps finalized recovery with ${commitment ?? 'default'} preparation and exact send response loss`, async () => {
  const plan = await planFor(), attempt = await attemptFor(plan, 'create');
  const requests: { method: string; params: unknown[] }[] = [];
  let loseSend = true;
  const connection = createSolanaRpcWithFetch('http://localhost:8899', async (_url, init) => {
    const body = JSON.parse(init!.body as string); requests.push(body);
    let result: unknown;
    if (body.method === 'getSignatureStatuses') result = { context: { slot: 12 }, value: [null] };
    else if (body.method === 'getTransaction') result = null;
    else if (body.method === 'getBlockHeight') result = 50;
    else if (body.method === 'sendTransaction') { if (loseSend) throw new Error('socket closed after upstream accepted bytes'); result = attempt.signature; }
    else throw new Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  });
  const options: {preparationCommitment?: 'confirmed'|'finalized'} = {preparationCommitment: commitment};
  const rpc = connectionTransport(connection, options);
  options.preparationCommitment = commitment === 'confirmed' ? 'finalized' : 'confirmed';
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'unknown' }); loseSend = false;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'pending' });
  const reads = requests.filter(r => r.method === 'getTransaction');
  for(const read of reads) assert.deepEqual(read.params[1], { encoding:'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  const statuses = requests.filter(r => r.method === 'getSignatureStatuses');
  assert.ok(statuses.every(r => (r.params[1] as { searchTransactionHistory: boolean }).searchTransactionHistory));
  const sends = requests.filter(r => r.method === 'sendTransaction');
  assert.equal(sends.length, 2); assert.equal(sends[0].params[0], sends[1].params[0]);
  assert.deepEqual(sends[0].params[1], { encoding: 'base64', skipPreflight:false, maxRetries: 0, preflightCommitment: commitment ?? 'finalized' });
  assert.ok(requests.filter(r => r.method === 'getBlockHeight').every(r => (r.params[0] as {commitment: string}).commitment === 'finalized'));
  for (const invalid of ['processed', 'recent', null, 1]) {
    assert.throws(() => connectionTransport(connection, {preparationCommitment: invalid as never}), /invalid transaction preparation commitment/);
  }
});


test('standalone finalize has durable signed recovery, note/account binding and no new proof', async () => {
  const upload = await planFor('initiate_escape');
  const financial = await vaultAccounts({ programId: upload.programId, pool: upload.pool, mint: upload.financial.mint, noteId: 0, payer: payer.address, operation: 'finalize_escape',
    destinationOwner: key(fixture.destination_owner), treasuryOwner: kitAddress(new Uint8Array(32).fill(8)) });
  const plan = { programId: upload.programId, pool: upload.pool, noteId: 0, feePayer: feePayer.address, financial, snapshot: upload.snapshot };
  const step = await finalizeEscape(plan.programId, financial, 0);
  let persisted: FinalizationAttempt | undefined;
  const attempt = await prepareFinalizationAttempt(plan, blockhash, requiredWallets(step), { save: async record => { persisted = JSON.parse(JSON.stringify(record)); } });
  assert.deepEqual(persisted, attempt); assert.equal(attempt.kind, 'finalize');
  assert.equal(v0Message(decodeTransaction(fromHex(attempt.wireHex, attempt.wireHex.length / 2))).instructions[1].data!.length, 12);
  const rpc = new Rpc(); rpc.sendFail = true;
  assert.deepEqual(await recoverFinalizationAttempt(attempt, rpc, true), { state: 'unknown' });
  rpc.sendFail = false;
  assert.deepEqual(await recoverFinalizationAttempt(attempt, rpc, true), { state: 'pending' });
  assert.deepEqual(rpc.sent[0], rpc.sent[1]);
  rpc.height = 101;
  assert.deepEqual(await recoverFinalizationAttempt(attempt, rpc, true), { state: 'expired_reconcile_required' }); assert.equal(rpc.sent.length, 2);
  rpc.receipt = receipt(attempt, { InstructionError: [1, { Custom: 6015 }] });
  const failed = await recoverFinalizationAttempt(attempt, rpc, true); assert.equal(failed.state, 'rejected'); if (failed.state === 'rejected') assert.equal(failed.needsNewProof, false);
  rpc.receipt = receipt(attempt);
  assert.deepEqual(await recoverFinalizationAttempt(attempt, rpc, true), { state: 'finalized', slot: 80 });
  const changed = structuredClone(attempt); changed.finalization.noteId = 1;
  await assert.rejects(recoverFinalizationAttempt(changed, rpc), /context|journal/);
  const changedDestination = structuredClone(attempt); changedDestination.finalization.financial.destinationOwner = payer.address;
  await assert.rejects(recoverFinalizationAttempt(changedDestination, rpc), /journal/);
  await assert.rejects(prepareFinalizationAttempt(plan, blockhash, requiredWallets(step), { save: async () => { throw new Error('fsync failed'); } }), /fsync/);
});

test('wallet prompt edits cannot change a finalization journal after the message is signed', async () => {
  const upload = await planFor('initiate_escape');
  const financial = await vaultAccounts({ programId: upload.programId, pool: upload.pool, mint: upload.financial.mint, noteId: 0, payer: payer.address, operation: 'finalize_escape',
    destinationOwner: key(fixture.destination_owner), treasuryOwner: kitAddress(new Uint8Array(32).fill(8)) });
  const plan = { programId: upload.programId, pool: upload.pool, noteId: 0, feePayer: feePayer.address, financial, snapshot: { ...upload.snapshot } };
  const hash = { ...blockhash }, step = await finalizeEscape(plan.programId, financial, plan.noteId), wallets = requiredWallets(step);
  const first = wallets[0];
  wallets[0] = { ...first, signTransaction: async tx => {
    plan.noteId = 1; plan.feePayer = owner.address; plan.financial.destinationOwner = owner.address;
    plan.snapshot.slot = 999; plan.snapshot.sequence = 999n; Object.assign(hash, freshHash);
    return first.signTransaction(tx);
  } };
  let saved: FinalizationAttempt | undefined;
  const attempt = await prepareFinalizationAttempt(plan, hash, wallets, { save: async record => { saved = structuredClone(record); } });
  assert.deepEqual(saved, attempt); assert.equal(attempt.finalization.noteId, 0);
  assert.equal(attempt.finalization.financial.destinationOwner, key(fixture.destination_owner));
  assert.equal(attempt.finalization.snapshotSlot, 27); assert.equal(attempt.finalization.snapshotSequence, '3');
  assert.equal(attempt.blockhash, blockhash.blockhash); assert.equal(attempt.lastValidBlockHeight, blockhash.lastValidBlockHeight);
  const rpc = new Rpc(); rpc.receipt = receipt(attempt);
  assert.deepEqual(await recoverFinalizationAttempt(saved!, rpc), { state: 'finalized', slot: 80 });
});

test('RPC waits cannot change a finalization attempt after journal validation', async () => {
  const upload = await planFor('initiate_escape');
  const financial = await vaultAccounts({ programId: upload.programId, pool: upload.pool, mint: upload.financial.mint, noteId: 0, payer: payer.address, operation: 'finalize_escape',
    destinationOwner: key(fixture.destination_owner), treasuryOwner: kitAddress(new Uint8Array(32).fill(8)) });
  const plan = { programId: upload.programId, pool: upload.pool, noteId: 0, feePayer: feePayer.address, financial, snapshot: upload.snapshot };
  const step = await finalizeEscape(plan.programId, financial, plan.noteId);
  const attempt = await prepareFinalizationAttempt(plan, blockhash, requiredWallets(step), { save: async () => {} });
  const replacement = await prepareFinalizationAttempt(plan, freshHash, requiredWallets(step), { save: async () => {} });
  const expected = fromHex(attempt.wireHex, attempt.wireHex.length / 2), rpc = new Rpc();
  rpc.signatureStatus = async () => { Object.assign(attempt, replacement); return null; };
  assert.deepEqual(await recoverFinalizationAttempt(attempt, rpc, true), { state: 'pending' });
  assert.deepEqual(rpc.sent, [expected]);
});

test('permissionless expired close records actual closer and never treats absence as success', async () => {
  const plan = await planFor(), closer = owner.address, step = await closePayload(plan, closer);
  const attempt = await prepareAttempt(plan, step, blockhash, requiredWallets(step), { save: async () => {} });
  assert.equal(attempt.closer, closer);
  const rpc = new Rpc(); rpc.height = 101;
  assert.deepEqual(await recoverAttempt(attempt, rpc, true), { state: 'expired_reconcile_required' }); assert.equal(rpc.sent.length, 0);
  rpc.receipt = receipt(attempt);
  assert.deepEqual(await recoverAttempt(attempt, rpc), { state: 'finalized', slot: 80 });
  const tampered = { ...attempt, closer: uploader.address };
  await assert.rejects(recoverAttempt(tampered, rpc), /journal plan/);
});
