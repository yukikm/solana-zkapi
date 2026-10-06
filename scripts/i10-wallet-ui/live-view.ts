import {expiryNotice, type NoteJournal} from '../../packages/sdk/src/control.ts';
import type {WalletOperation} from '../../packages/sdk/src/wallet.ts';

export interface LiveViewInput {
  journal: NoteJournal | null;
  connected: boolean;
  providerConfigured: boolean;
  busy?: boolean;
  /** Current-page response observation for the single pending operation. The
   * caller must match its observed operation ID; never persist this as trust. */
  responseObserved?: boolean;
  /** Display hint only; the SDK and host independently enforce state and budget. */
  newRequestAvailable?: boolean;
  /** Pool-bound authorization reserve, not a proposed charge. */
  authorizationCapMicroUsdc?: string;
  /** Presentation clock only. Financial checks remain in the existing SDK. */
  nowSeconds?: bigint;
}
export interface LiveView {
  stepIndex: 0 | 1 | 2 | 3;
  title: string;
  description: string;
  /** Six decimal USDC amounts; an em dash means unavailable or unverified. */
  balance: string;
  paid: string;
  returned: string;
  proofStatus: string;
  receiptStatus: string;
  nextAction: string;
}

/** A browser clock never proves chain expiry or authorizes a withdrawal. */
export function noteExpiry(journal: NoteJournal | null | undefined, nowSeconds = BigInt(Math.floor(Date.now() / 1000))) {
  return journal?.witness ? expiryNotice(BigInt(journal.witness.expiry), nowSeconds) : null;
}

/** Visibility only: WalletClient repeats all checks under its journal lock. */
export function escapeActions(journal: NoteJournal | null | undefined) {
  const w = journal?.wallet, op = w?.operation;
  const idle = !!journal && journal.pending === null;
  return {
    begin: idle && w?.status === 'active' && !op,
    fallback: idle && w?.status === 'active' && op?.kind === 'mutual_close'
      && ['proving', 'ready'].includes(op.phase) && op.attempts.length === 0 && !op.current
      && !!op.destinationOwner && !!w.clearance,
    finalize: idle && w?.status === 'pending_escape' && !op,
  };
}

/** Visibility only; the SDK separately verifies finalized expiry and absence. */
export function canRefreshExpiredSetup(journal: NoteJournal | null | undefined): boolean {
  const wallet = journal?.wallet, operation = wallet?.operation;
  const setup = wallet?.status === 'unfunded' && operation?.kind === 'deposit'
    || wallet?.status === 'active' && operation?.kind === 'initiate_escape' && !!operation.destinationOwner
    || wallet?.status === 'active' && operation?.kind === 'mutual_close' && !!operation.destinationOwner
      && wallet.clearance?.phase === 'verified' && !!wallet.clearance.signature;
  return journal?.pending === null && setup && !!operation
    && operation.phase === 'ready' && operation.step === 0 && !!operation.plan
    && operation.plan.operation === operation.kind
    && !operation.finalization && operation.finalized.length === 0 && !!operation.current
    && operation.attempts.at(-1)?.signature === operation.current
    && operation.attempts.every(attempt => attempt.kind === 'create');
}

/** Visibility only: retryRejected re-verifies the exact finalized rejection. */
export function canRetryRejected(journal: NoteJournal | null | undefined): boolean {
  const operation = journal?.wallet?.operation;
  return journal?.pending === null && !!operation && !operation.current && operation.attempts.length > 0
    && (operation.phase === 'failed' || operation.transport === 'v0_inline_deposit_v1' && operation.phase === 'stale');
}

export function amount(micro: string | bigint): string {
  const n = BigInt(micro);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}

