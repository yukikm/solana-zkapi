/** Shared browser/native client state machine. Every uncertain send is durable;
 * no inference is retried, and only the cryptographic verifier advances a note.
 */
import { Buffer } from 'buffer';
import { parseField, parseMicroUsdc, parseScalar } from './encoding.ts';
import { EncryptedJournal, type JournalRecord } from './journal.ts';
import { parseStrictJson, jcsBytes, sha256Hex, verifyEd25519, verifyArtifactBundle, verifyPoolConfig,
  type VerifiedManifest, type ArtifactBundle, type FinalizedPoolAccount } from './trust.ts';

export type Mode = 'proxy' | 'direct_oa' | 'direct_openrouter';
export interface Point { x: string; y: string }
export interface StateSignature { r_x: string; r_y: string; s: string }
export interface PrivateState {
  balance_micro_usdc: string; balance_blinding: string; note_leaf: string;
  commitment: Point; anchor: string; state_signature: StateSignature | null;
}
export interface Quote {
  body: {
    quote_id: string; deployment_id: string; pool: string; mode: Mode;
    provider: 'openai' | 'anthropic' | 'openrouter' | 'oa'; models: string[];
    tariff_hash: string; cap_micro_usdc: string; issued_at: string; expires_at: string;
    session_ttl_seconds: string; max_concurrency: string; control_api_origin: string; inference_api_origin: string;
  }; quote_hash: string; signature: string;
}
export interface SessionCreate {
  authorization: { version: '1'; deployment_id: string; pool: string; request_id: string; quote_hash: string;
    mode: Mode; control_secret_hash: string; proxy_secret_hash: string | null };
  quote: Quote; public_inputs: string[]; proof: { backend: 'groth16_bn254'; proof: string };
}
export interface Tariff {
  tariff_hash: string; version: string; provider: string; model: string; pricing_basis: string;
  valid_from: string; valid_until: string; rates: { unit: string; nano_usdc_numerator: string; unit_denominator: string }[];
  operator_fee_micro_usdc: string;
}
export interface PreparedSession {
  request: SessionCreate; control_token: string; proxy_token: string | null; tariff: Tariff; rerandomization: string;
}
export interface Settlement {
  charge_micro_usdc: string; next_commitment: Point; next_anchor: string;
  blind_delta_srv: string; next_state_signature: StateSignature;
}
export interface Receipt {
  body: Record<string, unknown> & { receipt_id: string; operation_id: string | null; billing_effect: string };
  receipt_hash: string; signature: string;
}
export interface VerificationContext {
  deployment_id: string; pool: string; vault_binding: string; state_key: [string, string]; cap_micro_usdc: string;
  control_api_origin: string; inference_api_origin: string; quote_public_key: string; receipt_public_key: string;
  request_vk_sha256: string; tariff_hashes: string[];
}
/** Checks the finalized chain and all installed artifacts, returning detached
 * verified artifact bytes for the prover. Both verifiers snapshot before the
 * first await, so input mutation cannot replace the installation being checked.
 * The manifest must first pass verifyManifest with an independent trust anchor. */
export async function verifiedClientBundle(manifest: VerifiedManifest, genesisHash: string,
  pool: FinalizedPoolAccount, minimumSlot: bigint, artifacts: ArtifactBundle): Promise<{ context: VerificationContext; artifacts: ArtifactBundle }> {
  const [, verifiedArtifacts] = await Promise.all([
    verifyPoolConfig(manifest, genesisHash, pool, minimumSlot), verifyArtifactBundle(manifest, artifacts),
  ]);
  const context: VerificationContext = { deployment_id: manifest.deployment_id, pool: manifest.pool, vault_binding: manifest.vault_binding,
    state_key: [manifest.state_key.x, manifest.state_key.y], cap_micro_usdc: manifest.cap_micro_usdc,
    control_api_origin: manifest.control_api_origin, inference_api_origin: manifest.inference_api_origin,
    quote_public_key: manifest.quote_public_key, receipt_public_key: manifest.receipt_public_key,
    request_vk_sha256: manifest.request_vk_hash, tariff_hashes: [...manifest.tariff_hashes] };
  return { context, artifacts: verifiedArtifacts };
}
/** Compatibility helper for consumers that only need the verification context.
 * Use verifiedClientBundle when passing PK/VK bytes to a prover; never reuse the
 * mutable input bundle as if it were the authenticated returned copy. */
