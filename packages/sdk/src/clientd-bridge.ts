/** Thin localhost application over the ONE ControlClient state machine.
 * Go forwards authenticated requests here over a private Unix socket. */
import { Buffer } from 'buffer';
import { ControlClient, createCredentials, expiryNotice, apiOperationPath, isApiOperationPath, validateApiService, PROXY_PRIVACY_NOTICE, DIRECT_OPENROUTER_PRIVACY_NOTICE, DIRECT_PRIVACY_NOTICE, type ApiService, type ApiBinding, type Mode, type NoteJournal, type PreparedSession, type SessionRecovery } from './control.ts';
import { JournalConflictError, JournalIntegrityError, type EncryptedJournal } from './journal.ts';
import { directRequestBytes } from './direct-request.ts';
import { privacyProfile, planClientUpgrade } from './client-guidance.ts';
import { parseStrictJson, type VerifiedManifest } from './trust.ts';
import { depositExpiryStatus } from './deposit-expiry.ts';
import { daemonApiPaths, validateDaemonModelPolicy, validateModelRequestCapabilities, type DaemonModelPolicy } from './clientd-models.ts';
import { ControlHttpError } from './control.ts';
import { ChatCompletionStreamParser } from './chat-stream.ts';
import { validateGatewayConfiguration, validateGatewayInvocation, gatewayIngressHeaders, decodeGatewayResponse, trackGatewayDelivery, type GatewayConfiguration, type GatewayInvocation, type GatewayResult, type HeaderPairs } from './gateway.ts';
import { jcsBytes, sha256Hex } from './trust.ts';