/** Explain the same conservative UI guards; this never authorizes an SDK send. */
export function providerPrepareHint({journal: j, connected, providerConfigured, busy = false, authorizationCapMicroUsdc = '1000000', nowSeconds}: LiveViewInput): string {
  if (!connected) return 'Connect Phantom and select the original Devnet account to reopen your saved demo.';
  if (busy) return 'Wait for the current step to finish.';
  if (!providerConfigured) return 'The live API connection is unavailable. Wallet recovery and withdrawal remain available.';
  if (!j) return 'Deposit 2 Devnet USDC and finish its wallet transactions before preparing an API request.';
  if (j.pending) return 'Finish or recover the saved session before preparing a new request. An uncertain API request is never replayed.';
  if (j.wallet?.operation) return 'Continue the saved wallet operation before preparing an API request.';
  if (j.wallet?.status === 'closed') return 'This demo has been withdrawn. Start another demo with a new 2 USDC deposit; previous records are retained.';
  if (j.wallet?.clearance) return 'This note is reserved for withdrawal. Finish the saved withdrawal before starting another demo.';
  if (j.wallet?.status !== 'active') return 'Finish the saved deposit or withdrawal before preparing an API request.';
  if (noteExpiry(j, nowSeconds)?.severity === 'expired')
    return 'This note has expired. New API requests are disabled. Recover any saved session and check withdrawal immediately; an expired active note can be swept to the treasury.';
  if (BigInt(j.state.balance_micro_usdc) < BigInt(authorizationCapMicroUsdc))
    return `Remaining balance ${amount(j.state.balance_micro_usdc)} USDC is below the ${amount(authorizationCapMicroUsdc)} USDC authorization reserve. Withdraw it, then start another demo with 2 USDC. The reserve is not an API fee.`;
  return `A new request uses a fresh authorization. The ${amount(authorizationCapMicroUsdc)} USDC authorization reserve is not an API fee; only verified usage is charged.`;
}

/** A finalized upload is not a finalized withdrawal. Match the execute signature. */
function finalizedMutualClose(op: WalletOperation): boolean {
  return op.kind === 'mutual_close' && op.phase === 'ready' && !op.current
    && op.attempts.some(a => a.kind === 'execute' && op.finalized.some(f => f.signature === a.signature));
}

/** Presentation only. The SDK owns state transitions and verification; this
 * projection must be recomputed from its current, authenticated journal. */