export async function verifiedClientContext(manifest: VerifiedManifest, genesisHash: string,
  pool: FinalizedPoolAccount, minimumSlot: bigint, artifacts: ArtifactBundle): Promise<VerificationContext> {
  return (await verifiedClientBundle(manifest, genesisHash, pool, minimumSlot, artifacts)).context;
}
/** Implementations MUST verify real RP, quote/tariff/credential bindings and
 * receipts + Baby-JubJub successor algebra/signature. There is no default or
 * success-on-unavailable implementation. The native implementation is supplied
 * by control-node; WASM is a separately tracked remaining acceptance gate. */
export interface SessionVerifier {
  prepare(context: VerificationContext, state: PrivateState, prepared: PreparedSession, now: string, root: string): Promise<void>;
  settle(context: VerificationContext, state: PrivateState, prepared: PreparedSession, settlement: Settlement,
    receipts: Receipt[], operations: string[]): Promise<PrivateState>;
}
export interface Operation {
  id: string; path: string; anthropicVersion: string; bodyBase64: string;
  phase: 'prepared' | 'send_unknown' | 'response_received';
}
export interface PendingSession {
  prepared: PreparedSession; exactRequest: string; phase: 'prepared' | 'send_unknown' | 'active' | 'closing';
  providerKey?: string; serverState?: string; operations: Operation[];
  /** Preserve close intent while an unacknowledged create still needs exact POST recovery. */
  closeRequested?: boolean;
}
export interface NoteJournal {
  schema: 1; state: PrivateState; pending: PendingSession | null;
  history: { previous: PrivateState; prepared: PreparedSession; settlement: Settlement; receipts: Receipt[]; operations: Operation[] }[];
}
export interface SessionStatus {
  request_id: string; mode: Mode; state: string; cap_micro_usdc: string;
  issued_at?: string; expires_at?: string; settlement?: Settlement;
  provider_key?: string; provider_api_origin?: string; last_error_code?: string;
}
const states = new Set(['RESERVED', 'ISSUING', 'ISSUANCE_UNKNOWN', 'ACTIVE', 'DRAINING', 'RECONCILING', 'SIGN_PENDING', 'SETTLED']);
const routes = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens']);
function requireTrue(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
function object(v: unknown): asserts v is Record<string, unknown> { requireTrue(v && typeof v === 'object' && !Array.isArray(v), 'invalid object'); }
function uuid(v: string): void { requireTrue(typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v), 'UUIDv4 required'); }
function point(p: Point): void { object(p); parseField(p.x); parseField(p.y); }
function privateState(s: PrivateState): void {
  object(s); parseMicroUsdc(s.balance_micro_usdc); parseScalar(s.balance_blinding); parseField(s.note_leaf); point(s.commitment); parseField(s.anchor);
  if (s.state_signature !== null) { object(s.state_signature); parseField(s.state_signature.r_x); parseField(s.state_signature.r_y); parseScalar(s.state_signature.s); }
}
export function validateNoteJournal(value: unknown): asserts value is NoteJournal {
  object(value); requireTrue(value.schema === 1 && Array.isArray(value.history), 'invalid note journal');
  privateState(value.state as PrivateState);
  if (value.pending !== null) {
    const p = value.pending as PendingSession; object(p); object(p.prepared);
    requireTrue(['prepared', 'send_unknown', 'active', 'closing'].includes(p.phase) && Array.isArray(p.operations), 'invalid session phase');
    requireTrue(p.closeRequested === undefined || typeof p.closeRequested === 'boolean', 'invalid close intent');
    uuid(p.prepared.request.authorization.request_id);
    requireTrue(JSON.stringify(p.prepared.request) === p.exactRequest, 'saved authorization bytes changed');
    requireTrue(typeof p.prepared.control_token === 'string' && (typeof p.prepared.proxy_token === 'string' || p.prepared.proxy_token === null), 'missing credentials');
    const ids = new Set();
    for (const o of p.operations) {
      uuid(o.id); requireTrue(!ids.has(o.id), 'duplicate operation'); ids.add(o.id);
      requireTrue(routes.has(o.path) && ['prepared', 'send_unknown', 'response_received'].includes(o.phase), 'invalid operation');
      const raw = Buffer.from(o.bodyBase64, 'base64');
      requireTrue(raw.toString('base64') === o.bodyBase64 && raw.length <= 1024 * 1024, 'invalid operation bytes');
    }
  }
}

