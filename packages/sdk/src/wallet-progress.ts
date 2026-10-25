/** Presentation projections over the existing journal. No RPC, proof or signing. */
import { restorePlan } from './transport.ts';
import type { WalletOperation } from './wallet.ts';

export interface WalletOperationProgress {
  stage: 'preparing_proof' | 'creating_proof_account' | 'uploading_proof' | 'sealing_proof'
    | 'submitting_deposit' | 'submitting_withdrawal' | 'starting_waiting_period'
    | 'finalizing_withdrawal' | 'cleaning_up_proof' | 'unknown';
  nextAction: 'prepare_proof' | 'approve_transaction' | 'wait_for_confirmation'
    | 'review_failure' | 'refresh_proof';
  /** Exact progress for the current saved proof plan; null if no plan is known. */
  proofUpload: { confirmedChunks: number; totalChunks: number } | null;
}

export interface EscapeWithdrawalStatus {
  /** Eligibility at observedChainTime, never inferred from the device clock. */
  availability: 'unknown' | 'waiting' | 'ready' | 'unavailable';
  /** Unix seconds from the verified PendingWithdrawal account. */
  executableAt: string | null;
  /** Unix seconds from Clock in the same finalized account read. */
  observedChainTime: string | null;
  observedSlot: number | null;
}

export function unknownEscapeWithdrawal(): EscapeWithdrawalStatus {
  return { availability: 'unknown', executableAt: null, observedChainTime: null, observedSlot: null };
}

export async function walletOperationProgress(op: WalletOperation): Promise<WalletOperationProgress> {
  const nextAction: WalletOperationProgress['nextAction'] = op.current ? 'wait_for_confirmation'
    : op.phase === 'failed' || op.phase === 'cancelled' || op.phase === 'stale' && op.transport === 'v0_inline_deposit_v1' ? 'review_failure'
    : op.phase === 'proving' ? 'prepare_proof'
    : op.phase === 'stale' ? 'refresh_proof' : 'approve_transaction';
  if (op.phase === 'proving') return { stage: 'preparing_proof', nextAction, proofUpload: null };
  if (op.kind === 'finalize_escape') return { stage: 'finalizing_withdrawal', nextAction, proofUpload: null };
  if (op.transport === 'v0_inline_deposit_v1') return { stage: 'submitting_deposit', nextAction, proofUpload: null };
  // Older journals can have an incomplete plan. Keep status readable without
  // manufacturing a step count or allowing a presentation error to authorize work.
  try {
    if (!op.plan) throw Error('no saved proof plan');
    const plan = await restorePlan(op.plan), step = plan.steps[op.step];
    if (!step) throw Error('unknown saved proof step');
    const proofUpload = {
      confirmedChunks: plan.steps.slice(0, op.step).filter(s => s.kind === 'append').length,
      totalChunks: plan.steps.filter(s => s.kind === 'append').length,
    };
    const current = op.attempts.find(a => a.signature === op.current);
    const kind = current?.kind ?? (op.phase === 'stale' || op.phase === 'closing_stale' ? 'close' : step.kind);
    const stage: WalletOperationProgress['stage'] = kind === 'create' ? 'creating_proof_account'
      : kind === 'append' ? 'uploading_proof' : kind === 'seal' ? 'sealing_proof'
      : kind === 'close' ? 'cleaning_up_proof' : kind === 'execute'
        ? op.kind === 'deposit' ? 'submitting_deposit' : op.kind === 'initiate_escape' ? 'starting_waiting_period' : 'submitting_withdrawal'
        : 'unknown';
    return { stage, nextAction, proofUpload };
  } catch {
    return { stage: 'unknown', nextAction: op.current ? 'wait_for_confirmation' : 'review_failure', proofUpload: null };
  }
}
