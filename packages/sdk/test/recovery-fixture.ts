/** Known-public synthetic private state; this fixture performs no financial operation. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { EncryptedJournal } from '../src/journal.ts';
import type { RecoveryStorage } from '../src/recovery.ts';

export const recoveryContext = { deploymentId: 'recovery-fixture-deployment', pool: 'recovery-fixture-pool', wallet: 'recovery-fixture-wallet' };
export const recoveryEndpoint = 'https://recovery.example.test/recovery/v1';
export const recoveryNoteId = 'saved-deposit-two';
export function recoveryState() {
  return {
    schema: 1 as const,
    witness: { secret: 'SYNTHETIC_NOTE_SECRET_MUST_SURVIVE_DEVICE_LOSS', note_id: 27, deposit_micro_usdc: '2000000', expiry: '1900000000' },
    state: { balance_micro_usdc: '1777123', balance_blinding: 'synthetic-blinding', anchor: 'synthetic-anchor', state_signature: 'synthetic-signed-successor' },
    pending: {
      phase: 'send_unknown', requestId: '0a2fa504-f248-4cb6-b70a-59b08768452f', controlToken: 'SYNTHETIC_CONTROL_RECOVERY_TOKEN',
      exactRequest: '{ "authorization": {"request_id":"0a2fa504-f248-4cb6-b70a-59b08768452f"}, "proof": "EXACT_SYNTHETIC_AUTH_BYTES" }',
      operations: [{ id: 'c17fe24c-0685-444d-a6ac-9f8dd2fabde2', phase: 'send_unknown', bodyRedacted: true, bodyBase64: '', bodySha256: 'af'.repeat(32) }],
    },
    wallet: { operation: { kind: 'mutual_close', attempts: [{ signature: 'synthetic-signed-transaction', wireHex: '00ab01cd0203eeff', blockhash: 'synthetic-blockhash', lastValidBlockHeight: 41 }] } },
    history: [{ requestId: '91f377d7-041f-4794-a53a-f1e56cbf4f3a', receipt: 'synthetic-verified-receipt', charge_micro_usdc: '222877' }],
  };
}
export type RecoveryState = ReturnType<typeof recoveryState>;
export function validateRecoveryState(value: unknown): asserts value is RecoveryState {
  const v = value as RecoveryState;
  if (!v || v.schema !== 1 || typeof v.witness?.secret !== 'string' || typeof v.state?.balance_micro_usdc !== 'string'
    || typeof v.pending?.exactRequest !== 'string' || !Array.isArray(v.wallet?.operation?.attempts) || !Array.isArray(v.history)) throw new Error('invalid synthetic recovery state');
}
export function recoveryJournal(storage: Pick<RecoveryStorage, 'store' | 'key'>) {
  return new EncryptedJournal<RecoveryState>(storage.store, storage.key, recoveryContext, validateRecoveryState);
}
export async function recoveryServer(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-service-'));
  const { startRecoveryServer } = await import(new URL('../../../services/recovery/server.mjs', import.meta.url).href);
  const service = await startRecoveryServer({ directory, port: 0, host: '127.0.0.1', allowedOrigins: ['https://recovery.example.test'], localTestOnly: true });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${service.address.port}`;
  const mappedFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(origin + url.pathname + url.search, init);
  };
  return { origin, directory, fetch: mappedFetch };
}
