import type { Mode } from './control.ts';
import { parseStrictJson } from './trust.ts';

/** Bounded body reader, including transports which do not abort response reads. */
async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = []; let size = 0, done = false;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error('response unavailable')); });
  signal.addEventListener('abort', abort, {once:true});
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) { done = true; break; }
      size += next.value.byteLength; if (size > limit) throw new Error('response too large');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseStrictJson(bytes);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export interface ModelAvailability {
  schema: 1;
  mode: Mode;
  checkedAt: string | null;
  basis: 'public_zdr_catalog' | 'not_applicable' | 'unavailable';
  providerAccess: 'unverified';
  inferencePerformed: false;
  models: { id: string; status: 'zdr_endpoint_listed' | 'not_listed' | 'unknown' | 'not_applicable' }[];
  message: string;
}
/** Explicit metadata-only GET through the installed provider base and transport.
 * No key, model ID, wallet information or prompt is sent. No automatic refresh. */
export async function checkModelAvailability(mode: Mode, models: readonly string[], options: {
  base?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<ModelAvailability> {
  if (!['proxy','direct_oa','direct_openrouter'].includes(mode) || models.length > 1000
    || new Set(models).size !== models.length || models.some(id => typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id))) throw new Error('configured models required');
  const ids = [...models];
  const result: ModelAvailability = {schema:1, mode, checkedAt:null, basis:'unavailable', providerAccess:'unverified', inferencePerformed:false,
    models:ids.map(id=>({id,status:mode === 'direct_openrouter' ? 'unknown' : 'not_applicable'})),
    message:'The ZDR catalog could not be verified. Keep the privacy policy unchanged; no inference was sent.'};
  if (mode !== 'direct_openrouter') { result.basis = 'not_applicable'; result.message = 'This mode has no ZDR catalog check. Consult its privacy profile.'; return result; }
  const ms = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(ms) || ms < 1 || ms > 30_000) throw new Error('metadata timeout must be 1–30000 milliseconds');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  try {
    signal.throwIfAborted();
    const base = new URL(options.base ?? '');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return result;
    const response = await (options.fetch ?? fetch)(base.href.replace(/\/$/, '') + '/models?zdr=true', {
      method:'GET', credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer', headers:{Accept:'application/json'}, signal,
    });
    if (!response.ok) { void response.body?.cancel().catch(()=>{}); return result; }
    const json = await readJson(response,8*1024*1024,signal) as {data?:unknown;total_count?:unknown;links?:{next?:unknown}};
    if (!json || !Array.isArray(json.data) || json.data.length > 10_000
      || json.total_count !== undefined && json.total_count !== json.data.length || json.links?.next) return result;
    const listed = new Set<string>();
    for (const row of json.data) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(row.id) || listed.has(row.id)) return result;
      listed.add(row.id);
    }
    result.checkedAt = new Date().toISOString(); result.basis = 'public_zdr_catalog';
    result.models = ids.map(id=>({id,status:listed.has(id)?'zdr_endpoint_listed':'not_listed'}));
    result.message = 'A public catalog snapshot, not an inference guarantee. Account access, credit, data-collection policy, capacity and current routing remain unverified.';
    return result;
  } catch { return result; }
}

/** Replace HTTP error payloads with bounded, actionable descriptions. Never echo
 * provider messages/metadata, which can contain prompts, keys or identifiers. */
export async function describeProviderError(response: Response, mode: Mode, signal?: AbortSignal): Promise<Response> {
  if (response.ok || mode !== 'direct_openrouter') return response;
  let message = '';
  try {
    const bound = signal ? AbortSignal.any([signal,AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000);
    const json = await readJson(response,64*1024,bound) as {error?:{message?:unknown}};
    if (typeof json?.error?.message === 'string') message = json.error.message;
  } catch { /* Malformed/oversize/interrupted errors get the status-only code. */ }
  const status = response.status;
  const policy = status === 404 && /no endpoints?[^\n]{0,160}(data policy|privacy|zero data retention|\bzdr\b)/i.test(message);
  const code = policy ? 'zdr_endpoint_unavailable' : status === 404 ? 'model_endpoint_unavailable'
    : status === 401 || status === 403 ? 'provider_access_denied' : status === 402 ? 'provider_budget_unavailable'
    : status === 429 ? 'provider_rate_limited' : status >= 500 ? 'provider_unavailable' : 'provider_request_rejected';
  const descriptions: Record<string,string> = {
    zdr_endpoint_unavailable:'No endpoint matched the required privacy policy. Check the ZDR catalog or choose another configured model; do not disable ZDR.',
    model_endpoint_unavailable:'The requested model or endpoint was unavailable. Check the configured model and ZDR catalog.',
    provider_access_denied:'The provider rejected access. Inspect session status and ask the operator to check provider authorization.',
    provider_budget_unavailable:'The provider reported insufficient credit. Inspect session status and ask the operator to check its provider budget.',
    provider_rate_limited:'The provider rate limit was reached. Inspect and settle the saved session before any explicit new request.',
    provider_unavailable:'The provider was unavailable. Inspect the saved operation before deciding on a new request.',
    provider_request_rejected:'The provider rejected the request. Check the supported model/API and request fields after inspecting session status.',
  };
  return Response.json({error:{type:'zkapi_provider_error',code,message:descriptions[code],providerStatus:status,
    nextAction:'inspect_status_and_recover_if_needed',automaticRetry:false,inferenceReplayable:false,privacyPolicyRelaxed:false}},
    {status,headers:{'Cache-Control':'no-store','X-Zkapi-Error-Code':code}});
}
