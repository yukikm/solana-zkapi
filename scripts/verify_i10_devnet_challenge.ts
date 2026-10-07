/** Read-only public evidence join. No wallet/private key or prover is opened.
 * Native status validates the stopped journal; I04 validates every exact signed
 * attempt with resend disabled. Output is an explicit public allowlist. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, realpath, rename, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createSolanaRpc} from '@solana/kit';
import {parseAddress,addressBytes,getFinalizedTransaction,getFinalizedBlock,decodeTransaction} from './solana-kit.ts';
import {encodeTransaction,transactionMessage,transactionSignature} from '../packages/sdk/src/solana.ts';
import bs58 from 'bs58';
import {parseField} from '../packages/sdk/src/encoding.ts';
import {concat, u32} from '../packages/sdk/src/layout2.ts';
import {connectionTransport, recoverAttempt, restorePlan, verifySignatures, type Attempt, type TransportRpc} from '../packages/sdk/src/transport.ts';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';
import type {DevnetChallengeReport, EscapeReady} from './i10_devnet_challenge.ts';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inputByteLimit = (name: string) => name === 'journal' ? 512 * 1024 * 1024 : 1024 * 1024;
/** Only the native durable archive receives a larger, explicit local-file bound.
 * Network manifests, transcripts and all other collector inputs retain 1 MiB. */
export function parseCollectorInput(name: string, value: Uint8Array) {
  return parseStrictJson(value, inputByteLimit(name));
}
export async function readCollectorInput(name: string, path: string): Promise<Buffer> {
  const info = await lstat(path);
  assert.ok(info.isFile() && info.size <= inputByteLimit(name), 'bounded regular collector input required');
  const value = await readFile(path);
  assert.ok(value.length <= inputByteLimit(name), 'collector input grew beyond bound');
  return value;
}
const obj = (value: unknown): Record<string, any> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, any>;
};
function bytes(value: unknown, length?: number): Buffer {
  assert.ok(Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'invalid byte array');
  const result = Buffer.from(value); if (length !== undefined) assert.equal(result.length, length);
  return result;
}
function integer(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'unsafe integer');
  return value;
}
function sameBytes(left: Uint8Array, right: Uint8Array): void {
  assert.ok(Buffer.from(left).equals(Buffer.from(right)), 'public byte binding mismatch');
}

/** The send override is defense in depth: the SDK call also receives false. */
export async function readOnlyRecovery(attempt: Attempt, rpc: TransportRpc) {
  return recoverAttempt(attempt, {...rpc, sendRawTransaction: async () => {
    throw Error('collector transaction sends are prohibited');
  }}, false);
}

export interface ChallengeEventBinding {
  program: string; pool: string; noteId: number; nullifier: string; sequence: string;
  oldRoot: string; newRoot: string; deadline: string;
  operation?: 2 | 3; status?: 1 | 2;
}
/** Match the Borsh event only inside the actual pinned Vault invocation. */
export function verifyChallengeEvent(logs: readonly string[], binding: ChallengeEventBinding): void {
  const stack: string[] = [];
  const discriminator = Buffer.from(sha('event:VaultTransitionV1').slice(0, 16), 'hex');
  let matched = 0;
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { assert.equal(Number(invoke[2]), stack.length + 1); stack.push(invoke[1]); continue; }
    const finish = /^Program (\S+) (success|failed:.*)$/.exec(line);
    if (finish) { assert.equal(stack.pop(), finish[1]); continue; }
    if (stack.at(-1) !== binding.program || !line.startsWith('Program data: ')) continue;
    for (const encoded of line.slice('Program data: '.length).split(' ')) {
      const data = Buffer.from(encoded, 'base64');
      assert.equal(data.toString('base64'), encoded, 'event base64');
      if (!data.subarray(0, 8).equals(discriminator)) continue;
      assert.equal(data.length, 251); assert.equal(data[8], 1);
      sameBytes(data.subarray(9, 41), addressBytes(parseAddress(binding.pool)));
      assert.equal(data.readBigUInt64LE(41).toString(), binding.sequence);
      assert.equal(data[49], binding.operation ?? 3); assert.equal(data.readUInt32LE(50), binding.noteId); assert.equal(data[54], binding.status ?? 1);
      sameBytes(data.subarray(55, 87), parseField(binding.oldRoot));
      sameBytes(data.subarray(87, 119), parseField(binding.newRoot));
      assert.equal(data[167], 1); sameBytes(data.subarray(168, 200), parseField(binding.nullifier));
      assert.equal(data[200], 1); assert.equal(data[209], 1); assert.equal(data[242], 1);
      assert.equal(data.readBigUInt64LE(243).toString(), binding.deadline);
      matched++;
    }
  }
  assert.equal(stack.length, 0); assert.equal(matched, 1, 'exactly one pinned Vault challenge event required');
}

