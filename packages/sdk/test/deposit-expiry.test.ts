/** Synthetic signed manifest and finalized account observations; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainFixture } from './chain-fixture.ts';
import { verifyPoolConfig, hasNonExpiringDeposits, type VerifiedManifest } from '../src/trust.ts';
import { canonicalDepositExpiry, depositExpiryStatus, validateDepositExpiry, NON_EXPIRING_NOTE_EXPIRY } from '../src/deposit-expiry.ts';
import { ClientDaemon } from '../src/clientd-bridge.ts';
import type { DaemonOptions } from '../src/clientd-bridge.ts';

async function noExpiryFixture() {
  const f = await chainFixture({ noteTtlSeconds: '0' });
  const account = { address: f.manifest.pool, owner: f.manifest.program_id, executable: false,
    lamports: 1n, data: f.poolData, slot: 100n, commitment: 'finalized' as const };
  return { ...f, account, verify: () => verifyPoolConfig(f.manifest, f.manifest.genesis_hash, account, 100n) };
}

test('no-expiry policy requires both authenticated manifest and matching finalized Pool', async () => {
  const f = await noExpiryFixture();
  assert.throws(() => hasNonExpiringDeposits(f.manifest), /verified finalized PoolConfig/);
  assert.throws(() => canonicalDepositExpiry(f.manifest, '1'), /verified finalized PoolConfig/);
  assert.throws(() => depositExpiryStatus(f.manifest, undefined, 1n), /verified finalized PoolConfig/);
  f.poolData.writeBigUInt64LE(86400n, 331);
  await assert.rejects(f.verify(), /PoolConfig timing/);
  assert.throws(() => hasNonExpiringDeposits(f.manifest), /verified finalized PoolConfig/);
  f.poolData.writeBigUInt64LE(0n, 331);
  await assert.rejects(verifyPoolConfig(f.manifest, f.manifest.genesis_hash, { ...f.account, commitment: 'confirmed' as never }, 100n), /finalized/);
  await f.verify();
  assert.equal(hasNonExpiringDeposits(f.manifest), true);
  assert.throws(() => hasNonExpiringDeposits({ ...f.manifest } as VerifiedManifest), /not verified/);
  const separate = await noExpiryFixture();
  assert.throws(() => hasNonExpiringDeposits(separate.manifest), /verified finalized PoolConfig/);
});

test('canonical unlimited expiry survives clock and day changes without changing withdrawal timing', async () => {
  const f = await noExpiryFixture(); await f.verify();
  for (const clock of ['0', '86399', '86400', '1792886400', NON_EXPIRING_NOTE_EXPIRY])
    assert.equal(canonicalDepositExpiry(f.manifest, clock), NON_EXPIRING_NOTE_EXPIRY);
  assert.equal(f.manifest.challenge_seconds, '86400');
  assert.deepEqual(depositExpiryStatus(f.manifest, undefined, 1n), { depositExpiryPolicy: 'none', expiry: null, canRequest: false });
  for (const now of [1n, 1_792_886_400n, BigInt(NON_EXPIRING_NOTE_EXPIRY)])
    assert.deepEqual(depositExpiryStatus(f.manifest, { expiry: NON_EXPIRING_NOTE_EXPIRY }, now),
      { depositExpiryPolicy: 'none', expiry: null, canRequest: true });
  for (const expiry of ['0', '86400', '9999999999', '018446744073709551615', '18446744073709551616'])
    assert.throws(() => validateDepositExpiry(f.manifest, expiry), /expiry|deposit time/);
});

test('finite Pools retain exact day rounding, expired admission and full-principal warning', async () => {
  const { manifest } = await chainFixture({ noteTtlSeconds: '86400' });
  assert.equal(canonicalDepositExpiry(manifest, '0'), '86400');
  assert.equal(canonicalDepositExpiry(manifest, '1'), '172800');
  assert.equal(canonicalDepositExpiry(manifest, '86400'), '172800');
  const status = depositExpiryStatus(manifest, { expiry: '86400' }, 86400n);
  assert.equal(status.depositExpiryPolicy, 'fixed');
  assert.equal(status.canRequest, false);
  assert.equal(status.expiry?.severity, 'expired');
  assert.match(status.expiry!.message, /entire principal.*treasury/);
  const large = depositExpiryStatus(manifest, { expiry: NON_EXPIRING_NOTE_EXPIRY }, 1n);
  assert.equal(large.depositExpiryPolicy, 'fixed', 'large timestamps alone cannot claim unlimited policy');
  assert.match(large.expiry!.message, /treasury/);
  assert.throws(() => canonicalDepositExpiry(manifest, NON_EXPIRING_NOTE_EXPIRY), /invalid deposit expiry/);
});

test('native daemon exposes authenticated no-expiry and preserves legacy warning without manifest', async () => {
  const f = await noExpiryFixture(); await f.verify();
  const value = { state: { balance_micro_usdc: '100' }, witness: { expiry: NON_EXPIRING_NOTE_EXPIRY },
    pending: null, history: [], wallet: { status: 'active', history: [] } };
  const options = { client: {}, journal: { read: async () => ({ value, head: 'fixture' }) }, noteId: 'note', mode: 'proxy',
    models: ['model'], now: () => 2_000_000_000n, prepare: async () => { throw Error('must not prepare'); } } as unknown as DaemonOptions;
  const unlimited = await new ClientDaemon({ ...options, manifest: f.manifest }).status() as { deposit_expiry_policy: string; expiry: null };
  assert.equal(unlimited.deposit_expiry_policy, 'none');
  assert.equal(unlimited.expiry, null);
  const legacy = await new ClientDaemon(options).status() as { expiry: { message: string } };
  assert.match(legacy.expiry!.message, /treasury/);
  value.witness.expiry = '1';
  await assert.rejects(new ClientDaemon({ ...options, manifest: f.manifest }).status(), /canonical expiry/);
});
