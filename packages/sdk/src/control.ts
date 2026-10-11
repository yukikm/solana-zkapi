/** Shared browser/native client state machine. Every uncertain send is durable;
 * no inference is retried, and only the cryptographic verifier advances a note.
 */
import { Buffer } from 'buffer';
import { directRequestBytes } from './direct-request.ts';
import { checkModelAvailability, describeProviderError } from './provider-status.ts';
import { parseField, parseMicroUsdc, parseScalar } from './encoding.ts';
import { EncryptedJournal, type JournalRecord } from './journal.ts';
import { parseStrictJson, jcsBytes, sha256Hex, verifyEd25519, verifyArtifactBundle, verifyPoolConfig,
  type VerifiedManifest, type ArtifactBundle, type FinalizedPoolAccount } from './trust.ts';
import { validateWitness, type NoteWitness } from './prover.ts';
import { validateInlineDepositPlanRecord, validateInlineDepositAttemptRecord } from './transport.ts';
import type { WalletJournal, WalletOperation } from './wallet.ts';

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
  /** Empty body with this marker is permanently non-replayable, even if prepared. */
  bodyRedacted?: true;
  /** Exact dispatched-body fingerprint, never sufficient to replay. Explicit purge removes it too. */
  bodySha256?: string;
  phase: 'prepared' | 'send_unknown' | 'response_received' | 'not_accepted';
}
/** OA's signed key evidence. The verifier and station are independently pinned
 * in ClientOptions; these response fields never select a network destination. */
export interface OaKeyVerification {
  verifier_url: string; station_id: string; station_recently_attested: boolean;
  key_valid_till: number; station_signature: string; org_signature: string;
}
export interface PendingSession {
  prepared: PreparedSession; exactRequest: string; phase: 'prepared' | 'send_unknown' | 'active' | 'closing';
  /** Legacy readable field; new ControlClient writes omit it. Usable keys are memory-only. */
  providerKey?: string; serverState?: string; operations: Operation[];
  /** Evidence, not a persisted assertion of trust or a replacement for a live key. */
  oaKeyVerification?: { evidence: OaKeyVerification; expiresAt: string };
  /** Preserve close intent while an unacknowledged create still needs exact POST recovery. */
  closeRequested?: boolean;
}
export interface NoteJournal {
  schema: 1 | 2; state: PrivateState; pending: PendingSession | null;
  /** Full prover witness stays in the same encrypted record as control state. */
  witness?: NoteWitness;
  wallet?: WalletJournal;
  history: { previous: PrivateState; prepared: PreparedSession; settlement: Settlement; receipts: Receipt[]; operations: Operation[] }[];
}
export interface SessionStatus {
  request_id: string; mode: Mode; state: string; cap_micro_usdc: string;
  issued_at?: string; expires_at?: string; settlement?: Settlement;
  provider_key?: string; provider_api_origin?: string; last_error_code?: string;
  provider_key_verification?: OaKeyVerification;
}
const states = new Set(['RESERVED', 'ISSUING', 'ISSUANCE_UNKNOWN', 'ACTIVE', 'DRAINING', 'RECONCILING', 'SIGN_PENDING', 'SETTLED']);
const routes = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens']);
function requireTrue(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
function object(v: unknown): asserts v is Record<string, unknown> { requireTrue(v && typeof v === 'object' && !Array.isArray(v), 'invalid object'); }
function allowedFields(value: object, allowed: readonly string[]): void { object(value); requireTrue(Object.keys(value).every(k=>allowed.includes(k)), 'unknown journal field'); }
function uuid(v: string): void { requireTrue(typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v), 'UUIDv4 required'); }
function point(p: Point): void { object(p); parseField(p.x); parseField(p.y); }
function privateState(s: PrivateState): void {
  object(s); parseMicroUsdc(s.balance_micro_usdc); parseScalar(s.balance_blinding); parseField(s.note_leaf); point(s.commitment); parseField(s.anchor);
  if (s.state_signature !== null) { object(s.state_signature); parseField(s.state_signature.r_x); parseField(s.state_signature.r_y); parseScalar(s.state_signature.s); }
}
function pendingSession(p: PendingSession): void {
  object(p); object(p.prepared);
  requireTrue(['prepared', 'send_unknown', 'active', 'closing'].includes(p.phase) && Array.isArray(p.operations), 'invalid session phase');
  requireTrue(p.closeRequested === undefined || typeof p.closeRequested === 'boolean', 'invalid close intent');
  uuid(p.prepared.request.authorization.request_id);
  requireTrue(JSON.stringify(p.prepared.request) === p.exactRequest, 'saved authorization bytes changed');
  requireTrue(typeof p.prepared.control_token === 'string' && (typeof p.prepared.proxy_token === 'string' || p.prepared.proxy_token === null), 'missing credentials');
  validateOperations(p.operations);
}
function validateOperations(operations: Operation[]): void {
  requireTrue(Array.isArray(operations),'invalid operations');
  const ids = new Set<string>();
  for (const o of operations) {
    object(o); uuid(o.id); requireTrue(!ids.has(o.id), 'duplicate operation'); ids.add(o.id);
    requireTrue(routes.has(o.path) && typeof o.anthropicVersion === 'string'
      && ['prepared','send_unknown','response_received','not_accepted'].includes(o.phase), 'invalid operation');
    requireTrue(typeof o.bodyBase64 === 'string', 'invalid operation bytes');
    const raw = Buffer.from(o.bodyBase64,'base64');
    requireTrue(raw.toString('base64') === o.bodyBase64 && raw.length <= 1024*1024, 'invalid operation bytes');
    requireTrue(o.bodySha256 === undefined || typeof o.bodySha256 === 'string' && /^[0-9a-f]{64}$/.test(o.bodySha256), 'invalid body fingerprint');
    requireTrue(o.bodyRedacted === undefined || o.bodyRedacted === true && o.bodyBase64 === '', 'invalid body redaction');
  }
}
async function redactOperations(operations: Operation[], eraseFingerprints = false): Promise<number> {
  let count = 0;
  for (const o of operations) {
    if (!o.bodyRedacted || eraseFingerprints && o.bodySha256 !== undefined) count++;
    if (!o.bodyRedacted && !eraseFingerprints) o.bodySha256 = await sha256Hex(Buffer.from(o.bodyBase64,'base64'));
    if (eraseFingerprints) delete o.bodySha256;
    o.bodyBase64 = ''; o.bodyRedacted = true;
  }
  return count;
}

