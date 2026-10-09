/** One direct-inference policy shared by daemon admission and the low-level
 * dispatch sink. Reject unsupported fields; never silently forward identifiers.
 * Returned bytes are detached and include OpenRouter's fixed retention policy. */
import { parseStrictJson, jcsBytes } from './trust.ts';
import type { Mode } from './control.ts';

const chatFields = new Set([
  'model','messages','stream','stream_options','temperature','top_p','top_k','n',
  'presence_penalty','frequency_penalty','repetition_penalty','logit_bias',
  'logprobs','top_logprobs','max_tokens','max_completion_tokens','stop','seed',
  'tools','tool_choice','parallel_tool_calls','functions','function_call',
  'response_format','reasoning','reasoning_effort','include_reasoning','store','provider',
]);
const responseFields = new Set([
  'model','input','instructions','stream','stream_options','temperature','top_p',
  'max_output_tokens','tools','tool_choice','parallel_tool_calls','text','reasoning',
  'truncation','store',
]);
export function directRequestBytes(mode: Exclude<Mode,'proxy'>, path: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length > 1024*1024 || !['/v1/chat/completions','/v1/responses'].includes(path)
    || mode === 'direct_openrouter' && path !== '/v1/chat/completions') throw new Error('unsupported direct endpoint');
  const body = parseStrictJson(bytes);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !body.model.length)
    throw new Error('explicit direct model required');
  // OpenRouter model suffixes and presets can enable plugins outside ZDR.
  // Only literal catalog IDs are supported, including at the low-level sink.
  if (mode === 'direct_openrouter' && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(body.model))
    throw new Error('unsupported direct model alias or preset');
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
  if (Array.isArray(body.functions)) for (const fn of body.functions) {
    if (fn && typeof fn === 'object' && !Array.isArray(fn) && Object.hasOwn(fn,'parameters')) schemas.add(fn.parameters);
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

  const fields = path === '/v1/chat/completions' ? chatFields : responseFields;
  if (Object.keys(body).some(key=>!fields.has(key))) throw new Error('unsupported identity or transport metadata');
  if (Object.hasOwn(body,'provider')) {
    const policy = body.provider;
    if (mode !== 'direct_openrouter' || !policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).some(key=>!['zdr','data_collection'].includes(key))
      || policy.zdr !== true || policy.data_collection !== undefined && policy.data_collection !== 'deny')
      throw new Error('unsupported identity or transport metadata: OpenRouter requires ZDR and denied data collection');
  }
  if (mode === 'direct_openrouter') {
    // No opt-out, alternate routing preference or fallback after a provider error.
    // This is a provider routing requirement, not cryptographic proof of deletion.
    body.provider = {zdr:true,data_collection:'deny'};
    const result = jcsBytes(body);
    if (result.length > 1024*1024) throw new Error('unsupported direct request size');
    return new Uint8Array(result);
  }
  return new Uint8Array(bytes);
}
