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

export interface UiOptions {
  fixtureOnly: boolean; financialEnabled?: boolean; targetWallet: string; runId: string; manifest: VerifiedManifest;
  initialize(journal: EncryptedJournal<NoteJournal>, signer: V0Wallet): Promise<Omit<WalletOptions, 'journal' | 'wallets'> & {providerOptions?: Omit<UiProviderOptions, 'journal'>}>;
  fee(transaction: VersionedTransaction): Promise<number>;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const walletSelect = () => element<HTMLSelectElement>('wallet');
const accountSelect = () => element<HTMLSelectElement>('account');
const noteId = 'wallet-ui-acceptance';

/** UI intent only. All financial state lives in the existing SDK NoteJournal. */
export function mountWalletUi(options: UiOptions): void {
  const {manifest: m} = options, registry = getWallets();
  if (m.deployment_environment !== 'devnet' || m.setup_profile !== 'test_only'
    || m.genesis_hash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    || m.mint !== '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU') throw Error('explicit Circle USDC devnet test profile required');
  document.body.dataset.fixture = String(options.fixtureOnly);
  element('scope').textContent = options.fixtureOnly ? 'OFFLINE FIXTURE ONLY — no real extension, public RPC or proof validity acceptance.' : 'Chrome + Phantom · Solana devnet';
  element('pins').textContent = `Pool ${m.pool}\nManifest ${m.manifest_hash}\nRun ${options.runId}`;
  let wallet: (StandardWallet & {name: string; version: string}) | undefined;
  let account: StandardAccount | undefined, client: WalletClient | undefined, journal: EncryptedJournal<NoteJournal> | undefined;
  let provider: UiProvider | undefined;
  let busy = false, offEvents: (() => void) | undefined;
  const events: {at: string; event: string; operation_id?: string; attempts?: number}[] = [];
  const recordEvent = (event: string, operation_id?: string, attempts?: number) => events.push({at: new Date().toISOString(), event, ...(operation_id ? {operation_id} : {}), ...(attempts !== undefined ? {attempts} : {})});
  const status = (message: string) => { element('status').textContent = message; };
  const summary = async () => {
    const r = await journal?.read(noteId), w = r?.value.wallet;
    return {fixture_only: options.fixtureOnly, wallet: wallet?.name, wallet_standard_version: wallet?.version,
      installed_wallet_version: element<HTMLInputElement>('wallet-version').value.trim(), account: account?.address,
      journal_revision: r?.revision ?? null, wallet_status: w?.status ?? null,
      balance_micro_usdc: r?.value.state.balance_micro_usdc ?? null, permanent_clearance: !!w?.clearance,
      provider_case: provider?.configuration.testCase.id ?? null,
      provider_plan_sha256: provider?.configuration.planSha256 ?? null,
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
      finalized_transactions: [...(w?.history ?? []), ...(w?.operation ? [w.operation] : [])].flatMap(op => op.finalized),
      manifest_hash: m.manifest_hash, pool: m.pool, run_id: options.runId,
      live_provider_verified: false, wallet_UI_verified: false, independent_wallet_and_receipt_review_required: true, release_gates_passed: []};
  };
  const refresh = async () => {
    const s = await summary(); element('state').textContent = JSON.stringify(s, null, 2);
    const connected = options.financialEnabled !== false && !!(client && account && wallet?.accounts.includes(account));
    element<HTMLButtonElement>('deposit').disabled = busy || !connected || s.wallet_status !== null;
    element<HTMLButtonElement>('advance').disabled = busy || !connected || !s.operation || s.operation.phase === 'proving';
    element<HTMLButtonElement>('prove').disabled = busy || !connected || s.operation?.phase !== 'proving';
    element<HTMLButtonElement>('withdraw').disabled = busy || !connected || s.wallet_status !== 'active' || !!s.operation || !!s.session;
    const noteAvailable = connected && s.wallet_status === 'active' && !s.operation && !s.permanent_clearance;
    element<HTMLButtonElement>('provider-prepare').disabled = busy || !provider || !noteAvailable || !!s.session || s.verified_settlements.length !== 0;
    element<HTMLButtonElement>('provider-send').disabled = busy || !provider || !noteAvailable || !s.session || s.session.close_requested
      || s.session.phase === 'closing' || s.session.operations.some(o => o.phase !== 'prepared');
    element<HTMLButtonElement>('provider-close').disabled = busy || !provider || !connected || !s.session;
    element<HTMLButtonElement>('provider-reconcile').disabled = busy || !provider || !connected || s.session?.phase !== 'closing'
      || !s.session.operations.some(o => o.phase === 'send_unknown');
    element<HTMLButtonElement>('report').disabled = busy || !journal;
    element<HTMLButtonElement>('select').disabled = busy || !accountSelect().value;
    element<HTMLButtonElement>('connect').disabled = busy || !walletSelect().value;
  };
  const run = (action: () => Promise<void>) => async () => {
    if (busy) return; busy = true; await refresh();
    try { await action(); }
    catch (error) {
      let message = 'Operation stopped. 保存済み SDK 状態は保持されています。接続とウォレットを確認し、明示的に再開してください。';
      try {
        const pending = (await journal?.read(noteId))?.value.pending;
        if (pending?.phase === 'send_unknown' && !pending.closeRequested && pending.operations.length === 0)
          message = 'Operation stopped. AUTH の応答を確認できません。推論はまだ送信していません。「Send saved request once」は同じ保存済み AUTH だけを再確認し、ACTIVE 確認後に初めて推論を送信します。「Recover / close」は推論せず終了します。';
        else if (pending?.operations.some(op => op.phase === 'send_unknown'))
          message = 'Operation stopped. 推論は送信済み、または到達が不明です。再送できません。「Recover / close session」で署名付き精算を確認してください。';
        else if (pending?.phase === 'closing')
          message = 'Operation stopped. セッション終了・精算の確認が残っています。「Recover / close session」で同じ保存済み状態を回復してください。';
      } catch { /* Preserve a generic message if the journal itself cannot be authenticated. */ }
      status(message + (options.fixtureOnly && error instanceof Error ? ' Fixture diagnostic: ' + error.message : '')); recordEvent('action_failed');
    }
    finally { busy = false; await refresh(); }
  };
  const discover = () => {
    const selected = walletSelect().value; walletSelect().replaceChildren(new Option('Choose wallet', ''));
    for (const [i, w] of registry.get().entries()) if (w.name === options.targetWallet) walletSelect().append(new Option(w.name, String(i)));
    walletSelect().value = selected; if (walletSelect().value === '') walletSelect().selectedIndex = 0; void refresh();
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
    if (!element<HTMLInputElement>('wallet-version').value.trim()) throw Error('record installed wallet version');
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
        status('Review the signature request in Phantom.');
        try { const signed = await adapter.signTransaction(tx); recordEvent('signature_returned', op?.id); return signed; }
        catch { recordEvent('signature_not_returned', op?.id, op?.attempts.length); throw Error('wallet signature not returned'); }
      }};
    const initialized = await options.initialize(journal, signer);
    const initializedProvider = initialized.providerOptions ? new UiProvider({...initialized.providerOptions, journal}) : undefined;
    client = new WalletClient({...initialized, journal, wallets: [signer]});
    provider = initializedProvider;
    element('provider-scope').textContent = provider
      ? `${provider.configuration.testCase.model} · one fixed prompt · at most ${provider.configuration.testCase.max_cost_micro_usdc} micro-USDC reserved by the host. The proxy operator can read this request and response.`
      : 'OpenAI acceptance is not configured for this run. Wallet recovery remains available.';
    element('identity').textContent = `${wallet.name} / ${account.address}`;
    status('Account selected. Existing encrypted note state reopened.'); recordEvent('account_selected');
  });
  const roles = (): WalletRoles => { if (!account) throw Error('no account'); const key = account.address; return {uploader: key, rentPayer: key, feePayer: key, payer: key, tokenOwner: key}; };
  element('deposit').onclick = run(async () => { status('Preparing the deposit proof locally…'); await client!.beginDeposit(noteId, '1000000', roles()); recordEvent('deposit_prepared'); status('Deposit prepared. Continue to request the first signature.'); });
  element('advance').onclick = run(async () => { const result = await client!.advance(noteId); recordEvent('sdk_' + result.state); status(`SDK result: ${result.state}. Continue explicitly if another step remains.`); });
  element('prove').onclick = run(async () => { status('Resuming the saved proof locally…'); await client!.resumeProof(noteId); recordEvent('proof_resumed'); status('Saved proof is ready.'); });
  element('withdraw').onclick = run(async () => { status('Verifying clearance and preparing withdrawal locally…'); await client!.beginWithdrawal(noteId, 'mutual_close', account!.address, roles()); recordEvent('withdrawal_prepared'); status('Mutual close prepared for the selected account.'); });
  element('provider-prepare').onclick = run(async () => { status('Preparing the OpenAI authorization proof locally…'); await provider!.prepare(noteId); recordEvent('provider_authorization_prepared'); status('Authorization saved. Send promptly; a never-sent quote expires after 120 seconds.'); });
  element('provider-send').onclick = run(async () => { status('Submitting the saved authorization and one OpenAI request…'); const result = await provider!.sendOnce(noteId);
    element('provider-response').textContent = result.text; recordEvent('provider_response_observed', result.operationId);
    status('Response received once. Recover / close the session to verify the signed charge and successor.'); });
  element('provider-close').onclick = run(async () => { status(await provider!.recoverClose(noteId)); recordEvent('provider_control_recovered'); });
  element('provider-reconcile').onclick = run(async () => { await provider!.reconcileAbsent(noteId); recordEvent('provider_absence_reconciled'); status('Terminal operation membership and signed successor verified.'); });
  element('report').onclick = run(async () => {
    const report = {...await summary(), browser_user_agent: navigator.userAgent, events};
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'}));
    link.href = url; link.download = options.fixtureOnly ? 'wallet-ui-fixture-observations.json' : 'wallet-ui-observations.json'; link.click(); URL.revokeObjectURL(url);
  });
  status('Choose Phantom to connect.'); void refresh();
}