export async function validateNoteJournal(input: unknown): Promise<void> {
  // PDA derivation is asynchronous. Validate a detached value across every await.
  const value: unknown = structuredClone(input);
  object(value); requireTrue((value.schema === 1 || value.schema === 2) && Array.isArray(value.history), 'invalid note journal');
  if(value.schema===2)allowedFields(value,['schema','state','pending','witness','wallet','history']);
  for (const h of value.history) { object(h); validateOperations(h.operations as Operation[]); }
  privateState(value.state as PrivateState);
  if (value.witness !== undefined) validateWitness(value.witness);
  if (value.wallet !== undefined) {
    const w = value.wallet as WalletJournal;
    requireTrue(w && ['unfunded','active','pending_escape','closed'].includes(w.status) && Array.isArray(w.history), 'invalid wallet journal');
    requireTrue(value.witness !== undefined, 'wallet witness missing');
    if(value.schema===2)allowedFields(w,['status','clearance','clearedAuthorization','emergencyEscapes','operation','history']);
    if (w.clearance) { parseField(w.clearance.nullifier); requireTrue(['requested','verified'].includes(w.clearance.phase), 'invalid clearance journal'); }
    if (w.clearedAuthorization !== undefined) {
      const archived = w.clearedAuthorization; object(archived);
      requireTrue(Object.keys(archived).sort().join(',') === 'pending,previous', 'invalid cleared authorization fields');
      privateState(archived.previous); pendingSession(archived.pending);
      requireTrue(Buffer.from(jcsBytes(archived.previous)).equals(Buffer.from(jcsBytes(value.state))), 'cleared authorization state changed');
      requireTrue(value.pending === null && w.clearance?.phase === 'verified' && w.clearance.signature,
        'cleared authorization requires permanent clearance');
      const signature = w.clearance.signature; object(signature);
      requireTrue(Object.keys(signature).sort().join(',') === 'r_x,r_y,s', 'invalid clearance signature fields');
      parseField(signature.r_x); parseField(signature.r_y); parseScalar(signature.s);
      const p = archived.pending, inputs = p.prepared.request.public_inputs;
      requireTrue(p.phase === 'send_unknown' && p.operations.length === 0 && p.providerKey === undefined && p.serverState === undefined,
        'invalid cleared authorization phase');
      requireTrue(Array.isArray(inputs) && inputs.length === 12, 'invalid cleared authorization inputs');
      inputs.forEach(parseField);
      requireTrue(inputs[8] === w.clearance.nullifier, 'cleared authorization nullifier changed');
    }
    for (const operation of [...w.history, ...(w.operation ? [w.operation] : [])]) {
      requireTrue(operation && typeof operation === 'object', 'invalid wallet operation');
      const inline = operation.transport === 'v0_inline_deposit_v1';
      requireTrue(operation.transport === undefined || operation.transport === 'v0_buffer' || inline, 'unknown wallet transport');
      requireTrue(value.schema === 2 || !inline && !operation.inlinePlan && operation.attempts?.every(a => a.kind !== 'deposit_inline' && a.schema === 1), 'schema 1 cannot contain inline deposit');
      requireTrue(['deposit','mutual_close','initiate_escape','finalize_escape'].includes(operation.kind)
        && ['proving','ready','stale','closing_stale','failed','cancelled'].includes(operation.phase)
        && Array.isArray(operation.attempts) && Number.isInteger(operation.step) && operation.step >= 0, 'invalid financial operation');
      const signatures = new Set();
      for (const attempt of operation.attempts) {
        requireTrue((inline ? attempt.schema === 2 && attempt.kind === 'deposit_inline' : attempt.schema === 1)
          && typeof attempt.signature === 'string' && !signatures.has(attempt.signature)
          && typeof attempt.wireHex === 'string' && /^(?:[0-9a-f]{2})+$/.test(attempt.wireHex), 'invalid financial attempt'); signatures.add(attempt.signature);
        if (attempt.kind === 'deposit_inline') await validateInlineDepositAttemptRecord(attempt);
      }
      requireTrue(operation.current === undefined || signatures.has(operation.current), 'missing current financial attempt');
      if (inline) {
        if(operation===w.operation)requireTrue(w.status==='unfunded'&&value.pending===null&&w.clearance===undefined,'inline deposit requires unfunded note');
        await validateInlineWalletOperation(operation,operation===w.operation);
      }
      else {
        requireTrue(operation.inlinePlan === undefined, 'buffer operation contains inline plan');
        if(value.schema===2){
          allowedFields(operation,['id','kind','phase','roles','destinationOwner','plan','finalization','step','attempts','current','finalized','expiredCreations','transport']);
          allowedFields(operation.roles,['uploader','rentPayer','feePayer','payer','tokenOwner']);
          const planFields=['programId','pool','operation','payloadHex','nonceHex','expires','uploader','rentPayer','feePayer','snapshotSlot','snapshotSequence','expectedRoot','expectedNoteId','financial','priorityFeeMicroLamports'];
          if(operation.plan)allowedFields(operation.plan,planFields);
          requireTrue(operation.kind==='finalize_escape'?operation.plan===undefined:operation.finalization===undefined,'mixed financial plans');
          for(const attempt of operation.attempts){
            allowedFields(attempt,['schema','kind','signature','wireHex','blockhash','lastValidBlockHeight',...(attempt.kind==='finalize'?['finalization']:['planDigest','buffer','plan','closer'])]);
            if(attempt.kind!=='finalize'&&attempt.kind!=='deposit_inline')allowedFields(attempt.plan,planFields);
          }
        }
      }
    }
  }
  if (value.pending !== null) pendingSession(value.pending as PendingSession);
  if (value.wallet) validateEmergencyEscapes(value as unknown as NoteJournal);
}
function sameJson(a:unknown,b:unknown):boolean { return Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b))); }
/** An archive is evidence, never an unchecked permission bit. Every phase is
 * joined to its original state/request, financial history and chain barrier. */
