/** Real-provider acceptance orchestration over the existing SDK state machine.
 * No credentials, alternate ledger, wallet transaction construction, inference
 * retry, or billing decisions live here. The caller supplies a verified native
 * ControlClient and the already finalized/imported note, plus the durable
 * Python coordinator's reserve-once callback. Offline tests do not prove G3. */
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlClient, ControlHttpError, createCredentials, type Mode, type NoteJournal, type PreparedSession, type Tariff} from '../packages/sdk/src/control.ts';
import type {EncryptedJournal} from '../packages/sdk/src/journal.ts';
import type {NoteProver} from '../packages/sdk/src/prover.ts';
import type {WalletChain} from '../packages/sdk/src/wallet-chain.ts';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';

export interface ProviderAcceptanceCase {
  id: string;
  mode: Mode;
  provider: 'openai' | 'anthropic' | 'openrouter' | 'oa';
  model: string;
  endpoint: 'chat_completions' | 'responses' | 'messages';
  stream: boolean;
  tools: boolean;
  max_output_tokens: number;
  max_cost_micro_usdc: string;
  session_ttl_seconds: number;
}
export interface ProviderAcceptanceContext {
  client: ControlClient;
  /** Same SDK context/journal/verifier/transport, with this signal combined into
   * fetch for quote and AUTH. Bounds HTTP without abandoning a journal commit. */
  authorizationClient(signal: AbortSignal): ControlClient;
  journal: EncryptedJournal<NoteJournal>;
  prover: Pick<NoteProver, 'prepareSession'>;
  chain: Pick<WalletChain, 'snapshot'>;
  noteId: string;
  tariff: Tariff;
  testCase: ProviderAcceptanceCase;
  /** Must atomically reserve this exact plan/case once before returning. Never
   * substitute a no-op callback for live acceptance. Root integration pins the
   * plan SHA-256 and private campaign directory to provider_acceptance.py. */
  reserve(testCase: ProviderAcceptanceCase): Promise<{case_id: string; reserved_micro_usdc: string; plan_sha256: string; send_authorized_once: true}>;
  settlementTimeoutMs?: number;
  quoteTimeoutMs?: number;
  authorizationTimeoutMs?: number;
  /** Must agree with the SDK's clock; omitted for the real wall clock. */
  now?: () => number;
}
export class ProviderAcceptanceFailure extends Error {
  readonly diagnostic?: ProviderAcceptanceDiagnostic;
  constructor(diagnostic?: ProviderAcceptanceDiagnostic) {
    super('Provider acceptance incomplete; preserve SDK journal and full budget reservation. No inference was replayed.');
    if (diagnostic) this.diagnostic = structuredClone(diagnostic);
  }
}
export interface ProviderInferenceDiagnostic {
  stage: 'prepare' | 'send' | 'response_status' | 'response_read' | 'response_limit' | 'response_decode' | 'response_validate' | 'complete';
  elapsed_ms: number;
  http_status: number | null;
  service_error_code: 'provider_unavailable' | 'operation_unavailable' | 'operation_in_progress' | 'response_not_replayable'
    | 'idempotency_conflict' | 'rate_limited' | 'invalid_request' | 'invalid_credential' | 'adapter_unavailable' | 'other' | null;
  response_bytes: number;
  sdk_send_invoked: boolean;
}
export interface ProviderAcceptanceDiagnostic {
  schema: 1;
  stage: 'preflight' | 'snapshot' | 'quote' | 'proof' | 'reserve' | 'authorize' | 'inference' | 'close' | 'settlement' | 'acceptance';
  elapsed_ms: number;
  control_http_status: number | null;
  inference: ProviderInferenceDiagnostic | null;
  settlement: 'not_started' | 'unresolved' | 'completed';
  inference_replays: 0;
}
class ProviderInferenceFailure extends Error {
  readonly diagnostic: ProviderInferenceDiagnostic;
  constructor(diagnostic: ProviderInferenceDiagnostic) {
    super('Provider inference incomplete; no replay.'); this.diagnostic = structuredClone(diagnostic);
  }
}
const elapsed = (start: number) => Math.min(2_147_483_647, Math.max(0, Math.floor(performance.now() - start)));
function requireTrue(condition: unknown): asserts condition { if (!condition) throw new ProviderAcceptanceFailure(); }
const PATHS = {chat_completions: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages'} as const;

function retryableControl(error: unknown) {
  return error instanceof ControlHttpError ? [429, 502, 503, 504].includes(error.status)
    : error instanceof Error && (error.message === 'pinned service transport'
      || error instanceof TypeError && error.message === 'fetch failed'
      || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));
}

