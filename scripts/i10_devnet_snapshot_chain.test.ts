/** Offline actual SolanaWalletChain/authorizationSnapshot wiring; synthetic
 * accounts and local path prover, never provider or public acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection, PublicKey, SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {SolanaWalletChain} from '../packages/sdk/src/wallet-chain.ts';
import {authorizationSnapshot, type SnapshotPathProver} from '../packages/sdk/src/session-snapshot.ts';
import {discriminator, type UploadPlan} from '../packages/sdk/src/transport.ts';
import {jcsBytes, sha256Hex} from '../packages/sdk/src/trust.ts';
import {chainFixture, key} from '../packages/sdk/test/chain-fixture.ts';
import {boundedDevnetSnapshotChain, snapshotWaitStats} from './i10_devnet_snapshot_chain.ts';

const field = (n: number) => '0x' + BigInt(n).toString(16).padStart(64, '0');
async function fixture() {
  const {manifest, poolData} = await chainFixture(), program = new PublicKey(manifest.program_id), pool = new PublicKey(manifest.pool);
  const [tree, bump] = PublicKey.findProgramAddressSync([Buffer.from('tree'), pool.toBytes()], program);
  const root = {pool: manifest.pool, root: field(1), slot: '100', blockhash: key(8), sequence: '7', next_note_id: '3'};
  const file = {schema_version: '1', snapshot: root, active_notes: [0, 2].map(id => ({note_id: String(id), commitment: field(42 + id), deposit_micro_usdc: '100', expiry: '3000000000'})), pending_withdrawals: []};
  const bytes = jcsBytes(file), digest = await sha256Hex(bytes), urls: string[] = [], rpc: string[][] = [], local: number[] = [];
  const treeData = Buffer.alloc(66); treeData.set(await discriminator('TreeState', 'account')); treeData[8] = 2; treeData[9] = bump;
  treeData.set(Buffer.from(root.root.slice(2), 'hex'), 10); treeData.writeBigUInt64LE(3n, 42); treeData.writeBigUInt64LE(7n, 50);
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(2600n, 32);
  const account = (data: Buffer, owner = manifest.program_id) => ({owner, executable: false, lamports: 1, rentEpoch: 0, data: [data.toString('base64'), 'base64']});
  const state = {unavailable: 1, stall: false, aborted: false, sourceHash: key(8)};
  const fetcher: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    if (state.stall) return await new Promise<Response>((_, reject) => {
      const aborted = () => {state.aborted = true; reject(init!.signal!.reason);};
      if (init?.signal?.aborted) aborted(); else init?.signal?.addEventListener('abort', aborted, {once: true});
    });
    if (String(url).startsWith('http://127.0.0.1:19891')) {
      urls.push(String(url));
      if (state.unavailable-- > 0) return new Response(null, {status: 503});
      if (String(url).endsWith('/snapshot')) return Response.json({snapshot: root, sha256: digest, download_url: 'https://logical.invalid/zkapi/v1/tree/snapshots/' + digest + '.json'});
      assert.equal(new URL(String(url)).pathname, '/zkapi/v1/tree/snapshots/' + digest + '.json');
      return new Response(Buffer.from(bytes));
    }
    const {id, method, params} = JSON.parse(String(init?.body)); let result: unknown;
    if (method === 'getGenesisHash') result = manifest.genesis_hash;
    else if (method === 'getBlock') result = {blockhash: params[0] === 100 ? state.sourceHash : key(9), previousBlockhash: key(7), parentSlot: params[0] - 1, blockHeight: params[0], blockTime: 2600};
    else if (method === 'getMultipleAccounts') {
      rpc.push(params[0]); assert.deepEqual(params[0], [pool, tree, SYSVAR_CLOCK_PUBKEY].map(p => p.toBase58()));
      assert.equal(params[1].minContextSlot, 105);
      result = {context: {slot: 110}, value: [account(poolData), account(treeData), account(clock, 'Sysvar1111111111111111111111111111111111111')]};
    } else throw Error('unexpected RPC');
    return Response.json({jsonrpc: '2.0', id, result});
  };
  const make = (signal?: AbortSignal) => {
    const bounded: typeof fetch = (url, init) => fetcher(url, {...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal});
    return new SolanaWalletChain(new Connection('http://127.0.0.1:19890', {fetch: bounded}), manifest, 'http://127.0.0.1:19891', {fetch: bounded, allowLoopbackHttp: true});
  };
  const prover: SnapshotPathProver = {async snapshotPath(gotRoot, next, notes, noteId) {
    local.push(noteId); assert.equal(gotRoot, root.root); assert.equal(next, '3'); assert.deepEqual(jcsBytes(notes), jcsBytes(file.active_notes));
    return {root: gotRoot, note_id: noteId, siblings: Array(32).fill(field(0))};
  }};
  return {make, prover, urls, rpc, local, state};
}

test('launcher wrapper retries common AUTH reads using actual SDK adapter, same prover and no selected-note fallback', async () => {
  const f = await fixture(), stats = snapshotWaitStats();
  const chain = boundedDevnetSnapshotChain({chain: f.make(), createReadChain: f.make, waitMs: 2000, retryMs: 1, stats});
  const a = await authorizationSnapshot(chain, 0, f.prover, 105), selectors = [...f.urls];
  f.urls.length = 0;
  const b = await authorizationSnapshot(chain, 2, f.prover, 105);
  assert.equal(a.root, b.root); assert.equal(a.clock, '2600'); assert.deepEqual(f.local, [0, 2]);
  assert.deepEqual(selectors.slice(1), f.urls); assert(f.urls.every(url => !url.includes('/notes/')));
  assert.deepEqual(f.rpc[0], f.rpc[1]); assert.equal(stats.retries, 1); assert.equal(stats.calls, 2); assert.equal(stats.timeouts, 0);
});

test('common snapshot deadline aborts actual SDK transport and later calls receive a fresh scope', async () => {
  const f = await fixture(), stats = snapshotWaitStats(); f.state.stall = true;
  const chain = boundedDevnetSnapshotChain({chain: f.make(), createReadChain: f.make, waitMs: 100, retryMs: 1, stats});
  const started = performance.now();
  await assert.rejects(authorizationSnapshot(chain, 0, f.prover, 105), /acceptance wait deadline/);
  assert.equal(f.state.aborted, true); assert(performance.now() - started < 2000); assert.equal(stats.timeouts, 1); assert.equal(f.local.length, 0);
  f.state.stall = false; f.state.unavailable = 0;
  assert.equal((await authorizationSnapshot(chain, 2, f.prover, 105)).clock, '2600'); assert.deepEqual(f.local, [2]);
});

test('missing private membership is terminal and never invokes a selected-note finance read', async () => {
  const f = await fixture(), stats = snapshotWaitStats(); f.state.unavailable = 0;
  const chain = boundedDevnetSnapshotChain({chain: f.make(), createReadChain: f.make, waitMs: 1000, retryMs: 1, stats});
  await assert.rejects(authorizationSnapshot(chain, 1, f.prover, 105), /active snapshot membership/);
  assert.equal(stats.retries, 0); assert.equal(f.local.length, 0); assert.equal(f.urls.length, 2); assert(f.urls.every(url => !url.includes('/notes/')));
});

test('finance recovery methods retain original adapter binding and never enter snapshot retry scope', async () => {
  const f = await fixture(), source = f.make(), calls: string[] = [], plan = {} as UploadPlan;
  source.buffer = async function (p, slot) {assert.equal(this, source); assert.equal(p, plan); assert.equal(slot, 91); calls.push('buffer'); return null;};
  source.bufferObservation = async function (p, slot) {assert.equal(this, source); assert.equal(p, plan); assert.equal(slot, 92); calls.push('observation'); throw Error('saved recovery failure');};
  source.blockhash = async function () {assert.equal(this, source); calls.push('blockhash'); return {blockhash: key(9), lastValidBlockHeight: 9};};
  const stats = snapshotWaitStats(), chain = boundedDevnetSnapshotChain({chain: source, createReadChain() {throw Error('must not create read scope');}, waitMs: 1000, stats});
  assert.equal(await chain.buffer(plan, 91), null); await assert.rejects(chain.bufferObservation(plan, 92), /saved recovery failure/);
  assert.equal((await chain.blockhash()).lastValidBlockHeight, 9); assert.deepEqual(calls, ['buffer', 'observation', 'blockhash']); assert.equal(stats.calls, 0);
});
