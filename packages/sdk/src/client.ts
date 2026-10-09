/** Application API over the existing wallet, control client and clientd lifecycle.
 * Only the encrypted NoteJournal owns financial state. No inference retries. */
import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { decodeRpcAccount, safeRpcNumber } from './solana-rpc.ts';
import { ClientDaemon } from './clientd-bridge.ts';
import { ControlClient, validateNoteJournal, verifiedClientBundle, expiryNotice,
  PROXY_PRIVACY_NOTICE, DIRECT_OPENROUTER_PRIVACY_NOTICE, DIRECT_PRIVACY_NOTICE, type ClientOptions, type Mode, type NoteJournal, type Quote, type Tariff } from './control.ts';
import { ProverSessionVerifier } from './control-prover.ts';
import { EncryptedJournal, type AtomicJournalStore } from './journal.ts';
import { NoteProver, type ClientProver } from './prover.ts';
import { connectionTransport, type V0Wallet, type TransactionPreparationCommitment } from './transport.ts';
import { verifyManifest, jcsBytes, sha256Hex, type ArtifactBundle, type ManifestTrustPolicy, type VerifiedManifest } from './trust.ts';
import { WalletClient, type WalletOptions } from './wallet.ts';
import { SolanaWalletChain } from './wallet-chain.ts';
import { authorizationSnapshot } from './session-snapshot.ts';
import { validateDaemonModelPolicy, validateModelRequestCapabilities } from './clientd-models.ts';

export type { Mode, Tariff, ManifestTrustPolicy, ArtifactBundle, V0Wallet, ClientProver };
export type InferenceApi = 'chat' | 'responses' | 'messages';
const paths: Record<InferenceApi, string> = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };

/** An operator-reviewed list, not discovery of every model on OpenRouter. */
export interface ModelConfiguration {
  id: string;
  label?: string;
  provider: Quote['body']['provider'];
  apis: readonly InferenceApi[];
  tariff: Tariff;
  capabilities?: { streaming: boolean; tools: boolean };
}
export type ModelInfo = Omit<ModelConfiguration, 'tariff'>;
export interface ClientStorage { store: AtomicJournalStore; key: CryptoKey }
export interface ClientDeployment {
  manifest: Uint8Array;
  /** Install independently of the fetched manifest. */
  trust: ManifestTrustPolicy;
  artifacts: ArtifactBundle;
  connection: Rpc<SolanaRpcApi>;
  indexerOrigin: string;
  fetch?: typeof globalThis.fetch;
  preparationCommitment?: TransactionPreparationCommitment;
}
export interface CreateClientOptions {
  deployment: ClientDeployment;
  storage: ClientStorage;
  prover: ClientProver;
  /** An already selected signer. Creating a client never connects a wallet. */
  wallet: V0Wallet;
  /** Stable local ID. Reopen this ID after reload; do not replace an unresolved note. */
  noteId: string;
  mode: Mode;
  models: readonly ModelConfiguration[];
  /** Direct default: reuse the 300-second lease, renewing with 90 seconds left.
   * Set 0 for per-request settlement or 1–300 for a fixed reuse window. */
  keyReuseSeconds?: number;
  directProviderBases?: ClientOptions['directProviderBases'];
  oaVerifier?: ClientOptions['oaVerifier'];
  priorityFeeMicroLamports?: bigint;
}
export interface ClientStatus {
  noteId: string;
  mode: Mode;
  wallet: 'empty' | 'unfunded' | 'active' | 'pending_escape' | 'closed';
  /** Last verified balance; active usage is deducted when its lease settles. */
  settledBalanceMicroUsdc: string;
  authorizationCapMicroUsdc: string;
  canRequest: boolean;
  /** Visibility hint only. Recovery still verifies the saved AUTH and signed permanent clearance. */
  canReconcileUnacceptedAuthorization: boolean;
  /** Explicit challengeable escape remains separate from ordinary withdrawal. */
  canPrepareEmergencyEscape: boolean;
  canReconcileChallengedEscape: boolean;
  emergencyEscape: { phase: 'escaping' | 'challenged' | 'settled' } | null;
  busy: boolean;
  session: { id: string; phase: string; operations: { id: string; phase: string }[] } | null;
  walletOperation: { kind: string; phase: string; signature: string | null; destinationOwner: string | null } | null;
  expiry: ReturnType<typeof expiryNotice> | null;
  lastSettlement: { chargeMicroUsdc: string; operationIds: string[] } | null;
  privacyNotice: string;
}
export class ClientActionError extends Error {
  readonly code: 'busy' | 'not_ready' | 'invalid_request' | 'closed';
  constructor(code: ClientActionError['code'], message: string) {
    super(message); this.name = 'ClientActionError'; this.code = code;
  }
}
export interface InferenceRequest {
  /** One UUID per explicit user send. Reuse this ID when checking an uncertain send. */
  operationId: string;
  /** Local conversation scope for direct key reuse. Defaults to "default". */
  sessionId?: string;
  model: string;
  api: InferenceApi;
  /** Provider-native JSON fields, excluding model (selected above). */
  body: Record<string, unknown>;
  anthropicVersion?: string;
  signal?: AbortSignal;
}
export interface ChatRequest {
  operationId: string;
  sessionId?: string;
  model: string;
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  stream?: boolean;
  signal?: AbortSignal;
}