export interface ChallengeTreeBinding {
  vaultBinding: string; noteId: number; oldRoot: string; newRoot: string;
}
/** Layout-2 TreeUpdate: 11 canonical fields followed by a 256-byte proof.
 * The pinned Vault receipt verifies the proof; this checks the collector's
 * identity/root join against the canonical tree-transition field order. */
export function verifyChallengeTree(treeBytes: Uint8Array, binding: ChallengeTreeBinding): void {
  assert.equal(treeBytes.length, 608, 'exact TreeUpdate length required');
  const tree = Buffer.from(treeBytes);
  assert.ok(Number.isSafeInteger(binding.noteId) && binding.noteId >= 0 && binding.noteId <= 0xffffffff);
  sameBytes(tree.subarray(0, 32), parseField(binding.vaultBinding));
  sameBytes(tree.subarray(32, 64), parseField(binding.oldRoot));
  sameBytes(tree.subarray(64, 96), parseField(binding.newRoot));
  assert.equal(BigInt('0x' + tree.subarray(96, 128).toString('hex')), BigInt(binding.noteId));
  assert.equal(BigInt('0x' + tree.subarray(9 * 32, 10 * 32).toString('hex')), 2n);
}

export interface CollectorPaths {run: string; challenger: string; deployment: string; output: string; binary: string}
function inputFiles(p: CollectorPaths) {
  return {observation: resolve(p.run, 'challenge-observation.json'), ready: resolve(p.run, 'escape-ready.json'),
    journal: resolve(p.challenger, 'journal/journal.json'), config: resolve(p.challenger, 'config.json'),
    identity: resolve(p.challenger, 'identity.json'), launcher: resolve(p.challenger, 'runtime-report.json'),
    manifest: resolve(p.deployment, 'public-manifest.json'), deployment: resolve(p.deployment, 'deployment.json')};
}
function paths(argv: string[]): CollectorPaths {
  const allowed = new Set(['run', 'challenger', 'deployment', 'output', 'binary']);
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    assert.ok(argv[i].startsWith('--') && allowed.has(name) && argv[i + 1] && !options.has(name), 'explicit unique collector paths required');
    options.set(name, resolve(argv[i + 1]));
  }
  for (const name of ['run', 'challenger', 'deployment', 'output']) assert.ok(options.has(name), 'missing collector path');
  return {run: options.get('run')!, challenger: options.get('challenger')!, deployment: options.get('deployment')!,
    output: options.get('output')!, binary: options.get('binary') ?? resolve('services/challenger/target/debug/challengerd')};
}
async function durable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function collectDevnetChallenge(p: CollectorPaths, endpoint: string): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'explicit HTTPS RPC required');
  const connection = createSolanaRpc(endpoint);
  assert.equal(await connection.getGenesisHash().send(), GENESIS, 'devnet required before evidence/config access');
  const source = await readFile(new URL(import.meta.url));
  const files = inputFiles(p);
  assert.ok(!Object.values(files).includes(resolve(p.output)), 'output cannot overwrite input evidence');
  const raw = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await readCollectorInput(name, path)]))) as Record<keyof typeof files, Buffer>;
  const parsed = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, obj(parseCollectorInput(name, new Uint8Array(value)))]));
  const observation = parsed.observation as DevnetChallengeReport;
  const ready = parsed.ready as EscapeReady;
  const manifest = parsed.manifest, deployment = parsed.deployment, identity = parsed.identity;
  assert.equal(manifest.deployment_environment, 'devnet'); assert.equal(manifest.setup_profile, 'test_only');
  assert.equal(manifest.genesis_hash, GENESIS); assert.equal(manifest.mint, MINT); assert.equal(manifest.challenge_seconds, '600');
  for (const key of ['pool', 'program_id', 'mint', 'token_program']) assert.equal(manifest[key], deployment[key]);
  assert.equal(parsed.config.manifest, files.manifest); assert.equal(parsed.config.manifest_sha256, manifest.manifest_hash);
  assert.equal(parsed.config.journal_directory, dirname(files.journal));
  assert.equal(identity.backend_identity.manifest_hash, manifest.manifest_hash);
  assert.equal(identity.backend_identity.pool, manifest.pool);
  assert.equal(identity.payer, parsed.config.payer);
  assert.ok(['prepared', 'stopped'].includes(parsed.launcher.status) && parsed.launcher.clean_shutdown === true, 'stop native daemon before collecting');
  assert.equal(observation.passed, true); assert.equal(observation.pool, manifest.pool); assert.equal(ready.pool, manifest.pool);
  assert.equal(observation.note_id, ready.note_id); integer(ready.note_id);
  assert.equal(observation.request_id, ready.request_id); assert.equal(observation.proof_nullifier, ready.nullifier);
  assert.equal(observation.escape_signature, ready.escape_signature); assert.equal(observation.escape_slot, ready.escape_slot);
  assert.equal(observation.escape_deadline, ready.deadline); assert.equal(observation.historical_request_root, ready.historical_request_root);
  assert.equal(observation.escaped_root, ready.escaped_root); assert.equal(observation.escaped_sequence, ready.escaped_sequence);
  assert.equal(observation.restored_root, ready.historical_request_root);
  assert.equal(BigInt(observation.restored_sequence), BigInt(ready.escaped_sequence) + 1n);
  for (const key of ['signed_successor_verified', 'old_authorization_retained', 'stale_sdk_pending_escape', 'note_active', 'pending_cleared', 'exit_nullifier_consumed'] as const) assert.equal(observation[key], true);
  assert.equal(observation.charge_micro_usdc, '0'); assert.equal(observation.inference_operations, 0);
  assert.ok(Array.isArray(observation.receipt_ids) && observation.receipt_ids.every(id =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)), 'public receipt IDs required');
  assert.equal(observation.challenge_sent_by_helper, false); assert.equal(ready.external_challenger_may_start, true);

  // Native status reuses existing checksum, archive, job and transport semantics;
  // it performs no RPC, proving, signing, recovery or fee-key read.
  const binaryHash = sha(await readFile(p.binary));
  assert.equal(binaryHash, parsed.launcher.binary_sha256);
  const status = await promisify(execFile)(p.binary, ['status', files.config],
    {cwd: resolve('.'), env: {}, timeout: 120_000, maxBuffer: 131_072, killSignal: 'SIGKILL'});
  const metrics = obj(parseStrictJson(new TextEncoder().encode(status.stdout)));
  assert.equal(metrics.pending_jobs, 0); assert.equal(metrics.unknown_signatures, 0); assert.equal(metrics.complete_jobs, 1);
  sameBytes(await readFile(files.journal), raw.journal);
  assert.equal(sha(await readFile(p.binary)), binaryHash);
  const state = obj(parsed.journal.state);
  assert.equal(state.version, 1); sameBytes(bytes(state.pool, 32), addressBytes(parseAddress(manifest.pool)));
  const jobs = Object.entries(obj(state.jobs)); assert.equal(jobs.length, 1, 'dedicated one-job challenge acceptance required');
  const [jobId, jobValue] = jobs[0], job = obj(jobValue), jobIdentity = obj(job.identity), evidence = obj(job.evidence);
  assert.equal(job.complete, true); assert.equal(jobIdentity.note_id, ready.note_id);
  const detectedAt = integer(job.discovered_at), firstExecuteSendAt = integer(job.first_execute_send_at);
  assert.ok(firstExecuteSendAt >= detectedAt && firstExecuteSendAt <= integer(jobIdentity.deadline));
  sameBytes(bytes(jobIdentity.pool, 32), addressBytes(parseAddress(manifest.pool)));
  sameBytes(bytes(jobIdentity.nullifier, 32), parseField(ready.nullifier));
  assert.equal(integer(jobIdentity.deadline).toString(), ready.deadline);
  assert.equal(jobIdentity.generation.position.signature, ready.escape_signature);
  assert.equal(jobIdentity.generation.position.slot, ready.escape_slot);
  assert.equal(integer(jobIdentity.generation.tree_sequence).toString(), ready.escaped_sequence);
  const escape = await getFinalizedTransaction(connection,ready.escape_signature);
  assert.ok(escape?.meta && escape.meta.err === null); assert.equal(escape.slot, ready.escape_slot);
  const escapeWire = escape.transaction;
  await verifySignatures(escapeWire); assert.equal(transactionMessage(escapeWire).version, 0);
  assert.equal(transactionSignature(escape.transaction), ready.escape_signature);
  assert.equal(transactionMessage(escapeWire).staticAccounts[0], deployment.initializer);
  assert.ok(encodeTransaction(escapeWire).length <= 1232 && integer(escape.meta.fee) <= 10_000);
  const escapeCu = integer(escape.meta.computeUnitsConsumed); assert.ok(escapeCu > 0 && escapeCu <= 1_000_000);
  assert.ok(Array.isArray(escape.meta.logMessages));
  verifyChallengeEvent(escape.meta.logMessages, {program: manifest.program_id, pool: manifest.pool,
    noteId: ready.note_id, nullifier: ready.nullifier, sequence: ready.escaped_sequence,
    oldRoot: ready.historical_request_root, newRoot: ready.escaped_root, deadline: ready.deadline, operation: 2, status: 2});
  const escapeBlock = await getFinalizedBlock(connection,ready.escape_slot);
  assert.ok(escapeBlock); assert.equal(escapeBlock.blockhash, parseAddress(bytes(jobIdentity.generation.blockhash, 32)));
  assert.equal(evidence.request_id, ready.request_id);
  sameBytes(bytes(evidence.pool, 32), bytes(jobIdentity.pool, 32));
  sameBytes(bytes(evidence.nullifier, 32), bytes(jobIdentity.nullifier, 32));
  const transcript = bytes(evidence.transcript);
  assert.equal(sha(transcript), bytes(evidence.transcript_digest, 32).toString('hex'));
  const authorization = obj(parseStrictJson(transcript));
  assert.equal(authorization.authorization.request_id, ready.request_id);
  assert.equal(authorization.authorization.pool, manifest.pool);
  assert.equal(authorization.authorization.deployment_id, manifest.deployment_id);
  assert.equal(authorization.authorization.mode, 'proxy');
  assert.equal(authorization.public_inputs.length, 12);
  assert.equal(authorization.public_inputs[8], ready.nullifier); assert.equal(authorization.public_inputs[3], ready.historical_request_root);
  assert.equal(authorization.proof.backend, 'groth16_bn254');
  const proof = Buffer.from(authorization.proof.proof, 'base64');
  assert.equal(proof.length, 256); assert.equal(proof.toString('base64'), authorization.proof.proof);
  const prefix = Buffer.from(concat(u32(ready.note_id), ...authorization.public_inputs.map(parseField), proof));
  assert.ok(Array.isArray(job.payloads) && job.payloads.length === 1, 'this acceptance requires one unchanged challenge proof');
  const payload = obj(job.payloads[0]), payloadBytes = bytes(payload.bytes, 1252);
  assert.equal(sha(payloadBytes), bytes(payload.digest, 32).toString('hex'));
  sameBytes(payloadBytes.subarray(0, prefix.length), prefix);
  const tree = payloadBytes.subarray(prefix.length);
  verifyChallengeTree(tree, {vaultBinding: manifest.vault_binding, noteId: ready.note_id,
    oldRoot: ready.escaped_root, newRoot: ready.historical_request_root});
  assert.equal(integer(payload.checkpoint.tree_sequence).toString(), ready.escaped_sequence);
  assert.ok(Array.isArray(job.attempts) && job.attempts.length > 0);
  const attempts = job.attempts.map(obj);
  assert.equal(attempts.filter((a: Record<string, any>) => a.stage === 'Execute').length, 1);
  const transport = obj(state.transport);
  assert.equal(Object.keys(transport).length, attempts.length);
  const signatures = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const rpc = connectionTransport(connection);
  let executeSlot = -1, executeSignature = '';
  for (const [index, saved] of attempts.entries()) {
    assert.ok(typeof saved.signature === 'string' && !signatures.has(saved.signature)); signatures.add(saved.signature);
    const outcome = obj(saved.outcome);
    assert.deepEqual(Object.keys(outcome), ['FinalizedSuccess'], 'incomplete/rejected/reconciled attempt is not this acceptance');
    const finalized = obj(outcome.FinalizedSuccess), slot = integer(finalized.slot);
    const attempt = obj(transport[saved.signature]) as Attempt & {stepIndex: number};
    assert.equal(attempt.stepIndex, index);
    if (index === 0) assert.equal((await restorePlan(attempt.plan)).steps.length, attempts.length);
    assert.equal(attempt.signature, saved.signature);
    sameBytes(Buffer.from(attempt.wireHex, 'hex'), bytes(saved.signed_bytes));
    assert.equal(attempt.planDigest, bytes(saved.payload_digest, 32).toString('hex'));
    assert.equal(attempt.planDigest, bytes(payload.digest, 32).toString('hex'));
    assert.equal(attempt.buffer, parseAddress(bytes(saved.buffer, 32)));
    sameBytes(bytes(saved.buffer, 32), bytes(payload.buffer, 32));
    assert.equal(attempt.plan.operation, 'challenge_escape'); assert.equal(attempt.plan.programId, manifest.program_id);
    assert.equal(attempt.plan.pool, manifest.pool); assert.equal(attempt.plan.expectedNoteId, ready.note_id);
    assert.equal('0x' + attempt.plan.expectedRoot, ready.escaped_root);
    assert.equal(attempt.plan.snapshotSequence, ready.escaped_sequence);
    assert.equal(attempt.plan.payloadHex, payloadBytes.toString('hex'));
    assert.equal(attempt.plan.feePayer, identity.payer);
    assert.equal(attempt.plan.priorityFeeMicroLamports ?? '0', '0');
    const wire = Buffer.from(attempt.wireHex, 'hex'), tx = decodeTransaction(wire);
    assert.ok(wire.length <= 1232); assert.equal(transactionMessage(tx).version, 0);
    assert.equal(transactionMessage(tx).staticAccounts[0], identity.payer);
    assert.equal(transactionMessage(tx).header.numSignerAccounts, 1);
    const recovered = await readOnlyRecovery(attempt, rpc);
    assert.equal(recovered.state, 'finalized'); assert.ok(recovered.state === 'finalized'); assert.equal(recovered.slot, slot);
    const transaction = await getFinalizedTransaction(connection,attempt.signature);
    assert.ok(transaction?.meta && transaction.meta.err === null); assert.equal(transaction.slot, slot);
    sameBytes(new Uint8Array(transaction.transaction.messageBytes), new Uint8Array(tx.messageBytes));
    const fee = integer(transaction.meta.fee), cu = integer(transaction.meta.computeUnitsConsumed);
    assert.ok(fee <= 10_000 && cu > 0 && cu <= 1_000_000);
    const block = await getFinalizedBlock(connection,slot);
    assert.ok(block); assert.equal(block.blockhash, parseAddress(bytes(finalized.blockhash, 32)));
    if (saved.stage === 'Execute') {
      assert.equal(attempt.kind, 'execute'); executeSlot = slot; executeSignature = attempt.signature;
      assert.ok(Array.isArray(transaction.meta.logMessages));
      verifyChallengeEvent(transaction.meta.logMessages, {program: manifest.program_id, pool: manifest.pool,
        noteId: ready.note_id, nullifier: ready.nullifier, sequence: observation.restored_sequence,
        oldRoot: ready.escaped_root, newRoot: ready.historical_request_root, deadline: ready.deadline});
    } else { assert.equal(saved.stage, 'Upload'); assert.ok(['create', 'append', 'seal'].includes(attempt.kind)); }
    rows.push({signature: attempt.signature, kind: attempt.kind, step_index: integer(attempt.stepIndex),
      slot, blockhash: block.blockhash, wire_sha256: sha(wire), wire_bytes: wire.length,
      fee_lamports: String(fee), compute_units: cu, finalized: true});
  }
  assert.ok(executeSlot >= ready.escape_slot && executeSlot <= integer(observation.restored_slot));
  assert.ok(integer(observation.exit_nullifier_observed_slot) >= observation.restored_slot);
  sameBytes(await readFile(files.journal), raw.journal);
  for (const [name, path] of Object.entries(files)) sameBytes(await readFile(path), raw[name as keyof typeof files]);
  sameBytes(await readFile(new URL(import.meta.url)), source);
  return {passed: true, schema: 1, scope: 'Public devnet finalized native challenger receipt and exact archived AUTH/root transition joined to SDK stale-escape observation; no real inference',
    verified_at_utc: new Date().toISOString(), genesis: GENESIS, program_id: manifest.program_id, pool: manifest.pool,
    manifest_hash: manifest.manifest_hash, payer: identity.payer, job_id: jobId, note_id: ready.note_id,
    request_id: ready.request_id, proof_nullifier: ready.nullifier, receipt_ids: observation.receipt_ids,
    charge_micro_usdc: '0', inference_operations: 0, native_status_validated: true, journal_unchanged: true,
    archived_authorization_sha256: sha(transcript), exact_authorization_payload_prefix_verified: true,
    exact_wire_and_signatures_verified: true, challenge_event_verified: true,
    escape_signature: ready.escape_signature, escape_slot: ready.escape_slot,
    escape_receipt: {slot: escape.slot, fee_lamports: String(escape.meta.fee), compute_units: escapeCu,
      wire_sha256: sha(encodeTransaction(escapeWire)), wire_bytes: encodeTransaction(escapeWire).length, event_verified: true},
    challenge_signature: executeSignature, challenge_slot: executeSlot,
    escaped_root: ready.escaped_root, restored_root: observation.restored_root,
    escaped_sequence: ready.escaped_sequence, restored_sequence: observation.restored_sequence,
    restored_note_observed_slot: observation.restored_slot, pending_cleared: true,
    persistent_exit_nullifier_observed_slot: observation.exit_nullifier_observed_slot,
    rows, unique_signed_attempts: rows.length, retransmission_count: null,
    retransmission_count_scope: 'Native journal records signed attempts and first execute send time, not every identical-byte retransmission',
    detected_at_unix_seconds: detectedAt, first_execute_send_at_unix_seconds: firstExecuteSendAt,
    detection_to_first_execute_send_seconds: firstExecuteSendAt - detectedAt,
    timing_scope: 'One dedicated devnet job; first execute send time is not finalized observation time or a production SLO',
    proof_regenerations: 0, proof_failure_total: integer(state.proof_failure_total ?? 0),
    collector_transactions_sent: 0, fee_key_read: false, live_provider_verified: false, release_gates_passed: [],
    native_binary_sha256: binaryHash, input_sha256: Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, sha(value)])),
    source_sha256: sha(source)};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let output: string | undefined;
  try {
    const p = paths(process.argv.slice(2));
    assert.ok(![p.run, p.challenger, p.deployment, p.binary, ...Object.values(inputFiles(p))].includes(p.output), 'output cannot replace evidence');
    try {
      assert.ok((await lstat(p.output)).isFile(), 'output must be a regular file');
      const actualOutput = await realpath(p.output);
      for (const input of [p.binary, ...Object.values(inputFiles(p))]) {
        let actualInput: string;
        try { actualInput = await realpath(input); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        assert.notEqual(actualOutput, actualInput, 'output cannot alias evidence');
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    output = p.output;
    const endpoint = process.env.SOLANA_DEVNET_RPC; assert.ok(endpoint, 'SOLANA_DEVNET_RPC required');
    const report = await collectDevnetChallenge(p, endpoint);
    await durable(output, report);
    console.log(JSON.stringify({passed: true, public_report: output, collector_transactions_sent: 0}));
  } catch {
    if (output) await durable(output, {passed: false, scope: 'Read-only challenge evidence verification incomplete; private inputs suppressed', collector_transactions_sent: 0, release_gates_passed: []});
    console.error('challenge evidence verification failed; no transaction was sent'); process.exitCode = 1;
  }
}
