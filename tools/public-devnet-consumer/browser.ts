/** Application-owned browser adapter. Bundle with the installed SDK and worker. */
import { address } from '@solana/kit';
import { createBrowserClient, walletStandardAdapter,
  type StandardWallet, type StandardAccount } from '@zkapi/solana-sdk/browser';
import { loadPublicDeploymentProfile, preflightPublicDeployment,
  publicProfileClientOptions, PublicProfileError,
  type PublicPreflightResult } from '@zkapi/solana-sdk/public-profile';
import { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';

export async function openChat(input: {
  profileUrl: string; profileSha256: string;
  /** Optional operator invitation, entered by the user. Memory only; never put
   * this value in the profile, URL, browser storage, diagnostics or logs. */
  admissionToken?: string;
  /** Trusted application transport; it must not log invitation headers. */
  fetch?: typeof fetch;
  selectedWallet: StandardWallet; selectedAccount: StandardAccount;
  storageName: string; noteId: string; initializeStorage?: boolean;
  createWorker(): Worker;
}) {
  let admissionToken = input.admissionToken;
  if (admissionToken !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(admissionToken)) throw new Error('Invalid invitation format.');
    const bytes = atob(admissionToken.replace(/-/g, '+').replace(/_/g, '/') + '=');
    if (bytes.length !== 32 || btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== admissionToken)
      throw new Error('Invalid invitation format.');
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  // The destination is learned only after independent profile/bundle/manifest
  // authentication. Asset and preflight reads never receive the invitation.
  let controlSessionUrl: string | undefined;
  const scopedFetch: typeof fetch = (resource, init) => {
    const request = resource instanceof Request ? resource : undefined;
    const url = request ? request.url : String(resource);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete('x-zkapi-admission');
    if (admissionToken !== undefined && controlSessionUrl !== undefined && url === controlSessionUrl && method === 'POST')
      headers.set('x-zkapi-admission', admissionToken);
    return fetcher(resource, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  };
  const wallet = walletStandardAdapter(input.selectedWallet, input.selectedAccount, 'solana:devnet');
  const destinationOwner = address(input.selectedAccount.address);
  const bindingKey = JSON.stringify(['zkapi-public-profile-v1', input.storageName, wallet.publicKey]);
  const installed = localStorage.getItem(bindingKey);
  if (installed === null && !input.initializeStorage)
    throw new Error('Original profile binding is missing. Restore it, or explicitly create storage for a new wallet.');
  const loaded = await loadPublicDeploymentProfile(input.profileUrl, {
    profileSha256: input.profileSha256, installedProfileSha256: installed ?? undefined, fetch: scopedFetch });
  controlSessionUrl = loaded.assets.verifiedManifest.control_api_origin + '/zkapi/v1/sessions';
  let preflight: PublicPreflightResult | null = null;
  let unavailableComponent: string | null = null;
  const refreshPreflight = async () => {
    try { preflight = await preflightPublicDeployment(loaded); unavailableComponent = null; }
    catch (error) {
      preflight = null;
      unavailableComponent = error instanceof PublicProfileError ? error.component : 'unavailable';
      if (installed === null) throw error;
    }
    return { preflight, unavailableComponent };
  };
  // Existing custody must still open for explicit recovery/withdrawal when a
  // provider catalog or admission diagnostic is unavailable. The factory still
  // verifies original assets, trust and finalized chain state before use.
  await refreshPreflight();
  // Preserve the original profile binding even if later initialization fails.
  // A profile update is an explicit migration, never an automatic new binding.
  await navigator.locks.request(bindingKey, { mode: 'exclusive' }, () => {
    const current = localStorage.getItem(bindingKey);
    if (current !== null && current !== loaded.profileSha256)
      throw new Error('The original profile binding changed. Reopen the original profile.');
    if (current === null) {
      if (!input.initializeStorage) throw new Error('Original profile binding is missing.');
      localStorage.setItem(bindingKey, loaded.profileSha256);
    }
  });
  const assets = loaded.assets;
  const opened = await createBrowserClient({ ...publicProfileClientOptions(loaded), wallet,
    noteId: input.noteId, storageName: input.storageName,
    initializeStorage: input.initializeStorage, createWorker: input.createWorker,
    wasm: assets.wasm, wasmSha256: assets.wasmSha256 });
  const { client } = opened;
  return {
    ...opened, refreshPreflight,
    dispose() { opened.dispose(); admissionToken = undefined; },
    get diagnostic() { return { preflight, unavailableComponent }; },
    // Invoke each of these only from the corresponding explicit user action.
    fund: (microUsdc: string) => client.prepareDeposit(microUsdc),
    advance: () => client.advanceWallet(),
    resumeProof: () => client.resumeWalletProof(),
    recover: () => client.recover(),
    withdraw: () => client.prepareWithdrawal(destinationOwner, 'mutual_close'),
    async send(input: { operationId: string; model: string;
      messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
      maxOutputTokens: number; stream: boolean; signal?: AbortSignal;
      onDelta(text: string): void }) {
      if (!preflight?.chainAllowsNewOperations || !(await client.status()).canRequest)
        throw new Error('Refresh connectivity, funding or explicit recovery before sending.');
      const response = await client.chat(input);
      let text = '';
      if (input.stream) {
        for await (const delta of readChatDeltas(response)) { text += delta; input.onDelta(delta); }
      } else { text = await readChatText(response); input.onDelta(text); }
      return { text, status: await client.status() };
    },
  };
}