/** Advanced composition for existing hosts. All components must share one journal,
 * deployment and independently verified configuration. Prefer createZkApiClient. */
export interface ClientComponents {
  wallet: WalletOptions;
  control: ControlClient;
  store: AtomicJournalStore;
  noteId: string;
  mode: Mode;
  models: readonly ModelConfiguration[];
  keyReuseSeconds?: number;
}

export class ZkApiClient {
  private readonly options: ClientComponents;
  private readonly walletClient: WalletClient;
  private readonly daemon: ClientDaemon;
  private readonly models: ModelConfiguration[];
  private busy = false;
  private disposed = false;
  private activeSessionId?: string;
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(status: ClientStatus) => void>();

  constructor(options: ClientComponents) {
    if (!options.noteId || options.noteId.length > 1024 || !options.wallet.wallets.length) throw new Error('stable note ID and selected wallet required');
    this.models = structuredClone([...options.models]);
    validateModelConfigurations(options.mode, this.models);
    this.options = { ...options, wallet: { ...options.wallet, wallets: [...options.wallet.wallets] } };
    this.walletClient = new WalletClient(this.options.wallet);
    const reuse = options.keyReuseSeconds ?? (options.mode === 'proxy' ? 0 : 300);
    this.daemon = new ClientDaemon({ client: options.control, journal: options.wallet.journal,
      noteId: options.noteId, mode: options.mode, models: this.models, keyReuseSeconds: reuse,
      minimumLeaseRemainingSeconds: options.keyReuseSeconds === undefined && options.mode !== 'proxy' ? 90 : 1,
      settlementWaitMs: options.mode === 'proxy' ? 0 : 45_000,
      prepare: async (id, credentials) => {
        const model = this.models.find(m => m.id === id)!;
        const record = await this.options.wallet.journal.read(this.options.noteId);
        if (!record?.value.witness) throw new Error('funded note witness required');
        const quote = await this.options.control.quote({ mode: this.options.mode, provider: model.provider,
          models: [this.options.mode === 'proxy' ? model.id : '*'], session_ttl_seconds: String(reuse || 60) }, model.tariff);
        const snapshot = await authorizationSnapshot(this.options.wallet.chain, record.value.witness.note_id, this.options.wallet.prover);
        const prepared = await this.options.wallet.prover.prepareSession(record.value.witness, record.value.state,
          snapshot.root, snapshot.siblings, quote, model.tariff, credentials);
        return { prepared, root: snapshot.root };
      },
    });
  }

  listModels(): ModelInfo[] { return this.models.map(({ tariff: _tariff, ...model }) => structuredClone(model)); }