export interface ClientOptions {
  context: VerificationContext; journal: EncryptedJournal<NoteJournal>; verifier: SessionVerifier;
  fetch?: typeof globalThis.fetch; now?: () => bigint;
  allowLoopbackHttp?: boolean;
  /** Independently configured direct adapter bases (often include /api/v1).
   * Absent entries refuse key delivery and close the session; never infer a
   * destination from an untrusted response or fall back to proxy. */
  directProviderBases?: Partial<Record<'direct_oa' | 'direct_openrouter', string>>;
}
export class ControlHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`control HTTP ${status}; durable state retained`); this.status = status; }
}
export class ResponseNotReplayable extends Error {
  readonly operationId: string; readonly statusPath: string;
  constructor(operationId: string, statusPath: string) {
    super('Inference response cannot be replayed. Check operation status; a new inference requires an explicit new operation.');
    this.operationId = operationId; this.statusPath = statusPath;
  }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex');
}
export async function createCredentials(mode: Mode): Promise<{
  requestId: string; controlToken: string; proxyToken: string | null; controlHash: string; proxyHash: string | null;
}> {
  requireTrue(['proxy', 'direct_oa', 'direct_openrouter'].includes(mode), 'explicit mode required');
  const requestId = crypto.randomUUID(); const control = crypto.getRandomValues(new Uint8Array(32));
  const proxy = mode === 'proxy' ? crypto.getRandomValues(new Uint8Array(32)) : null;
  return { requestId, controlToken: `zkc1.${requestId}.${Buffer.from(control).toString('base64url')}`,
    proxyToken: proxy ? `zkp1.${requestId}.${Buffer.from(proxy).toString('base64url')}` : null,
    controlHash: await sha256(control), proxyHash: proxy ? await sha256(proxy) : null };
}

