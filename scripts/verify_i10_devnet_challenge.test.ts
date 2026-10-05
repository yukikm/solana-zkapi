/** Offline parser/transport guards only; dummy proof bytes are never submitted
 * to a chain and cannot establish proof validity or public acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import {challengePlan, challengerWallet} from '../packages/sdk/src/challenger.ts';
import {prepareAttempt, type TransportRpc} from '../packages/sdk/src/transport.ts';
import {parseField} from '../packages/sdk/src/encoding.ts';
import {encodeLayout2Args, type PublicProof} from '../packages/sdk/src/layout2.ts';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';
import {parseCollectorInput, readCollectorInput, readOnlyRecovery, verifyChallengeEvent, verifyChallengeTree, type ChallengeEventBinding} from './verify_i10_devnet_challenge.ts';

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const field = (value: number) => '0x' + value.toString(16).padStart(64, '0');
const binding: ChallengeEventBinding = {program: key(1), pool: key(2), noteId: 7,
  nullifier: field(4), sequence: '9', oldRoot: field(2), newRoot: field(3), deadline: '1600'};
function event(): string {
  const b = Buffer.alloc(251);
  createHash('sha256').update('event:VaultTransitionV1').digest().copy(b, 0, 0, 8);
  b[8] = 1; new PublicKey(binding.pool).toBuffer().copy(b, 9);
  b.writeBigUInt64LE(9n, 41); b[49] = 3; b.writeUInt32LE(7, 50); b[54] = 1;
  Buffer.from(parseField(binding.oldRoot)).copy(b, 55); Buffer.from(parseField(binding.newRoot)).copy(b, 87);
  b[167] = 1; Buffer.from(parseField(binding.nullifier)).copy(b, 168);
  b[200] = 1; b[209] = 1; b[242] = 1; b.writeBigUInt64LE(1600n, 243);
  return 'Program data: ' + b.toString('base64');
}

test('challenge event is bound to Vault emitter, pool, note, nullifier, roots and sequence', () => {
  const logs = [`Program ${binding.program} invoke [1]`, event(), `Program ${binding.program} success`];
  verifyChallengeEvent(logs, binding);
  for (const changed of [{...binding, pool: key(3)}, {...binding, noteId: 8},
    {...binding, nullifier: field(5)}, {...binding, oldRoot: field(7)}, {...binding, newRoot: field(6)},
    {...binding, sequence: '11'}, {...binding, deadline: '1601'}, {...binding, operation: 2 as const}]) {
    assert.throws(() => verifyChallengeEvent(logs, changed));
  }
  assert.throws(() => verifyChallengeEvent([`Program ${key(3)} invoke [1]`, event(), `Program ${key(3)} success`], binding));
  assert.throws(() => verifyChallengeEvent([...logs.slice(0, 2), event(), logs[2]], binding));
  assert.throws(() => verifyChallengeEvent(logs.slice(0, 2), binding));
});

test('a child program cannot impersonate the Vault event', () => {
  const logs = [`Program ${binding.program} invoke [1]`, `Program ${key(3)} invoke [2]`, event(),
    `Program ${key(3)} success`, `Program ${binding.program} success`];
  assert.throws(() => verifyChallengeEvent(logs, binding));
  logs.splice(4, 0, event()); verifyChallengeEvent(logs, binding);
});

test('read-only I04 recovery never sends and rejects altered exact bytes/receipts', async () => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const payload = Buffer.alloc(1252); payload.writeUInt32LE(7); payload[1252 - 608 + 31] = 2; payload[1252 - 608 + 127] = 7;
  const plan = await challengePlan({programId: key(1), pool: key(2), mint: key(3), payer: signer.publicKey.toBase58(),
    noteId: 7, payloadHex: payload.toString('hex'), nonceHex: '01'.repeat(32), expires: '1000000', slot: 100, sequence: '8'});
  const attempt = await prepareAttempt(plan, plan.steps[0], {blockhash: key(8), lastValidBlockHeight: 1000},
    [challengerWallet(signer.secretKey)], {save: async () => {}});
  let sends = 0, reads = 0;
  const rpc: TransportRpc = {signatureStatus: async () => { reads++; return null; }, finalizedReceipt: async () => null,
    finalizedBlockHeight: async () => 0, sendRawTransaction: async () => { sends++; throw Error('send forbidden'); }};
  assert.equal((await readOnlyRecovery(attempt, rpc)).state, 'pending'); assert.equal(sends, 0);
  const tx = VersionedTransaction.deserialize(Buffer.from(attempt.wireHex, 'hex'));
  const finalized = {...rpc, finalizedReceipt: async () => ({message: tx.message.serialize(), signature: attempt.signature, err: null, slot: 101})};
  assert.deepEqual(await readOnlyRecovery(attempt, finalized), {state: 'finalized', slot: 101});
  assert.equal((await readOnlyRecovery(attempt, {...finalized, finalizedReceipt: async () => ({message: new Uint8Array([1]), signature: attempt.signature, err: null, slot: 101})})).state, 'unknown');
  const corrupt = Buffer.from(attempt.wireHex, 'hex'); corrupt[corrupt.length - 1] ^= 1;
  const before = reads;
  await assert.rejects(readOnlyRecovery({...attempt, wireHex: corrupt.toString('hex')}, rpc));
  assert.equal(reads, before); assert.equal(sends, 0);
});

test('CLI refuses an evidence file as output without touching it or needing RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'i10-collector-guard-'));
  try {
    const evidence = join(directory, 'escape-ready.json');
    await writeFile(evidence, 'offline-evidence-canary');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./verify_i10_devnet_challenge.ts', import.meta.url)),
      '--run', directory, '--challenger', join(directory, 'daemon'), '--deployment', join(directory, 'deployment'),
      '--output', evidence], {env: {}, timeout: 10_000, encoding: 'utf8'});
    assert.equal(child.status, 1); assert.equal(await readFile(evidence, 'utf8'), 'offline-evidence-canary');
    assert.ok(!child.stderr.includes('offline-evidence-canary'));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

const mib = 1024 * 1024;
function paddedJson(text: string, length: number): Buffer {
  const bytes = Buffer.from(text);
  assert.ok(bytes.length <= length);
  const result = Buffer.alloc(length, 0x20); bytes.copy(result); return result;
}

test('only a local journal can exceed 1 MiB; exact metadata boundary and strict parsing remain', () => {
  const exact = paddedJson('{"version":1}', mib);
  const over = paddedJson('{"version":1}', mib + 1);
  const names = ['observation', 'ready', 'config', 'identity', 'launcher', 'manifest', 'deployment', 'unknown'];
  for (const name of names) {
    assert.equal((parseCollectorInput(name, exact) as {version: number}).version, 1);
    assert.throws(() => parseCollectorInput(name, over), /JSON size/);
  }
  assert.equal((parseStrictJson(exact) as {version: number}).version, 1);
  assert.throws(() => parseStrictJson(over), /JSON size/);
  assert.equal((parseCollectorInput('journal', over) as {version: number}).version, 1);
  assert.throws(() => parseCollectorInput('journal', paddedJson('{"version":1,"version":2}', mib + 1)), /duplicate JSON key/);
  assert.throws(() => parseCollectorInput('journal', paddedJson('{"version":1} false', mib + 1)), /trailing JSON data/);
});

test('large synthetic archived instruction data keeps its exact bytes through journal parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'i10-collector-large-'));
  try {
    const payload = '1'.repeat(mib) + '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const encoded = Buffer.from(JSON.stringify({digest: [1, 2, 3], state: {version: 1,
      archive: [{slot: 123, instructions: [{data: payload}]}]}}));
    assert.ok(encoded.length > mib);
    const path = join(directory, 'synthetic-journal.json');
    await writeFile(path, encoded);
    const raw = await readCollectorInput('journal', path);
    assert.ok(raw.equals(encoded));
    const parsed = parseCollectorInput('journal', raw) as {state: {version: number; archive: {slot: number; instructions: {data: string}[]}[]}};
    assert.equal(parsed.state.version, 1); assert.equal(parsed.state.archive[0].slot, 123);
    assert.equal(parsed.state.archive[0].instructions[0].data, payload);
    await assert.rejects(readCollectorInput('manifest', path), /bounded regular collector input required/);
    assert.throws(() => parseStrictJson(raw), /JSON size/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('file reader rejects over-bound sparse archives and nonregular inputs before reading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'i10-collector-bound-'));
  try {
    const path = join(directory, 'synthetic.json'), alias = join(directory, 'alias.json');
    const exact = paddedJson('{}', mib);
    await writeFile(path, exact);
    assert.ok((await readCollectorInput('manifest', path)).equals(exact));
    await truncate(path, mib + 1);
    await assert.rejects(readCollectorInput('manifest', path), /bounded regular collector input required/);
    await symlink(path, alias);
    await assert.rejects(readCollectorInput('journal', alias), /bounded regular collector input required/);
    await assert.rejects(readCollectorInput('journal', directory), /bounded regular collector input required/);
    // Sparse extension tests the actual 512 MiB stat bound without allocating
    // or parsing that amount of memory. No live journal is accessed.
    await truncate(path, 512 * mib + 1);
    await assert.rejects(readCollectorInput('journal', path), /bounded regular collector input required/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

async function canonicalChallengeTree() {
  const contract = JSON.parse(await readFile(new URL('../docs/contracts/tree-transition.json', import.meta.url), 'utf8')) as {
    public_inputs: {name: string; index: number}[]; tree_update: {bytes: number};
    instructions: {name: string; tree_op: number | null; payload_bytes: number}[];
  };
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/vault/a-with-b.json', import.meta.url), 'utf8')) as {
    id: number; auth: {request: PublicProof}; trees: PublicProof[];
  };
  const index = Object.fromEntries(contract.public_inputs.map(input => [input.name, input.index]));
  const transition = fixture.trees[2], operation = contract.instructions.find(instruction => instruction.name === 'challenge_escape')!;
  const payload = encodeLayout2Args({operation: 'challenge_escape', noteId: fixture.id, auth: fixture.auth.request, tree: transition});
  assert.equal(payload.length, operation.payload_bytes); assert.equal(contract.tree_update.bytes, 608);
  assert.deepEqual([index.vault_binding, index.old_root, index.new_root, index.note_id, index.op], [0, 1, 2, 3, 9]);
  assert.equal(BigInt(transition.public_inputs[index.op]), BigInt(operation.tree_op!));
  const expected = {vaultBinding: transition.public_inputs[index.vault_binding], noteId: fixture.id,
    oldRoot: transition.public_inputs[index.old_root], newRoot: transition.public_inputs[index.new_root]};
  return {tree: Buffer.from(payload.slice(-contract.tree_update.bytes)), expected, index};
}

test('canonical real-fixture challenge tree binds vault at field 0 and operation at field 9', async () => {
  const {tree, expected} = await canonicalChallengeTree();
  assert.notEqual(expected.vaultBinding, field(2), 'fixture must expose the old field-0-as-op bug');
  verifyChallengeTree(tree, expected);
  assert.throws(() => verifyChallengeTree(tree.subarray(0, tree.length - 1), expected), /TreeUpdate length/);
  assert.throws(() => verifyChallengeTree(Buffer.concat([tree, Buffer.from([0])]), expected), /TreeUpdate length/);
});

test('tree join rejects altered vault, operation, note and roots including the former field-0-as-op layout', async () => {
  const {tree, expected, index} = await canonicalChallengeTree();
  for (const [name, replacement] of [
    ['vault_binding', field(2)], ['old_root', field(17)], ['new_root', field(19)],
    ['note_id', field(expected.noteId + 1)], ['op', field(0)], ['op', field(1)], ['op', field(3)],
  ] as const) {
    const changed = Buffer.from(tree); changed.set(parseField(replacement), index[name] * 32);
    assert.throws(() => verifyChallengeTree(changed, expected), name);
  }
  const swapped = Buffer.from(tree);
  swapped.set(tree.subarray(index.op * 32, (index.op + 1) * 32), index.vault_binding * 32);
  swapped.set(tree.subarray(index.vault_binding * 32, (index.vault_binding + 1) * 32), index.op * 32);
  assert.throws(() => verifyChallengeTree(swapped, expected));
  for (const changed of [{...expected, vaultBinding: field(2)}, {...expected, noteId: expected.noteId + 1},
    {...expected, oldRoot: expected.newRoot}, {...expected, newRoot: expected.oldRoot}]) {
    assert.throws(() => verifyChallengeTree(tree, changed));
  }
});