  /** Local read only. No AUTH, inference, wallet prompt or transaction is sent. */
  async status(): Promise<ClientStatus> {
    const r = await this.options.wallet.journal.read(this.options.noteId), v = r?.value, w = v?.wallet, p = v?.pending;
    const expiry = v?.witness ? expiryNotice(BigInt(v.witness.expiry), BigInt(Math.floor(Date.now() / 1000))) : null;
    const last = v?.history.at(-1);
    const emergency = w?.emergencyEscapes?.at(-1), unresolvedEscape = w?.emergencyEscapes?.some(e => e.phase !== 'settled');
    const escapeOperation = emergency
      ? w?.operation?.id === emergency.operationId ? w.operation : w?.history.find(o => o.id === emergency.operationId)
      : undefined;
    const escapeAttempt = escapeOperation?.attempts.find(a => a.signature === (escapeOperation.current ?? emergency?.escape?.signature));
    return { noteId: this.options.noteId, mode: this.options.mode, wallet: w?.status ?? 'empty',
      settledBalanceMicroUsdc: v?.state.balance_micro_usdc ?? '0', authorizationCapMicroUsdc: this.options.wallet.manifest.cap_micro_usdc,
      canRequest: !this.disposed && !this.busy && w?.status === 'active' && !w.operation && !w.clearance && (!p || this.daemon.canContinue(p)) && !unresolvedEscape
        && expiry !== null && expiry.severity !== 'expired' && BigInt(v!.state.balance_micro_usdc) >= BigInt(this.options.wallet.manifest.cap_micro_usdc),
      canReconcileUnacceptedAuthorization: !this.disposed && !this.busy && w?.status === 'active' && !w.operation
        && p?.phase === 'send_unknown' && p.operations.length === 0 && p.providerKey === undefined && p.serverState === undefined,
      canPrepareEmergencyEscape: !this.disposed && !this.busy && w?.status === 'active' && !w.operation
        && !!p && p.phase !== 'prepared' && !unresolvedEscape && !w.clearedAuthorization
        && (!w.clearance || w.clearance.phase === 'requested' && w.clearance.signature === undefined),
      canReconcileChallengedEscape: !this.disposed && !this.busy && emergency?.phase === 'escaping' && !p
        && escapeOperation?.id === emergency.operationId && escapeOperation?.kind === 'initiate_escape' && !!escapeOperation.plan
        // An existing finalization may have lost a race to a challenge. Offer a
        // check; the wallet requires every signed finalization to be rejected.
        && (w?.status === 'pending_escape' && (!w.operation || w.operation.kind === 'finalize_escape')
          || w?.status === 'active' && w.operation === escapeOperation)
        && escapeAttempt?.kind === 'execute',
      emergencyEscape: emergency ? { phase: emergency.phase } : null,
      busy: this.busy,
      session: p ? { id: p.prepared.request.authorization.request_id, phase: p.phase,
        operations: p.operations.map(o => ({ id: o.id, phase: o.phase })) } : null,
      walletOperation: w?.operation ? { kind: w.operation.kind, phase: w.operation.phase, signature: w.operation.current ?? null,
        destinationOwner: w.operation.destinationOwner ?? null } : null,
      expiry, lastSettlement: last ? { chargeMicroUsdc: last.settlement.charge_micro_usdc, operationIds: last.operations.map(o => o.id) } : null,
      privacyNotice: this.options.mode === 'proxy' ? PROXY_PRIVACY_NOTICE : this.options.mode === 'direct_openrouter' ? DIRECT_OPENROUTER_PRIVACY_NOTICE : DIRECT_PRIVACY_NOTICE,
    };
  }