export class ControlClient {
  private readonly config: VerificationContext;
  private readonly options: ClientOptions;
  constructor(options: ClientOptions) {
    this.options = { ...options, directProviderBases: { ...options.directProviderBases } }; this.config = structuredClone(options.context);
    for (const origin of [this.config.control_api_origin, this.config.inference_api_origin]) {
      const u = new URL(origin);
      requireTrue(u.origin === origin && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'canonical origin required');
      requireTrue(u.protocol === 'https:' || options.allowLoopbackHttp === true && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname), 'HTTPS required');
    }
    for (const base of Object.values(this.options.directProviderBases ?? {})) {
      const u = new URL(base); requireTrue(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, 'invalid direct provider base');
    }
  }
  private async record(noteId: string): Promise<JournalRecord<NoteJournal>> {
    const r = await this.options.journal.read(noteId); requireTrue(r, 'note must already be finalized and imported'); return r;
  }
  private async save(noteId: string, r: JournalRecord<NoteJournal>): Promise<JournalRecord<NoteJournal>> {
    return this.options.journal.compareAndSwap(noteId, r.revision, r.value);
  }
  private async json(response: Response): Promise<unknown> {
    // Bound the stream, not just Content-Length, before materializing JSON.
    const reader = response.body?.getReader(); requireTrue(reader, 'missing response');
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      length += value.length; requireTrue(length <= 4 * 1024 * 1024, 'response size limit'); chunks.push(value);
    } } finally { await reader.cancel(); }
    return parseStrictJson(new Uint8Array(Buffer.concat(chunks)));
  }
  private fetch(path: string, method: string, token: string, body?: string): Promise<Response> {
    requireTrue(path.startsWith('/zkapi/v1/') && !path.includes('://'), 'invalid control path');
    return (this.options.fetch ?? globalThis.fetch)(this.config.control_api_origin + path, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body,
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    });
  }
  private path(p: PendingSession): string { return `/zkapi/v1/sessions/${p.prepared.request.authorization.request_id}`; }
  async quote(request: { mode: Mode; provider: Quote['body']['provider']; models: string[]; session_ttl_seconds?: string }, tariff: Tariff): Promise<Quote> {
    const wanted = structuredClone(request), frozenTariff = structuredClone(tariff);
    object(wanted);
    requireTrue(Object.keys(wanted).every(k => ['mode','provider','models','session_ttl_seconds'].includes(k)), 'unknown quote request field');
    requireTrue(Array.isArray(wanted.models) && wanted.models.length === 1 && typeof wanted.models[0] === 'string', 'quote model selection');
    requireTrue(wanted.mode === 'proxy' ? ['openai','anthropic','openrouter'].includes(wanted.provider) && wanted.models[0] !== '*' && /^[\x21-\x7e]+$/.test(wanted.models[0])
      : (wanted.mode === 'direct_oa' && wanted.provider === 'oa' || wanted.mode === 'direct_openrouter' && wanted.provider === 'openrouter') && wanted.models[0] === '*', 'explicit quote mode/provider required');
    if (wanted.session_ttl_seconds !== undefined) requireTrue(typeof wanted.session_ttl_seconds === 'string' && /^[1-9][0-9]{0,2}$/.test(wanted.session_ttl_seconds) && BigInt(wanted.session_ttl_seconds) <= 300n, 'session TTL');
    const response = await (this.options.fetch ?? globalThis.fetch)(this.config.control_api_origin + '/zkapi/v1/quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wanted),
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new ControlHttpError(response.status);
    const raw = await this.json(response); object(raw);
    requireTrue(Object.keys(raw).sort().join(',') === 'body,quote_hash,signature', 'invalid quote fields');
    const quote = raw as unknown as Quote; object(quote.body); const b = quote.body;
    requireTrue(Object.keys(b).sort().join(',') === ['quote_id','deployment_id','pool','mode','provider','models','tariff_hash','cap_micro_usdc','issued_at','expires_at','session_ttl_seconds','max_concurrency','control_api_origin','inference_api_origin'].sort().join(','), 'invalid quote body');
    const hash = await sha256Hex(jcsBytes(b)); requireTrue(hash === quote.quote_hash, 'quote hash');
    await verifyEd25519(this.config.quote_public_key, Uint8Array.from(Buffer.from(hash, 'hex')), quote.signature);
    const { tariff_hash: tariffHash, ...tariffBody } = frozenTariff;
    requireTrue(await sha256Hex(jcsBytes(tariffBody)) === tariffHash && this.config.tariff_hashes.includes(tariffHash), 'untrusted tariff');
    requireTrue(b.deployment_id === this.config.deployment_id && b.pool === this.config.pool && b.cap_micro_usdc === this.config.cap_micro_usdc
      && b.control_api_origin === this.config.control_api_origin && b.inference_api_origin === this.config.inference_api_origin
      && b.mode === wanted.mode && b.provider === wanted.provider && JSON.stringify(b.models) === JSON.stringify(wanted.models)
      && b.tariff_hash === tariffHash && b.provider === frozenTariff.provider && b.models.length === 1 && b.models[0] === frozenTariff.model, 'quote binding');
    requireTrue(b.mode === 'proxy' ? ['openai','anthropic','openrouter'].includes(b.provider) && b.models[0] !== '*' && /^[\x21-\x7e]+$/.test(b.models[0]) && frozenTariff.pricing_basis === 'fixed_usage_rates'
      : (b.mode === 'direct_oa' && b.provider === 'oa' || b.mode === 'direct_openrouter' && b.provider === 'openrouter') && b.models[0] === '*' && frozenTariff.pricing_basis === 'provider_reported_usd', 'mode/provider mismatch');
    uuid(b.quote_id); parseMicroUsdc(b.cap_micro_usdc);
    for (const v of [b.issued_at,b.expires_at,b.session_ttl_seconds,frozenTariff.valid_from,frozenTariff.valid_until]) requireTrue(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20 && BigInt(v) <= 0xffffffffffffffffn, 'quote time');
    const now = this.options.now?.() ?? BigInt(Math.floor(Date.now()/1000));
    requireTrue(BigInt(b.issued_at) <= now && now < BigInt(b.expires_at) && BigInt(b.expires_at) === BigInt(b.issued_at)+120n
      && BigInt(b.issued_at) >= BigInt(frozenTariff.valid_from) && BigInt(b.issued_at) < BigInt(frozenTariff.valid_until)
      && BigInt(b.session_ttl_seconds) >= 1n && BigInt(b.session_ttl_seconds) <= 300n
      && b.session_ttl_seconds === (wanted.session_ttl_seconds ?? '60') && b.max_concurrency === '4', 'quote limits');
    return quote;
  }
  async prepare(noteId: string, prepared: PreparedSession, finalizedRoot: string): Promise<void> {
    // Snapshot the proof and secrets before asynchronous verification/storage.
    const copy = structuredClone(prepared);
    await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); requireTrue(r.value.pending === null, 'note already has an unresolved authorization');
      const id = copy.request.authorization.request_id;
      requireTrue(!r.value.history.some(h => h.prepared.request.authorization.request_id === id), 'request already settled');
      await this.options.verifier.prepare(this.config, r.value.state, copy, (this.options.now?.() ?? BigInt(Math.floor(Date.now() / 1000))).toString(), finalizedRoot);
      r.value.pending = { prepared: copy, exactRequest: JSON.stringify(copy.request), phase: 'prepared', operations: [] };
      await this.save(noteId, r);
    });
  }
  async submit(noteId: string): Promise<SessionStatus> {
    return this.options.journal.withNoteLock(noteId, async () => this.submitPending(noteId, await this.record(noteId)));
  }
  /** Caller holds the note operation lock. An unknown create must remain
   * replayable even when close was requested before the server acknowledged it. */
  private async submitPending(noteId: string, record: JournalRecord<NoteJournal>): Promise<SessionStatus> {
    let r = record; const p = r.value.pending; requireTrue(p, 'no pending authorization');
    requireTrue(p.phase === 'prepared' || p.phase === 'send_unknown', 'use recover for existing session');
    if (p.phase === 'prepared') {
      const now = this.options.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
      requireTrue(now >= BigInt(p.prepared.request.quote.body.issued_at) && now < BigInt(p.prepared.request.quote.body.expires_at), 'unsent quote expired; cancelUnsent and prepare new credentials/quote/proof');
    }
    p.phase = 'send_unknown'; r = await this.save(noteId, r);
    // Exact same body and credentials on retries, even when the quote is old.
    const response = await this.fetch('/zkapi/v1/sessions', 'POST', p.prepared.control_token, p.exactRequest);
    if (!response.ok) throw new ControlHttpError(response.status);
    return this.accept(noteId, r, await this.json(response), response.status !== 202);
  }
  /** Only a never-sent authorization can be discarded locally. A send_unknown
   * record, even after a timeout or expired quote, must use exact recovery. */
  async cancelUnsent(noteId: string): Promise<void> {
    await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId);
      requireTrue(r.value.pending?.phase === 'prepared' && r.value.pending.operations.length === 0, 'cannot cancel a possibly sent authorization');
      r.value.pending = null; await this.save(noteId, r);
    });
  }
  async recover(noteId: string): Promise<SessionStatus> {
    // Recovering an unknown create resends only the identical authorization;
    // provider inference is never repeated by this path.
    const existing = await this.record(noteId); requireTrue(existing.value.pending, 'no pending authorization');
    if (['prepared', 'send_unknown'].includes(existing.value.pending.phase)) return this.submit(noteId);
    return this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending; requireTrue(p, 'already settled');
      const response = await this.fetch(this.path(p), 'GET', p.prepared.control_token);
      if (!response.ok) throw new ControlHttpError(response.status);
      return this.accept(noteId, r, await this.json(response), false);
    });
  }
  async close(noteId: string): Promise<SessionStatus> {
    return this.options.journal.withNoteLock(noteId, async () => {
      let r = await this.record(noteId); const p = r.value.pending; requireTrue(p, 'no pending authorization');
      requireTrue(p.phase !== 'prepared', 'submit authorization before close');
      p.closeRequested = true;
      if (p.phase === 'send_unknown') return this.submitPending(noteId, r);
      p.phase = 'closing'; r = await this.save(noteId, r);
      const response = await this.fetch(this.path(p) + '/close', 'POST', p.prepared.control_token);
      if (!response.ok) throw new ControlHttpError(response.status);
      return this.accept(noteId, r, await this.json(response), false);
    });
  }
  private async accept(noteId: string, r: JournalRecord<NoteJournal>, raw: unknown, initial: boolean): Promise<SessionStatus> {
    object(raw); const status = raw as unknown as SessionStatus; const p = r.value.pending!;
    const q = p.prepared.request.quote.body;
    requireTrue(Object.keys(raw).every(k => ['request_id','mode','state','cap_micro_usdc','issued_at','expires_at','settlement','provider_key','provider_api_origin','last_error_code'].includes(k)), 'unknown session field');
    requireTrue(status.request_id === p.prepared.request.authorization.request_id && status.mode === q.mode
      && status.cap_micro_usdc === q.cap_micro_usdc && states.has(status.state), 'session identity mismatch');
    p.serverState = status.state;
    if (status.provider_key !== undefined) {
      requireTrue(initial && p.prepared.request.authorization.mode !== 'proxy' && status.state === 'ACTIVE'
        && typeof status.provider_key === 'string' && status.provider_key.length > 0 && status.provider_key.length <= 8192, 'unexpected provider key');
      if (p.closeRequested || p.phase === 'closing') { delete status.provider_key; delete status.provider_api_origin; }
      else if (status.provider_api_origin === this.options.directProviderBases?.[p.prepared.request.authorization.mode]) p.providerKey = status.provider_key;
      else { p.phase = 'closing'; delete status.provider_key; delete status.provider_api_origin; }
    }
    if (status.state === 'SETTLED') {
      requireTrue(status.settlement && !status.provider_key, 'missing settlement');
      const receipts = await this.receipts(p);
      const operations = p.operations.filter(o => o.phase !== 'prepared').map(o => o.id);
      const next = await this.options.verifier.settle(this.config, r.value.state, p.prepared, status.settlement, receipts, operations);
      privateState(next);
      r.value.history.push({ previous: r.value.state, prepared: p.prepared, settlement: status.settlement, receipts, operations: p.operations });
      r.value.state = next; r.value.pending = null; await this.save(noteId, r);
      return status;
    }
    requireTrue(status.settlement === undefined, 'premature settlement');
    const closeRequired = p.closeRequested === true || p.phase === 'closing' || q.mode !== 'proxy' && !p.providerKey;
    p.phase = closeRequired ? 'closing' : 'active'; r = await this.save(noteId, r);
    if (closeRequired) {
      // Losing a direct key is not permission to issue another key or change mode.
      const response = await this.fetch(this.path(p) + '/close', 'POST', p.prepared.control_token);
      if (!response.ok) throw new ControlHttpError(response.status);
      const closed = await this.json(response); object(closed);
      // A close response may already contain the signed successor. Avoid recursive
      // polling; persist closing and let caller schedule the next explicit recover.
      if (closed.state === 'SETTLED') return this.accept(noteId, r, closed, false);
    }
    return status;
  }
  private async receipts(p: PendingSession): Promise<Receipt[]> {
    const all: Receipt[] = []; let cursor: string | null = null; const seen = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      const response = await this.fetch(this.path(p) + '/receipts' + (cursor === null ? '' : `?cursor=${cursor}`), 'GET', p.prepared.control_token);
      if (!response.ok) throw new ControlHttpError(response.status);
      const raw = await this.json(response); object(raw);
      requireTrue(Object.keys(raw).sort().join(',') === 'next_cursor,receipts' && Array.isArray(raw.receipts) && raw.receipts.length <= 100, 'invalid receipt page');
      if (raw.receipts.length === 0) { requireTrue(raw.next_cursor === null, 'empty page cursor'); return all; }
      requireTrue(typeof raw.next_cursor === 'string' && /^[1-9][0-9]*$/.test(raw.next_cursor) && raw.next_cursor.length <= 19
        && (cursor === null || BigInt(raw.next_cursor) > BigInt(cursor)), 'receipt cursor did not advance');
      for (const item of raw.receipts) { object(item); requireTrue(typeof item.receipt_hash === 'string' && !seen.has(item.receipt_hash), 'duplicate receipt');
        seen.add(item.receipt_hash); all.push(item as unknown as Receipt); }
      cursor = raw.next_cursor;
    }
    throw new Error('receipt page limit; settlement remains unresolved');
  }
  async prepareOperation(noteId: string, operationId: string, path: string, body: Uint8Array, anthropicVersion = ''): Promise<void> {
    uuid(operationId); requireTrue(routes.has(path) && body.length <= 1024 * 1024, 'unsupported inference');
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    const anthropic = path.startsWith('/v1/messages');
    requireTrue(anthropic ? /^[\x20-\x7e]+$/.test(anthropicVersion) : anthropicVersion === '', 'invalid API version');
    const bodyBase64 = Buffer.from(body).toString('base64');
    await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending;
      requireTrue(p && p.phase === 'active' && p.serverState === 'ACTIVE' && p.prepared.request.authorization.mode === 'proxy', 'proxy session required');
      const old = p.operations.find(o => o.id === operationId);
      if (old) { requireTrue(old.path === path && old.bodyBase64 === bodyBase64 && old.anthropicVersion === anthropicVersion, 'idempotency conflict'); return; }
      p.operations.push({ id: operationId, path, bodyBase64, anthropicVersion, phase: 'prepared' }); await this.save(noteId, r);
    });
  }
  async sendOperation(noteId: string, operationId: string): Promise<Response> {
    uuid(operationId);
    const dispatch = await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending;
      requireTrue(p && p.phase === 'active' && p.serverState === 'ACTIVE' && p.prepared.proxy_token, 'active proxy session required');
      const operation = p.operations.find(o => o.id === operationId); requireTrue(operation, 'operation must be saved before sending');
      if (operation.phase !== 'prepared') throw new ResponseNotReplayable(operationId, this.path(p) + `/operations/${operationId}`);
      operation.phase = 'send_unknown'; await this.save(noteId, r);
      return { operation: structuredClone(operation), token: p.prepared.proxy_token, statusPath: this.path(p) + `/operations/${operationId}` };
    });
    const response = await (this.options.fetch ?? globalThis.fetch)(this.config.inference_api_origin + dispatch.operation.path, {
      method: 'POST', headers: { Authorization: `Bearer ${dispatch.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': operationId,
        ...(dispatch.operation.anthropicVersion ? { 'anthropic-version': dispatch.operation.anthropicVersion } : {}) },
      body: new Uint8Array(Buffer.from(dispatch.operation.bodyBase64, 'base64')), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(600_000),
    });
    if (response.status === 409) { await response.body?.cancel(); throw new ResponseNotReplayable(operationId, dispatch.statusPath); }
    // The response stream is passed through once. Usage comes from signed receipts.
    return response;
  }
  async operationStatus(noteId: string, operationId: string): Promise<unknown> {
    uuid(operationId); const r = await this.record(noteId); const p = r.value.pending;
    requireTrue(p && p.operations.some(o => o.id === operationId), 'unknown local operation');
    const response = await this.fetch(this.path(p) + `/operations/${operationId}`, 'GET', p.prepared.control_token);
    if (!response.ok) throw new ControlHttpError(response.status);
    const result = await this.json(response); object(result);
    requireTrue(result.request_id === p.prepared.request.authorization.request_id && result.operation_id === operationId && result.response_replayable === false, 'operation identity');
    return result;
  }
}

export function expiryNotice(expiry: bigint, now: bigint): { severity: 'expired' | 'one_day' | 'seven_days' | 'normal'; message: string } {
  requireTrue(expiry >= 0n && now >= 0n, 'invalid expiry');
  const left = expiry - now;
  return { severity: left <= 0n ? 'expired' : left <= 86_400n ? 'one_day' : left <= 604_800n ? 'seven_days' : 'normal',
    message: `Note expiry: ${expiry} (Unix seconds). After expiry, the entire principal of an Active note can be transferred to the treasury.` };
}
export const PROXY_PRIVACY_NOTICE = 'The proxy operator can read your prompts and responses. Direct and proxy modes are selected explicitly.';
