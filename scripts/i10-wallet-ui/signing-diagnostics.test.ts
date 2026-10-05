import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
import {signingDiagnostics} from './signing-diagnostics.ts';

const payer = Keypair.fromSeed(new Uint8Array(32).fill(11));
const receiver = new PublicKey(new Uint8Array(32).fill(12));
const program = new PublicKey(new Uint8Array(32).fill(13));
const blockhash = new PublicKey(new Uint8Array(32).fill(14)).toBase58();
const secretPayload = Buffer.from('private-proof-payload-never-log');
const action = () => new TransactionInstruction({programId: program, keys: [
  {pubkey: payer.publicKey, isSigner: true, isWritable: true}, {pubkey: receiver, isSigner: false, isWritable: false},
], data: Buffer.from(secretPayload)});
function transaction(instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({units: 1_000_000}), action()]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({payerKey: payer.publicKey, recentBlockhash: blockhash, instructions}).compileToV0Message());
}
const clone = (tx: VersionedTransaction) => VersionedTransaction.deserialize(tx.serialize());

test('an untouched message remains equal despite a signature, without exposing private bytes or mutating either input', () => {
  const original = transaction(), returned = clone(original); returned.sign([payer]);
  const before = [Buffer.from(original.serialize()).toString('hex'), Buffer.from(returned.serialize()).toString('hex')];
  const result = signingDiagnostics(original, returned);
  assert.deepEqual(result.version, {original: 0, returned: 0});
  for (const key of ['message_equal', 'header_equal', 'blockhash_equal', 'accounts_equal', 'ALT_equal',
    'original_non_compute_instructions_retained', 'non_compute_instructions_equal'] as const) assert.equal(result[key], true, key);
  assert.deepEqual(result.original_instructions, [
    {programId: ComputeBudgetProgram.programId.toBase58(), dataLength: 5, computeBudget: {kind: 'SetComputeUnitLimit', value: '1000000'}},
    {programId: program.toBase58(), dataLength: secretPayload.length},
  ]);
  const publicJson = JSON.stringify(result);
  for (const forbidden of [payer.publicKey.toBase58(), receiver.toBase58(), blockhash,
    secretPayload.toString(), secretPayload.toString('hex'), secretPayload.toString('base64'),
    Buffer.from(returned.signatures[0]).toString('hex'), ...before]) assert.equal(publicJson.includes(forbidden), false);
  assert.deepEqual([Buffer.from(original.serialize()).toString('hex'), Buffer.from(returned.serialize()).toString('hex')], before);
});

test('blockhash mutation is distinguished from instruction or account changes', () => {
  const original = transaction(), returned = clone(original);
  returned.message.recentBlockhash = new PublicKey(new Uint8Array(32).fill(22)).toBase58();
  const result = signingDiagnostics(original, returned);
  assert.equal(result.message_equal, false); assert.equal(result.blockhash_equal, false);
  assert.equal(result.accounts_equal, true); assert.equal(result.header_equal, true);
  assert.equal(result.non_compute_instructions_equal, true);
});

test('added or changed compute-unit price is reported exactly without authorizing message mutation', () => {
  const original = transaction(), price = 9_007_199_254_740_993n;
  const returned = transaction([ComputeBudgetProgram.setComputeUnitLimit({units: 1_000_000}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports: price}), action()]);
  const result = signingDiagnostics(original, returned);
  assert.equal(result.message_equal, false); assert.equal(result.blockhash_equal, true);
  assert.equal(result.original_non_compute_instructions_retained, true); assert.equal(result.non_compute_instructions_equal, true);
  assert.deepEqual(result.returned_instructions[1].computeBudget, {kind: 'SetComputeUnitPrice', value: price.toString()});
  const changed = clone(returned); changed.message.compiledInstructions[1].data[1] = 2;
  assert.equal(signingDiagnostics(returned, changed).message_equal, false);
  assert.notEqual(signingDiagnostics(returned, changed).returned_instructions[1].computeBudget!.value, price.toString());
});

