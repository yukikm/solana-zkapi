import {getWallets} from '@wallet-standard/app';
import type {StandardConnectFeature, StandardEventsFeature} from '@wallet-standard/features';
import {PublicKey, VersionedTransaction} from '@solana/web3.js';
import {walletStandardAdapter, type StandardWallet, type StandardAccount} from '../../packages/sdk/src/wallet-standard.ts';
import {EncryptedJournal, IndexedDbJournalStore} from '../../packages/sdk/src/journal.ts';
import {validateNoteJournal, type NoteJournal} from '../../packages/sdk/src/control.ts';
import {WalletClient, type WalletOptions, type WalletRoles} from '../../packages/sdk/src/wallet.ts';
import type {VerifiedManifest} from '../../packages/sdk/src/trust.ts';
import type {V0Wallet} from '../../packages/sdk/src/transport.ts';
import {journalKey} from './storage.ts';
import {UiProvider, type UiProviderOptions} from './provider.ts';
import {liveView, canRefreshExpiredSetup, canRetryRejected, providerPrepareHint} from './live-view.ts';
import {failureCode} from './diagnostics.ts';
import {signingDiagnostics} from './signing-diagnostics.ts';
import {beginNextDemoDeposit, canStartDemo, checkedProviderBudget, latestDemoNote, legacyDemoNoteId, type UiProviderBudget} from './demo-notes.ts';

