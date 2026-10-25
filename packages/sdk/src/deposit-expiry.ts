/** Deposit lifetime is separate from quote, provider-lease and withdrawal timers. */
import { expiryNotice } from './control.ts';
import { hasNonExpiringDeposits, type VerifiedManifest } from './trust.ts';

export const NON_EXPIRING_NOTE_EXPIRY = '18446744073709551615';
export type DepositExpiryPolicy = 'fixed' | 'none';
const maximum = BigInt(NON_EXPIRING_NOTE_EXPIRY);

function uint(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > maximum) throw new Error('invalid deposit time');
  return BigInt(value);
}

/** Preserve the original expiry formula for every finite-lifetime Pool. */
export function canonicalDepositExpiry(manifest: VerifiedManifest, chainClock: string): string {
  const now = uint(chainClock);
  if (hasNonExpiringDeposits(manifest)) return NON_EXPIRING_NOTE_EXPIRY;
  const ttl = uint(manifest.note_ttl_seconds);
  const expiry = (now + ttl + 86_399n) / 86_400n * 86_400n;
  if (ttl === 0n || expiry > maximum) throw new Error('invalid deposit expiry');
  return expiry.toString();
}

export function validateDepositExpiry(manifest: VerifiedManifest, expiry: string): void {
  uint(expiry);
  if (hasNonExpiringDeposits(manifest) && expiry !== NON_EXPIRING_NOTE_EXPIRY)
    throw new Error('non-expiring deposit witness must match the canonical expiry');
}

/** A timestamp alone never suppresses the legacy claim warning. */
export function depositExpiryStatus(manifest: VerifiedManifest, witness: { expiry: string } | undefined, now: bigint): {
  depositExpiryPolicy: DepositExpiryPolicy; expiry: ReturnType<typeof expiryNotice> | null; canRequest: boolean;
} {
  const noExpiry = hasNonExpiringDeposits(manifest);
  if (witness) validateDepositExpiry(manifest, witness.expiry);
  const expiry = witness && !noExpiry ? expiryNotice(BigInt(witness.expiry), now) : null;
  return { depositExpiryPolicy: noExpiry ? 'none' : 'fixed', expiry,
    canRequest: !!witness && (noExpiry || expiry?.severity !== 'expired') };
}