/** Quote POST stores signed quote metadata; a lost ACK can leave an unused row.
 * It creates no session, nullifier/budget reservation, key or inference. Retry
 * fixed quote parameters only before generating credentials/proof or AUTH;
 * malformed, mismatched, wrongly signed or expired quotes remain fatal. */
async function obtainQuote(o: ProviderAcceptanceContext) {
  const timeout = o.quoteTimeoutMs ?? 120_000, now = o.now ?? Date.now;
  requireTrue(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 120_000);
  const started = now(); requireTrue(Number.isSafeInteger(started));
  const deadline = started + timeout, monotonicDeadline = performance.now() + timeout;
  requireTrue(Number.isSafeInteger(deadline));
  const remaining = () => Math.floor(Math.min(deadline - now(), monotonicDeadline - performance.now()));
  const request = {mode: o.testCase.mode, provider: o.testCase.provider,
    models: [o.tariff.model], session_ttl_seconds: String(o.testCase.session_ttl_seconds)};
  let attempts = 0, lastTransient: unknown;
  for (;;) {
    const ms = remaining();
    if (!Number.isSafeInteger(ms) || ms <= 0) throw lastTransient ?? new ProviderAcceptanceFailure();
    try {
      const client = o.authorizationClient(AbortSignal.timeout(ms)); attempts++;
      const quote = await client.quote(request, o.tariff);
      requireTrue(remaining() > 0);
      return {quote, attempts};
    } catch (error) {
      if (!retryableControl(error)) throw error;
      lastTransient = error;
    }
    const msAfter = remaining();
    if (msAfter <= 0) throw lastTransient;
    await delay(Math.min(1000, msAfter));
  }
}

/** Retry only the already persisted AUTH through the existing SDK. An expired
 * or uncertain authorization is retained, never replaced or inferred absent. */
