import type { ClientStatus, InferenceApi, ZkApiClient } from '@zkapi/solana-sdk';
import type { StandardAccount, StandardWallet } from '@zkapi/solana-sdk/browser';
import type { connectChat } from './integration.ts';
import type { DevnetAdmission, ReviewedChatProfile } from './load-deployment.ts';
import { Conversation, canLeaveNote, formatUsdc, microUsdc, modeName, privacyNotice } from './chat-model.ts';
import { shell } from './shell.ts';

export interface BrowserWallet extends StandardWallet { name: string }
type UiClient = Pick<ZkApiClient, 'status' | 'subscribe' | 'listModels' | 'chat' | 'request' | 'prepareDeposit' | 'prepareWithdrawal'
  | 'advanceWallet' | 'resumeWalletProof' | 'retryRejectedWalletOperation' | 'recoverExpiredWalletSetup'
  | 'fallbackToEscape' | 'prepareFinalizeEscape' | 'recover' | 'settle' | 'cancelUnsentAuthorization' | 'reconcileAbsentOperations' | 'reconcileUnacceptedAuthorization'
  | 'prepareEmergencyEscape' | 'reconcileChallengedEscape'>;
export interface AppServices {
  profiles: readonly ReviewedChatProfile[];
  wallets(): readonly BrowserWallet[];
  connect(options: Parameters<typeof connectChat>[0]): Promise<{ client: UiClient; persistence?: 'persistent' | 'best_effort' | 'unknown'; admission?(): Promise<DevnetAdmission>; dispose(): void }>;
}

