/** Bounded text readers for provider-native APIs. Usage never becomes billing
 * authority. Completion/cancellation still flows through the SDK response body. */
export type NativeApi = 'responses' | 'messages';
export class NativeResponseError extends Error {
  readonly code: 'http_error' | 'invalid_response' | 'incomplete_stream';
  readonly api: NativeApi;
  constructor(code: NativeResponseError['code'], api: NativeApi) {
    super('Provider response could not be completed. Inspect saved SDK status before another request.');
    this.name = 'NativeResponseError'; this.code = code; this.api = api;
  }
}
function invalid(api: NativeApi): never { throw new NativeResponseError('invalid_response', api); }
const textStopReasons = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'model_context_window_exceeded']);
function record(value: unknown, api: NativeApi): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(api);
  return value as Record<string, any>;
}
async function check(response: Response, api: NativeApi, stream: boolean) {
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || type !== (stream ? 'text/event-stream' : 'application/json') || !response.body) {
    try { await response.body?.cancel(); } catch { /* Preserve the redacted error. */ }
    throw new NativeResponseError(response.ok ? 'invalid_response' : 'http_error', api);
  }
}
async function cleanup(reader: ReadableStreamDefaultReader<Uint8Array>, api: NativeApi, failed: boolean) {
  try { await reader.cancel(); }
  catch { if (!failed) invalid(api); }
  finally { reader.releaseLock(); }
}
function completedText(value: unknown, api: NativeApi): string {
  const body = record(value, api);
  if (body.error) invalid(api);
  if (api === 'messages') {
    if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)
      || !textStopReasons.has(body.stop_reason)) invalid(api);
    if (!body.content.length) invalid(api);
    return body.content.map((part: unknown) => {
      const item = record(part, api);
      if (item.type !== 'text' || typeof item.text !== 'string') invalid(api);
      return item.text;
    }).join('');
  }
  if (body.status !== 'completed' || !Array.isArray(body.output)) invalid(api);
  let found = false, text = '';
  for (const itemValue of body.output) {
    const item = record(itemValue, api);
    // Reasoning metadata is not the assistant's user-visible answer.
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) invalid(api);
    for (const partValue of item.content) {
      const part = record(partValue, api);
      const content = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
      if (typeof content !== 'string') invalid(api);
      found = true; text += content;
    }
  }
  if (!found) invalid(api);
  return text;
}

export async function readNativeText(response: Response, api: NativeApi): Promise<string> {
  await check(response, api, false);
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let text = '', bytes = 0, failed = false;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > 4 * 1024 * 1024) invalid(api);
      text += decoder.decode(next.value, {stream: true});
    }
    return completedText(JSON.parse(text + decoder.decode()), api);
  } catch (error) {
    failed = true; if (error instanceof NativeResponseError) throw error; invalid(api);
  } finally { await cleanup(reader, api, failed); }
}

/** Known events without user-visible text. Unknown/new event schemas are
 * rejected until reviewed, rather than silently treated as successful output. */
const responseMetadata = new Set([
  'response.created', 'response.in_progress', 'response.queued',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.done', 'response.refusal.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
]);

export async function* readNativeDeltas(response: Response, api: NativeApi): AsyncGenerator<string> {
  await check(response, api, true);
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let buffer = '', data: string[] = [], eventName = '', frameSize = 0, total = 0;
  let done = false, failed = false, started = false, stopReason: string | undefined;
  let activeBlock: number | null = null, nextBlock = 0, textSeen = false;
  let outputText = '';
  const event = (): string | null => {
    const source = data.join('\n'), declared = eventName;
    data = []; eventName = ''; frameSize = 0;
    if (!source) return null;
    const value = record(JSON.parse(source), api);
    if (typeof value.type !== 'string' || declared && declared !== value.type || value.error || value.type === 'error') invalid(api);
    if (api === 'responses') {
      if (value.type === 'response.completed') {
        // Exact agreement prevents a truncated or inconsistent delta sequence
        // from being retained as complete conversation history.
        if (completedText(value.response, api) !== outputText) invalid(api);
        done = true; return null;
      }
      if (value.type === 'response.output_text.delta' || value.type === 'response.refusal.delta') {
        if (typeof value.delta !== 'string') invalid(api);
        outputText += value.delta; return value.delta;
      }
      if (!responseMetadata.has(value.type)) invalid(api);
      // Tool execution is outside this text UI. Metadata cannot hide tool calls.
      if (value.item && !['message', 'reasoning'].includes(value.item.type)) invalid(api);
      if (value.part && !['output_text', 'refusal', 'summary_text'].includes(value.part.type)) invalid(api);
      return null;
    }
    if (value.type === 'ping') return null;
    if (value.type === 'message_start') {
      if (started || value.message?.type !== 'message' || value.message.role !== 'assistant'
        || !Array.isArray(value.message.content) || value.message.content.length) invalid(api);
      started = true; return null;
    }
    if (!started) invalid(api);
    if (value.type === 'content_block_start') {
      if (activeBlock !== null || value.index !== nextBlock || value.content_block?.type !== 'text'
        || typeof value.content_block.text !== 'string') invalid(api);
      activeBlock = nextBlock++; textSeen = true;
      return value.content_block.text;
    }
    if (value.type === 'content_block_delta') {
      if (activeBlock === null || value.index !== activeBlock || value.delta?.type !== 'text_delta' || typeof value.delta.text !== 'string') invalid(api);
      return value.delta.text;
    }
    if (value.type === 'content_block_stop') {
      if (activeBlock === null || value.index !== activeBlock) invalid(api);
      activeBlock = null; return null;
    }
    if (value.type === 'message_delta') {
      // Some provider versions also emit usage-only updates. These are ignored
      // by the presentation layer and never interpreted as a signed charge.
      const reason = value.delta?.stop_reason;
      if (reason !== undefined && reason !== null) {
        if (!textStopReasons.has(reason) || stopReason && stopReason !== reason) invalid(api);
        stopReason = reason;
      }
      return null;
    }
    if (value.type === 'message_stop') {
      if (activeBlock !== null || !stopReason || !textSeen) invalid(api);
      done = true; return null;
    }
    invalid(api);
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) buffer += decoder.decode();
      else {
        total += next.value.length; if (total > 16 * 1024 * 1024) invalid(api);
        buffer += decoder.decode(next.value, {stream: true});
      }
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || !next.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        frameSize += line.length; if (frameSize > 1024 * 1024) invalid(api);
        if (!line) { const text = event(); if (text) yield text; if (done) break; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /, '');
      }
      if (buffer.length + frameSize > 1024 * 1024) invalid(api);
      if (next.done) break;
    }
    if (!done) throw new NativeResponseError('incomplete_stream', api);
  } catch (error) {
    failed = true; if (error instanceof NativeResponseError) throw error; invalid(api);
  } finally { await cleanup(reader, api, failed); }
}