async function authorizeSaved(o: ProviderAcceptanceContext, prepared: PreparedSession) {
  const timeout = o.authorizationTimeoutMs ?? 120_000, now = o.now ?? Date.now;
  requireTrue(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 120_000);
  const expires = Number(BigInt(prepared.request.quote.body.expires_at) * 1000n);
  requireTrue(Number.isSafeInteger(expires));
  const started = now(); requireTrue(Number.isSafeInteger(started));
  const allowance = Math.min(expires - started, timeout); requireTrue(allowance > 0);
  const deadline = started + allowance, monotonicDeadline = performance.now() + allowance;
  const remaining = () => Math.floor(Math.min(deadline - now(), monotonicDeadline - performance.now()));
  const exact = JSON.stringify(prepared.request);
  let attempts = 0;
  for (;;) {
    const pending = (await o.journal.read(o.noteId))?.value.pending;
    requireTrue(pending && pending.exactRequest === exact && pending.prepared.control_token === prepared.control_token
      && pending.prepared.proxy_token === prepared.proxy_token && pending.operations.length === 0
      && !pending.closeRequested && ['prepared', 'send_unknown', 'active'].includes(pending.phase));
    const ms = remaining(); requireTrue(Number.isSafeInteger(ms) && ms > 0);
    try {
      const client = o.authorizationClient(AbortSignal.timeout(ms)); attempts++;
      const status = await client.recover(o.noteId);
      requireTrue(remaining() > 0);
      const saved = (await o.journal.read(o.noteId))?.value.pending;
      requireTrue(saved && saved.exactRequest === exact && saved.operations.length === 0
        && saved.phase === 'active' && !saved.closeRequested);
      if (status.state === 'ACTIVE') return attempts;
      requireTrue(['RESERVED', 'ISSUING', 'ISSUANCE_UNKNOWN'].includes(status.state));
    } catch (error) {
      if (!retryableControl(error)) throw error;
    }
    const msAfter = remaining(); requireTrue(msAfter > 0);
    await delay(Math.min(1000, msAfter));
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Inspect dispatched SSE data, never incidental text, comments, or event names
 * inside content. This is response-shape evidence; the SDK receipt verifier
 * remains responsible for metering and settlement. */
function verifyStream(text: string, testCase: ProviderAcceptanceCase) {
  let data: string[] = [], event = '', terminal = false, tool = false;
  const chatNames = new Map<string, {name: string; functionType: boolean}>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line !== '') {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      if (field === 'event') event = value;
      continue;
    }
    if (data.length === 0) { event = ''; continue; }
    requireTrue(!terminal);
    const payload = data.join('\n'); data = [];
    const eventName = event; event = '';
    if (payload === '[DONE]') {
      requireTrue(testCase.endpoint === 'chat_completions' && (eventName === '' || eventName === 'message'));
      terminal = true; continue;
    }
    const value = object(parseStrictJson(new TextEncoder().encode(payload), 8 * 1024 * 1024));
    requireTrue(value && !Object.hasOwn(value, 'error') && eventName !== 'error');
    if (testCase.endpoint === 'chat_completions') {
      requireTrue(eventName === '' || eventName === 'message');
      if (Array.isArray(value.choices)) for (const choiceValue of value.choices) {
        const choice = object(choiceValue), calls = object(choice?.delta)?.tool_calls;
        if (!Array.isArray(calls)) continue;
        requireTrue(Number.isSafeInteger(choice?.index) && Number(choice!.index) >= 0);
        for (const callValue of calls) {
          const call = object(callValue), fn = object(call?.function);
          requireTrue(call && Number.isSafeInteger(call.index) && Number(call.index) >= 0
            && (call.type === undefined || call.type === 'function') && fn);
          const key = `${choice!.index}:${call.index}`, saved = chatNames.get(key) ?? {name: '', functionType: false};
          if (fn.name !== undefined) { requireTrue(typeof fn.name === 'string'); saved.name += fn.name; }
          saved.functionType ||= call.type === 'function'; chatNames.set(key, saved);
        }
      }
    } else {
      requireTrue(typeof value.type === 'string' && (eventName === '' || eventName === value.type)
        && !['error', 'response.failed', 'response.error', 'response.incomplete'].includes(value.type));
      if (testCase.endpoint === 'responses') {
        if (['response.output_item.added', 'response.output_item.done'].includes(value.type)) {
          const item = object(value.item);
          tool ||= item?.type === 'function_call' && item.name === 'acceptance_echo';
        }
        if (value.type === 'response.completed') {
          const response = object(value.response); requireTrue(response?.status === 'completed');
          terminal = true;
        }
      } else {
        if (value.type === 'content_block_start') {
          const block = object(value.content_block);
          tool ||= block?.type === 'tool_use' && block.name === 'acceptance_echo';
        }
        if (value.type === 'message_stop') terminal = true;
      }
    }
  }
  requireTrue(data.length === 0 && terminal);
  if (testCase.endpoint === 'chat_completions') tool = [...chatNames.values()].some(call => call.functionType && call.name === 'acceptance_echo');
  requireTrue(!testCase.tools || tool);
}