export interface UiOptions {
  fixtureOnly: boolean; financialEnabled?: boolean; targetWallet: string; runId: string; manifest: VerifiedManifest;
  initialize(journal: EncryptedJournal<NoteJournal>, signer: V0Wallet): Promise<Omit<WalletOptions, 'journal' | 'wallets'> & {providerOptions?: Omit<UiProviderOptions, 'journal'>}>;
  fee(transaction: VersionedTransaction): Promise<number>;
  /** Read-only availability; the host still reserves each new request atomically. */
  providerBudget?(): Promise<UiProviderBudget>;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const walletSelect = () => element<HTMLSelectElement>('wallet');
const accountSelect = () => element<HTMLSelectElement>('account');
// Explicit pricing prevents the wallet adding an unreviewed fee instruction.
// At the SDK's 1,000,000-CU limit this adds 1 lamport; the fee cap still applies.
const priorityFeeMicroLamports = 1n;

/** UI intent only. All financial state lives in the existing SDK NoteJournal. */
export function mountWalletUi(options: UiOptions): void {
  const {manifest: m} = options, registry = getWallets();
  if (m.deployment_environment !== 'devnet' || m.setup_profile !== 'test_only'
    || m.genesis_hash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    || m.mint !== '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') throw Error('explicit Circle USDC devnet test profile required');
  document.body.dataset.fixture = String(options.fixtureOnly);
  if (options.fixtureOnly) {
    element('network-badge').textContent = 'Offline fixture';
    element('live-network-status').textContent = 'Synthetic wallet, provider and chain. No real API request or Devnet transfer.';
  }
  element('scope').textContent = options.fixtureOnly ? 'OFFLINE FIXTURE ONLY — no real extension, public RPC or proof validity acceptance.' : 'Chrome + Phantom · Solana devnet';
  element('pins').textContent = `Pool ${m.pool}\nManifest ${m.manifest_hash}\nRun ${options.runId}`;
  let wallet: (StandardWallet & {name: string; version: string}) | undefined;
  let account: StandardAccount | undefined, client: WalletClient | undefined, journal: EncryptedJournal<NoteJournal> | undefined;
  let provider: UiProvider | undefined;
  let noteId = legacyDemoNoteId, demoRun = 1;
  let providerBudget: UiProviderBudget | null = null;
  const updateProviderBudget = async () => {
    if (!options.providerBudget || !provider) return;
    try { providerBudget = checkedProviderBudget(await options.providerBudget(), provider.configuration); }
    catch { providerBudget = null; }
  };
  const budgetAvailable = () => !options.providerBudget || !!providerBudget && providerBudget.available_requests > 0;
  const requireBudget = async () => {
    await updateProviderBudget();
    if (provider && !budgetAvailable()) throw Error('provider request budget unavailable or exhausted');
  };
  let responseObservation: {operation_id: string; http_status: number; response_bytes: number; response_sha256: string} | null = null;
  let lastSigningReview: ReturnType<typeof signingDiagnostics> | null = null;
  let expiredSetupObserved = false;
  let busy = false, offEvents: (() => void) | undefined;
  const events: {at: string; event: string; operation_id?: string; attempts?: number}[] = [];
  const recordEvent = (event: string, operation_id?: string, attempts?: number) => events.push({at: new Date().toISOString(), event, ...(operation_id ? {operation_id} : {}), ...(attempts !== undefined ? {attempts} : {})});
  const status = (message: string) => { element('status').textContent = message; };
  const summary = async () => {
    const latest = journal ? await latestDemoNote(journal) : undefined;
    if (latest && latest.id !== noteId) {
      noteId = latest.id; responseObservation = null; expiredSetupObserved = false; lastSigningReview = null;
      element('provider-response').textContent = 'No response for this demo yet.';
    }
    demoRun = latest?.runNumber ?? 1;
    const r = latest?.record, w = r?.value.wallet;
    const unresolved = w?.operation?.attempts.find(attempt => attempt.signature === w.operation?.current);
    return {journal: r?.value ?? null, observation: {fixture_only: options.fixtureOnly, wallet: wallet?.name, wallet_standard_version: wallet?.version,
      installed_wallet_version: element<HTMLInputElement>('wallet-version').value.trim(), account: account?.address,
      last_signing_review: lastSigningReview,
      journal_revision: r?.revision ?? null, wallet_status: w?.status ?? null,
      balance_micro_usdc: r?.value.state.balance_micro_usdc ?? null, permanent_clearance: !!w?.clearance,
      provider_case: provider?.configuration.testCase.id ?? null,
      provider_request_policy: provider?.configuration.requestPolicy ?? 'single_acceptance_case',
      response_observation: responseObservation,
      provider_plan_sha256: provider?.configuration.planSha256 ?? null,
      provider_budget: providerBudget, demo_run: demoRun, saved_demo_runs: r ? demoRun : 0,
      session: r?.value.pending ? {request_id: r.value.pending.prepared.request.authorization.request_id,
        phase: r.value.pending.phase, server_state: r.value.pending.serverState ?? null, close_requested: r.value.pending.closeRequested === true,
        operations: r.value.pending.operations.map(o => ({id: o.id, phase: o.phase}))} : null,
      verified_settlements: r?.value.history.map(h => ({request_id: h.prepared.request.authorization.request_id,
        charge_micro_usdc: h.settlement.charge_micro_usdc, balance_before_micro_usdc: h.previous.balance_micro_usdc,
        receipt_ids: h.receipts.map(receipt => receipt.body.receipt_id),
        billing_effects: h.receipts.map(receipt => receipt.body.billing_effect),
        operation_ids: h.operations.map(o => o.id)})) ?? [],
      operation: w?.operation ? {id: w.operation.id, kind: w.operation.kind, phase: w.operation.phase, step: w.operation.step,
        attempts: w.operation.attempts.length, unresolved_signature: w.operation.current ?? null} : null,
      unresolved_transaction: unresolved ? {kind: unresolved.kind, signature: unresolved.signature,
        last_valid_block_height: unresolved.lastValidBlockHeight} : null,
      expired_setup_recoveries: [...(w?.history ?? []), ...(w?.operation ? [w.operation] : [])]
        .flatMap(operation => operation.expiredCreations ?? []),
      finalized_transactions: [...(w?.history ?? []), ...(w?.operation ? [w.operation] : [])].flatMap(op => op.finalized),
      manifest_hash: m.manifest_hash, pool: m.pool, run_id: options.runId,
      live_provider_verified: false, wallet_UI_verified: false, independent_wallet_and_receipt_review_required: true, release_gates_passed: []}};
  };
  const refresh = async () => {
    const {journal: saved, observation: s} = await summary(); element('state').textContent = JSON.stringify(s, null, 2);
    const connected = options.financialEnabled !== false && !!(client && account && wallet?.accounts.includes(account));
    const view = liveView({journal: saved, connected: !!(client && account && wallet?.accounts.includes(account)),
      providerConfigured: !!provider, busy, authorizationCapMicroUsdc: m.cap_micro_usdc,
      newRequestAvailable: provider?.configuration.requestPolicy === 'explicit_demo'
        && budgetAvailable() && !!saved && BigInt(saved.state.balance_micro_usdc) >= BigInt(m.cap_micro_usdc),
      responseObserved: events.some(event => event.event === 'provider_response_observed'
        && saved?.pending?.operations.some(operation => operation.id === event.operation_id))});
    for (const [id, value] of Object.entries({'live-step-title': view.title, 'live-step-description': view.description,
      'live-balance': view.balance, 'live-paid': view.paid, 'live-returned': view.returned,
      'live-proof-status': view.proofStatus, 'live-receipt-status': view.receiptStatus,
      'live-next-action': options.financialEnabled === false ? 'This host is read-only. Transaction and API sends are disabled.' : view.nextAction})) {
      const node = document.getElementById(id); if (node) node.textContent = value;
    }
    const runSummary = document.getElementById('demo-run-summary');
    if (runSummary) runSummary.textContent = !journal ? 'Connect your wallet to reopen its saved demo.'
      : `Demo ${demoRun}${demoRun > 1 ? ` · ${demoRun - 1} previous completed demo${demoRun > 2 ? 's' : ''} retained in this browser` : ' · saved in this browser'}.`;
    const budgetHint = document.getElementById('provider-budget-hint');
    if (budgetHint) budgetHint.textContent = !provider ? 'Connect your wallet to check API availability.'
      : !options.providerBudget ? 'Each request is checked against the host budget before it is sent.'
      : !providerBudget ? 'API availability could not be checked. Select "Check API availability" to try again; recovery and withdrawal remain available.'
      : providerBudget.available_requests > 0 ? `${providerBudget.available_requests} more AI request${providerBudget.available_requests === 1 ? '' : 's'} available in this demo. Availability is checked again before sending.`
      : 'This demo has no more API requests available. Recover any saved session, then withdraw your remaining Devnet USDC.';
    const prepareHint = document.getElementById('provider-prepare-hint');
    if (prepareHint) prepareHint.textContent = providerPrepareHint({journal: saved, connected, providerConfigured: !!provider, busy, authorizationCapMicroUsdc: m.cap_micro_usdc});
    const waitingForBudget = connected && !busy && !!provider && !budgetAvailable()
      && (!saved || saved.pending === null && !saved.wallet?.operation && (!saved.wallet?.clearance || saved.wallet.status === 'closed'));
    if (waitingForBudget) {
      const message = providerBudget ? 'This demo has no more API requests available. Withdraw any remaining Devnet USDC; saved records are retained.'
        : 'Check API availability again before starting a new request or deposit. Recovery and withdrawal remain available.';
      if (prepareHint) prepareHint.textContent = message;
      if (options.financialEnabled !== false) element('live-next-action').textContent = message;
    }
    const budgetRefresh = document.getElementById('provider-budget-refresh') as HTMLButtonElement | null;
    if (budgetRefresh) budgetRefresh.disabled = busy || !provider || !options.providerBudget;
    const completedSteps = [!!saved?.wallet && saved.wallet.status !== 'unfunded',
      !!saved?.history.some(h => h.receipts.some(r => r.body.evidence_kind === 'PROXY_USAGE')),
      !!saved?.history.length, saved?.wallet?.status === 'closed'];
    document.querySelectorAll<HTMLElement>('[data-live-step]').forEach(node => {
      const step = Number(node.dataset.liveStep);
      // Zero-use recovery can close a note without completing the AI stage.
      node.dataset.state = completedSteps[step] ? 'done' : step === view.stepIndex && saved?.wallet?.status !== 'closed' ? 'current' : 'idle';
      if (node.dataset.state === 'current') node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
    const transactions = document.getElementById('live-transactions');
    if (transactions) {
      transactions.replaceChildren();
      for (const [index, receipt] of s.finalized_transactions.entries()) {
        const item = document.createElement('li'), link = document.createElement('a');
        link.href = `https://explorer.solana.com/tx/${encodeURIComponent(receipt.signature)}?cluster=devnet`;
        link.target = '_blank'; link.rel = 'noreferrer';
        link.textContent = `Transaction ${index + 1} · finalized at slot ${receipt.slot} ↗`;
        item.append(link); transactions.append(item);
      }
      if (!transactions.childElementCount) { const item = document.createElement('li'); item.textContent = 'No finalized transactions yet.'; transactions.append(item); }
    }
    const receipts = document.getElementById('live-receipts');
    if (receipts) {
      receipts.replaceChildren();
      for (const settlement of s.verified_settlements) {
        const item = document.createElement('li');
        item.textContent = `Verified settlement · ${settlement.charge_micro_usdc} micro-USDC · ${settlement.billing_effects.join(', ') || 'no usage receipts'}`;
        for (const id of settlement.receipt_ids) { const detail = document.createElement('code'); detail.textContent = id; item.append(document.createElement('br'), detail); }
        receipts.append(item);
      }
      if (!receipts.childElementCount) { const item = document.createElement('li'); item.textContent = 'No verified settlement yet. An AI response alone does not confirm the charge.'; receipts.append(item); }
    }
    element<HTMLButtonElement>('deposit').disabled = busy || !connected || !canStartDemo(saved) || !!provider && !budgetAvailable();
    element('deposit').textContent = saved?.wallet?.status === 'closed' ? 'Start another demo · 2 USDC' : 'Prepare 2 USDC deposit';
    const inlineDeposit = saved?.wallet?.operation?.transport === 'v0_inline_deposit_v1';
    element<HTMLButtonElement>('advance').disabled = busy || !connected || !s.operation || ['proving', 'failed', 'cancelled'].includes(s.operation.phase)
      || inlineDeposit && s.operation.phase === 'stale';
    element('advance').textContent = s.operation?.unresolved_signature ? 'Continue saved transaction' : inlineDeposit ? 'Sign deposit in Phantom' : 'Request next Phantom signature';
    element<HTMLButtonElement>('prove').disabled = busy || !connected || s.operation?.phase !== 'proving';
    const rejectionRetry = element<HTMLButtonElement>('retry-rejected');
    rejectionRetry.hidden = !canRetryRejected(saved);
    rejectionRetry.disabled = busy || !connected || !canRetryRejected(saved);
    const createRecovery = element<HTMLButtonElement>('refresh-create');
    const expiredCreate = expiredSetupObserved && canRefreshExpiredSetup(saved);
    createRecovery.hidden = !expiredCreate;
    createRecovery.disabled = busy || !connected || !expiredCreate;
    element<HTMLButtonElement>('withdraw').disabled = busy || !connected || s.wallet_status !== 'active' || !!s.operation || !!s.session;
    const noteAvailable = connected && s.wallet_status === 'active' && !s.operation && !s.permanent_clearance;
    const repeatable = provider?.configuration.requestPolicy === 'explicit_demo';
    element<HTMLButtonElement>('provider-prepare').disabled = busy || !provider || !budgetAvailable() || !noteAvailable || !!s.session
      || (s.verified_settlements.length !== 0 && !repeatable) || BigInt(s.balance_micro_usdc ?? '0') < BigInt(m.cap_micro_usdc);
    element('provider-prepare').textContent = repeatable && s.verified_settlements.length ? 'Prepare new AI request' : 'Prepare AI authorization';
    element<HTMLButtonElement>('provider-send').disabled = busy || !provider || !budgetAvailable() || !noteAvailable || !s.session || s.session.close_requested
      || s.session.phase === 'closing' || s.session.operations.some(o => o.phase !== 'prepared');
    element<HTMLButtonElement>('provider-close').disabled = busy || !provider || !connected || !s.session;
    element<HTMLButtonElement>('provider-reconcile').disabled = busy || !provider || !connected || s.session?.phase !== 'closing'
      || !s.session.operations.some(o => o.phase === 'send_unknown');
    element<HTMLButtonElement>('report').disabled = busy || !journal;
    element<HTMLButtonElement>('select').disabled = busy || !accountSelect().value;
    element<HTMLButtonElement>('connect').disabled = busy || !walletSelect().value;
  };
  const run = (action: () => Promise<void>) => async () => {
    if (busy) return; busy = true;
    try { await refresh(); await action(); }
    catch (error) {
      let message = 'Operation stopped. Your saved state is preserved. Check the connection and wallet, then continue the saved operation.';
      try {
        const pending = (await journal?.read(noteId))?.value.pending;
        if (pending?.phase === 'send_unknown' && !pending.closeRequested && pending.operations.length === 0)
          message = 'Authorization could not be confirmed. No AI request has been sent. "Send saved request once" checks the same saved authorization before the first request. "Recover / close session" closes without sending an AI request.';
        else if (pending?.operations.some(op => op.phase === 'send_unknown'))
          message = 'The AI request was sent, or its outcome is unknown. It cannot be sent again. Use "Recover / close session" to check the signed settlement.';
        else if (pending?.phase === 'closing')
          message = 'Settlement is still pending. Use "Recover / close session" to check the same saved session.';
      } catch { /* Preserve a generic message if the journal itself cannot be authenticated. */ }
      const code = failureCode(error);
      if (code === 'expired_upload_buffer_missing') {
        try {
          expiredSetupObserved = canRefreshExpiredSetup((await journal?.read(noteId))?.value);
          if (expiredSetupObserved)
            message = 'The setup transaction expired before it could be confirmed. Select "Refresh expired setup" to verify its final chain status and prepare a fresh signature request from this saved operation.';
        } catch { expiredSetupObserved = false; }
      }
      status(message + ` Diagnostic: ${code}.` + (options.fixtureOnly && error instanceof Error ? ' Fixture diagnostic: ' + error.message : '')); recordEvent('action_failed_' + code);
    }
    finally { busy = false; await refresh().catch(() => { status('Saved state could not be read. Keep this browser profile and site data; do not create a replacement deposit.'); }); }
  };
  const discover = () => {
    const selected = walletSelect().value; walletSelect().replaceChildren(new Option('Choose wallet', ''));
    for (const [i, w] of registry.get().entries()) if (w.name === options.targetWallet) walletSelect().append(new Option(w.name, String(i)));
    walletSelect().value = selected; if (walletSelect().value === '') walletSelect().selectedIndex = 0; void refresh();
    const hint = document.getElementById('wallet-hint');
    if (hint) hint.textContent = walletSelect().options.length > 1
      ? 'Choose Phantom, connect, then explicitly select your devnet account.'
      : 'Phantom is not detected in this browser. Open this same URL in Chrome with Phantom installed and unlocked.';
  };
  registry.on('register', discover); registry.on('unregister', discover); discover();
  walletSelect().onchange = () => { void refresh(); };
  accountSelect().onchange = () => { void refresh(); };
  element('connect').onclick = run(async () => {
    if (client) throw Error('reload before changing wallets');
    const candidate = registry.get()[Number(walletSelect().value)];
    if (!candidate || candidate.name !== options.targetWallet) throw Error('explicit target wallet required');
    const connect = (candidate.features as Partial<StandardConnectFeature>)['standard:connect'];
    if (!connect) throw Error('wallet connect unavailable');
    await connect.connect(); wallet = candidate as unknown as typeof wallet;
    accountSelect().replaceChildren(new Option('Choose account', ''));
    for (const a of wallet!.accounts) if (a.chains.includes('solana:devnet')) accountSelect().append(new Option(a.address, a.address));
    offEvents?.();
    const eventFeature = (candidate.features as Partial<StandardEventsFeature>)['standard:events'];
    offEvents = eventFeature?.on('change', () => { if (account && !wallet?.accounts.includes(account)) status('Account changed or disconnected. Reload and explicitly select the original account to resume.'); void refresh(); });
    status('Select the devnet account explicitly.'); recordEvent('connected');
  });
  element('select').onclick = run(async () => {
    if (client) throw Error('reload before changing the selected account');
    account = wallet?.accounts.find(a => a.address === accountSelect().value);
    if (!wallet || !account) throw Error('explicit connected account required');
    const adapter = walletStandardAdapter(wallet, account, 'solana:devnet');
    const storageName = `${m.manifest_hash}:${options.runId}:${account.address}`;
    const store = await IndexedDbJournalStore.open('zkapi-i10-ui:' + storageName);
    journal = new EncryptedJournal(store, await journalKey(storageName), {deploymentId: m.deployment_id, pool: m.pool}, validateNoteJournal);
    const signer: V0Wallet = {publicKey: new PublicKey(account.address), supportedTransactionVersions: new Set([0]),
      async signTransaction(tx) {
        if (options.financialEnabled === false) throw Error('read-only host');
        if (tx.version !== 0 || tx.serialize().length > 1232) throw Error('v0 wire bound');
        const fee = await options.fee(tx); if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10_000) throw Error('transaction fee cap');
        const before = await journal!.read(noteId), op = before?.value.wallet?.operation;
        recordEvent('signature_requested', op?.id, op?.attempts.length);
        await refresh();
        status('Review the signature request in Phantom promptly; this transaction has an expiry. If you are not ready, reject it and request a new signature when ready.');
        const reviewed = VersionedTransaction.deserialize(tx.serialize());
        let signed: VersionedTransaction;
        try {
          signed = await adapter.signTransaction(tx);
        }
        catch { recordEvent('signature_not_returned', op?.id, op?.attempts.length); throw Error('wallet signature not returned'); }
        recordEvent('signature_returned', op?.id);
        try { lastSigningReview = signingDiagnostics(reviewed, signed); } catch { lastSigningReview = null; }
        return signed;
      }};
    const initialized = await options.initialize(journal, signer);
    const initializedProvider = initialized.providerOptions ? new UiProvider({...initialized.providerOptions, journal}) : undefined;
    client = new WalletClient({...initialized, journal, wallets: [signer], priorityFeeMicroLamports});
    provider = initializedProvider;
    await updateProviderBudget();
    element('provider-scope').textContent = provider
      ? `${provider.configuration.testCase.model} · one fixed prompt · at most ${provider.configuration.testCase.max_cost_micro_usdc} micro-USDC reserved by the host. The proxy operator can read this request and response.`
      : 'OpenAI acceptance is not configured for this run. Wallet recovery remains available.';
    element('identity').textContent = `${wallet.name} / ${account.address}`;
    status('Account selected. Existing encrypted note state reopened.'); recordEvent('account_selected');
  });
  const roles = (): WalletRoles => { if (!account) throw Error('no account'); const key = account.address; return {uploader: key, rentPayer: key, feePayer: key, payer: key, tokenOwner: key}; };
  element('deposit').onclick = run(async () => {
    await requireBudget(); status('Preparing a new 2 Devnet USDC deposit proof locally…');
    try { await beginNextDemoDeposit(journal!, client!, roles()); recordEvent('deposit_prepared'); status('Deposit prepared. Continue to request the first signature. Earlier demo records remain saved.'); }
    finally { await updateProviderBudget(); }
  });
  element('advance').onclick = run(async () => {
    const operation = (await journal!.read(noteId))?.value.wallet?.operation;
    // Upgrade only a never-sent plan. The SDK repeats these checks under its
    // journal lock; signed or unresolved attempts are never repriced/rebuilt.
    if (operation?.phase === 'ready' && (operation.plan || operation.inlinePlan) && operation.step === 0
      && operation.attempts.length === 0 && operation.finalized.length === 0 && !operation.current)
      await client!.setUnsentPriorityFee(noteId, priorityFeeMicroLamports);
    const result = await client!.advance(noteId); recordEvent('sdk_' + result.state);
    status(`SDK result: ${result.state}. Continue explicitly if another step remains.`);
  });
  element('prove').onclick = run(async () => { status('Resuming the saved proof locally…'); await client!.resumeProof(noteId); recordEvent('proof_resumed'); status('Saved proof is ready.'); });
  element('retry-rejected').onclick = run(async () => {
    status('Verifying the saved rejection before preparing another attempt…');
    await client!.retryRejected(noteId);
    recordEvent('finalized_rejection_retried');
    status('Rejection verified. Continue the saved operation and review the new transaction in Phantom.');
  });
  element('refresh-create').onclick = run(async () => {
    status('Checking the expired setup against finalized chain history…');
    await client!.reconcileExpiredCreation(noteId);
    expiredSetupObserved = false;
    recordEvent('expired_setup_reconciled');
    status('Setup refreshed. Continue the saved operation and review the new signature in Phantom.');
  });
  element('withdraw').onclick = run(async () => { status('Verifying clearance and preparing withdrawal locally…'); await client!.beginWithdrawal(noteId, 'mutual_close', account!.address, roles()); recordEvent('withdrawal_prepared'); status('Mutual close prepared for the selected account.'); });
  element('provider-prepare').onclick = run(async () => { await requireBudget(); status('Preparing a new OpenAI authorization proof locally…');
    try { await provider!.prepare(noteId); } finally { await updateProviderBudget(); }
    responseObservation = null;
    element('provider-response').textContent = 'No response for this new request yet.';
    recordEvent('provider_authorization_prepared'); status('New authorization saved. Send promptly; a never-sent quote expires after 120 seconds.'); });
  element('provider-send').onclick = run(async () => { await requireBudget(); status('Submitting the saved authorization and one OpenAI request…');
    let result: Awaited<ReturnType<UiProvider['sendOnce']>>;
    try { result = await provider!.sendOnce(noteId); } finally { await updateProviderBudget(); }
    responseObservation = {operation_id: result.operationId, http_status: result.httpStatus, response_bytes: result.responseBytes, response_sha256: result.responseSha256};
    element('provider-response').textContent = result.text; recordEvent('provider_response_observed', result.operationId);
    status('Response received once. Recover / close the session to verify the signed charge and successor.'); });
  element('provider-close').onclick = run(async () => { try { status(await provider!.recoverClose(noteId)); recordEvent('provider_control_recovered'); } finally { await updateProviderBudget(); } });
  element('provider-reconcile').onclick = run(async () => { try { await provider!.reconcileAbsent(noteId); recordEvent('provider_absence_reconciled'); status('Terminal operation membership and signed successor verified.'); } finally { await updateProviderBudget(); } });
  const budgetRefresh = document.getElementById('provider-budget-refresh');
  if (budgetRefresh) budgetRefresh.onclick = run(async () => {
    await updateProviderBudget();
    status(providerBudget ? `${providerBudget.available_requests} more AI requests available. Saved funds and sessions are unchanged.`
      : 'API availability could not be checked. Try again when the connection is restored; recovery and withdrawal remain available.');
  });
  element('report').onclick = run(async () => {
    const report = {...(await summary()).observation, browser_user_agent: navigator.userAgent, events};
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    link.href = url; link.download = options.fixtureOnly ? 'wallet-ui-fixture-observations.json' : 'wallet-ui-observations.json'; link.click(); URL.revokeObjectURL(url);
  });
  status('Choose Phantom to connect.'); void refresh();
}