  /** Notifications are local projections, not a background network poller. */
  subscribe(listener: (status: ClientStatus) => void): () => void {
    this.listeners.add(listener); void this.status().then(s => { if (this.listeners.has(listener)) this.notify(listener, s); }).catch(() => {});
    return () => { this.listeners.delete(listener); };
  }
  private notify(listener: (s: ClientStatus) => void, status: ClientStatus): void {
    try { void Promise.resolve(listener(structuredClone(status))).catch(() => {}); } catch { /* UI observers cannot interrupt financial work. */ }
  }
  private async publish(): Promise<void> {
    try { const status = await this.status(); for (const listener of this.listeners) this.notify(listener, status); } catch { /* Explicit status() reports storage failures. */ }
  }
  private async action<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new ClientActionError('closed', 'Client disposed; reopen the same storage and note ID.');
    if (this.busy) throw new ClientActionError('busy', 'Consume or cancel the current response before another action.');
    clearTimeout(this.maintenanceTimer); this.maintenanceTimer = undefined;
    this.busy = true;
    try {
      // Separate from NoteJournal's inner operation lock. Hold through stream consumption.
      const m = this.options.wallet.manifest;
      return await this.options.store.withLock(JSON.stringify(['zkapi-app-client-v1', m.deployment_id, m.pool, this.options.noteId]), async () => {
        await this.publish(); return fn();
      });
    } finally { this.busy = false; await this.publish(); await this.scheduleMaintenance(); }
  }
  private async scheduleMaintenance(): Promise<void> {
    if (this.disposed || this.busy || this.maintenanceTimer) return;
    try {
      const p = (await this.options.wallet.journal.read(this.options.noteId))?.value.pending;
      if (!p || !this.daemon.canContinue(p) || this.disposed || this.busy || this.maintenanceTimer) return;
      this.maintenanceTimer = setTimeout(() => {
        this.maintenanceTimer = undefined;
        void this.maintainOwnedLease().catch(() => {});
      }, 1_000);
      // Browser timers are numbers; Node timers should not keep a host alive.
      if (typeof this.maintenanceTimer === 'object') this.maintenanceTimer.unref();
    } catch { /* Explicit status/recovery reports storage failures. */ }
  }
  private async maintainOwnedLease(): Promise<void> {
    if (this.disposed || this.busy) return;
    const p = (await this.options.wallet.journal.read(this.options.noteId))?.value.pending;
    if (!p || !this.daemon.canContinue(p) || this.disposed || this.busy) return;
    // Idle checks do not emit a busy state or touch control before retirement.
    if (this.daemon.maintenanceDue(p)) await this.action(() => this.daemon.maintenance());
    else await this.scheduleMaintenance();
  }

  /** Prepare the saved deposit. advanceWallet() requests the next wallet signature. */
  prepareDeposit(amountMicroUsdc: string): Promise<void> {
    return this.action(() => this.walletClient.beginDeposit(this.options.noteId, amountMicroUsdc, this.roles()));
  }
  prepareWithdrawal(destinationOwner: string, mode: 'mutual_close' | 'initiate_escape' = 'mutual_close'): Promise<void> {
    return this.action(async () => {
      if (mode === 'mutual_close' && this.options.mode !== 'proxy') await this.daemon.management('close');
      await this.walletClient.beginWithdrawal(this.options.noteId, mode, destinationOwner, this.roles());
    });
  }
  /** Preserve an unresolved session and prepare an explicit challengeable escape. */
  prepareEmergencyEscape(destinationOwner: string): Promise<void> {
    return this.action(() => this.walletClient.beginEmergencyEscape(this.options.noteId, destinationOwner, this.roles()));
  }
  /** Authenticate chain restoration before recovering the archived session. No send is replayed. */
  reconcileChallengedEscape(): Promise<void> {
    return this.action(() => this.walletClient.reconcileChallengedEscape(this.options.noteId));
  }
  advanceWallet(): ReturnType<WalletClient['advance']> { return this.action(() => this.walletClient.advance(this.options.noteId)); }
  resumeWalletProof(): Promise<void> { return this.action(() => this.walletClient.resumeProof(this.options.noteId)); }
  retryRejectedWalletOperation(): Promise<void> { return this.action(() => this.walletClient.retryRejected(this.options.noteId)); }
  recoverExpiredWalletSetup(): Promise<void> { return this.action(() => this.walletClient.reconcileExpiredCreation(this.options.noteId)); }
  /** Explicitly fence a possibly sent AUTH with no observed acceptance or inference.
   * Only verified permanent clearance releases it; expiry or missing rows do not. */
  reconcileUnacceptedAuthorization(): Promise<void> {
    return this.action(() => this.walletClient.reconcileUnacceptedAuthorization(this.options.noteId));
  }
  fallbackToEscape(): Promise<void> { return this.action(() => this.walletClient.fallbackToEscape(this.options.noteId)); }
  prepareFinalizeEscape(): Promise<void> { return this.action(() => this.walletClient.beginFinalize(this.options.noteId, this.roles())); }
  private roles() {
    const owner = this.options.wallet.wallets[0].publicKey;
    return { uploader: owner, rentPayer: owner, feePayer: owner, payer: owner, tokenOwner: owner };
  }

  chat(request: ChatRequest): Promise<Response> {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
      || !Array.isArray(request.messages) || !request.messages.length
      || request.messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')
      || request.stream !== undefined && typeof request.stream !== 'boolean') {
      return Promise.reject(new ClientActionError('invalid_request', 'Text messages and a positive integer maxOutputTokens are required.'));
    }
    return this.request({ operationId: request.operationId, sessionId: request.sessionId, model: request.model, api: 'chat', signal: request.signal,
      body: { messages: request.messages.map(m => ({ role: m.role, content: m.content })), max_completion_tokens: request.maxOutputTokens, stream: request.stream ?? false } });
  }

  /** Response bytes are delivered once. Always consume or cancel the body.
   * Successful direct responses retain their bounded key. Cancellation retires it.
   * A pending settlement stays visible in status(); it is never treated as paid. */
  request(request: InferenceRequest): Promise<Response> {
    let body: Uint8Array;
    try {
      const model = this.models.find(m => m.id === request.model);
      if (!model?.apis.includes(request.api) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.operationId)
        || request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !request.sessionId.length || request.sessionId.length > 160)
        || !request.body || Array.isArray(request.body) || Object.hasOwn(request.body, 'model')
        || (request.api === 'messages' ? !/^[\x20-\x7e]+$/.test(request.anthropicVersion ?? '') : request.anthropicVersion !== undefined)) {
        throw new ClientActionError('invalid_request', 'Choose a configured model/API and a stable operation UUID; model belongs outside body. Messages requires anthropicVersion.');
      }
      validateModelRequestCapabilities(model, request.body);
      body = jcsBytes({ ...request.body, model: request.model });
      if (body.length > 1024 * 1024) throw new ClientActionError('invalid_request', 'Request exceeds 1 MiB.');
    } catch (error) { return Promise.reject(error); }
    const operationId = request.operationId, sessionId = request.sessionId ?? 'default', path = paths[request.api], version = request.anthropicVersion ?? '', signal = request.signal;
    return new Promise<Response>((resolve, reject) => {
      const completed = this.action(async () => {
        signal?.throwIfAborted();
        const s = await this.status();
        // action() sets busy, so inspect durable fields directly here.
        const r = await this.options.wallet.journal.read(this.options.noteId);
        const pending = r?.value.pending;
        if (s.wallet !== 'active' || pending && !this.daemon.canContinue(pending) || s.walletOperation || r?.value.wallet?.clearance
          || r?.value.wallet?.emergencyEscapes?.some(e => e.phase !== 'settled') || !s.expiry || s.expiry.severity === 'expired'
          || BigInt(s.settledBalanceMicroUsdc) < BigInt(s.authorizationCapMicroUsdc)) {
          throw new ClientActionError('not_ready', 'Fund the note or recover its saved operation before a new request.');
        }
        if (pending && this.options.mode !== 'proxy' && this.activeSessionId !== sessionId)
          throw new ClientActionError('not_ready', 'Settle the previous conversation before using its balance in another conversation.');
        await this.daemon.startIfNeeded();
        this.activeSessionId = sessionId;
        const response = await this.daemon.infer(path, body, operationId, version, signal);
        if (!response.body) { void completed.then(() => resolve(response), reject); return; }
        const reader = response.body.getReader();
        let release!: () => void;
        let cancelling = false;
        const consumed = new Promise<void>(r => { release = r; });
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              // cancel() resolves pending reads before its asynchronous close
              // finalizer finishes. Only cancel() may release the lock then.
              if (cancelling) return;
              if (next.done) { release(); await completed; controller.close(); } else controller.enqueue(next.value);
            } catch {
              if (cancelling) return;
              release(); await completed.catch(() => {}); controller.error(new Error('Response interrupted; inference was not replayed.'));
            }
          },
          async cancel(reason) {
            cancelling = true;
            try { await reader.cancel(reason); } finally { release(); await completed; }
          },
        }, { highWaterMark: 0 });
        resolve(new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }));
        await consumed;
      });
      void completed.catch(reject);
    });
  }

  /** Explicit recovery may resend the exact saved AUTH, never inference. */
  recover(): Promise<void> { return this.action(() => this.daemon.start()); }
  settle(): Promise<void> { return this.action(async () => { await this.daemon.management('close'); }); }
  cancelUnsentAuthorization(): Promise<void> { return this.action(async () => { await this.daemon.management('cancel-unsent'); }); }
  reconcileAbsentOperations(): Promise<void> { return this.action(async () => { await this.daemon.management('reconcile'); }); }
  /** Erase legacy settled request content locally; retain financial/recovery evidence. */
  purgeSettledRequestBodies(): Promise<{historyOperations:number;emergencyOperations:number}> {
    return this.action(()=>this.options.control.purgeSettledRequestBodies(this.options.noteId));
  }
  /** Release observers and volatile provider keys. Does not settle, delete storage or stop a caller-owned prover. */
  dispose(): void {
    if (this.busy) throw new ClientActionError('busy', 'Consume or cancel the current response before disposal.');
    this.disposed = true; this.listeners.clear(); this.options.control.clearEphemeralKeys();
    clearTimeout(this.maintenanceTimer); this.maintenanceTimer = undefined;
  }
}