export function providerAcceptanceBody(testCase: ProviderAcceptanceCase): Uint8Array {
  requireTrue(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(testCase.id)
    && typeof testCase.model === 'string' && /^[\x21-\x7e]+$/.test(testCase.model) && testCase.model !== '*'
    && Number.isInteger(testCase.max_output_tokens) && testCase.max_output_tokens > 0 && testCase.max_output_tokens <= 4096
    && /^(?:[1-9][0-9]{0,7})$/.test(testCase.max_cost_micro_usdc) && BigInt(testCase.max_cost_micro_usdc) <= 10_000_000n
    && Number.isInteger(testCase.session_ttl_seconds) && testCase.session_ttl_seconds > 0 && testCase.session_ttl_seconds <= 300
    && typeof testCase.stream === 'boolean' && typeof testCase.tools === 'boolean');
  requireTrue(testCase.mode === 'proxy'
    ? ((testCase.provider === 'openai' && ['chat_completions', 'responses'].includes(testCase.endpoint))
      || (testCase.provider === 'anthropic' && testCase.endpoint === 'messages')
      || (testCase.provider === 'openrouter' && testCase.endpoint === 'chat_completions'))
    : ((testCase.mode === 'direct_openrouter' && testCase.provider === 'openrouter')
      || (testCase.mode === 'direct_oa' && testCase.provider === 'oa' && testCase.session_ttl_seconds % 60 === 0))
      && testCase.endpoint === 'chat_completions');
  const prompt = testCase.tools ? 'Call the acceptance_echo tool once with the word ok. Do not use any other tool.' : 'Reply with the single word ok.';
  const body: Record<string, unknown> = {model: testCase.model};
  const schema = {type: 'object', properties: {word: {type: 'string'}}, required: ['word'], additionalProperties: false};
  if (testCase.endpoint === 'responses') {
    body.input = prompt; body.max_output_tokens = testCase.max_output_tokens;
    body.store = false; body.background = false;
    if (testCase.tools) body.tools = [{type: 'function', name: 'acceptance_echo', parameters: schema}];
  } else {
    body.messages = [{role: 'user', content: prompt}];
    if (testCase.endpoint === 'messages') {
      body.max_tokens = testCase.max_output_tokens;
      if (testCase.tools) body.tools = [{name: 'acceptance_echo', input_schema: schema}];
    } else {
      body.max_completion_tokens = testCase.max_output_tokens;
      if (testCase.tools) body.tools = [{type: 'function', function: {name: 'acceptance_echo', parameters: schema}}];
    }
  }
  if (testCase.stream) {
    body.stream = true;
    if (testCase.endpoint === 'chat_completions') body.stream_options = {include_usage: true};
  }
  return new TextEncoder().encode(JSON.stringify(body));
}

/** One durable SDK inference operation. Response bytes are consumed once and
 * never logged or returned; receipts, not response text, decide billable usage. */