export function liveView({journal: j, connected, providerConfigured, busy = false, responseObserved = false, newRequestAvailable = false, authorizationCapMicroUsdc, nowSeconds}: LiveViewInput): LiveView {
  const w = j?.wallet, pending = j?.pending, op = w?.operation;
  const observedPendingResponse = responseObserved && pending?.operations.length === 1
    && pending.operations[0].phase === 'send_unknown';
  const history = j?.history ?? [];
  const verifiedCharge = history.reduce((sum, h) => sum + BigInt(h.settlement.charge_micro_usdc), 0n);
  const effects = [...new Set(history.flatMap(h => h.receipts.map(r => r.body.billing_effect)))];
  const evidenceKinds = [...new Set(history.flatMap(h => h.receipts.flatMap(r => typeof r.body.evidence_kind === 'string' ? [r.body.evidence_kind] : [])))];
  const hasWaiver = evidenceKinds.includes('UNKNOWN_OPERATOR_LOSS');
  const receiptSummary = history.length === 0 ? 'No verified settlement yet.'
    : `${history.length} signed settlement${history.length === 1 ? '' : 's'} verified by the SDK.`
      + (verifiedCharge === 0n ? ' No API charge verified.' : '')
      + (hasWaiver ? ' Operator-loss waiver recorded; this does not establish successful API usage.' : '')
      + (effects.length ? ` Billing: ${effects.join(', ')}.` : '')
      + (evidenceKinds.length ? ` Evidence: ${evidenceKinds.join(', ')}.` : '');
  const view: LiveView = {
    stepIndex: 0, title: 'Connect your wallet',
    description: 'Connect Phantom, then select your Devnet account to open its saved state.',
    balance: w?.status === 'closed' ? '0.000000'
      : connected && w?.status === 'active' && !pending && !op ? amount(j!.state.balance_micro_usdc) : '—',
    paid: j ? amount(verifiedCharge) : '—', returned: '—',
    proofStatus: 'No finalized deposit recorded.', receiptStatus: receiptSummary,
    nextAction: 'Connect Phantom and select your Devnet account.',
  };

  if (w?.status === 'closed' && !pending && !op) {
    view.stepIndex = 3;
    view.title = 'Withdrawal complete';
    view.description = 'The SDK confirmed the closed note on Solana Devnet. This note can no longer fund an API request.';
    view.proofStatus = 'Closed note confirmed on Devnet.';
    view.nextAction = 'Start another demo with a new 2 USDC deposit. This completed demo remains saved.';
    if (w.history.some(finalizedMutualClose)) view.returned = amount(j!.state.balance_micro_usdc);
  } else if (op) {
    view.stepIndex = op.kind === 'deposit' ? 0 : 3;
    const name = op.kind === 'deposit' ? 'Deposit' : 'Withdrawal';
    view.title = `${name} in progress`;
    view.description = 'The SDK retains every signed transaction. Continue the saved operation until its final transaction and account state are verified.';
    view.proofStatus = op.phase === 'proving' ? `${name} proof pending.` : `${name} proof prepared; completion pending.`;
    view.nextAction = op.phase === 'proving' ? 'Resume the saved proof.'
      : 'When ready to review Phantom, request the next signature. Each transaction has an expiry.';
    if (op.transport === 'v0_inline_deposit_v1' && op.phase === 'ready') {
      view.description = 'Review one deposit transaction in Phantom. Your balance becomes available after its confirmation and account checks.';
      view.nextAction = 'Sign the deposit once in Phantom, then continue to check confirmation.';
    }
    if (op.current) {
      view.title = `${name} confirmation pending`;
      view.description = 'A signed transaction is unresolved. Continue to check that exact transaction before any new step.';
      view.nextAction = 'Continue to check the saved transaction. Review Phantom if another signature is requested.';
      if (op.transport === 'v0_inline_deposit_v1') view.nextAction = 'Continue to check the saved deposit. No new signature is needed for this check.';
    }
    if (op.phase === 'failed' || op.phase === 'cancelled') {
      view.title = `${name} needs review`;
      view.proofStatus = `${name} did not complete.`;
      view.nextAction = 'Review the saved operation before continuing.';
    } else if (op.phase === 'stale' || op.phase === 'closing_stale') {
      view.title = `${name} proof needs recovery`;
      view.proofStatus = 'Saved proof is stale; completion pending.';
    }
    if (canRetryRejected(j)) view.nextAction = 'After reviewing the rejection, select Retry confirmed rejection to prepare another attempt. Review its new signature in Phantom.';
  } else if (w?.status === 'pending_escape') {
    view.stepIndex = 3;
    view.title = 'Escape withdrawal pending';
    view.description = 'The note is in its escape period. Funds have not been confirmed returned.';
    view.proofStatus = 'Escape initiated; final withdrawal pending.';
    view.nextAction = 'Select Check deadline and prepare final withdrawal. The SDK checks the finalized chain deadline before requesting a signature.';
  } else if (pending) {
    view.stepIndex = 1;
    view.title = 'Authorization prepared';
    view.description = 'The saved authorization proof is ready. No API response or charge has been verified for this session.';
    view.proofStatus = 'Authorization proof prepared locally.';
    view.receiptStatus = 'Current session has no verified settlement. ' + receiptSummary;
    view.nextAction = 'Send the saved request once.';
    if (pending.phase === 'send_unknown') {
      view.title = 'Authorization outcome unknown';
      view.description = 'The authorization response is unresolved. The saved journal controls recovery; an absent response does not mean the request failed.';
      view.proofStatus = 'Authorization acceptance unconfirmed.';
      view.nextAction = 'Recover the saved authorization or close the session.';
    } else if (pending.phase === 'active') {
      view.title = 'Authorization accepted';
      view.description = 'The session is active. Its API operation and final charge still need to be verified.';
      view.proofStatus = 'Authorization accepted; signed successor pending.';
    }
    if (pending.operations.some(operation => operation.phase === 'send_unknown')) {
      view.stepIndex = 2;
      view.title = 'API outcome unknown';
      view.description = 'The API request may have reached the provider. It must not be replayed. Recover this session to verify its final charge.';
      view.receiptStatus = 'Current API outcome and settlement are unverified. ' + receiptSummary;
      view.nextAction = 'Recover or close the saved session; do not send another API request.';
      if (observedPendingResponse) {
        view.title = 'API response received';
        view.description = 'An answer was received in this page view. Its charge and remaining balance still await signed settlement verification. The request must not be replayed.';
        view.receiptStatus = 'Current signed settlement is unverified. ' + receiptSummary;
      }
    } else if (pending.operations.some(operation => operation.phase === 'response_received')) {
      view.stepIndex = 2;
      view.title = 'API response received';
      view.description = 'A response was received. The displayed answer does not yet establish a verified charge or new balance.';
      view.nextAction = 'Close the session to verify its signed settlement.';
    } else if (pending.operations.some(operation => operation.phase === 'not_accepted')) {
      view.stepIndex = 2;
      view.title = 'API request not accepted';
      view.description = 'The SDK confirmed this operation was not accepted. Verify the terminal settlement before withdrawing.';
      view.nextAction = 'Recover or close the session to verify its signed settlement.';
    }
    if (pending.phase === 'closing' || pending.closeRequested) {
      view.stepIndex = 2;
      if (observedPendingResponse || !pending.operations.some(operation => operation.phase === 'send_unknown')) view.title = 'Settlement pending';
      view.proofStatus = 'Signed successor verification pending.';
      view.nextAction = 'Recover or close the saved session to finish verification.';
    }
  } else if (w?.status === 'active') {
    view.stepIndex = 1;
    view.title = 'Deposit active';
    view.description = 'The SDK verified the funded note on Solana Devnet. Prepare a proof to authorize one real API request.';
    view.proofStatus = 'Active note verified on Devnet.';
    view.nextAction = providerConfigured ? 'Prepare the API authorization.' : 'The provider is unavailable. Restore the live connection or withdraw your funds.';
    if (!providerConfigured) {
      view.title = 'Provider unavailable';
      view.description = 'Your funded note is recorded, but no live provider is configured for this browser session.';
    }
    if (history.length) {
      view.stepIndex = 3;
      view.title = verifiedCharge === 0n ? 'Session closed with no charge' : 'Signed settlement verified';
      view.description = verifiedCharge === 0n
        ? 'The SDK verified a zero-charge settlement. This alone does not establish successful API usage. Withdraw the remaining balance.'
        : 'The SDK verified the signed receipts and successor state. Withdraw the remaining balance to your Devnet wallet.';
      view.proofStatus = 'Signed successor verified by the SDK.';
      view.nextAction = 'Withdraw the remaining Devnet USDC.';
      if (newRequestAvailable && providerConfigured) {
        view.stepIndex = 1;
        view.description = 'The SDK verified the previous settlement. The remaining balance can fund a new, separately authorized request.'
          + (verifiedCharge === 0n ? ' The previous zero-charge settlement alone does not establish successful API usage.' : '');
        view.nextAction = 'Prepare a new AI request, or withdraw the remaining Devnet USDC.';
      }
    }
    if (w.clearance) {
      view.stepIndex = 3;
      view.title = w.clearance.phase === 'verified' ? 'Withdrawal clearance verified' : 'Withdrawal clearance pending';
      view.description = 'This note has entered withdrawal recovery. The saved authorization cannot be reused for another API request.';
      view.proofStatus = w.clearance.phase === 'verified' ? 'Permanent signed clearance verified.' : 'Signed clearance verification pending.';
      view.nextAction = 'Continue the saved withdrawal recovery.';
    } else if (providerConfigured && authorizationCapMicroUsdc && BigInt(j!.state.balance_micro_usdc) < BigInt(authorizationCapMicroUsdc)) {
      view.nextAction = 'Withdraw the remaining Devnet USDC, then start another demo with a new 2 USDC deposit.';
      view.description = providerPrepareHint({journal: j, connected: true, providerConfigured, authorizationCapMicroUsdc, nowSeconds});
    }
    if (noteExpiry(j, nowSeconds)?.severity === 'expired') {
      view.stepIndex = 3;
      view.title = 'Note expired — withdrawal needs attention';
      view.description = 'New API requests are disabled. Expiry does not automatically return funds: the entire principal of an active note can be swept to the treasury.';
      view.nextAction = 'Check withdrawal now. If clearance is unavailable, choose the explicit escape withdrawal; the SDK verifies current chain state.';
    }
  } else if (connected) {
    view.title = 'Ready to deposit';
    view.description = 'Deposit 2 Devnet USDC to create a funded note with room for repeated API requests. Its balance becomes available only after the SDK verifies finalization.';
    view.nextAction = 'Prepare the deposit, then approve its transactions in Phantom.';
  }

  // Connection/work state takes precedence over a historical success headline.
  if (!connected) {
    view.title = j ? 'Reconnect your wallet' : 'Connect your wallet';
    view.description = j
      ? 'Reconnect Phantom and select the original Devnet account to resume its saved state. Historical amounts below are not a live wallet balance.'
      : 'Connect Phantom, then select your Devnet account to open its saved state.';
    view.nextAction = 'Connect Phantom and select your Devnet account.';
  }
  if (busy) {
    view.title = 'Working on the current step';
    view.nextAction = 'Wait for the current step to finish. Check Phantom if a signature is requested.';
  }
  return view;
}