export function validateModelConfigurations(mode: Mode, models: readonly ModelConfiguration[]): void {
  if (!['proxy', 'direct_oa', 'direct_openrouter'].includes(mode) || !models.length || new Set(models.map(m => m.id)).size !== models.length) throw new Error('explicit mode and unique models required');
  for (const m of models) {
    validateDaemonModelPolicy(mode, m);
    const supported: InferenceApi[] = m.provider === 'anthropic' ? ['messages'] : m.provider === 'openrouter' ? ['chat'] : ['chat', 'responses'];
    if (!/^[\x21-\x7e]{1,200}$/.test(m.id) || m.id === '*' || !m.apis.length || m.apis.some(a => !supported.includes(a))
      || m.tariff.provider !== m.provider || (mode === 'proxy'
        ? !['openai', 'anthropic', 'openrouter'].includes(m.provider) || m.tariff.model !== m.id || m.tariff.pricing_basis !== 'fixed_usage_rates'
        : m.provider !== (mode === 'direct_oa' ? 'oa' : 'openrouter') || m.tariff.model !== '*' || m.tariff.pricing_basis !== 'provider_reported_usd')) throw new Error('model, API, mode and tariff must agree');
  }
}

/** Read-only initialization: authenticate pins/artifacts and finalized PoolConfig.
 * Reopening a pending journal does not submit AUTH or sign a transaction. */