export async function sendProviderAcceptanceOperation(client: ControlClient, noteId: string,
  testCase: ProviderAcceptanceCase, operationId = randomUUID()) {
  const body = providerAcceptanceBody(testCase), path = PATHS[testCase.endpoint];
  const started = performance.now();
  const diagnostic: ProviderInferenceDiagnostic = {stage: 'prepare', elapsed_ms: 0, http_status: null,
    service_error_code: null, response_bytes: 0, sdk_send_invoked: false};
  let response: Response | undefined;
  const signal = AbortSignal.timeout(600_000);
  try {
    if (testCase.mode === 'proxy') {
      await client.prepareOperation(noteId, operationId, path, body, testCase.provider === 'anthropic' ? '2023-06-01' : '');
      diagnostic.stage = 'send'; diagnostic.sdk_send_invoked = true;
      response = await client.sendOperation(noteId, operationId, signal);
    } else {
      diagnostic.stage = 'send'; diagnostic.sdk_send_invoked = true;
      response = await client.sendDirectOperation(noteId, operationId, path, body, signal);
    }
    diagnostic.stage = 'response_status'; diagnostic.http_status = response.status;
    const code = response.headers.get('x-zkapi-error-code');
    diagnostic.service_error_code = code === null ? null : ['provider_unavailable', 'operation_unavailable', 'operation_in_progress',
      'response_not_replayable', 'idempotency_conflict', 'rate_limited', 'invalid_request', 'invalid_credential', 'adapter_unavailable'].includes(code)
      ? code as ProviderInferenceDiagnostic['service_error_code'] : 'other';
    requireTrue(response.status === 200);
    diagnostic.stage = 'response_read';
    const reader = response.body?.getReader(); requireTrue(reader);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > 8 * 1024 * 1024) { diagnostic.stage = 'response_limit'; throw new ProviderAcceptanceFailure(); }
        diagnostic.response_bytes = length; chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    diagnostic.stage = 'response_decode';
    const raw = Buffer.concat(chunks), text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    if (testCase.stream) {
      diagnostic.stage = 'response_validate';
      requireTrue(response.headers.get('content-type')?.startsWith('text/event-stream'));
      verifyStream(text, testCase);
    } else {
      const value = JSON.parse(text);
      diagnostic.stage = 'response_validate';
      requireTrue(value && typeof value === 'object');
      if (testCase.tools) {
        const calls = testCase.endpoint === 'responses' ? value.output
          : testCase.endpoint === 'messages' ? value.content : value.choices?.[0]?.message?.tool_calls;
        requireTrue(Array.isArray(calls) && calls.some((v: unknown) => {
          const call = object(v);
          return testCase.endpoint === 'chat_completions'
            ? call?.type === 'function' && object(call.function)?.name === 'acceptance_echo'
            : call?.type === (testCase.endpoint === 'responses' ? 'function_call' : 'tool_use') && call.name === 'acceptance_echo';
        }));
      }
    }
    diagnostic.stage = 'complete'; diagnostic.elapsed_ms = elapsed(started);
    return {operation_id: operationId, endpoint: path, http_status: response.status,
      response_bytes: length, response_sha256: createHash('sha256').update(raw).digest('hex'), inference_sends: 1 as const,
      inference_observation: structuredClone(diagnostic)};
  } catch {
    diagnostic.elapsed_ms = elapsed(started);
    throw new ProviderInferenceFailure(diagnostic);
  } finally { await response?.body?.cancel().catch(() => {}); }
}