function validateEmergencyEscapes(note:NoteJournal):void {
  const w=note.wallet!,archives=w.emergencyEscapes;if(archives===undefined)return;
  requireTrue(Array.isArray(archives),'invalid emergency escape archive');
  const ids=new Set<string>(),requests=new Set<string>();
  for(const [index,e] of archives.entries()){
    allowedFields(e,['pending','previous','nullifier','operationId','phase','escape','challenge']);
    pendingSession(e.pending);privateState(e.previous);parseField(e.nullifier);uuid(e.operationId);
    const p=e.pending,request=p.prepared.request,q=request.quote.body,requestId=request.authorization.request_id;
    requireTrue(p.phase!=='prepared'&&['escaping','challenged','settled'].includes(e.phase)
      &&!ids.has(e.operationId)&&!requests.has(requestId),'invalid emergency escape identity');
    ids.add(e.operationId);requests.add(requestId);
    requireTrue(request.public_inputs.length===12&&request.public_inputs[8]===e.nullifier
      &&request.authorization.deployment_id===q.deployment_id&&request.authorization.pool===q.pool
      &&request.authorization.mode===q.mode,'emergency authorization binding changed');
    request.public_inputs.forEach(parseField);
    const operation=[...w.history,...(w.operation?[w.operation]:[])].filter(o=>o.id===e.operationId);
    requireTrue(operation.length===1&&operation[0].kind==='initiate_escape','emergency escape operation missing');
    const op=operation[0];
    if(op.plan)requireTrue(op.plan.operation==='initiate_escape'&&op.plan.pool===request.authorization.pool,'emergency escape plan binding changed');
    if(e.escape){
      allowedFields(e.escape,['signature','slot','sequence']);
      requireTrue(typeof e.escape.signature==='string'&&Number.isSafeInteger(e.escape.slot)&&e.escape.slot>=0
        &&typeof e.escape.sequence==='string'&&/^(0|[1-9][0-9]*)$/.test(e.escape.sequence)
        &&BigInt(e.escape.sequence)<=0xffffffffffffffffn,'invalid finalized escape evidence');
      requireTrue(w.history.includes(op)&&op.attempts.some(a=>a.kind==='execute'&&a.signature===e.escape!.signature)
        &&op.finalized.some(f=>f.signature===e.escape!.signature&&f.slot===e.escape!.slot),'escape receipt history missing');
    }
    if(e.phase==='escaping'){
      requireTrue(e.challenge===undefined&&note.pending===null&&sameJson(e.previous,note.state)
        &&(e.escape?w.status==='pending_escape'||w.status==='closed':w.status==='active'&&w.operation===op),
        'invalid unresolved emergency escape');
    }else{
      requireTrue(e.escape&&e.challenge,'challenge evidence required');
      allowedFields(e.challenge,['slot','sequence']);
      requireTrue(Number.isSafeInteger(e.challenge.slot)&&e.challenge.slot>=e.escape.slot
        &&typeof e.challenge.sequence==='string'&&/^(0|[1-9][0-9]*)$/.test(e.challenge.sequence)
        &&BigInt(e.challenge.sequence)<=0xffffffffffffffffn&&BigInt(e.challenge.sequence)>BigInt(e.escape.sequence),
        'invalid finalized challenge evidence');
      if(e.phase==='challenged'){
        const current=note.pending;
        requireTrue(w.status==='active'&&!w.operation&&sameJson(e.previous,note.state)&&current
          &&current.phase==='closing'&&current.closeRequested===true&&sameJson(current.prepared,p.prepared)
          &&current.exactRequest===p.exactRequest&&current.operations.length===p.operations.length
          &&current.operations.every((o,i)=>sameJson({...o,phase:p.operations[i].phase},p.operations[i])
            &&(o.phase===p.operations[i].phase||o.phase==='not_accepted')),'challenged authorization changed');
      }else {
        const settled=note.history.filter(h=>h.prepared.request.authorization.request_id===requestId);
        requireTrue(settled.length===1&&sameJson(settled[0].previous,e.previous)&&sameJson(settled[0].prepared,p.prepared),
          'emergency successor settlement missing or duplicated');
      }
    }
    if(e.phase!=='settled')requireTrue(index===archives.length-1&&!w.clearedAuthorization
      &&!note.history.some(h=>h.prepared.request.authorization.request_id===requestId),'multiple unresolved emergency escapes');
  }
}

