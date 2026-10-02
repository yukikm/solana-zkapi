import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { frame, h2f, vaultBinding, destinationBinding, parseField, parseScalar, parseMicroUsdc, settleSession,
  MAX_MICRO_USDC, FR_MODULUS, SCALAR_MODULUS, VAULT_LABEL, OPERATION_LABEL } from '../src/encoding.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../docs/contracts/binding-vectors.json', import.meta.url), 'utf8'));
const encoding = JSON.parse(readFileSync(new URL('../../../tests/fixtures/encoding.json', import.meta.url), 'utf8'));

test('the shared Rust/browser binding vectors match byte for byte', async () => {
  for (const v of fixture.vectors) {
    const parts: Uint8Array[] = v.parts_hex.map((s: string) => new Uint8Array(Buffer.from(s, 'hex')));
    const bytes = frame(v.label, parts);
    assert.equal(Buffer.from(bytes).toString('hex'), v.frame_hex);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), v.sha256);
    assert.equal(await h2f(v.label, parts), v.field);
    if (v.label === VAULT_LABEL) {
      assert.equal(parts.length, 6);
      assert.equal(await vaultBinding(parts[0], parts[1], parts[2], parts[3], parts[4]), v.field);
    }
  }
});

test('each Solana identity component changes the binding', async () => {
  const parts = Array.from({ length: 5 }, () => new Uint8Array(32));
  const bind = (p: Uint8Array[]) => vaultBinding(p[0], p[1], p[2], p[3], p[4]);
  const baseline = await bind(parts);
  for (let i = 0; i < 5; i++) {
    const mutated = parts.map(p => p.slice()); mutated[i][31] = 1;
    assert.notEqual(await bind(mutated), baseline);
  }
  assert.notEqual(await destinationBinding(new Uint8Array(32)), await destinationBinding(new Uint8Array(32).fill(1)));
  assert.throws(() => destinationBinding(new Uint8Array(31)));
});

test('integer charges round once per session and respect cap', () => {
  for (const v of fixture.rounding) assert.equal(settleSession(v.nano_values.map(BigInt), MAX_MICRO_USDC).toString(), v.expected_micro);
  assert.equal(settleSession([MAX_MICRO_USDC * 1000n - 1n], MAX_MICRO_USDC), MAX_MICRO_USDC);
  assert.throws(() => settleSession([MAX_MICRO_USDC * 1000n + 1n], MAX_MICRO_USDC));
  assert.throws(() => settleSession([-1n], 1n));
  for (const value of ['01', '-1', '+1', '1.0', '1e3', '9007199254740992', ' 1', '1\n', '1\r\n']) assert.throws(() => parseMicroUsdc(value));
  assert.equal(parseMicroUsdc('9007199254740991'), MAX_MICRO_USDC);
});

test('external fields reject noncanonical values instead of reducing', () => {
  assert.throws(() => parseField('0x' + FR_MODULUS.toString(16)));
  assert.throws(() => parseField('0x0'));
  assert.throws(() => parseField('0x' + 'AB'.repeat(32)));
  assert.throws(() => parseField('0x' + '00'.repeat(32) + '\n'));
  assert.equal(parseField('0x' + '00'.repeat(32)).length, 32);
});

test('Schnorr scalars use the Baby-JubJub bound, independently of Fr', () => {
  assert.equal(BigInt(encoding.scalar_modulus_hex), SCALAR_MODULUS);
  assert.equal(parseField(encoding.scalar_modulus_hex).length, 32);
  assert.throws(() => parseScalar(encoding.scalar_modulus_hex));
  assert.equal(Buffer.from(parseScalar(encoding.scalar_max_hex)).toString('hex'), encoding.scalar_max_hex.slice(2));
  assert.equal(parseScalar('0x' + '00'.repeat(32)).length, 32);
  for (const invalid of ['0x0', encoding.scalar_max_hex.toUpperCase(), encoding.scalar_max_hex + '\n', '0x' + 'ff'.repeat(32)]) {
    assert.throws(() => parseScalar(invalid));
  }
});

test('operation framing binds endpoint, version and exact UTF-8 bytes', async () => {
  const v = encoding.operation_frame;
  const parts: Uint8Array[] = v.parts_hex.map((s: string) => Uint8Array.from(Buffer.from(s, 'hex')));
  const encoded = frame(OPERATION_LABEL, parts);
  assert.equal(Buffer.from(encoded).toString('hex'), v.frame_hex);
  for (let i = 0; i < parts.length; i++) {
    const changed = parts.map(p => p.slice());
    changed[i][0] ^= 1;
    assert.notDeepEqual(frame(OPERATION_LABEL, changed), encoded);
  }
  assert.notDeepEqual(frame(OPERATION_LABEL, [new Uint8Array([1, 2]), new Uint8Array([3])]),
    frame(OPERATION_LABEL, [new Uint8Array([1]), new Uint8Array([2, 3])]));
  // Runtime callers cannot repurpose an operation frame as a field binding.
  // @ts-expect-error operation is intentionally not a BindingLabel
  await assert.rejects(h2f(OPERATION_LABEL, parts));
});