export interface DaemonOptions {
  client: ControlClient; journal: EncryptedJournal<NoteJournal>; noteId: string; mode: Mode;
  /** Independently authenticated manifest and finalized Pool; omitted for legacy hosts. */
  manifest?: VerifiedManifest;
  models: readonly (string | DaemonModelPolicy)[]; keyReuseSeconds?: number; now?: () => bigint;
  services?: readonly ApiService[];
  gateway?: GatewayConfiguration;
  prepareApi?(api: ApiBinding, credentials: Awaited<ReturnType<typeof createCredentials>>): Promise<{ prepared: PreparedSession; root: string }>;
  /** Browser lease policy: rotate before a long request could cross expiry. */
  minimumLeaseRemainingSeconds?: number;
  /** Wait for completed same-process direct responses to settle before a new
   * lease. Default 120000 with direct reuse, otherwise 0. No inference replay. */
  settlementWaitMs?: number;
  prepare(model: string, credentials: Awaited<ReturnType<typeof createCredentials>>): Promise<{ prepared: PreparedSession; root: string }>;
  wallet?(command: unknown): Promise<unknown>;
}
const routes = new Set(['/v1/chat/completions','/v1/responses','/v1/messages','/v1/messages/count_tokens']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
export class DaemonConflict extends Error { constructor() { super('Unresolved session or operation. Inspect status and recover; inference was not replayed.'); } }
function transientSettlementError(error: unknown): boolean {
  return error instanceof ControlHttpError && (error.status === 408 || error.status === 429 || error.status >= 500)
    || error instanceof DOMException && error.name === 'TimeoutError';
}
export type RecoveryReasonCode = SessionRecovery['reason_code'] | 'authorization_pending' | 'settlement_pending'
  | 'gateway_delivery_pending' | 'control_unavailable' | 'control_request_rejected' | 'recovery_failed';
/** Result of session recovery, not proof of zero usage or wallet completion.
 * A completed result requires the journal's session and delivery hold to clear. */
export interface RecoveryResult {
  outcome: 'completed' | 'pending' | 'failed';
  reasonCode: RecoveryReasonCode | null;
  sessionId: string | null;
  serverState: string | null;
  recovery: SessionRecovery | null;
  httpStatus?: number;
}
type RecoveryFailure = { reasonCode: 'control_unavailable' | 'control_request_rejected' | 'recovery_failed'; httpStatus?: number };
function recoveryFailure(error: unknown): RecoveryFailure {
  if (error instanceof ControlHttpError) return {
    reasonCode: transientSettlementError(error) ? 'control_unavailable' : 'control_request_rejected', httpStatus: error.status,
  };
  return { reasonCode: error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name) ? 'control_unavailable' : 'recovery_failed' };
}
export class ClientDaemon {
  private readonly o: DaemonOptions; private readonly reuse: number; private readonly settlementWait: number;
  private readonly stoppingController = new AbortController();
  private completedDirectResponse?: { requestId: string; operationIds: Set<string> };
  private lease?: { requestId: string; until: bigint; expiresAt: bigint };
  private invalidated = false;
  private lastRecoveryFailure?: RecoveryFailure;
  private serial: Promise<unknown> = Promise.resolve(); private inflight = 0; private stopping = false; private started = false; private recoveryRequired = false; private idleWaiters: (()=>void)[] = [];
  constructor(options: DaemonOptions) {
    this.o = {...options,models:structuredClone(options.models),services:structuredClone(options.services ?? []),gateway:structuredClone(options.gateway)}; this.reuse = options.keyReuseSeconds ?? 60;
    this.settlementWait = options.settlementWaitMs ?? (options.mode !== 'proxy' && this.reuse > 0 ? 120_000 : 0);
    const ids = this.o.models.map(model => typeof model === 'string' ? model : model.id);
    if (!['proxy','direct_oa','direct_openrouter'].includes(options.mode) || !Number.isInteger(this.reuse) || this.reuse < 0 || this.reuse > 300 || !ids.length && !this.o.services!.length || ids.some(id=>typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id) || id === '*') || new Set(ids).size !== ids.length) throw new Error('explicit mode, unique pinned models or services and key reuse 0–300 required');
    if(this.o.gateway)validateGatewayConfiguration(this.o.gateway,this.o.services!,this.o.models.filter((m):m is DaemonModelPolicy=>typeof m!=='string'));
    if (this.o.services!.length && (options.mode !== 'proxy' || !options.prepareApi)) throw new Error('registered APIs require proxy and preparation');
    const servicePaths = new Set<string>();
    for (const service of this.o.services!) { validateApiService(service); const path = apiOperationPath(service.tariff.api); if (servicePaths.has(path)) throw new Error('duplicate API operation'); servicePaths.add(path); }
    if (!Number.isSafeInteger(this.settlementWait) || this.settlementWait < 0 || this.settlementWait > 180_000
      || this.settlementWait > 0 && options.mode === 'proxy') throw new Error('settlement wait requires direct mode and 0–180000 milliseconds');
    if (!Number.isSafeInteger(options.minimumLeaseRemainingSeconds ?? 1) || (options.minimumLeaseRemainingSeconds ?? 1) < 1
      || (options.minimumLeaseRemainingSeconds ?? 1) > 300) throw new Error('minimum lease remaining must be 1–300 seconds');
    for (const model of this.o.models) if (typeof model !== 'string') validateDaemonModelPolicy(options.mode, model);
  }
  private now(): bigint { return this.o.now?.() ?? BigInt(Math.floor(Date.now()/1000)); }
  private exclusive<T>(fn:()=>Promise<T>): Promise<T> {
    const task = this.serial.then(fn,fn); this.serial = task.catch(()=>{}); return task;
  }
  private exclusiveUntil<T>(signal:AbortSignal,fn:()=>Promise<T>):Promise<T>{
    signal.throwIfAborted();
    // Cancellation releases the observer, never the underlying financial lock.
    const task=this.exclusive(async()=>{signal.throwIfAborted();return fn();});
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      task.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
      if(signal.aborted)abort();
    });
  }
  private async record() { const r = await this.o.journal.read(this.o.noteId); if (!r) throw new Error('finalized note required'); return r; }
  /** Local ownership only; never revives a persisted key after restart. An
   * expired owned lease may rotate before the caller's new explicit send. */
  canContinue(p: NonNullable<NoteJournal['pending']>): boolean {
    return this.started && !this.stopping && !this.recoveryRequired && !this.invalidated
      && !!this.lease && this.lease.requestId === p.prepared.request.authorization.request_id
      && (p.phase === 'active' && p.serverState === 'ACTIVE' && !p.closeRequested || this.canWaitForSettlement(p));
  }
  private expired(p: NonNullable<NoteJournal['pending']>, forRequest = false): boolean {
    if (this.reuse === 0) return true;
    if (this.lease?.requestId !== p.prepared.request.authorization.request_id) return true;
    return this.now() >= this.lease.until
      || forRequest && this.now() + BigInt(this.o.minimumLeaseRemainingSeconds ?? 1) >= this.lease.expiresAt;
  }
  maintenanceDue(p: NonNullable<NoteJournal['pending']>): boolean {
    return p.phase === 'closing' || !!p.closeRequested || this.stopping || this.invalidated || this.expired(p);
  }
  private canWaitForSettlement(p: NonNullable<NoteJournal['pending']>): boolean {
    const completed = this.completedDirectResponse;
    return this.settlementWait > 0 && !!completed && p.phase === 'closing' && p.closeRequested === true
      && !this.invalidated && p.prepared.request.authorization.mode !== 'proxy'
      && p.prepared.request.authorization.request_id === completed.requestId
      && ['ACTIVE','DRAINING','RECONCILING','SIGN_PENDING'].includes(p.serverState ?? '')
      && p.operations.length > 0 && p.operations.every(o => completed.operationIds.has(o.id) && o.phase === 'send_unknown');
  }
  private async waitForSettlement(p: NonNullable<NoteJournal['pending']>, caller?: AbortSignal): Promise<void> {
    // This marker only survives a fully consumed successful response in this
    // process. An unknown send, canceled body or restart requires explicit recovery.
    if (!this.canWaitForSettlement(p)) throw new DaemonConflict();
    const deadline = new AbortController(), timer = setTimeout(()=>deadline.abort(),this.settlementWait);
    const signal = AbortSignal.any([deadline.signal,this.stoppingController.signal,...(caller ? [caller] : [])]);
    try {
      for (;;) {
        signal.throwIfAborted();
        // The verified closing phase prevents recover from taking its AUTH path.
        // Existing close/status/receipt checks alone may clear the old session.
        try { await this.o.client.recover(this.o.noteId,signal); }
        catch (error) {
          // Only retry observation of an already-closing, locally completed
          // request. Invalid receipts and journal errors fail closed immediately.
          if (!transientSettlementError(error)) throw error;
        }
        const pending = (await this.record()).value.pending;
        signal.throwIfAborted();
        if (!pending) { this.completedDirectResponse = undefined; return; }
        if (!this.canWaitForSettlement(pending)) throw new DaemonConflict();
        await new Promise<void>((resolve,reject)=>{
          const done = () => { signal.removeEventListener('abort',aborted); resolve(); };
          const next = setTimeout(done,1_000);
          const aborted = () => { clearTimeout(next); signal.removeEventListener('abort',aborted); reject(signal.reason); };
          signal.addEventListener('abort',aborted,{once:true});
          if (signal.aborted) aborted();
        });
      }
    } catch (error) {
      this.completedDirectResponse = undefined;
      caller?.throwIfAborted();
      if (error instanceof JournalIntegrityError || error instanceof JournalConflictError) throw error;
      throw new DaemonConflict();
    } finally { clearTimeout(timer); }
  }
  /** Local projection only. Server diagnostics never authorize financial changes. */
  recoveryStatus(value: NoteJournal | undefined): RecoveryResult {
    const pending = value?.pending;
    const base = { sessionId: pending?.prepared.request.authorization.request_id ?? null,
      serverState: pending?.serverState ?? null, recovery: pending?.recovery ? structuredClone(pending.recovery) : null };
    if (!pending && !value?.gatewayRecoveryHold) return { ...base, outcome: 'completed', reasonCode: null };
    if (this.lastRecoveryFailure) return { ...base, outcome: 'failed', ...this.lastRecoveryFailure };
    return { ...base, outcome: 'pending', reasonCode: pending
      ? pending.recovery?.reason_code ?? (pending.serverState === 'ISSUANCE_UNKNOWN' ? 'issuance_unknown'
        : ['prepared', 'send_unknown'].includes(pending.phase) ? 'authorization_pending' : 'settlement_pending')
      : 'gateway_delivery_pending' };
  }
  async start(): Promise<RecoveryResult> {
    return this.exclusive(async()=>{
      // A restart recovers and closes the old session before accepting NEW work.
      // An unknown create may need its exact authorization POST, never inference.
      this.started = false;
      this.lastRecoveryFailure = undefined;
      this.completedDirectResponse = undefined;
      this.lease = undefined; this.invalidated = false;
      const r = await this.record();
      const recover = async(action:()=>Promise<unknown>):Promise<boolean>=>{
        try { await action(); return true; }
        catch(error) {
          // A remote outage or an incomplete receipt set must leave admin
          // recovery reachable. Local journal corruption/concurrency is fatal.
          if(error instanceof JournalIntegrityError || error instanceof JournalConflictError)throw error;
          await this.record();
          this.lastRecoveryFailure = recoveryFailure(error);
          this.recoveryRequired = true; return false;
        }
      };
      if (r.value.pending) {
        if(!await recover(()=>this.o.client.recover(this.o.noteId)))return this.recoveryStatus((await this.record()).value);
        if((await this.record()).value.pending && !await recover(()=>this.o.client.close(this.o.noteId)))return this.recoveryStatus((await this.record()).value);
      }
      const recovered=(await this.record()).value;this.recoveryRequired = recovered.pending !== null||!!recovered.gatewayRecoveryHold;
      this.started = !this.recoveryRequired;
      return this.recoveryStatus(recovered);
    });
  }
  async recover(): Promise<RecoveryResult> {
    const result = await this.start();
    if (result.outcome === 'failed') return result;
    if ((await this.record()).value.gatewayRecoveryHold) {
      try { await this.management('recover'); }
      catch (error) {
        if (error instanceof JournalIntegrityError || error instanceof JournalConflictError) throw error;
        this.lastRecoveryFailure = recoveryFailure(error);
        this.recoveryRequired = true;
      }
    }
    return this.recoveryStatus((await this.record()).value);
  }
  async startIfNeeded(): Promise<void> { if (!this.started && !this.recoveryRequired) await this.start(); }
  async maintenance(waitForSettlement = false): Promise<void> {
    await this.exclusive(async()=>{
      if (this.inflight || this.recoveryRequired) return;
      const p = (await this.record()).value.pending;
      if (!p) return;
      if (this.maintenanceDue(p)) {
        try {
          if (waitForSettlement && this.canWaitForSettlement(p)) {
            await this.waitForSettlement(p); return;
          }
          if (p.phase === 'prepared' || p.phase === 'send_unknown') await this.o.client.recover(this.o.noteId);
          if ((await this.record()).value.pending) await this.o.client.close(this.o.noteId);
        } catch (error) {
          let retainCompletion = false;
          try {
            if (transientSettlementError(error)) {
              const pending = (await this.record()).value.pending;
              retainCompletion = !!pending && this.canWaitForSettlement(pending);
            }
          } finally { if (!retainCompletion) this.completedDirectResponse = undefined; }
          throw error;
        }
      }
    });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stoppingController.abort();
    // Authorization/proof preparation runs under serial before incrementing
    // inflight. Drain that admission boundary before deciding we are idle.
    await this.exclusive(async()=>{});
    if(this.inflight) await new Promise<void>(resolve=>this.idleWaiters.push(resolve));
    await this.maintenance();
  }
  async status(): Promise<unknown> {
    const record = await this.o.journal.read(this.o.noteId);
    const privacy = privacyProfile(this.o.mode,this.reuse);
    const deposit = this.o.manifest ? depositExpiryStatus(this.o.manifest, record?.value.witness, this.now()) : undefined;
    if (!record) return { mode:this.o.mode, balance_micro_usdc:'0', phase:'unfunded', in_flight:this.inflight, recovery_required:false,
      server_state:null, recovery:this.recoveryStatus(undefined),
      unresolved_operations:[], key_reuse_seconds:this.reuse, journal_head:null, privacy_notice:this.o.mode === 'proxy' ? PROXY_PRIVACY_NOTICE : this.o.mode === 'direct_openrouter' ? DIRECT_OPENROUTER_PRIVACY_NOTICE : DIRECT_PRIVACY_NOTICE,
      ...(deposit ? { deposit_expiry_policy: deposit.depositExpiryPolicy, expiry: deposit.expiry } : {}),
      privacy, wallet_status:'unfunded', wallet_operation:null, wallet_emergency_escape:null };
    const {value,head} = record;
    const witness = (value as NoteJournal & { witness?: {expiry:string} }).witness;
    const emergency=value.wallet?.emergencyEscapes?.find(e=>e.phase!=='settled'),closed=value.wallet?.status==='closed';
    return { mode:this.o.mode, balance_micro_usdc:value.state.balance_micro_usdc, phase:value.pending?.phase ?? (closed?'closed':emergency?'emergency_escape':'ready'), in_flight:this.inflight, recovery_required:(!closed||!!value.pending)&&(this.recoveryRequired||!!value.gatewayRecoveryHold||!!emergency),
      server_state:value.pending?.serverState ?? null, recovery:this.recoveryStatus(value),
      unresolved_operations:value.pending?.operations.filter(o=>o.phase==='send_unknown').map(o=>({id:o.id,response_replayable:false})) ?? [],
      key_reuse_seconds:this.reuse, journal_head:head, privacy_notice:this.o.mode === 'proxy' ? PROXY_PRIVACY_NOTICE : this.o.mode === 'direct_openrouter' ? DIRECT_OPENROUTER_PRIVACY_NOTICE : DIRECT_PRIVACY_NOTICE,
      privacy, wallet_status:value.wallet?.status ?? 'legacy_import', wallet_operation:value.wallet?.operation ? {kind:value.wallet.operation.kind,phase:value.wallet.operation.phase} : null,
      wallet_emergency_escape:emergency?{phase:emergency.phase,funds_withdrawn:closed}:null,
      ...(deposit ? { deposit_expiry_policy: deposit.depositExpiryPolicy, expiry: deposit.expiry } : witness ? {expiry:expiryNotice(BigInt(witness.expiry),this.now())} : {}) };
  }
  async management(action: 'close' | 'recover' | 'reconcile' | 'cancel-unsent' | 'purge-settled-bodies' | 'wallet', body?: unknown): Promise<unknown> {
    return this.exclusive(async()=>{
      if (this.inflight) throw new DaemonConflict();
      if (action === 'purge-settled-bodies') {
        if (body !== undefined) throw new Error('purge-settled-bodies accepts no body');
        return this.o.client.purgeSettledRequestBodies(this.o.noteId);
      }
      if (action === 'wallet') { if (!this.o.wallet) throw new Error('wallet adapter unavailable'); return this.o.wallet(body); }
      this.lastRecoveryFailure = undefined;
      try {
        if ((await this.record()).value.pending) {
          if (action === 'reconcile') await this.o.client.reconcileAbsentOperations(this.o.noteId); else if (action === 'cancel-unsent') await this.o.client.cancelUnsent(this.o.noteId); else if (action === 'recover') await this.o.client.recover(this.o.noteId); else await this.o.client.close(this.o.noteId);
        }
        if(action==='recover'&&(await this.record()).value.gatewayRecoveryHold){if((await this.record()).value.pending)await this.o.client.close(this.o.noteId);if(!(await this.record()).value.pending)await this.o.client.recoverGatewayDelivery(this.o.noteId);}
        if(this.recoveryRequired) {
          // Recovered pre-restart sessions must close before new inference; never
          // reuse their upstream key or replay their uncertain operations.
          if(action === 'recover' && (await this.record()).value.pending)await this.o.client.close(this.o.noteId);
          const recovered=(await this.record()).value;if(!recovered.pending&&!recovered.gatewayRecoveryHold) { this.recoveryRequired = false; this.started = true; }
        }
        return this.status();
      } catch (error) {
        if (error instanceof JournalIntegrityError || error instanceof JournalConflictError) throw error;
        this.lastRecoveryFailure = recoveryFailure(error);
        this.recoveryRequired = true;
        throw error;
      }
    });
  }
  async infer(path: string, bytes: Uint8Array, operationId: string|undefined = undefined, anthropicVersion = '', signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();bytes=new Uint8Array(bytes);await this.waitGatewayDelivery(signal);operationId??=crypto.randomUUID();
    if (!routes.has(path) || !uuid.test(operationId) || bytes.length > 1024*1024) throw new Error('unsupported inference');
    const body = parseStrictJson(bytes);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw new Error('model is not in the pinned allowlist');
    const model = this.o.models.find(model => (typeof model === 'string' ? model : model.id) === body.model);
    if (!model) throw new Error('model is not in the pinned allowlist');
    if (typeof model !== 'string' && !model.apis.some(api => daemonApiPaths[api] === path)) throw new Error('model API is not configured');
    if (typeof model !== 'string') validateModelRequestCapabilities(model, body);
    if (path === '/v1/chat/completions' && body.stream === true && body.n != null
      && (typeof body.n !== 'number' || !Number.isSafeInteger(body.n) || body.n < 1)) throw new Error('invalid Chat choice count');
    const snapshot = this.o.mode === 'proxy' ? new Uint8Array(bytes) : directRequestBytes(this.o.mode,path,bytes);
    return this.dispatchRequest(path,snapshot,operationId,anthropicVersion,signal,{
      matches: p => 'models' in p.prepared.request.quote.body && (this.o.mode !== 'proxy' || p.prepared.request.quote.body.models[0] === body.model)
        && !(typeof model !== 'string' && 'tariff' in model && (model.tariff as {tariff_hash:string}).tariff_hash !== p.prepared.tariff.tariff_hash),
      prepare: credentials => this.o.prepare(body.model as string,credentials), singleRequest:false,
      chatStreamChoices: path === '/v1/chat/completions' && body.stream === true ? (typeof body.n === 'number' ? body.n : 1) : undefined,
    });
  }
  async requestApi(service: string, operation: string, bytes: Uint8Array, operationId: string|undefined = undefined, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();bytes=new Uint8Array(bytes);await this.waitGatewayDelivery(signal);operationId??=crypto.randomUUID();
    const selected = this.o.services!.find(s => s.tariff.api.service === service && s.tariff.api.operation === operation);
    if (!selected || selected.tariff.api.version!=='1' || this.o.mode !== 'proxy' || !this.o.prepareApi || !uuid.test(operationId) || bytes.length > Number(selected.tariff.api.request_max_bytes)) throw new Error('registered API operation required');
    const snapshot = new Uint8Array(bytes); parseStrictJson(snapshot);
    const api = selected.tariff.api;
    return this.dispatchRequest(apiOperationPath(api),snapshot,operationId,'',signal,{
      matches: p => 'api' in p.prepared.request.quote.body && apiOperationPath(p.prepared.request.quote.body.api) === apiOperationPath(api)
        && p.prepared.tariff.tariff_hash === selected.tariff.tariff_hash,
      prepare: credentials => this.o.prepareApi!(structuredClone(api),credentials), singleRequest:true,
    });
  }
  /** A known delivered success may finish signed settlement. Unknown delivery
   * always needs an explicit management action, including after restart. */
  async waitGatewayDelivery(caller?:AbortSignal):Promise<void>{
    if(!(await this.o.journal.read(this.o.noteId))?.value.gatewayRecoveryHold)return;
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new DOMException('Gateway settlement wait timed out','TimeoutError')),45_000),signal=AbortSignal.any([deadline.signal,this.stoppingController.signal,...(caller?[caller]:[])]);
    try{await this.exclusiveUntil(signal,async()=>{
      for(;;){signal.throwIfAborted();const record=await this.record();const hold=record.value.gatewayRecoveryHold;if(!hold){this.recoveryRequired=false;this.started=true;return;}if(!hold.delivered||!record.value.pending||!['active','closing'].includes(record.value.pending.phase)||record.value.pending.prepared.request.authorization.request_id!==hold.request_id)throw new DaemonConflict();
        try{await this.o.client.close(this.o.noteId,signal);}catch(error){if(!transientSettlementError(error))throw error;}
        if(!(await this.record()).value.gatewayRecoveryHold){this.recoveryRequired=false;this.started=true;return;}
        await new Promise<void>((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',aborted);resolve();},next=setTimeout(done,100);const aborted=()=>{clearTimeout(next);signal.removeEventListener('abort',aborted);reject(signal.reason);};signal.addEventListener('abort',aborted,{once:true});});
      }
    });}finally{clearTimeout(timer);}
  }
  async requestGateway(service:string,operation:string,input:GatewayInvocation,operationId?:string,signal?:AbortSignal,deferDelivery=false):Promise<GatewayResult> {
    signal?.throwIfAborted();input=structuredClone(input);await this.waitGatewayDelivery(signal);operationId??=crypto.randomUUID();const selected=this.o.services!.find(s=>s.tariff.api.service===service&&s.tariff.api.operation===operation);
    if(!selected||selected.tariff.api.version!=='2'||this.o.mode!=='proxy'||!this.o.prepareApi||!uuid.test(operationId))throw Error('registered gateway operation required');
    const api=selected.tariff.api,invocation=validateGatewayInvocation(api,input);
    const response=await this.dispatchRequest(apiOperationPath(api),invocation.body,operationId,'',signal,{
      matches:p=>'api' in p.prepared.request.quote.body&&apiOperationPath(p.prepared.request.quote.body.api)===apiOperationPath(api)&&p.prepared.tariff.tariff_hash===selected.tariff.tariff_hash,
      prepare:credentials=>this.o.prepareApi!(structuredClone(api),credentials),singleRequest:true,gateway:invocation,
    });
    const pending=(await this.record()).value.pending;if(!pending)throw Error('gateway authorization unavailable');
    return trackGatewayDelivery({...await decodeGatewayResponse(response,api,invocation.method),operationId,statusPath:`/zkapi/v1/sessions/${pending.prepared.request.authorization.request_id}/operations/${operationId}`},()=>this.exclusive(()=>this.o.client.confirmGatewayDelivery(this.o.noteId,operationId!)),deferDelivery);
  }
  /** Called only after the native peer/Host/Origin/token ingress checks. */
  async handleGateway(method:string,target:string,body:Uint8Array,rawPairs:HeaderPairs,signal?:AbortSignal):Promise<GatewayResult|Response> {
    if(/^\/(?:admin|zkapi)(?:\/|$)/.test(target.split('?')[0])||target.split('?')[0]==='/v1/models')throw Error('reserved gateway route');
    const matching=[] as {service:string;operation:string;invocation:GatewayInvocation}[];
    const suppliedIds=rawPairs.filter(([name])=>name.toLowerCase()==='idempotency-key');if(suppliedIds.length>1)throw Error('duplicate Idempotency-Key');
    const operationId=suppliedIds.length?Buffer.from(suppliedIds[0][1],'base64').toString('latin1'):undefined;
    for(const mount of this.o.gateway?.mounts??[]){const path=target.split('?')[0];if(mount.prefix!==''&&path!==mount.prefix&&!path.startsWith(mount.prefix+'/'))continue;
      const selected=this.o.services!.find(s=>s.tariff.api.service===mount.service&&s.tariff.api.operation===mount.operation);if(!selected||selected.tariff.api.version!=='2')throw Error('invalid gateway mount');
      const binding=selected.tariff.api;if(await sha256Hex(jcsBytes(binding))!==mount.binding_hash)throw Error('gateway mount binding mismatch');
      const stripped=mount.prefix===''?target:target.slice(mount.prefix.length);const rawTarget=stripped.startsWith('/')?stripped:'/'+stripped;
      const headers=gatewayIngressHeaders(rawPairs,binding);
      try{matching.push({service:mount.service,operation:mount.operation,invocation:validateGatewayInvocation(binding,{version:'2',method,target:rawTarget,headers,body})});}catch{continue;}
    }
    if(matching.length!==1)throw Error(matching.length?'ambiguous gateway binding':'unsupported gateway request');
    const result=await this.requestGateway(matching[0].service,matching[0].operation,matching[0].invocation,operationId,signal,true);
    if(result.status>=300&&result.status<400&&result.status!==304){await result.body.cancel();throw Error('native gateway redirect rejected');}
    return result;
  }
  private async dispatchRequest(path: string, snapshot: Uint8Array, operationId: string, anthropicVersion: string, signal: AbortSignal | undefined,
    selection: { matches(p:NonNullable<NoteJournal['pending']>):boolean; prepare(credentials:Awaited<ReturnType<typeof createCredentials>>):Promise<{prepared:PreparedSession;root:string}>; singleRequest:boolean; chatStreamChoices?:number; gateway?:GatewayInvocation }): Promise<Response> {
    let requestId: string | undefined;
    // Bound gateway quote/proof/AUTH preparation separately from its carrier.
    // Only pure preparation races cancellation; financial writes stay serialized.
    const admissionDeadline = selection.gateway ? new AbortController() : undefined;
    const admissionTimer = admissionDeadline ? setTimeout(()=>admissionDeadline.abort(new DOMException('Gateway admission timed out','TimeoutError')),180_000) : undefined;
    const admissionSignal = admissionDeadline ? AbortSignal.any([admissionDeadline.signal,this.stoppingController.signal,...(signal ? [signal] : [])]) : signal;
    const admissionExclusive=<T>(fn:()=>Promise<T>)=>selection.gateway?this.exclusiveUntil(admissionSignal!,fn):this.exclusive(fn);
    try { await admissionExclusive(async()=>{
      admissionSignal?.throwIfAborted();
      if (!this.started || this.stopping || this.inflight >= (this.reuse === 0 || selection.singleRequest ? 1 : 4)) throw new DaemonConflict();
      let r = await this.record();
      if (this.o.manifest) {
        const deposit = depositExpiryStatus(this.o.manifest, r.value.witness, this.now());
        if (deposit.depositExpiryPolicy === 'none' && !deposit.canRequest) throw new Error('non-expiring deposit witness required');
      }
      if(r.value.gatewayRecoveryHold)throw new DaemonConflict();
      if(r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'))throw new DaemonConflict();
      if (r.value.history.some(h=>h.operations.some(o=>o.id===operationId)) || r.value.pending?.operations.some(o=>o.id===operationId)) throw new DaemonConflict();
      let p = r.value.pending;
      if (p && this.invalidated) throw new DaemonConflict();
      if (p && (p.phase !== 'active' || p.closeRequested || this.expired(p,true) || p.prepared.request.authorization.mode !== this.o.mode || !selection.matches(p))) {
        // This new operation has not been dispatched. Preserve its exact intent
        // while closing an incompatible/expired session; never replay an old one.
        if (this.inflight) throw new DaemonConflict();
        // Retire an active owned lease once before polling its signed successor.
        try {
          if (p.phase !== 'closing' || this.settlementWait === 0) {
            try { await this.o.client.close(this.o.noteId,selection.gateway ? admissionSignal : undefined); }
            catch (error) {
              const closing = (await this.record()).value.pending;
              if (!transientSettlementError(error) || !closing || !this.canWaitForSettlement(closing)) throw error;
            }
          }
          const closing = (await this.record()).value.pending;
          if (closing && this.settlementWait > 0) await this.waitForSettlement(closing,admissionSignal);
        } catch (error) { this.completedDirectResponse = undefined; throw error; }
        r = await this.record(); p = r.value.pending;
        if (p) throw new DaemonConflict();
        admissionSignal?.throwIfAborted();
        if (this.stopping) throw new DaemonConflict();
      }
      if (!p) {
        this.lease = undefined; this.invalidated = false; this.completedDirectResponse = undefined;
        const credentials = await createCredentials(this.o.mode);
        admissionSignal?.throwIfAborted();
        const prepared = selection.gateway ? await new Promise<Awaited<ReturnType<typeof selection.prepare>>>((resolve,reject)=>{
          const abort=()=>{admissionSignal!.removeEventListener('abort',abort);reject(admissionSignal!.reason);};
          admissionSignal!.addEventListener('abort',abort,{once:true});
          Promise.resolve().then(()=>{admissionSignal!.throwIfAborted();return selection.prepare(credentials);})
            .then(value=>{admissionSignal!.removeEventListener('abort',abort);resolve(value);},error=>{admissionSignal!.removeEventListener('abort',abort);reject(error);});
          if(admissionSignal!.aborted)abort();
        }) : await selection.prepare(credentials);
        admissionSignal?.throwIfAborted();
        if (prepared.prepared.request.authorization.mode !== this.o.mode) throw new Error('mode changed during preparation');
        await this.o.client.prepare(this.o.noteId,prepared.prepared,prepared.root,selection.gateway ? admissionSignal : undefined);
        admissionSignal?.throwIfAborted();
        const status = await this.o.client.submit(this.o.noteId,admissionSignal);
        r = await this.record(); p = r.value.pending;
        if (p?.phase === 'active' && p.serverState === 'ACTIVE') {
          // Fall back to the signed quote's earlier TTL boundary for legacy
          // endpoints without timing fields; never extend an advertised expiry.
          const q = p.prepared.request.quote.body;
          const fallback = BigInt(q.issued_at) + BigInt(q.session_ttl_seconds);
          const expiresAt = typeof status.expires_at === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(status.expires_at)
            ? BigInt(status.expires_at) : fallback;
          const until = this.now() + BigInt(selection.singleRequest ? 0 : this.reuse);
          const retireAt = expiresAt - ((this.o.minimumLeaseRemainingSeconds ?? 1) > 1 ? 0n : 1n);
          this.lease = { requestId: p.prepared.request.authorization.request_id, expiresAt, until: until < retireAt ? until : retireAt };
        }
      }
      if(selection.gateway)admissionSignal?.throwIfAborted();
      if (!p || p.phase !== 'active' || p.serverState !== 'ACTIVE') throw new DaemonConflict();
      if (this.lease && this.now() + BigInt(this.o.minimumLeaseRemainingSeconds ?? 1) >= this.lease.expiresAt) {
        await this.o.client.close(this.o.noteId,selection.gateway ? admissionSignal : undefined); throw new DaemonConflict();
      }
      requestId = p.prepared.request.authorization.request_id;
      if (this.o.mode === 'proxy') {if(selection.gateway)await this.o.client.prepareGatewayOperation(this.o.noteId,operationId,selection.gateway);else await this.o.client.prepareOperation(this.o.noteId,operationId,path,snapshot,anthropicVersion);}
      if(selection.gateway)admissionSignal?.throwIfAborted();
      this.inflight++;
    }); } finally { clearTimeout(admissionTimer); }
    let finishing: Promise<void> | undefined;
    const finish = (complete = false) => finishing ??= (async() => {
      if (complete && requestId && !signal?.aborted && !this.invalidated) {
        if (this.completedDirectResponse?.requestId !== requestId) this.completedDirectResponse = {requestId,operationIds:new Set()};
        this.completedDirectResponse.operationIds.add(operationId);
      } else { this.invalidated = this.o.mode !== 'proxy'; this.completedDirectResponse = undefined; }
      this.inflight--; if(this.inflight===0)for(const resolve of this.idleWaiters.splice(0))resolve();
      // Gateway EOF still precedes frame validation and consumer delivery.
      // Settlement runs separately, within the next admission's bounded wait.
      if (!selection.gateway) await this.maintenance().catch(()=>{});
    })();
    try {
      const response = this.o.mode === 'proxy' ? await this.o.client.sendOperation(this.o.noteId,operationId,signal) : await this.o.client.sendDirectOperation(this.o.noteId,operationId,path,snapshot,signal);
      // An upstream response must not set cookies, enable CORS or attach an
      // arbitrary correlation identifier to the local application origin.
      const headers = selection.gateway ? new Headers(response.headers) : new Headers();
      for (const name of ['Content-Type','Retry-After',...(this.o.mode === 'proxy' ? ['X-Zkapi-Status-Url','X-Zkapi-Error-Code'] : this.o.mode === 'direct_openrouter' && !response.ok ? ['X-Zkapi-Error-Code'] : [])]) {
        const value = response.headers.get(name); if (value !== null) headers.set(name,value);
      }
      headers.set('X-Zkapi-Operation-Id',operationId); headers.set('Cache-Control','no-store');
      // Validate the wire before any public Response can be cloned or teed.
      // Consumer parsers have independent positions and cannot decide whether
      // the network operation completed. Other API dialects remain untouched.
      const chatStream = response.ok && selection.chatStreamChoices !== undefined;
      const parser = chatStream ? new ChatCompletionStreamParser({ expectedChoices: selection.chatStreamChoices }) : undefined;
      const reader = response.body?.getReader();
      if (!reader) {
        await finish(response.ok && !chatStream);
        if (chatStream) throw new Error('upstream stream interrupted; no replay');
        return new Response(null,{status:response.status,headers});
      }
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopping: Promise<void> | undefined;
      let stop: (reason?: unknown) => Promise<void>;
      const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { void stop().catch(() => {}); };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          stop = reason => stopping ??= (async () => {
            if (ended) { await finish(); return; }
            ended = true; detach();
            // Canceling may resolve a pending read. The ended flag prevents it
            // from being mistaken for genuine EOF, including with custom fetch.
            // Keep admission held until cancellation and accounting both finish.
            try { await reader.cancel(reason); } catch { /* Preserve the redacted interruption. */ }
            await finish();
            controller.error(new Error('upstream stream interrupted; no replay'));
          })();
          if (parser) timer = setTimeout(aborted, 600_000);
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        },
        async pull(controller) {
          try {
            if (parser && response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream')
              throw new Error('invalid Chat stream');
            const next = await reader.read();
            if (ended) return;
            if (next.done) {
              if (parser) for (const _ of parser.finish()) { /* validation only */ }
              ended = true; detach();
              // EOF is verified before accounting finalization. Forward byte-
              // neutral progress so per-read consumer deadlines naturally reset
              // through native clone/tee, without sharing parser state or hooks.
              if (parser) controller.enqueue(new Uint8Array());
              await finish(response.ok); controller.close();
            } else {
              if (parser) for (const _ of parser.push(next.value)) { /* validation only */ }
              controller.enqueue(next.value);
            }
          } catch {
            if (ended) return;
            await stop();
          }
        },
        async cancel(reason) {
          if (ended) { await (stopping ?? finish()); return; }
          ended = true; detach();
          try { await reader.cancel(reason); } finally { await finish(); }
        },
      }, { highWaterMark: 0 });
      return new Response(stream,{status:response.status,headers});
    } catch (error) { await finish(); throw error; }
  }
  private gatewayModels():{id:string;object:string;owned_by:string}[]{
    const models=new Map<string,{id:string;object:string;owned_by:string}>();
    for(const mount of this.o.gateway?.mounts??[]){const binding=this.o.services!.find(s=>s.tariff.api.service===mount.service&&s.tariff.api.operation===mount.operation)?.tariff.api;if(binding?.version==='2'&&binding.meter.resource)models.set(binding.meter.resource.model,{id:binding.meter.resource.model,object:'model',owned_by:binding.meter.resource.provider});}
    return [...models.values()];
  }
  async handle(method: string, path: string, bytes: Uint8Array, headers: Headers, signal?: AbortSignal): Promise<Response> {
    try {
      if (method === 'GET' && path === '/v1/models') return json({object:'list',data:[...this.o.models.map(model=>({id:typeof model === 'string' ? model : model.id,object:'model',owned_by:typeof model === 'string' ? 'configured-provider' : model.provider})),...this.gatewayModels()]});
      if (method === 'GET' && path === '/zkapi/v1/apis') return json({apis:this.o.services!.map(s=>s.tariff.api)});
      if (method === 'GET' && path === '/admin/status') return json(await this.status());
      if (method === 'GET' && path === '/admin/upgrade-plan') return json(planClientUpgrade(await this.status()));
      if (method === 'GET' && path === '/admin/model-availability' && this.o.models.length === 0) return json({error:{code:'unsupported_for_profile'}},400);
      if (method === 'GET' && path === '/admin/model-availability') return json(await this.o.client.checkModelAvailability(this.o.mode,this.o.models.map(m=>typeof m === 'string'?m:m.id),signal));
      if (method === 'POST' && ['/admin/close','/admin/recover','/admin/reconcile','/admin/cancel-unsent','/admin/purge-settled-bodies','/admin/wallet'].includes(path)) return json(await this.management(path.slice(7) as 'close'|'recover'|'reconcile'|'cancel-unsent'|'purge-settled-bodies'|'wallet',bytes.length?parseStrictJson(bytes):undefined));
      if (method === 'POST' && routes.has(path)) return await this.infer(path,bytes,headers.get('Idempotency-Key') ?? undefined,headers.get('anthropic-version') ?? '',signal);
      if (method === 'POST' && isApiOperationPath(path)) { const parts=path.split('/'); return await this.requestApi(parts[4],parts[5],bytes,headers.get('Idempotency-Key') ?? undefined,signal); }
      return json({error:{code:'unsupported_route'}},404);
    } catch(error) { return json({error:{code:error instanceof DaemonConflict ? 'recovery_required' : 'client_request_failed',message:'Request was not replayed. Inspect local status before retrying.'}},error instanceof DaemonConflict ? 409 : 400); }
  }
}