async function validateInlineWalletOperation(op: WalletOperation, active: boolean): Promise<void> {
  requireTrue(op.transport === 'v0_inline_deposit_v1' && op.kind === 'deposit' && op.step === 0, 'invalid inline operation');
  const allowed = ['id','kind','phase','roles','transport','inlineContext','inlinePlan','priorityFeeMicroLamports','step','attempts','current','finalized','rejectedInline'];
  requireTrue(Object.keys(op).every(k => allowed.includes(k)) && !['closing_stale','cancelled'].includes(op.phase), 'invalid inline operation fields');
  uuid(op.id); object(op.roles); object(op.inlineContext);
  requireTrue(Object.keys(op.inlineContext).sort().join(',')==='deploymentId,manifestHash,mint,pool,programId,vaultBinding','invalid inline deployment context');
  requireTrue(typeof op.inlineContext.deploymentId==='string'&&op.inlineContext.deploymentId.length>0&&/^[0-9a-f]{64}$/.test(op.inlineContext.manifestHash),'invalid inline deployment pins');
  parseField(op.inlineContext.vaultBinding);
  requireTrue(Object.keys(op.roles).sort().join(',') === 'feePayer,payer,tokenOwner', 'invalid inline role fields');
  if (op.priorityFeeMicroLamports !== undefined) {
    requireTrue(typeof op.priorityFeeMicroLamports === 'string' && /^(0|[1-9][0-9]*)$/.test(op.priorityFeeMicroLamports)
      && BigInt(op.priorityFeeMicroLamports) <= 0xffffffffffffffffn, 'invalid inline priority fee');
  }
  if (op.inlinePlan) {
    await validateInlineDepositPlanRecord(op.inlinePlan);
    requireTrue(op.priorityFeeMicroLamports === undefined || op.priorityFeeMicroLamports === (op.inlinePlan.priorityFeeMicroLamports ?? '0'), 'inline priority fee changed');
    requireTrue(Object.entries(op.inlineContext).every(([k,v])=>op.inlinePlan![k as keyof typeof op.inlineContext]===v),'inline plan deployment changed');
    requireTrue(op.inlinePlan.financial.tokenOwner === op.roles.tokenOwner && op.inlinePlan.financial.payer === op.roles.payer && op.inlinePlan.feePayer === op.roles.feePayer, 'inline roles changed');
  }
  requireTrue(op.phase === 'proving' ? op.inlinePlan === undefined && op.current === undefined : !!op.inlinePlan, 'invalid inline preparation phase');
  requireTrue(Array.isArray(op.finalized) && (active ? op.finalized.length===0 : op.finalized.length===1&&op.current===undefined&&op.phase==='ready'), 'invalid inline finality');
  for (const final of op.finalized) requireTrue(op.attempts.some(a => a.signature === final.signature) && Number.isSafeInteger(final.slot) && final.slot >= 0, 'invalid inline finality');
  const rejected = new Set<string>();
  for (const evidence of op.rejectedInline ?? []) {
    requireTrue(Object.keys(evidence).sort().join(',') === 'signature,slot' && !rejected.has(evidence.signature) && op.attempts.some(a => a.signature === evidence.signature) && Number.isSafeInteger(evidence.slot) && evidence.slot >= 0, 'invalid inline rejection evidence');
    rejected.add(evidence.signature);
  }
  for (const attempt of op.attempts) {
    requireTrue(attempt.kind === 'deposit_inline', 'mixed inline transport history');
    requireTrue(op.priorityFeeMicroLamports === undefined || op.priorityFeeMicroLamports === (attempt.plan.priorityFeeMicroLamports ?? '0'), 'inline attempt priority fee changed');
    requireTrue(Object.entries(op.inlineContext).every(([k,v])=>attempt.plan[k as keyof typeof op.inlineContext]===v),'inline attempt deployment changed');
    requireTrue(attempt.plan.financial.tokenOwner === op.roles.tokenOwner && attempt.plan.financial.payer === op.roles.payer && attempt.plan.feePayer === op.roles.feePayer, 'inline attempt roles changed');
  }
  if (op.current) {
    const current = op.attempts.find(a => a.signature === op.current)!;
    requireTrue(op.phase === 'ready' && current.kind === 'deposit_inline' && JSON.stringify(current.plan) === JSON.stringify(op.inlinePlan) && !rejected.has(op.current), 'inline current plan changed');
  }
  const terminalSignature = op.current ?? op.finalized[0]?.signature
    ?? (op.phase==='stale'||op.phase==='failed'?op.attempts.at(-1)?.signature:undefined);
  requireTrue(op.attempts.every(a=>a.signature===terminalSignature?!rejected.has(a.signature):rejected.has(a.signature)), 'unresolved inline attempt cannot be replaced');
}

export interface ClientOptions {
  context: VerificationContext; journal: EncryptedJournal<NoteJournal>; verifier: SessionVerifier;
  fetch?: typeof globalThis.fetch; now?: () => bigint;
  allowLoopbackHttp?: boolean;
  /** Independently configured direct adapter bases (often include /api/v1).
   * Absent entries refuse key delivery and close the session; never infer a
   * destination from an untrusted response or fall back to proxy. */
  directProviderBases?: Partial<Record<'direct_oa' | 'direct_openrouter', string>>;
  /** Installed independently of control responses/attestation. Missing pins
   * disable OA key use while leaving close and settlement available. */
  oaVerifier?: { base: string; stationId: string };
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
  // buffer@6 in browsers supports base64, not Node's newer base64url label.
  // This is the same canonical unpadded RFC 4648 URL alphabet for both runtimes.
  const tokenBytes = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { requestId, controlToken: `zkc1.${requestId}.${tokenBytes(control)}`,
    proxyToken: proxy ? `zkp1.${requestId}.${tokenBytes(proxy)}` : null,
    controlHash: await sha256(control), proxyHash: proxy ? await sha256(proxy) : null };
}