export async function runProviderAcceptanceCase(options: ProviderAcceptanceContext) {
  const o = {...options, testCase: structuredClone(options.testCase), tariff: structuredClone(options.tariff)};
  const c = o.testCase;
  const started = performance.now();
  const diagnostic: ProviderAcceptanceDiagnostic = {schema: 1, stage: 'preflight', elapsed_ms: 0,
    control_http_status: null, inference: null, settlement: 'not_started', inference_replays: 0};
  try {
    providerAcceptanceBody(c);
    const timeout = o.settlementTimeoutMs ?? 600_000;
    requireTrue(Number.isInteger(timeout) && timeout > 0 && timeout <= 900_000);
    const before = (await o.journal.read(o.noteId))?.value;
    requireTrue(before?.witness && before.pending === null && before.wallet?.status === 'active' && !before.wallet.operation);
    requireTrue(o.tariff.provider === c.provider && o.tariff.model === (c.mode === 'proxy' ? c.model : '*'));
    diagnostic.stage = 'snapshot';
    const snapshot = await o.chain.snapshot(before.witness.note_id, 'active');
    diagnostic.stage = 'quote';
    const {quote, attempts: quoteRequestAttempts} = await obtainQuote(o);
    // A direct lease may spend its entire upstream cap; one small prompt is not
    // a reason to reserve less. Proxy is bounded by the pinned model/tariff.
    if (c.mode !== 'proxy') requireTrue(BigInt(quote.body.cap_micro_usdc) <= BigInt(c.max_cost_micro_usdc));
    diagnostic.stage = 'proof';
    const prepared = await o.prover.prepareSession(before.witness, before.state, snapshot.root,
      snapshot.siblings, quote, o.tariff, await createCredentials(c.mode));
    diagnostic.stage = 'reserve';
    const reservation = await o.reserve(c);
    requireTrue(reservation.send_authorized_once === true && reservation.case_id === c.id
      && reservation.reserved_micro_usdc === c.max_cost_micro_usdc && /^[0-9a-f]{64}$/.test(reservation.plan_sha256));
    diagnostic.stage = 'authorize';
    await o.client.prepare(o.noteId, prepared, snapshot.root);
    const authorizationRecoveryAttempts = await authorizeSaved(o, prepared);
    let observation: Awaited<ReturnType<typeof sendProviderAcceptanceOperation>> | undefined;
    let inferenceFailed = false;
    diagnostic.stage = 'inference';
    try {
      observation = await sendProviderAcceptanceOperation(o.client, o.noteId, c);
      diagnostic.inference = observation.inference_observation;
    } catch (error) {
      inferenceFailed = true;
      if (error instanceof ProviderInferenceFailure) diagnostic.inference = error.diagnostic;
    }
    // Disable/retire a direct key and settle the same SDK authorization even
    // when inference was uncertain. No inference or key creation is replayed.
    diagnostic.stage = 'close'; diagnostic.settlement = 'unresolved';
    await o.client.close(o.noteId);
    diagnostic.stage = 'settlement';
    const deadline = performance.now() + timeout;
    while ((await o.journal.read(o.noteId))!.value.pending) {
      requireTrue(performance.now() < deadline);
      await delay(Math.min(1000, Math.max(1, deadline - performance.now())));
      await o.client.recover(o.noteId);
    }
    const after = (await o.journal.read(o.noteId))!.value;
    diagnostic.settlement = 'completed'; diagnostic.stage = 'acceptance';
    requireTrue(!inferenceFailed && observation && after.history.length === before.history.length + 1);
    const history = after.history.at(-1)!;
    requireTrue(history.prepared.request.authorization.request_id === prepared.request.authorization.request_id
      && history.operations.length === 1 && history.operations[0].id === observation.operation_id
      && history.receipts.length === 1 && after.state.anchor !== before.state.anchor);
    const receipt = history.receipts[0];
    const evidence = c.mode === 'proxy' ? 'PROXY_USAGE' : c.mode === 'direct_oa' ? 'OA_SIGNED_RECEIPT' : 'OPENROUTER_USAGE';
    requireTrue(receipt.body.evidence_kind === evidence && receipt.body.reason === 'metered'
      && typeof receipt.body.observed_nano_usdc === 'string'
      && typeof receipt.body.provider_evidence_digest === 'string' && /^[0-9a-f]{64}$/.test(receipt.body.provider_evidence_digest)
      && BigInt(history.settlement.charge_micro_usdc) <= BigInt(c.max_cost_micro_usdc)
      && BigInt(before.state.balance_micro_usdc) - BigInt(after.state.balance_micro_usdc) === BigInt(history.settlement.charge_micro_usdc));
    return {schema: 1, passed: true, scope: 'one real-provider case via existing ControlClient; no wallet UI or full G3 claim',
      case_id: c.id, mode: c.mode, provider: c.provider, model: c.model, stream: c.stream, tools: c.tools,
      ...observation, request_id: prepared.request.authorization.request_id, receipt_id: receipt.body.receipt_id,
      receipt_hash: receipt.receipt_hash, evidence_kind: evidence,
      charged_micro_usdc: history.settlement.charge_micro_usdc, reserved_micro_usdc: reservation.reserved_micro_usdc,
      plan_sha256: reservation.plan_sha256, tariff_hash: o.tariff.tariff_hash, signed_successor_verified_by_sdk: true,
      authorization_recovery_attempts: authorizationRecoveryAttempts,
      quote_request_attempts: quoteRequestAttempts,
      inference_replays: 0, full_g3_passed: false};
  } catch (error) {
    diagnostic.elapsed_ms = elapsed(started);
    diagnostic.control_http_status = error instanceof ControlHttpError ? error.status : null;
    throw new ProviderAcceptanceFailure(diagnostic);
  }
}
