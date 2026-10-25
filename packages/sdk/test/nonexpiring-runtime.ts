/** Explicit real native/WASM proof regression with public fixture keys only.
 * Requires built runtimes and local test PKs; no RPC, custody or provider calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeProver } from '../src/prover-node.ts';
import { WasmProver } from '../src/prover-runtime.ts';
import type { PrivateState } from '../src/control.ts';
import type { PrivateWitness } from '../src/prover.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const expiry = '18446744073709551615';
const field = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

test('rebuilt native and WASM preserve canonical MAX expiry and generate valid request, escape and tree proofs', { timeout: 180_000 }, async t => {
  const binary = resolve(process.env.ZKAPI_TEST_NATIVE_PROVER ?? 'apps/clientd/prover/target/release/zkapi-client-prover');
  const wasmBytes = await readFile(resolve(process.env.ZKAPI_TEST_WASM_PROVER ?? 'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm'));
  const engines = { native: new NativeProver(binary, hash(await readFile(binary))), wasm: await WasmProver.create(wasmBytes, hash(wasmBytes)) };
  const fixtureText = await readFile(resolve('tests/fixtures/vault/nonexpiring-a.json'), 'utf8');
  // The Rust fixture JSON uses a u64 number. Never round that integer through a JS number.
  assert.match(fixtureText, /"expiry":\s*18446744073709551615\s*,/);
  const f = JSON.parse(fixtureText), p = f.auth.escape.public_inputs;
  const context = { vault_binding: p[2], state_key: [p[4], p[5]], clearance_key: [p[6], p[7]] };
  const witness = { secret: field(42n), note_id: 0, deposit_micro_usdc: '5000000', expiry };
  const pathCommand = { kind: 'snapshot_path', root: f.auth.request.public_inputs[3], next_note_id: '1', note_id: 0,
    active_notes: [{ note_id: '0', commitment: '0x' + f.commitment, deposit_micro_usdc: witness.deposit_micro_usdc, expiry }] };
  const key = async (name: string) => {
    const pk = await readFile(resolve(name === 'tree' ? 'target/i03/test-tree.pk' : `vendor/ethereum-zkapi/protocol/setup/v2/${name}.pk`));
    const vk = await readFile(resolve(name === 'tree' ? 'tests/fixtures/layout2/test-tree.vk' : `vendor/ethereum-zkapi/protocol/setup/v2/${name}.vk`));
    return { bytes_base64: pk.toString('base64'), pk_sha256: hash(pk), vk_sha256: hash(vk) };
  };
  const keys = { request: await key('request'), withdrawal: await key('withdrawal'), tree: await key('tree') };
  for (const [name, engine] of Object.entries(engines)) {
    const created = await engine.run({ kind: 'rebase_deposit', witness, note_id: 0, expiry }) as { witness: PrivateWitness; state: PrivateState; registration_commitment: string };
    assert.deepEqual(created.witness, witness); assert.equal(created.registration_commitment, '0x' + f.commitment);
    const path = await engine.run(pathCommand) as { root: string; siblings: string[] };
    assert.equal(path.root, pathCommand.root); assert.equal(path.siblings.length, 32);
    const common = { context, witness: created.witness, state: created.state, root: path.root, siblings: path.siblings };
    await engine.run({ kind: 'inspect', context, witness: created.witness, state: created.state });
    await assert.rejects(engine.run({ kind: 'inspect', context, witness: { ...created.witness, expiry: '1' }, state: created.state }));
    const request = await engine.run({ kind: 'request', ...common, request_time: expiry, cap: '1000000', key: keys.request,
      authorization: { version: '1', deployment_id: 'synthetic-nonexpiring-runtime', pool: 'synthetic-pool', request_id: '12345678-1234-4123-8123-123456789012',
        quote_hash: '00'.repeat(32), mode: 'proxy', control_secret_hash: '11'.repeat(32), proxy_secret_hash: '22'.repeat(32) } }) as { auth: { public_inputs: string[]; proof_wire_hex: string } };
    assert.equal(request.auth.public_inputs[3], path.root); assert.equal(request.auth.public_inputs[6], field(BigInt(expiry)));
    assert.match(request.auth.proof_wire_hex, /^[0-9a-f]{512}$/);
    const escape = await engine.run({ kind: 'withdrawal', ...common, destination_owner_hex: '07'.repeat(32), clearance: null, mutual: false, key: keys.withdrawal }) as { public_inputs: string[]; proof_wire_hex: string };
    assert.equal(escape.public_inputs[3], path.root); assert.equal(escape.public_inputs[9], field(5000000n)); assert.equal(escape.public_inputs[12], field(0n));
    const tree = await engine.run({ kind: 'tree', context, note: { note_id: 0, registration_commitment: created.registration_commitment,
      deposit_micro_usdc: witness.deposit_micro_usdc, expiry }, root: f.trees[0].public_inputs[1], siblings: path.siblings, op: 0, key: keys.tree }) as { public_inputs: string[]; proof_wire_hex: string };
    assert.deepEqual(tree.public_inputs, f.trees[0].public_inputs);
    t.diagnostic(`${name}: canonical MAX deposit/state/path and locally verified request, escape, tree proofs passed`);
  }
  t.diagnostic(JSON.stringify({ native_sha256: hash(await readFile(binary)), wasm_sha256: hash(wasmBytes), wasm_bytes: wasmBytes.length }));
});
