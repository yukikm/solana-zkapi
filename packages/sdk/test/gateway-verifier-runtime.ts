/** Actual native/WASM agreement on real-proof v3 receipt fixtures; no network calls.
 * Generate first with ZKAPI_GATEWAY_FIXTURE_DIR=target/gateway-native-verifier
 * cargo test --locked --manifest-path apps/clientd/companion/Cargo.toml
 * --test verification finite_http_real_proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { WasmProver } from '../src/prover-runtime.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
test('real native/WASM receipt v3 agreement: metered, unknown and signed identity/arithmetic rejection', async () => {
  const fixturePath = resolve(process.env.ZKAPI_GATEWAY_FIXTURE_DIR ?? 'target/gateway-native-verifier', 'gateway-verifier.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const bytes = await readFile(resolve(process.env.ZKAPI_TEST_WASM_PROVER
    ?? 'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm'));
  const wasm = await WasmProver.create(bytes, hash(bytes));
  assert.deepEqual(await wasm.run({ kind: 'verify', command: fixture.success }), fixture.expected_success);
  assert.deepEqual(await wasm.run({ kind: 'verify', command: fixture.unknown }), fixture.expected_unknown);
  for (const command of fixture.rejected) await assert.rejects(wasm.run({ kind: 'verify', command }));
});