export async function createZkApiClient(options: CreateClientOptions): Promise<ZkApiClient> {
  const d = options.deployment;
  const manifestBytes = new Uint8Array(d.manifest), trust = structuredClone(d.trust), artifacts = structuredClone(d.artifacts);
  const models = structuredClone([...options.models]), mode = options.mode, noteId = options.noteId, keyReuseSeconds = options.keyReuseSeconds;
  const wallet = options.wallet, storage = { ...options.storage }, engine = options.prover;
  const connection = d.connection, fetcher = d.fetch, indexerOrigin = d.indexerOrigin, preparationCommitment = d.preparationCommitment;
  const directProviderBases = structuredClone(options.directProviderBases), oaVerifier = structuredClone(options.oaVerifier), priorityFeeMicroLamports = options.priorityFeeMicroLamports;
  validateModelConfigurations(mode, models);
  if (mode !== 'proxy' && !directProviderBases?.[mode]) throw new Error('independently installed direct provider base required');
  if (mode === 'direct_oa' && !oaVerifier) throw new Error('independently installed OA verifier required');
  const manifest: VerifiedManifest = await verifyManifest(manifestBytes, trust);
  for (const model of models) {
    const { tariff_hash, ...body } = model.tariff;
    if (!manifest.tariff_hashes.includes(tariff_hash) || await sha256Hex(jcsBytes(body)) !== tariff_hash) throw new Error('model tariff is not pinned by this deployment');
  }
  const genesis = await connection.getGenesisHash().send();
  const observed = await connection.getAccountInfo(address(manifest.pool), { commitment: 'finalized', encoding: 'base64' }).send();
  if (!observed.value) throw new Error('finalized PoolConfig unavailable');
  const a = decodeRpcAccount(observed.value)!;
  safeRpcNumber(observed.context.slot, 'finalized PoolConfig slot');
  const bundle = await verifiedClientBundle(manifest, genesis, { address: manifest.pool, owner: a.owner, executable: a.executable,
    lamports: BigInt(a.lamports), data: a.data, slot: BigInt(observed.context.slot), commitment: 'finalized' }, BigInt(observed.context.slot), artifacts);
  const journal = new EncryptedJournal<NoteJournal>(storage.store, storage.key, { deploymentId: manifest.deployment_id, pool: manifest.pool }, validateNoteJournal);
  const prover = await NoteProver.create(manifest, bundle.artifacts, engine);
  const allowLoopbackHttp = manifest.deployment_environment === 'local';
  const control = new ControlClient({ context: bundle.context, journal, verifier: new ProverSessionVerifier(engine), fetch: fetcher, allowLoopbackHttp, directProviderBases, oaVerifier });
  const chain = new SolanaWalletChain(connection, manifest, indexerOrigin, { fetch: fetcher, allowLoopbackHttp, preparationCommitment });
  const client = new ZkApiClient({ wallet: { manifest, prover, journal, chain, rpc: connectionTransport(connection, { preparationCommitment }),
    wallets: [wallet], fetch: fetcher, priorityFeeMicroLamports }, control, store: storage.store, noteId, mode, models,
    keyReuseSeconds });
  await client.status(); // Fail on corrupt or incompatible storage before returning.
  return client;
}
