/** Thin localhost application over the ONE ControlClient state machine.
 * Go forwards authenticated requests here over a private Unix socket. */
import { ControlClient, createCredentials, expiryNotice, PROXY_PRIVACY_NOTICE, type Mode, type NoteJournal, type PreparedSession } from './control.ts';
import { JournalConflictError, JournalIntegrityError, type EncryptedJournal } from './journal.ts';
import { parseStrictJson } from './trust.ts';
import { daemonApiPaths, validateDaemonModelPolicy, validateModelRequestCapabilities, type DaemonModelPolicy } from './clientd-models.ts';

export interface DaemonOptions {
  client: ControlClient; journal: EncryptedJournal<NoteJournal>; noteId: string; mode: Mode;
  models: readonly (string | DaemonModelPolicy)[]; keyReuseSeconds?: number; now?: () => bigint;
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
export class DaemonConflict extends Error { constructor() { super('Unresolved session or operation. Inspect status; inference was not replayed.'); } }
export class ClientDaemon {
  private readonly o: DaemonOptions; private readonly reuse: number; private readonly settlementWait: number;
  private readonly stoppingController = new AbortController();
  private completedDirectResponse?: { requestId: string; operationIds: Set<string> };
  private lease?: { requestId: string; until: bigint; expiresAt: bigint };
  private invalidated = false;
  private serial: Promise<unknown> = Promise.resolve(); private inflight = 0; private stopping = false; private started = false; private recoveryRequired = false; private idleWaiters: (()=>void)[] = [];
  constructor(options: DaemonOptions) {
    this.o = {...options,models:structuredClone(options.models)}; this.reuse = options.keyReuseSeconds ?? 60;
    this.settlementWait = options.settlementWaitMs ?? (options.mode !== 'proxy' && this.reuse > 0 ? 120_000 : 0);
    const ids = this.o.models.map(model => typeof model === 'string' ? model : model.id);
    if (!['proxy','direct_oa','direct_openrouter'].includes(options.mode) || !Number.isInteger(this.reuse) || this.reuse < 0 || this.reuse > 300 || !ids.length || ids.some(id=>typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id) || id === '*') || new Set(ids).size !== ids.length) throw new Error('explicit mode, unique pinned models and key reuse 0–300 required');
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
        await this.o.client.recover(this.o.noteId,signal);
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
  async start(): Promise<void> {
    await this.exclusive(async()=>{
      // A restart recovers and closes the old session before accepting NEW work.
      // An unknown create may need its exact authorization POST, never inference.
      this.started = false;
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
          this.recoveryRequired = true; return false;
        }
      };
      if (r.value.pending) {
        if(!await recover(()=>this.o.client.recover(this.o.noteId)))return;
        if((await this.record()).value.pending && !await recover(()=>this.o.client.close(this.o.noteId)))return;
      }
      this.recoveryRequired = (await this.record()).value.pending !== null;
      this.started = !this.recoveryRequired;
    });
  }
  async startIfNeeded(): Promise<void> { if (!this.started && !this.recoveryRequired) await this.start(); }
  async maintenance(): Promise<void> {
    await this.exclusive(async()=>{
      if (this.inflight || this.recoveryRequired) return;
      const p = (await this.record()).value.pending;
      if (!p) return;
      if (this.maintenanceDue(p)) {
        try {
          if (p.phase === 'prepared' || p.phase === 'send_unknown') await this.o.client.recover(this.o.noteId);
          if ((await this.record()).value.pending) await this.o.client.close(this.o.noteId);
        } catch (error) { this.completedDirectResponse = undefined; throw error; }
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
    if (!record) return { mode:this.o.mode, balance_micro_usdc:'0', phase:'unfunded', in_flight:this.inflight, recovery_required:false,
      unresolved_operations:[], key_reuse_seconds:this.reuse, journal_head:null, privacy_notice:PROXY_PRIVACY_NOTICE,
      wallet_status:'unfunded', wallet_operation:null, wallet_emergency_escape:null };
    const {value,head} = record;
    const witness = (value as NoteJournal & { witness?: {expiry:string} }).witness;
    const emergency=value.wallet?.emergencyEscapes?.find(e=>e.phase!=='settled'),closed=value.wallet?.status==='closed';
    return { mode:this.o.mode, balance_micro_usdc:value.state.balance_micro_usdc, phase:value.pending?.phase ?? (closed?'closed':emergency?'emergency_escape':'ready'), in_flight:this.inflight, recovery_required:(!closed||!!value.pending)&&(this.recoveryRequired||!!emergency),
      unresolved_operations:value.pending?.operations.filter(o=>o.phase==='send_unknown').map(o=>({id:o.id,response_replayable:false})) ?? [],
      key_reuse_seconds:this.reuse, journal_head:head, privacy_notice:PROXY_PRIVACY_NOTICE,
      wallet_status:value.wallet?.status ?? 'legacy_import', wallet_operation:value.wallet?.operation ? {kind:value.wallet.operation.kind,phase:value.wallet.operation.phase} : null,
      wallet_emergency_escape:emergency?{phase:emergency.phase,funds_withdrawn:closed}:null,
      ...(witness ? {expiry:expiryNotice(BigInt(witness.expiry),this.now())} : {}) };
  }
  async management(action: 'close' | 'recover' | 'reconcile' | 'cancel-unsent' | 'wallet', body?: unknown): Promise<unknown> {
    return this.exclusive(async()=>{
      if (this.inflight) throw new DaemonConflict();
      if (action === 'wallet') { if (!this.o.wallet) throw new Error('wallet adapter unavailable'); return this.o.wallet(body); }
      if ((await this.record()).value.pending) {
        if (action === 'reconcile') await this.o.client.reconcileAbsentOperations(this.o.noteId); else if (action === 'cancel-unsent') await this.o.client.cancelUnsent(this.o.noteId); else if (action === 'recover') await this.o.client.recover(this.o.noteId); else await this.o.client.close(this.o.noteId);
      }
      if(this.recoveryRequired) {
        // Recovered pre-restart sessions must close before new inference; never
        // reuse their upstream key or replay their uncertain operations.
        if(action === 'recover' && (await this.record()).value.pending)await this.o.client.close(this.o.noteId);
        if(!(await this.record()).value.pending) { this.recoveryRequired = false; this.started = true; }
      }
      return this.status();
    });
  }
  async infer(path: string, bytes: Uint8Array, operationId = crypto.randomUUID() as string, anthropicVersion = '', signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    if (!routes.has(path) || !uuid.test(operationId) || bytes.length > 1024*1024) throw new Error('unsupported inference');
    const body = parseStrictJson(bytes);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw new Error('model is not in the pinned allowlist');
    const model = this.o.models.find(model => (typeof model === 'string' ? model : model.id) === body.model);
    if (!model) throw new Error('model is not in the pinned allowlist');
    if (typeof model !== 'string' && !model.apis.some(api => daemonApiPaths[api] === path)) throw new Error('model API is not configured');
    if (typeof model !== 'string') validateModelRequestCapabilities(model, body);
    if (this.o.mode !== 'proxy') {
      if (path.startsWith('/v1/messages') || this.o.mode === 'direct_openrouter' && path !== '/v1/chat/completions') throw new Error('unsupported direct endpoint');
      // Upstream clientd strips these identity/transport fields. Reject them
      // before AUTH here so the durable request retains the caller's exact bytes.
      if (['user','metadata','safety_identifier','prompt_cache_key','extra_headers','provider'].some(key=>Object.hasOwn(body,key))) throw new Error('unsupported identity or transport metadata');
      if (path === '/v1/responses' && body.store !== false) throw new Error('direct Responses requires store:false');
      // Direct adapters are text/client-tool only in this release as well.
      // Function parameter schemas describe application data. Their property
      // names/types are not provider request fields or hosted-tool selectors.
      const schemas = new Set<unknown>();
      if (Array.isArray(body.tools)) for (const tool of body.tools) {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function') continue;
        const definition = path === '/v1/chat/completions' ? tool.function : tool;
        if (definition && typeof definition === 'object' && !Array.isArray(definition) && Object.hasOwn(definition,'parameters')) schemas.add(definition.parameters);
      }
      const formats = new Set<unknown>();
      const format = path === '/v1/chat/completions' ? body.response_format
        : body.text && typeof body.text === 'object' && !Array.isArray(body.text) ? body.text.format : undefined;
      if (format && typeof format === 'object' && !Array.isArray(format) && ['text','json_object','json_schema'].includes(String(format.type))) {
        formats.add(format);
        if (format.type === 'json_schema') {
          const definition = path === '/v1/chat/completions' ? format.json_schema : format;
          if (definition && typeof definition === 'object' && !Array.isArray(definition) && Object.hasOwn(definition,'schema')) schemas.add(definition.schema);
        }
      }
      const check = (v: unknown): void => {
        if (schemas.has(v)) return;
        if (Array.isArray(v)) { for (const x of v) check(x); return; }
        if (!v || typeof v !== 'object') return;
        const obj = v as Record<string,unknown>;
        if (['image_url','input_audio','file_id','file_url','audio','web_search_options','previous_response_id','background','conversation'].some(k=>Object.hasOwn(obj,k)) || obj.store === true || obj.type !== undefined && !formats.has(obj) && !(Array.isArray(obj.type) ? obj.type.every(t=>['object','array','string','number','integer','boolean','null'].includes(String(t))) : ['text','input_text','output_text','function','function_call','function_call_output','message','object','array','string','number','integer','boolean','null'].includes(String(obj.type)))) throw new Error('unsupported modality or hosted tool');
        for (const v of Object.values(obj)) check(v);
      }; check(body);
    }
    const snapshot = new Uint8Array(bytes);
    let requestId: string | undefined;
    await this.exclusive(async()=>{
      signal?.throwIfAborted();
      if (!this.started || this.stopping || this.inflight >= (this.reuse === 0 ? 1 : 4)) throw new DaemonConflict();
      let r = await this.record();
      if(r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'))throw new DaemonConflict();
      if (r.value.history.some(h=>h.operations.some(o=>o.id===operationId)) || r.value.pending?.operations.some(o=>o.id===operationId)) throw new DaemonConflict();
      let p = r.value.pending;
      if (p && this.invalidated) throw new DaemonConflict();
      const tariffChanged = p && typeof model !== 'string' && 'tariff' in model
        && (model.tariff as { tariff_hash: string }).tariff_hash !== p.prepared.tariff.tariff_hash;
      if (p && (p.phase !== 'active' || p.closeRequested || this.expired(p,true) || tariffChanged || p.prepared.request.authorization.mode !== this.o.mode || this.o.mode === 'proxy' && p.prepared.request.quote.body.models[0] !== body.model)) {
        // This new operation has not been dispatched. Preserve its exact intent
        // while closing an incompatible/expired session; never replay an old one.
        if (this.inflight) throw new DaemonConflict();
        // Retire an active owned lease once before polling its signed successor.
        try {
          if (p.phase !== 'closing' || this.settlementWait === 0) await this.o.client.close(this.o.noteId);
          const closing = (await this.record()).value.pending;
          if (closing && this.settlementWait > 0) await this.waitForSettlement(closing,signal);
        } catch (error) { this.completedDirectResponse = undefined; throw error; }
        r = await this.record(); p = r.value.pending;
        if (p) throw new DaemonConflict();
        signal?.throwIfAborted();
        if (this.stopping) throw new DaemonConflict();
      }
      if (!p) {
        this.lease = undefined; this.invalidated = false; this.completedDirectResponse = undefined;
        const credentials = await createCredentials(this.o.mode);
        signal?.throwIfAborted();
        const prepared = await this.o.prepare(body.model as string,credentials);
        signal?.throwIfAborted();
        if (prepared.prepared.request.authorization.mode !== this.o.mode) throw new Error('mode changed during preparation');
        await this.o.client.prepare(this.o.noteId,prepared.prepared,prepared.root);
        signal?.throwIfAborted();
        const status = await this.o.client.submit(this.o.noteId,signal);
        r = await this.record(); p = r.value.pending;
        if (p?.phase === 'active' && p.serverState === 'ACTIVE') {
          // Fall back to the signed quote's earlier TTL boundary for legacy
          // endpoints without timing fields; never extend an advertised expiry.
          const q = p.prepared.request.quote.body;
          const fallback = BigInt(q.issued_at) + BigInt(q.session_ttl_seconds);
          const expiresAt = typeof status.expires_at === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(status.expires_at)
            ? BigInt(status.expires_at) : fallback;
          const until = this.now() + BigInt(this.reuse);
          const retireAt = expiresAt - ((this.o.minimumLeaseRemainingSeconds ?? 1) > 1 ? 0n : 1n);
          this.lease = { requestId: p.prepared.request.authorization.request_id, expiresAt, until: until < retireAt ? until : retireAt };
        }
      }
      if (!p || p.phase !== 'active' || p.serverState !== 'ACTIVE') throw new DaemonConflict();
      if (this.lease && this.now() + BigInt(this.o.minimumLeaseRemainingSeconds ?? 1) >= this.lease.expiresAt) {
        await this.o.client.close(this.o.noteId); throw new DaemonConflict();
      }
      requestId = p.prepared.request.authorization.request_id;
      if (this.o.mode === 'proxy') await this.o.client.prepareOperation(this.o.noteId,operationId,path,snapshot,anthropicVersion);
      this.inflight++;
    });
    let finishing: Promise<void> | undefined;
    const finish = (complete = false) => finishing ??= (async() => {
      if (complete && requestId && !signal?.aborted && !this.invalidated) {
        if (this.completedDirectResponse?.requestId !== requestId) this.completedDirectResponse = {requestId,operationIds:new Set()};
        this.completedDirectResponse.operationIds.add(operationId);
      } else { this.invalidated = this.o.mode !== 'proxy'; this.completedDirectResponse = undefined; }
      this.inflight--; if(this.inflight===0)for(const resolve of this.idleWaiters.splice(0))resolve();
      await this.maintenance().catch(()=>{ this.completedDirectResponse = undefined; });
    })();
    try {
      const response = this.o.mode === 'proxy' ? await this.o.client.sendOperation(this.o.noteId,operationId,signal) : await this.o.client.sendDirectOperation(this.o.noteId,operationId,path,snapshot,signal);
      // An upstream response must not set cookies, enable CORS or attach an
      // arbitrary correlation identifier to the local application origin.
      const headers = new Headers();
      for (const name of ['Content-Type','Retry-After',...(this.o.mode === 'proxy' ? ['X-Zkapi-Status-Url','X-Zkapi-Error-Code'] : [])]) {
        const value = response.headers.get(name); if (value !== null) headers.set(name,value);
      }
      headers.set('X-Zkapi-Operation-Id',operationId); headers.set('Cache-Control','no-store');
      const reader = response.body?.getReader();
      if (!reader) { await finish(response.ok); return new Response(null,{status:response.status,headers}); }
      let canceling = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            // cancel() resolves an outstanding read before its asynchronous
            // finalizer completes. Cancellation alone owns admission release.
            if (canceling) return;
            if (next.done) { await finish(response.ok); controller.close(); } else controller.enqueue(next.value);
          } catch {
            if (canceling) return;
            await finish(); controller.error(new Error('upstream stream interrupted; no replay'));
          }
        },
        async cancel() { canceling = true; try { await reader.cancel(); } finally { await finish(); } },
      });
      return new Response(body,{status:response.status,headers});
    } catch (error) { await finish(); throw error; }
  }
  async handle(method: string, path: string, bytes: Uint8Array, headers: Headers, signal?: AbortSignal): Promise<Response> {
    try {
      if (method === 'GET' && path === '/v1/models') return json({object:'list',data:this.o.models.map(model=>({id:typeof model === 'string' ? model : model.id,object:'model',owned_by:typeof model === 'string' ? 'configured-provider' : model.provider}))});
      if (method === 'GET' && path === '/admin/status') return json(await this.status());
      if (method === 'POST' && ['/admin/close','/admin/recover','/admin/reconcile','/admin/cancel-unsent','/admin/wallet'].includes(path)) return json(await this.management(path.slice(7) as 'close'|'recover'|'reconcile'|'cancel-unsent'|'wallet',bytes.length?parseStrictJson(bytes):undefined));
      if (method === 'POST' && routes.has(path)) return await this.infer(path,bytes,headers.get('Idempotency-Key') ?? undefined,headers.get('anthropic-version') ?? '',signal);
      return json({error:{code:'unsupported_route'}},404);
    } catch(error) { return json({error:{code:error instanceof DaemonConflict ? 'recovery_required' : 'client_request_failed',message:'Inference was not replayed. Inspect local status before retrying.'}},error instanceof DaemonConflict ? 409 : 400); }
  }
}