test('an added assertion-like program keeps originals but is distinct from an unchanged instruction list', () => {
  const original = transaction(), assertionProgram = new PublicKey(new Uint8Array(32).fill(44));
  const returned = transaction([ComputeBudgetProgram.setComputeUnitLimit({units: 1_000_000}), action(),
    new TransactionInstruction({programId: assertionProgram, keys: [{pubkey: receiver, isSigner: false, isWritable: false}], data: Buffer.from('unknown-assertion-private-payload')})]);
  const result = signingDiagnostics(original, returned);
  assert.equal(result.message_equal, false); assert.equal(result.accounts_equal, false);
  assert.equal(result.original_non_compute_instructions_retained, true); assert.equal(result.non_compute_instructions_equal, false);
  assert.deepEqual(result.returned_instructions[2], {programId: assertionProgram.toBase58(), dataLength: 33});
  assert.equal(JSON.stringify(result).includes('unknown-assertion-private-payload'), false);
});

test('changed non-compute data, account or writable flags never count as retained', () => {
  const original = transaction();
  const modifications = [
    (ix: TransactionInstruction) => { ix.data[0] ^= 1; },
    (ix: TransactionInstruction) => { ix.keys[1].pubkey = new PublicKey(new Uint8Array(32).fill(33)); },
    (ix: TransactionInstruction) => { ix.keys[1].isWritable = true; },
  ];
  for (const mutate of modifications) {
    const ix = action(); mutate(ix);
    const returned = transaction([ComputeBudgetProgram.setComputeUnitLimit({units: 1_000_000}), ix]);
    const result = signingDiagnostics(original, returned);
    assert.equal(result.original_non_compute_instructions_retained, false);
    assert.equal(result.non_compute_instructions_equal, false);
  }
});

test('non-compute comparison preserves order, multiplicity and signer flags', () => {
  const other = action(); other.data = Buffer.from('second-private-payload');
  const original = transaction([action(), other]);
  assert.equal(signingDiagnostics(original, transaction([other, action()])).original_non_compute_instructions_retained, false);
  assert.equal(signingDiagnostics(transaction([action(), action()]), transaction([action()])).original_non_compute_instructions_retained, false);
  const changed = action(); changed.keys[1].isSigner = true;
  const result = signingDiagnostics(transaction([action()]), transaction([changed]));
  assert.equal(result.header_equal, false); assert.equal(result.original_non_compute_instructions_retained, false);
});

test('malformed or non-compute payloads never masquerade as decoded compute settings', () => {
  const cases = [
    new TransactionInstruction({programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([3, 1])}),
    new TransactionInstruction({programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(9, 99)}),
    new TransactionInstruction({programId: program, keys: [], data: ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}).data}),
    new TransactionInstruction({programId: ComputeBudgetProgram.programId, keys: [{pubkey: receiver, isSigner: false, isWritable: false}], data: ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}).data}),
  ];
  for (const ix of cases) assert.equal(signingDiagnostics(transaction(), transaction([ix])).returned_instructions[0].computeBudget, undefined);
});

test('unresolved ALT changes cannot establish byte-equivalent non-compute instructions', () => {
  const original = transaction(), lookupKey = new PublicKey(new Uint8Array(32).fill(55));
  const table = new AddressLookupTableAccount({key: lookupKey, state: {deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [receiver]}});
  const returned = new VersionedTransaction(new TransactionMessage({payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [action()]}).compileToV0Message([table]));
  const result = signingDiagnostics(original, returned);
  assert.equal(result.ALT_equal, false); assert.equal(result.original_non_compute_instructions_retained, null);
  assert.equal(result.non_compute_instructions_equal, null);
  assert.equal(JSON.stringify(result).includes(lookupKey.toBase58()), false);
  assert.equal(signingDiagnostics(returned, clone(returned)).ALT_equal, true);
});
