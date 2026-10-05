/** UI run discovery only. The SDK journal remains the sole financial state. */
import type {NoteJournal} from '../../packages/sdk/src/control.ts';
import type {EncryptedJournal, JournalRecord} from '../../packages/sdk/src/journal.ts';
import type {WalletClient, WalletRoles} from '../../packages/sdk/src/wallet.ts';
import type {UiProviderConfiguration} from './provider.ts';

export const legacyDemoNoteId = 'wallet-ui-acceptance';
export const demoDepositMicroUsdc = '2000000';
const allocationLock = 'ui-demo-note-allocation';
type DemoJournal = Pick<EncryptedJournal<NoteJournal>, 'read' | 'withNoteLock'>;
export interface DemoNote {
  id: string;
  runNumber: number;
  record: JournalRecord<NoteJournal> | null;
}
export function demoNoteId(runNumber: number): string {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw Error('invalid demo run');
  return runNumber === 1 ? legacyDemoNoteId : `${legacyDemoNoteId}:${runNumber}`;
}
export function canStartDemo(journal: NoteJournal | null): boolean {
  return journal === null || journal.wallet?.status === 'closed' && journal.pending === null && !journal.wallet.operation;
}
/** Consecutive names need no mutable catalog or trusted balance in UI storage.
 * Every earlier record remains encrypted under its original ID and key. */
export async function latestDemoNote(journal: Pick<DemoJournal, 'read'>): Promise<DemoNote> {
  let latest: DemoNote = {id: legacyDemoNoteId, runNumber: 1, record: await journal.read(legacyDemoNoteId)};
  if (!latest.record) return latest;
  for (;;) {
    const runNumber = latest.runNumber + 1, id = demoNoteId(runNumber), record = await journal.read(id);
    if (!record) return latest;
    if (!latest.record || !canStartDemo(latest.record.value)) throw Error('earlier demo note still unresolved');
    latest = {id, runNumber, record};
  }
}
/** This lock spans discovery and SDK creation across tabs. A failure after
 * create leaves an ordinary saved SDK operation which discovery reopens. */
export async function beginNextDemoDeposit(journal: DemoJournal, client: Pick<WalletClient, 'beginDeposit'>,
  roles: WalletRoles): Promise<void> {
  await journal.withNoteLock(allocationLock, async () => {
    const latest = await latestDemoNote(journal);
    if (!canStartDemo(latest.record?.value ?? null)) throw Error('finish the saved demo withdrawal before another deposit');
    const id = latest.record ? demoNoteId(latest.runNumber + 1) : legacyDemoNoteId;
    await client.beginDeposit(id, demoDepositMicroUsdc, roles);
  });
}

export interface UiProviderBudget {
  schema: 1; plan_sha256: string; budget_micro_usdc: string; reserved_micro_usdc: string; remaining_micro_usdc: string;
  max_requests: number; reserved_requests: number; remaining_requests: number; request_max_cost_micro_usdc: string;
  available_requests: number; request_policy: string;
}
/** This read-only display is never a reservation or permission to replay. */
export function checkedProviderBudget(value: UiProviderBudget, configuration: UiProviderConfiguration): UiProviderBudget {
  const b = structuredClone(value), amounts = [b.budget_micro_usdc, b.reserved_micro_usdc, b.remaining_micro_usdc, b.request_max_cost_micro_usdc];
  if (b.schema !== 1 || b.plan_sha256 !== configuration.planSha256 || !/^[0-9a-f]{64}$/.test(b.plan_sha256)
    || !amounts.every(n => typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n))
    || ![b.max_requests, b.reserved_requests, b.remaining_requests, b.available_requests].every(n => Number.isSafeInteger(n) && n >= 0)
    || BigInt(b.budget_micro_usdc) !== BigInt(b.reserved_micro_usdc) + BigInt(b.remaining_micro_usdc)
    || b.max_requests !== b.reserved_requests + b.remaining_requests || BigInt(b.request_max_cost_micro_usdc) === 0n
    || b.available_requests > b.remaining_requests
    || BigInt(b.available_requests) * BigInt(b.request_max_cost_micro_usdc) > BigInt(b.remaining_micro_usdc)
    || b.request_policy !== (configuration.requestPolicy ?? 'single_acceptance_case')
    || b.request_max_cost_micro_usdc !== configuration.testCase.max_cost_micro_usdc) throw Error('provider budget unavailable');
  return b;
}