/** Dependency injection is for local verification; main.ts installs only the real SDK. */
export function mountChat(root: HTMLElement, services: AppServices): { dispose(): void } {
  root.innerHTML = shell;
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const value = root.querySelector<T>(`#${id}`); if (!value) throw new Error('Missing app element'); return value;
  };
  const input = (id: string) => el<HTMLInputElement>(id);
  const select = (id: string) => el<HTMLSelectElement>(id);
  const button = (id: string) => el<HTMLButtonElement>(id);
  const note = (message: string, error = false) => { el('notice').textContent = message; el('notice').classList.toggle('error', error); };
  const conversation = new Conversation();
  let wallets: readonly BrowserWallet[] = [], connectedWallet: BrowserWallet | undefined;
  let opened: Awaited<ReturnType<AppServices['connect']>> | undefined;
  let latest: ClientStatus | undefined, working = false, unsubscribe: (() => void) | undefined;
  let admission: DevnetAdmission | null | undefined, admissionRead: Promise<void> | undefined;
  let disposed = false;
  const getProfile = () => services.profiles.find(p => p.id === select('profile').value);
  const selectedWallet = () => wallets[Number(select('wallet').value)];
  const selectedAccount = (): StandardAccount | undefined => select('account').value === '' ? undefined : connectedWallet?.accounts[Number(select('account').value)];
  const addOption = (target: HTMLSelectElement, value: string, text: string) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text; target.append(option);
  };
  const clearOptions = (target: HTMLSelectElement, text: string) => { target.replaceChildren(); addOption(target, '', text); };
  for (const profile of services.profiles) addOption(select('profile'), profile.id, `${profile.label} · ${modeName(profile.mode)}`);
  if (new Set(services.profiles.map(p => p.id)).size !== services.profiles.length) throw new Error('Reviewed profile IDs must be unique.');
  el('profile-state').textContent = services.profiles.length
    ? 'Configuration and trust pins are installed in this app build. Selecting a profile does not authorize a request.'
    : 'No reviewed deployment is installed. Ask the operator for a configured devnet build. No network request or wallet prompt has been made.';
  // Public locator preferences only: no transcript, keys, signatures or financial state.
  try {
    const saved = JSON.parse(localStorage.getItem('zkapi-browser-chat-locator-v1') ?? 'null');
    if (saved && typeof saved.storageName === 'string' && saved.storageName.length <= 100 && typeof saved.noteId === 'string' && saved.noteId.length <= 100) {
      input('storage-name').value = saved.storageName; input('note-id').value = saved.noteId;
      if (services.profiles.some(p => p.id === saved.profile)) select('profile').value = saved.profile;
    }
  } catch { /* Preferences are optional; never reset custody when unavailable. */ }

  const newWorkAvailable = () => !opened?.admission || !!admission?.allowTransactions && admission.available_requests > 0;
  function showAdmission() {
    el('admission').textContent = !opened?.admission ? 'No local campaign admission hint for this profile.'
      : admission === undefined ? 'Checking local campaign availability before new funding or requests…'
      : admission === null ? 'Campaign availability is unavailable. New deposits and requests are disabled. Refresh to check again; saved-state recovery and withdrawal remain available.'
      : `${admission.allowTransactions ? '' : 'Host is read-only. '}Capacity: ${admission.available_requests} new request(s), within ${admission.remaining_requests} remaining request slots. `
        + `Worst-case reservation per new session: ${formatUsdc(admission.request_max_cost_micro_usdc)} USDC; unreserved campaign budget: ${formatUsdc(admission.remaining_micro_usdc)} USDC. `
        + 'Reservations are not actual charges. The host checks and reserves again at authorization; recovery and withdrawal do not require a new reservation.';
  }
  async function refreshAdmission() {
    const current = opened;
    if (!current?.admission) {admission = undefined; showAdmission(); return;}
    if (!admissionRead) {
      admissionRead = (async () => {
        let next: DevnetAdmission | null;
        try {next = await current.admission!();} catch {next = null;}
        if (opened === current) {admission = next; showAdmission(); updateControls();}
      })().finally(() => {admissionRead = undefined;});
    }
    await admissionRead;
  }

  function updateControls() {
    const busy = working || conversation.busy || !!latest?.busy;
    const profile = getProfile(), account = selectedAccount();
    const readyToOpen = !!profile && !!account && input('privacy-ack').checked && !!input('note-id').value.trim() && !!input('storage-name').value.trim();
    for (const id of ['profile', 'wallet', 'account', 'privacy-ack', 'storage-name', 'note-id']) {
      (el(id) as HTMLInputElement).disabled = busy || !!opened;
    }
    button('scan-wallets').disabled = busy || !!opened || !profile;
    button('connect-wallet').disabled = busy || !!opened || !select('wallet').value;
    button('open-note').disabled = button('create-note').disabled = busy || !!opened || !readyToOpen;
    button('close-note').disabled = busy || !opened || !canLeaveNote(latest);
    button('refresh').disabled = !opened || working;
    select('model').disabled = busy || !opened;
    select('api').disabled = busy || !opened || !select('model').value;
    input('max-tokens').disabled = input('stream').disabled = busy || !opened;
    (el('message') as HTMLTextAreaElement).disabled = busy || !latest?.canRequest || !select('model').value || !select('api').value;
    button('send').disabled = busy || !newWorkAvailable() || !latest?.canRequest || !select('model').value || !select('api').value;
    button('cancel').disabled = !conversation.busy;
    button('clear-chat').disabled = conversation.busy;
    const usable = !!opened && !!latest && !busy;
    button('deposit').disabled = !usable || !newWorkAvailable() || latest?.wallet !== 'empty';
    input('deposit-amount').disabled = button('deposit').disabled;
    button('advance').disabled = !usable || !latest?.walletOperation || latest.walletOperation.phase === 'failed' || latest.walletOperation.phase === 'proving';
    button('resume-proof').disabled = !usable || latest?.walletOperation?.phase !== 'proving';
    button('retry-rejected').disabled = !usable || !['failed', 'stale'].includes(latest?.walletOperation?.phase ?? '');
    button('recover-setup').disabled = !usable || !latest?.walletOperation;
    for (const id of ['recover', 'settle', 'reconcile']) button(id).disabled = !usable || !latest?.session || latest.emergencyEscape?.phase === 'escaping';
    button('cancel-unsent').disabled = !usable || latest?.session?.phase !== 'prepared';
    button('clear-unaccepted').disabled = !usable || latest?.canReconcileUnacceptedAuthorization !== true;
    button('emergency-escape').disabled = !usable || latest?.canPrepareEmergencyEscape !== true;
    button('reconcile-escape').disabled = !usable || latest?.canReconcileChallengedEscape !== true;
    const withdraw = usable && latest?.wallet === 'active' && !latest.walletOperation && !latest.session
      && (!latest.emergencyEscape || latest.emergencyEscape.phase === 'settled');
    button('withdraw').disabled = button('escape').disabled = !withdraw;
    button('fallback').disabled = !usable || latest?.walletOperation?.kind !== 'mutual_close';
    button('finalize').disabled = !usable || latest?.wallet !== 'pending_escape' || !!latest.walletOperation;
    input('destination').disabled = !withdraw && button('emergency-escape').disabled;
    el('send-state').textContent = conversation.busy ? 'Receiving response; settlement follows consumption or cancellation.'
      : latest?.wallet === 'closed' ? 'This note is closed. Close this view to select a new local note; the saved history is retained.'
      : latest?.session || latest?.walletOperation || latest?.emergencyEscape?.phase === 'escaping' ? 'Saved work requires recovery before another send.'
      : opened?.admission && !newWorkAvailable() ? 'New funding and requests require available campaign capacity and an enabled host. Existing recovery remains available.'
      : latest?.canRequest ? (select('model').value && select('api').value ? 'Ready for an explicit new request.' : 'Select a configured model and API.')
      : 'Open and fund an unexpired note with at least the authorization cap.';
  }
  function showStatus(status: ClientStatus) {
    latest = status;
    el('balance').textContent = formatUsdc(status.settledBalanceMicroUsdc);
    el('cap').textContent = `${formatUsdc(status.authorizationCapMicroUsdc)} USDC`;
    el('charge').textContent = status.lastSettlement ? `${formatUsdc(status.lastSettlement.chargeMicroUsdc)} USDC` : 'No signed settlement';
    el('wallet-state').textContent = status.wallet;
    el('expiry').textContent = status.expiry?.message ?? 'Note expiry will appear after deposit preparation.';
    const parts = [`Note: ${status.noteId}`, `Mode: ${modeName(status.mode)}`];
    if (status.walletOperation) {
      parts.push(`Wallet operation: ${status.walletOperation.kind} · ${status.walletOperation.phase}`);
      if (status.walletOperation.destinationOwner) parts.push(`Saved destination owner: ${status.walletOperation.destinationOwner}`);
      if (status.walletOperation.signature) parts.push(`Saved signature: ${status.walletOperation.signature}`);
    }
    if (status.session) {
      parts.push(`Saved session: ${status.session.id} · ${status.session.phase}`);
      for (const operation of status.session.operations) parts.push(`Operation: ${operation.id} · ${operation.phase}`);
    }
    if (status.emergencyEscape) parts.push(status.wallet === 'closed'
      ? 'Emergency withdrawal finalized. Original authorization and operations remain archived; this is not a signed API settlement.'
      : `Emergency escape archive: ${status.emergencyEscape.phase}. Original authorization and operations remain saved.`);
    if (!status.session && !status.walletOperation) parts.push(status.wallet === 'closed' ? 'No further wallet recovery is required for this closed note.'
      : status.emergencyEscape && status.emergencyEscape.phase !== 'settled'
      ? 'No active session or wallet step. Emergency escape remains unresolved.'
      : 'No pending session or wallet operation.');
    el('pending').textContent = parts.join('\n');
    updateControls();
  }
  async function refresh() {
    if (!opened) return;
    try { showStatus(await opened.client.status()); await refreshAdmission(); }
    catch { latest = undefined; updateControls(); note('Saved status could not be read. Keep this origin, wallet and storage intact; do not create a replacement note.', true); }
  }
  async function action(label: string, run: () => Promise<void>, success: string) {
    if (working || conversation.busy || latest?.busy) return;
    working = true; updateControls(); note(`${label}…`);
    try { await run(); note(success); }
    catch { note(`${label} did not complete. Inspect the saved state and use the matching recovery action. No inference retry or mode switch was performed.`, true); }
    finally { working = false; await refresh(); updateControls(); }
  }
  function profileChanged() {
    input('privacy-ack').checked = false;
    const profile = getProfile();
    el('privacy').textContent = profile ? privacyNotice(profile.mode) : 'Select a mode to review who can read your content.';
    connectedWallet = undefined; clearOptions(select('account'), 'Connect and choose an account');
    updateControls();
  }
  select('profile').addEventListener('change', profileChanged);
  for (const id of ['privacy-ack', 'storage-name', 'note-id']) input(id).addEventListener('input', updateControls);
  button('scan-wallets').addEventListener('click', () => {
    wallets = services.wallets().filter(w => w.features['standard:connect'] && w.features['solana:signTransaction']?.supportedTransactionVersions.includes(0));
    connectedWallet = undefined; clearOptions(select('wallet'), wallets.length ? 'Choose a wallet' : 'No compatible wallet found');
    clearOptions(select('account'), 'Connect and choose an account');
    wallets.forEach((wallet, index) => addOption(select('wallet'), String(index), wallet.name)); updateControls();
    note(wallets.length ? 'Select a wallet, then connect and choose its account.' : 'Install a Wallet Standard wallet with Solana v0 support, then find wallets again.');
  });
  select('wallet').addEventListener('change', () => { connectedWallet = undefined; clearOptions(select('account'), 'Connect and choose an account'); updateControls(); });
  button('connect-wallet').addEventListener('click', () => void action('Connecting wallet', async () => {
    const wallet = selectedWallet(), profile = getProfile();
    if (!wallet || !profile) throw new Error('Select a profile and wallet.');
    const feature = wallet.features['standard:connect'] as { connect(): Promise<unknown> } | undefined;
    if (!feature) throw new Error('Wallet cannot connect.');
    await feature.connect(); connectedWallet = wallet;
    clearOptions(select('account'), 'Choose an account');
    wallet.accounts.forEach((account, index) => {
      if (account.chains.includes(profile.chain) && account.features.includes('solana:signTransaction')) addOption(select('account'), String(index), account.address);
    });
  }, 'Wallet connected. Explicitly select the account to use.'));
  select('account').addEventListener('change', () => { input('destination').value = selectedAccount()?.address ?? ''; updateControls(); });
  function open(initializeStorage: boolean) {
    void action(initializeStorage ? 'Creating browser custody' : 'Opening saved browser custody', async () => {
      const profile = getProfile(), wallet = connectedWallet, account = selectedAccount();
      if (!profile || !wallet || !account || !input('privacy-ack').checked || !select('account').value) throw new Error('Explicit setup required.');
      const storageName = input('storage-name').value.trim(), noteId = input('note-id').value.trim();
      if (!storageName || !noteId) throw new Error('Stable storage and note IDs required.');
      opened = await services.connect({ profile, mode: profile.mode, wallet, account, chain: profile.chain, storageName, noteId, initializeStorage });
      admission = undefined; showAdmission();
      el('storage-status').textContent = opened.persistence === 'persistent'
        ? 'Browser persistence granted. Clearing site data or losing this device can still lose access to the note; portable backup is unavailable.'
        : 'Browser storage is not confirmed persistent and may be evicted. Keep this origin and browser profile intact; clearing site data or device loss can lose access. Portable backup is unavailable.';
      const initial = await opened.client.status();
      if (initial.wallet === 'empty') input('deposit-amount').value = formatUsdc((2n * BigInt(initial.authorizationCapMicroUsdc)).toString());
      unsubscribe = opened.client.subscribe(showStatus);
      clearOptions(select('model'), 'Choose a configured model');
      for (const model of opened.client.listModels()) addOption(select('model'), model.id, model.label ?? model.id);
      try { localStorage.setItem('zkapi-browser-chat-locator-v1', JSON.stringify({ profile: profile.id, storageName, noteId })); } catch { /* Optional public preferences. */ }
    }, 'Note opened. Initialization did not authorize inference or submit a financial transaction.');
  }
  button('open-note').addEventListener('click', () => open(false));
  button('create-note').addEventListener('click', () => open(true));
  button('close-note').addEventListener('click', () => void action('Closing local view', async () => {
    if (!opened || !canLeaveNote(await opened.client.status())) throw new Error('Keep the funded or unresolved note selected.');
    opened.dispose(); unsubscribe?.(); unsubscribe = undefined; opened = undefined; latest = undefined;
    admission = undefined; showAdmission();
    conversation.clear(); renderConversation();
    el('balance').textContent = el('cap').textContent = el('charge').textContent = '—';
    el('wallet-state').textContent = 'Not open'; el('pending').textContent = 'No note open.';
    el('expiry').textContent = 'Note expiry will appear after deposit preparation.';
    el('wallet-result').textContent = ''; clearOptions(select('model'), 'Open a note first'); clearOptions(select('api'), 'Choose a model first');
  }, 'Local view closed. The encrypted journal is retained. You can explicitly select another note ID.'));
  button('refresh').addEventListener('click', () => void refresh());
  select('model').addEventListener('change', () => {
    clearOptions(select('api'), 'Choose a configured API');
    const names = { chat: 'Chat Completions', responses: 'OpenAI Responses', messages: 'Anthropic Messages' };
    for (const api of opened?.client.listModels().find(m => m.id === select('model').value)?.apis ?? []) addOption(select('api'), api, names[api]);
    updateControls();
  });
  select('api').addEventListener('change', updateControls);
  button('deposit').addEventListener('click', () => {
    let amount: string;
    try { amount = microUsdc(input('deposit-amount').value.trim()); }
    catch { note('Enter a positive USDC amount with at most six decimal places; exponent notation is not supported.', true); return; }
    void action('Preparing deposit', async () => {
      await refreshAdmission(); if (!newWorkAvailable()) throw new Error('New deposit admission unavailable');
      await opened!.client.prepareDeposit(amount);
    }, 'Deposit prepared. Continue the saved wallet step to approve and finalize funding.');
  });
  const actions: [string, string, (client: UiClient) => Promise<unknown>, string][] = [
    ['advance', 'Continuing saved wallet step', async client => {
      const result = await client.advanceWallet();
      el('wallet-result').textContent = `Last wallet result: ${result.state}. ${result.state === 'complete' ? 'Finalized state verified.' : 'Inspect saved state before continuing.'}`;
    }, 'Wallet step finished. Check the verified state; another explicit step may be required.'],
    ['resume-proof', 'Resuming saved proof', client => client.resumeWalletProof(), 'Saved proof step finished. Check status.'],
    ['recover', 'Recovering saved session', client => client.recover(), 'Recovery finished. Inspect whether settlement is still pending. No inference was replayed.'],
    ['settle', 'Requesting settlement', client => client.settle(), 'Settlement attempt finished. Check the signed charge and remaining pending state.'],
    ['cancel-unsent', 'Cancelling never-sent authorization', client => client.cancelUnsentAuthorization(), 'Never-sent authorization cancellation checked. Inspect status.'],
    ['clear-unaccepted', 'Requesting permanent authorization clearance', client => client.reconcileUnacceptedAuthorization(), 'Signed permanent clearance verified. The saved authorization is archived. Choose a withdrawal action; no inference was replayed.'],
    ['reconcile-escape', 'Checking challenged escape', client => client.reconcileChallengedEscape(), 'Finalized challenge verified. The original session is restored for settlement. Recover or settle it before any new request; no inference was replayed.'],
    ['reconcile', 'Reconciling absent operations', client => client.reconcileAbsentOperations(), 'Authenticated operation reconciliation finished. Inspect status.'],
    ['retry-rejected', 'Reviewing finalized rejection', client => client.retryRejectedWalletOperation(), 'Rejected operation recovery prepared. Continue the saved wallet step.'],
    ['recover-setup', 'Checking expired setup', client => client.recoverExpiredWalletSetup(), 'Expired setup recovery checked. Inspect the saved state.'],
    ['fallback', 'Preparing explicit escape fallback', client => client.fallbackToEscape(), 'Escape fallback prepared. Continue the saved wallet step.'],
    ['finalize', 'Checking escape finalization deadline', client => client.prepareFinalizeEscape(), 'Finalization prepared. Continue the saved wallet step.'],
  ];
  for (const [id, label, run, success] of actions) button(id).addEventListener('click', () => void action(label, async () => { await run(opened!.client); }, success));
  for (const [id, mode] of [['withdraw', 'mutual_close'], ['escape', 'initiate_escape']] as const) {
    button(id).addEventListener('click', () => {
      const destination = input('destination').value.trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destination)) { note('Enter the destination Solana wallet owner address.', true); return; }
      void action('Preparing withdrawal', () => opened!.client.prepareWithdrawal(destination, mode), 'Withdrawal prepared. Check its saved destination and continue the wallet steps.');
    });
  }
  button('emergency-escape').addEventListener('click', () => {
    const destination = input('destination').value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destination)) { note('Enter the destination Solana wallet owner address.', true); return; }
    void action('Preparing emergency escape', () => opened!.client.prepareEmergencyEscape(destination), 'Emergency escape prepared from the last verified state. The original pending work remains archived and new sends are blocked. Continue the saved wallet steps; an on-chain challenge can require settlement before withdrawal.');
  });
  function renderConversation() {
    const transcript = el('transcript'); transcript.replaceChildren();
    if (!conversation.turns.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Your conversation will appear here.'; transcript.append(empty); }
    for (const turn of conversation.turns) {
      const section = document.createElement('section'); section.className = 'turn';
      for (const [role, text] of [['user', turn.user], ['assistant', turn.assistant || (turn.outcome === 'receiving' ? 'Waiting for response…' : 'No complete response received.')]]) {
        const label = document.createElement('p'); label.className = 'message-label'; label.textContent = role;
        const body = document.createElement('div'); body.className = `message ${role}`; body.textContent = text; section.append(label, body);
      }
      const info = document.createElement('p'); info.className = 'operation'; info.textContent = `${turn.model} · ${turn.api} · ${turn.outcome} · operation ${turn.operationId}`; section.append(info); transcript.append(section);
    }
    transcript.scrollTop = transcript.scrollHeight;
    updateControls();
  }
  el('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!opened || working || conversation.busy || !latest?.canRequest || !select('model').value || !select('api').value) return;
    const text = (el('message') as HTMLTextAreaElement).value, maxOutputTokens = Number(input('max-tokens').value);
    if (!text.trim() || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) {
      note('Enter a message and a maximum output of 1 to 32768 tokens.', true); return;
    }
    const api = select('api').value as InferenceApi;
    if (!opened.client.listModels().find(m => m.id === select('model').value)?.apis.includes(api)) return;
    working = true; updateControls();
    void (async () => {
      await refreshAdmission();
      if (!newWorkAvailable()) {
        note('New request unavailable. Refresh campaign availability or recover existing saved work. No authorization or inference was submitted.', true); return;
      }
      const request = conversation.send(opened!.client, { text, model: select('model').value, api, maxOutputTokens, stream: input('stream').checked }, renderConversation);
      working = false; updateControls(); note('Request in progress. You can cancel; provider work may still incur a charge.');
      (el('message') as HTMLTextAreaElement).value = '';
      await request.then(() => note('Response consumption finished. Check the verified settlement and any pending work.'),
        () => note('Response interrupted or cancelled. Inspect saved status and recover pending work; inference was not replayed.', true));
    })().finally(async () => { working = false; await refresh(); updateControls(); });
  });
  button('cancel').addEventListener('click', () => { conversation.cancel(); note('Cancellation requested. Waiting for response cleanup and settlement attempt.'); });
  button('clear-chat').addEventListener('click', () => { conversation.clear(); renderConversation(); note('Conversation display cleared. Saved request bodies, including prompts and prior turns, remain in the encrypted financial journal. Pending operations are retained.'); });
  const timer = setInterval(() => { if (!disposed && !working) void refresh(); }, 10_000);
  // Never try to settle asynchronously during unload. The SDK's saved journal is
  // reopened explicitly, and the user decides which recovery action to run.
  const unload = (event: BeforeUnloadEvent) => { if (conversation.busy || latest && !canLeaveNote(latest)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  profileChanged(); updateControls();
  return { dispose() {
    if (conversation.busy || working || latest?.busy) throw new Error('Finish the active action before disposal.');
    opened?.dispose(); unsubscribe?.(); disposed = true; clearInterval(timer); window.removeEventListener('beforeunload', unload); root.replaceChildren();
  } };
}