export class ControlClient {
  private readonly config: VerificationContext;
  private readonly options: ClientOptions;
  private readonly verifiedOaKeys = new Map<string, string>();
  private readonly directKeys = new Map<string, { exactRequest: string; requestId: string; key: string }>();
  constructor(options: ClientOptions) {
    this.options = { ...options, directProviderBases: { ...options.directProviderBases },
      oaVerifier: options.oaVerifier && { ...options.oaVerifier } }; this.config = structuredClone(options.context);
    for (const origin of [this.config.control_api_origin, this.config.inference_api_origin]) {
      const u = new URL(origin);
      requireTrue(u.origin === origin && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'canonical origin required');
      requireTrue(u.protocol === 'https:' || options.allowLoopbackHttp === true && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname), 'HTTPS required');
    }
    for (const base of Object.values(this.options.directProviderBases ?? {})) {
      const u = new URL(base); requireTrue(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, 'invalid direct provider base');
    }
    if (this.options.oaVerifier) {
      const { base, stationId } = this.options.oaVerifier, u = new URL(base);
      requireTrue(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
        && !base.includes('?') && !base.includes('#')
        && (u.href === base || u.origin === base) && !base.endsWith('/'), 'canonical OA verifier base required');
      requireTrue(typeof stationId === 'string' && stationId.length > 0 && new TextEncoder().encode(stationId).length <= 128
        && !/[\u0000-\u001f\u007f-\u009f]/.test(stationId), 'invalid OA station pin');
    }
  }
  private async record(noteId: string): Promise<JournalRecord<NoteJournal>> {
    const r = await this.options.journal.read(noteId); requireTrue(r, 'note must already be finalized and imported');
    const p = r.value.pending, cached = this.directKeys.get(noteId);
    // Reading a legacy key never grants it a new lifetime after restart and
    // never rewrites the durable journal. Only this client's original delivery
    // can hydrate an active session with a usable key.
    if (p) delete p.providerKey;
    if (p && cached && p.exactRequest === cached.exactRequest
      && p.prepared.request.authorization.request_id === cached.requestId
      && p.phase === 'active' && p.serverState === 'ACTIVE' && !p.closeRequested
      && !r.value.wallet?.emergencyEscapes?.some(e => e.phase !== 'settled')) p.providerKey = cached.key;
    else this.directKeys.delete(noteId);
    return r;
  }
  private async save(noteId: string, r: JournalRecord<NoteJournal>): Promise<JournalRecord<NoteJournal>> {
    const value = structuredClone(r.value), p = r.value.pending;
    if (value.pending) delete value.pending.providerKey;
    // Commit exact AUTH/operation recovery state before retaining the volatile
    // key. A failed write must not turn an uncommitted delivery into admission.
    let saved: JournalRecord<NoteJournal>;
    try { saved = await this.options.journal.compareAndSwap(noteId, r.revision, value); }
    catch (error) { this.directKeys.delete(noteId); throw error; }
    if (p?.providerKey && p.phase === 'active' && p.serverState === 'ACTIVE' && !p.closeRequested
      && !value.wallet?.emergencyEscapes?.some(e => e.phase !== 'settled')) {
      this.directKeys.set(noteId, { exactRequest: p.exactRequest, requestId: p.prepared.request.authorization.request_id, key: p.providerKey });
    } else this.directKeys.delete(noteId);
    return saved;
  }
  /** Forget local short-lived keys only. Recovery still uses the saved control
   * credentials to close/settle; this does not revoke a provider key remotely. */
  clearEphemeralKeys(): void { this.directKeys.clear(); this.verifiedOaKeys.clear(); }
  private async json(response: Response): Promise<unknown> {
    // Bound the stream, not just Content-Length, before materializing JSON.
    const reader = response.body?.getReader(); requireTrue(reader, 'missing response');
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      length += value.length; requireTrue(length <= 4 * 1024 * 1024, 'response size limit'); chunks.push(value);
    } } finally { await reader.cancel(); }
    return parseStrictJson(new Uint8Array(Buffer.concat(chunks)));
  }
  private fetch(path: string, method: string, token: string, body?: string, signal?: AbortSignal): Promise<Response> {
    requireTrue(path.startsWith('/zkapi/v1/') && !path.includes('://'), 'invalid control path');
    return (this.options.fetch ?? globalThis.fetch)(this.config.control_api_origin + path, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body,
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
  }
  private path(p: PendingSession): string { return `/zkapi/v1/sessions/${p.prepared.request.authorization.request_id}`; }
  private async verifyOaKey(p: PendingSession, key: string, evidence: unknown, expiresAt: unknown, signal?: AbortSignal): Promise<void> {
    const pin = this.options.oaVerifier; requireTrue(pin, 'OA verifier pin required');
    object(evidence);
    requireTrue(Object.keys(evidence).sort().join(',') === 'key_valid_till,org_signature,station_id,station_recently_attested,station_signature,verifier_url', 'invalid OA evidence fields');
    requireTrue(evidence.verifier_url === pin.base && evidence.station_id === pin.stationId
      && typeof evidence.station_recently_attested === 'boolean', 'OA evidence pin mismatch');
    for (const signature of [evidence.station_signature, evidence.org_signature])
      requireTrue(typeof signature === 'string' && /^[0-9a-fA-F]{128}$/.test(signature), 'invalid OA signature');
    requireTrue(typeof key === 'string' && key.length > 0 && key.length <= 4096 && !/\s/.test(key), 'invalid OA key');
    requireTrue(typeof expiresAt === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(expiresAt), 'invalid OA lease expiry');
    requireTrue(typeof evidence.key_valid_till === 'number' && Number.isSafeInteger(evidence.key_valid_till)
      && evidence.key_valid_till > 0, 'invalid OA evidence expiry');
    const expiry = BigInt(expiresAt), validTill = BigInt(evidence.key_valid_till);
    // Preserve the existing issuer adapter's maximum 65-second clock allowance.
    requireTrue(validTill >= expiry && validTill - expiry <= 65n, 'OA evidence does not cover lease');
    const fresh = () => requireTrue(expiry > (this.options.now?.() ?? BigInt(Math.floor(Date.now() / 1000))), 'OA lease expired');
    fresh();
    const id = p.prepared.request.authorization.request_id;
    const binding = await sha256Hex(jcsBytes({ key, evidence, expiresAt, pin,
      requestId: id, providerBase: this.options.directProviderBases?.direct_oa ?? null }));
    if (this.verifiedOaKeys.get(id) !== binding) {
      const response = await (this.options.fetch ?? globalThis.fetch)(pin.base + '/submit_key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station_id: evidence.station_id, api_key: key, key_valid_till: evidence.key_valid_till,
          station_signature: evidence.station_signature, org_signature: evidence.org_signature }),
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('OA verifier unavailable'); }
      const verified = await this.json(response); object(verified);
      requireTrue(verified.status === 'verified', 'OA verifier rejected key');
      fresh();
      this.verifiedOaKeys.set(id, binding);
    }
    fresh();
  }
  private discardDirectKey(p: PendingSession): void {
    delete p.providerKey; delete p.oaKeyVerification;
    this.verifiedOaKeys.delete(p.prepared.request.authorization.request_id);
    for (const [noteId, cached] of this.directKeys) if (cached.requestId === p.prepared.request.authorization.request_id) this.directKeys.delete(noteId);
    p.phase = 'closing'; p.closeRequested = true;
  }
  private async closePending(noteId: string, r: JournalRecord<NoteJournal>, signal?: AbortSignal): Promise<SessionStatus | undefined> {
    const p = r.value.pending!;
    const response = await this.fetch(this.path(p) + '/close', 'POST', p.prepared.control_token, undefined, signal);
    if (!response.ok) throw new ControlHttpError(response.status);
    const closed = await this.json(response); object(closed);
    // No recursive polling. A later explicit recover resumes a pending close.
    if (closed.state === 'SETTLED') return this.accept(noteId, r, closed, false, signal);
  }
  /** Optional cancellation bounds this call's transport only; it never changes
   * the client's transport or the lifetime of a later inference/close call. */
  async quote(request: { mode: Mode; provider: Quote['body']['provider']; models: string[]; session_ttl_seconds?: string }, tariff: Tariff, signal?: AbortSignal): Promise<Quote> {
    signal?.throwIfAborted();
    const wanted = structuredClone(request), frozenTariff = structuredClone(tariff);
    object(wanted);
    requireTrue(Object.keys(wanted).every(k => ['mode','provider','models','session_ttl_seconds'].includes(k)), 'unknown quote request field');
    requireTrue(Array.isArray(wanted.models) && wanted.models.length === 1 && typeof wanted.models[0] === 'string', 'quote model selection');
    requireTrue(wanted.mode === 'proxy' ? ['openai','anthropic','openrouter'].includes(wanted.provider) && wanted.models[0] !== '*' && /^[\x21-\x7e]+$/.test(wanted.models[0])
      : (wanted.mode === 'direct_oa' && wanted.provider === 'oa' || wanted.mode === 'direct_openrouter' && wanted.provider === 'openrouter') && wanted.models[0] === '*', 'explicit quote mode/provider required');
    if (wanted.session_ttl_seconds !== undefined) requireTrue(typeof wanted.session_ttl_seconds === 'string' && /^[1-9][0-9]{0,2}$/.test(wanted.session_ttl_seconds) && BigInt(wanted.session_ttl_seconds) <= 300n, 'session TTL');
    const response = await (this.options.fetch ?? globalThis.fetch)(this.config.control_api_origin + '/zkapi/v1/quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wanted),
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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
    // Only an authenticated, otherwise valid quote may wait for a small clock
    // skew. Keep its exact bytes and make no additional quote/AUTH request.
    requireTrue(BigInt(b.expires_at) === BigInt(b.issued_at)+120n
      && BigInt(b.issued_at) >= BigInt(frozenTariff.valid_from) && BigInt(b.issued_at) < BigInt(frozenTariff.valid_until)
      && BigInt(b.session_ttl_seconds) >= 1n && BigInt(b.session_ttl_seconds) <= 300n
      && b.session_ttl_seconds === (wanted.session_ttl_seconds ?? '60') && b.max_concurrency === '4', 'quote limits');
    signal?.throwIfAborted();
    let now = this.options.now?.() ?? BigInt(Math.floor(Date.now()/1000));
    if (BigInt(b.issued_at) > now) {
      const ahead = BigInt(b.issued_at) - now;
      requireTrue(ahead <= 5n, 'quote limits');
      await new Promise<void>((resolve,reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
        const abort = () => { cleanup(); reject(signal!.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, Number(ahead)*1000);
        signal?.addEventListener('abort',abort,{once:true});
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      now = this.options.now?.() ?? BigInt(Math.floor(Date.now()/1000));
    }
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
      requireTrue(!r.value.wallet || r.value.wallet.status === 'active' && !r.value.wallet.operation && !r.value.wallet.clearance && !r.value.wallet.emergencyEscapes?.some(e=>e.phase!=='settled'), 'note has an unresolved financial operation or permanent clearance intent');
      const id = copy.request.authorization.request_id;
      requireTrue(!r.value.history.some(h => h.prepared.request.authorization.request_id === id), 'request already settled');
      await this.options.verifier.prepare(this.config, r.value.state, copy, (this.options.now?.() ?? BigInt(Math.floor(Date.now() / 1000))).toString(), finalizedRoot);
      r.value.pending = { prepared: copy, exactRequest: JSON.stringify(copy.request), phase: 'prepared', operations: [] };
      await this.save(noteId, r);
    });
  }
  async submit(noteId: string, signal?: AbortSignal): Promise<SessionStatus> {
    signal?.throwIfAborted();
    return this.options.journal.withNoteLock(noteId, async () => this.submitPending(noteId, await this.record(noteId), signal));
  }
  /** Caller holds the note operation lock. An unknown create must remain
   * replayable even when close was requested before the server acknowledged it. */
  private async submitPending(noteId: string, record: JournalRecord<NoteJournal>, signal?: AbortSignal): Promise<SessionStatus> {
    signal?.throwIfAborted();
    let r = record; const p = r.value.pending; requireTrue(p, 'no pending authorization');
    requireTrue(!r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'),'emergency escape forbids authorization replay');
    requireTrue(p.phase === 'prepared' || p.phase === 'send_unknown', 'use recover for existing session');
    if (p.phase === 'prepared') {
      const now = this.options.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
      requireTrue(now >= BigInt(p.prepared.request.quote.body.issued_at) && now < BigInt(p.prepared.request.quote.body.expires_at), 'unsent quote expired; cancelUnsent and prepare new credentials/quote/proof');
    }
    p.phase = 'send_unknown'; r = await this.save(noteId, r);
    // Exact same body and credentials on retries, even when the quote is old.
    const response = await this.fetch('/zkapi/v1/sessions', 'POST', p.prepared.control_token, p.exactRequest, signal);
    if (!response.ok) throw new ControlHttpError(response.status);
    return this.accept(noteId, r, await this.json(response), response.status !== 202, signal);
  }
  /** Only a never-sent authorization can be discarded locally. A send_unknown
   * record, even after a timeout or expired quote, must use exact recovery. */
  async cancelUnsent(noteId: string): Promise<void> {
    await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId);
      requireTrue(!r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'),'emergency escape fences session changes');
      requireTrue(r.value.pending?.phase === 'prepared' && r.value.pending.operations.length === 0, 'cannot cancel a possibly sent authorization');
      r.value.pending = null; await this.save(noteId, r);
    });
  }
  async recover(noteId: string, signal?: AbortSignal): Promise<SessionStatus> {
    signal?.throwIfAborted();
    // Recovering an unknown create resends only the identical authorization;
    // provider inference is never repeated by this path.
    const existing = await this.record(noteId); requireTrue(existing.value.pending, 'no pending authorization');
    if (['prepared', 'send_unknown'].includes(existing.value.pending.phase)) return this.submit(noteId, signal);
    return this.options.journal.withNoteLock(noteId, async () => {
      signal?.throwIfAborted();
      const r = await this.record(noteId); const p = r.value.pending; requireTrue(p, 'already settled');
      const response = await this.fetch(this.path(p), 'GET', p.prepared.control_token, undefined, signal);
      if (!response.ok) throw new ControlHttpError(response.status);
      return this.accept(noteId, r, await this.json(response), false, signal);
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
  private async accept(noteId: string, r: JournalRecord<NoteJournal>, raw: unknown, initial: boolean, signal?: AbortSignal): Promise<SessionStatus> {
    object(raw); const status = raw as unknown as SessionStatus; const p = r.value.pending!;
    const q = p.prepared.request.quote.body;
    const emergency=r.value.wallet?.emergencyEscapes?.find(e=>e.phase!=='settled');
    requireTrue(!emergency||emergency.phase==='challenged'&&p.phase==='closing'&&p.closeRequested===true, 'emergency escape requires finalized challenge reconciliation');
    requireTrue(Object.keys(raw).every(k => ['request_id','mode','state','cap_micro_usdc','issued_at','expires_at','settlement','provider_key','provider_api_origin','provider_key_verification','last_error_code'].includes(k)), 'unknown session field');
    requireTrue(status.request_id === p.prepared.request.authorization.request_id && status.mode === q.mode
      && status.cap_micro_usdc === q.cap_micro_usdc && states.has(status.state), 'session identity mismatch');
    p.serverState = status.state;
    requireTrue(status.provider_key_verification === undefined || initial && q.mode === 'direct_oa' && status.provider_key !== undefined, 'unexpected OA evidence');
    if (status.provider_key !== undefined) {
      requireTrue(initial && p.prepared.request.authorization.mode !== 'proxy' && status.state === 'ACTIVE'
        && typeof status.provider_key === 'string' && status.provider_key.length > 0 && status.provider_key.length <= 8192, 'unexpected provider key');
      if (p.closeRequested || p.phase === 'closing'
        || !this.options.directProviderBases?.[p.prepared.request.authorization.mode]
        || status.provider_api_origin !== this.options.directProviderBases?.[p.prepared.request.authorization.mode]) this.discardDirectKey(p);
      else if (q.mode === 'direct_oa') {
        try {
          await this.verifyOaKey(p, status.provider_key, status.provider_key_verification, status.expires_at, signal);
          p.oaKeyVerification = { evidence: structuredClone(status.provider_key_verification!), expiresAt: status.expires_at! };
          p.providerKey = status.provider_key;
        } catch { this.discardDirectKey(p); }
      } else p.providerKey = status.provider_key;
      if (!p.providerKey) { delete status.provider_key; delete status.provider_api_origin; delete status.provider_key_verification; }
    }
    if (status.state === 'SETTLED') {
      requireTrue(status.settlement && !status.provider_key, 'missing settlement');
      const receipts = await this.receipts(p, signal);
      const operations = q.mode === 'proxy' ? p.operations.filter(o => o.phase !== 'prepared' && o.phase !== 'not_accepted').map(o => o.id) : [];
      const next = await this.options.verifier.settle(this.config, r.value.state, p.prepared, status.settlement, receipts, operations);
      privateState(next);
      const clearance = r.value.wallet?.clearance;
      if (clearance) {
        // A verified successor establishes that AUTH won the server's atomic N
        // reservation race. Retire only its still-unverified clearance intent,
        // in the same commit as settlement; HTTP rejection alone cannot do so.
        requireTrue(clearance.phase === 'requested' && clearance.signature === undefined && !r.value.wallet!.operation
          && clearance.nullifier === p.prepared.request.public_inputs[8],
          'settlement conflicts with permanent clearance');
        delete r.value.wallet!.clearance;
      }
      // Financial verification above needs IDs, never inference content. Clear
      // both copies only after verifying a terminal successor.
      await redactOperations(p.operations);
      if (emergency) await redactOperations(emergency.pending.operations);
      r.value.history.push({ previous: r.value.state, prepared: p.prepared, settlement: status.settlement, receipts, operations: p.operations });
      r.value.state = next; r.value.pending = null; if(emergency)emergency.phase='settled'; await this.save(noteId, r);
      this.verifiedOaKeys.delete(p.prepared.request.authorization.request_id);
      return status;
    }
    requireTrue(status.settlement === undefined, 'premature settlement');
    // Legacy key-only journals remain readable for recovery, never for OA use.
    if (q.mode === 'direct_oa' && p.providerKey && !p.oaKeyVerification) this.discardDirectKey(p);
    const closeRequired = p.closeRequested === true || p.phase === 'closing' || q.mode !== 'proxy' && !p.providerKey;
    p.phase = closeRequired ? 'closing' : 'active'; r = await this.save(noteId, r);
    if (closeRequired) {
      // Losing a direct key is not permission to issue another key or change mode.
      const closed = await this.closePending(noteId, r, signal); if (closed) return closed;
    }
    return status;
  }
  private async receipts(p: PendingSession, signal?: AbortSignal): Promise<Receipt[]> {
    const all: Receipt[] = []; let cursor: string | null = null; const seen = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      const response = await this.fetch(this.path(p) + '/receipts' + (cursor === null ? '' : `?cursor=${cursor}`), 'GET', p.prepared.control_token, undefined, signal);
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
      requireTrue(!r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'),'emergency escape fences inference');
      requireTrue(p && p.phase === 'active' && p.serverState === 'ACTIVE' && p.prepared.request.authorization.mode === 'proxy', 'proxy session required');
      const old = p.operations.find(o => o.id === operationId);
      if (old) { if (old.bodyRedacted) throw new ResponseNotReplayable(operationId,this.path(p) + `/operations/${operationId}`); requireTrue(old.path === path && old.bodyBase64 === bodyBase64 && old.anthropicVersion === anthropicVersion, 'idempotency conflict'); return; }
      p.operations.push({ id: operationId, path, bodyBase64, anthropicVersion, phase: 'prepared' }); await this.save(noteId, r);
    });
  }
  async sendOperation(noteId: string, operationId: string, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    uuid(operationId);
    const dispatch = await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending;
      requireTrue(!r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'),'emergency escape fences inference');
      requireTrue(p && p.phase === 'active' && p.serverState === 'ACTIVE' && p.prepared.proxy_token, 'active proxy session required');
      const operation = p.operations.find(o => o.id === operationId); requireTrue(operation, 'operation must be saved before sending');
      if (operation.phase !== 'prepared' || operation.bodyRedacted) throw new ResponseNotReplayable(operationId, this.path(p) + `/operations/${operationId}`);
      const bytes = new Uint8Array(Buffer.from(operation.bodyBase64,'base64'));
      operation.phase = 'send_unknown'; await redactOperations([operation]); await this.save(noteId, r);
      return { operation: structuredClone(operation), bytes, token: p.prepared.proxy_token, statusPath: this.path(p) + `/operations/${operationId}` };
    });
    const response = await (this.options.fetch ?? globalThis.fetch)(this.config.inference_api_origin + dispatch.operation.path, {
      method: 'POST', headers: { Authorization: `Bearer ${dispatch.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': operationId,
        ...(dispatch.operation.anthropicVersion ? { 'anthropic-version': dispatch.operation.anthropicVersion } : {}) },
      body: dispatch.bytes, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
    });
    if (response.status === 409) { await response.body?.cancel(); throw new ResponseNotReplayable(operationId, dispatch.statusPath); }
    // The response stream is passed through once. Usage comes from signed receipts.
    return response;
  }
  /** Direct inference uses the same encrypted intent journal. Recovery closes the
   * key/session; it never submits an inference again. Only explicit new IDs send. */
  async sendDirectOperation(noteId: string, operationId: string, path: string, body: Uint8Array, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted();
    uuid(operationId);
    requireTrue(['/v1/chat/completions', '/v1/responses'].includes(path) && body.length <= 1024 * 1024, 'unsupported direct route');
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    const snapshot = new Uint8Array(body);
    const dispatch = await this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending;
      requireTrue(!r.value.wallet?.emergencyEscapes?.some(e=>e.phase!=='settled'),'emergency escape fences inference');
      requireTrue(p && p.phase === 'active' && p.serverState === 'ACTIVE' && p.providerKey && !p.closeRequested, 'active direct session required');
      const mode = p.prepared.request.authorization.mode;
      requireTrue(mode === 'direct_oa' || mode === 'direct_openrouter', 'explicit direct mode required');
      requireTrue(mode !== 'direct_openrouter' || path === '/v1/chat/completions', 'unsupported direct route');
      const bytes = directRequestBytes(mode,path,snapshot);
      const base = this.options.directProviderBases?.[mode]; requireTrue(base, 'pinned direct provider required');
      requireTrue(!p.operations.some(o => o.id === operationId) && !r.value.history.some(h => h.operations.some(o => o.id === operationId)), 'direct inference cannot be replayed');
      if (mode === 'direct_oa') {
        try { await this.verifyOaKey(p, p.providerKey, p.oaKeyVerification?.evidence, p.oaKeyVerification?.expiresAt); }
        catch {
          this.discardDirectKey(p); const saved = await this.save(noteId, r);
          await this.closePending(noteId, saved);
          throw new Error('OA key verification failed; session closing');
        }
      }
      signal?.throwIfAborted();
      p.operations.push({ id: operationId, path, anthropicVersion: '', bodyBase64: '', bodyRedacted: true, bodySha256: await sha256Hex(bytes), phase: 'send_unknown' });
      await this.save(noteId, r);
      return { base, key: p.providerKey, bytes, mode };
    });
    const response = await (this.options.fetch ?? globalThis.fetch)(dispatch.base.replace(/\/$/, '') + path.slice(3), {
      method: 'POST', headers: { Authorization: `Bearer ${dispatch.key}`, 'Content-Type': 'application/json' }, body: dispatch.bytes,
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
    });
    return describeProviderError(response, dispatch.mode, signal);
  }
  /** Metadata only, through the same installed transport. Never uses session keys. */
  checkModelAvailability(mode: Mode, models: readonly string[], signal?: AbortSignal) {
    return checkModelAvailability(mode, models, {base:this.options.directProviderBases?.direct_openrouter, fetch:this.options.fetch, signal});
  }
  /** Explicit local erasure of legacy settled inference bodies. Does not erase
   * receipts/AUTH, active recovery records, external backups or old ciphertext.
   * No reads, startup or installation automatically rewrite legacy journals. */
  async purgeSettledRequestBodies(noteId: string): Promise<{ historyOperations: number; emergencyOperations: number }> {
    return this.options.journal.withNoteLock(noteId,async()=>{
      const r = await this.record(noteId);
      let historyOperations = 0, emergencyOperations = 0;
      for (const h of r.value.history) historyOperations += await redactOperations(h.operations,true);
      for (const e of r.value.wallet?.emergencyEscapes ?? [])
        if (e.phase === 'settled') emergencyOperations += await redactOperations(e.pending.operations,true);
      if (historyOperations || emergencyOperations) await this.save(noteId,r);
      return {historyOperations,emergencyOperations};
    });
  }
  /** Explicit reconciliation after terminal settlement only. A 404 while ACTIVE
   * cannot establish non-admission: an earlier inference may still arrive. The
   * original successor and all receipt signatures are verified by accept before
   * committing the exclusion or advancing the note. No inference is retried. */
  async reconcileAbsentOperations(noteId: string): Promise<SessionStatus> {
    return this.options.journal.withNoteLock(noteId, async () => {
      const r = await this.record(noteId); const p = r.value.pending;
      requireTrue(p && p.prepared.request.authorization.mode === 'proxy', 'unresolved proxy session required');
      const response = await this.fetch(this.path(p), 'GET', p.prepared.control_token);
      if (!response.ok) throw new ControlHttpError(response.status);
      const status = await this.json(response); object(status);
      requireTrue(status.state === 'SETTLED', 'only a terminal session can exclude unaccepted operations');
      for (const operation of p.operations) {
        if (operation.phase === 'prepared' || operation.phase === 'not_accepted') continue;
        const result = await this.fetch(this.path(p) + `/operations/${operation.id}`, 'GET', p.prepared.control_token);
        if (result.status === 404) operation.phase = 'not_accepted';
        else {
          if (!result.ok) throw new ControlHttpError(result.status);
          const known = await this.json(result); object(known);
          requireTrue(known.request_id === p.prepared.request.authorization.request_id && known.operation_id === operation.id && known.response_replayable === false, 'operation identity');
        }
      }
      return this.accept(noteId, r, status, false);
    });
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
export const DIRECT_OPENROUTER_PRIVACY_NOTICE = 'Prompts go to OpenRouter and its selected provider. Every direct request requires ZDR and denied data collection. Providers still see content and network metadata; routing policy is not proof of deletion.';
export const DIRECT_PRIVACY_NOTICE = 'Prompts go to the selected provider. The provider sees content and network metadata.';
export const PROXY_PRIVACY_NOTICE = 'The proxy operator can read your prompts and responses. Direct and proxy modes are selected explicitly.';
