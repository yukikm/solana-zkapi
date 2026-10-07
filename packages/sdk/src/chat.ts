/** Optional text helpers. Provider usage is never a trusted billing receipt. */
export class ChatResponseError extends Error {
  readonly code: 'http_error' | 'invalid_response' | 'incomplete_stream';
  readonly operationId: string | null;
  readonly status: number;
  constructor(code: ChatResponseError['code'], operationId: string | null, status: number) {
    super(`Chat ${code}; inspect SDK status before sending a new request.`); this.name = 'ChatResponseError';
    this.code = code; this.operationId = operationId; this.status = status;
  }
}
function failure(response: Response, code: ChatResponseError['code']): ChatResponseError {
  return new ChatResponseError(code, response.headers.get('X-Zkapi-Operation-Id'), response.status);
}
const textFinishReasons = new Set(['stop', 'length', 'content_filter']);
function textMessage(value: unknown): value is { content?: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (message.role === undefined || message.role === 'assistant')
    && (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.length === 0)
    && message.function_call == null
    && (message.content === undefined || message.content === null || typeof message.content === 'string');
}
async function check(response: Response, stream: boolean): Promise<void> {
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || type !== (stream ? 'text/event-stream' : 'application/json')) {
    try { await response.body?.cancel(); } catch { /* Preserve the redacted HTTP/format error. */ }
    throw failure(response, response.ok ? 'invalid_response' : 'http_error');
  }
}
async function cleanup(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, failed: boolean): Promise<void> {
  try { await reader.cancel(); }
  catch { if (!failed) throw failure(response, 'invalid_response'); }
  finally { reader.releaseLock(); }
}
/** Text-only Chat Completions. Use response.json() for client-side tool calls. */
export async function readChatText(response: Response): Promise<string> {
  await check(response, false);
  const reader = response.body?.getReader();
  if (!reader) throw failure(response, 'invalid_response');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0, failed = false;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
      if (bytes > 4 * 1024 * 1024) throw failure(response, 'invalid_response'); text += decoder.decode(next.value, { stream: true }); }
    text += decoder.decode(); const value = JSON.parse(text);
    const choice = value?.choices?.[0];
    if (value.error || !Array.isArray(value.choices) || value.choices.length !== 1 || !choice
      || choice.index !== undefined && choice.index !== 0 || !textMessage(choice.message)
      || typeof choice.message.content !== 'string' || !textFinishReasons.has(choice.finish_reason)) throw failure(response, 'invalid_response');
    return choice.message.content;
  } catch (error) { failed = true; if (error instanceof ChatResponseError) throw error; throw failure(response, 'invalid_response'); }
  finally { await cleanup(response, reader, failed); }
}

/** Bounded Chat Completions SSE parser. Breaking iteration cancels the body and
 * triggers the SDK's ordinary settlement attempt; it never replays inference. */
export async function* readChatDeltas(response: Response): AsyncGenerator<string> {
  await check(response, true);
  const reader = response.body?.getReader(); if (!reader) throw failure(response, 'invalid_response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], frameSize = 0, total = 0, done = false, failed = false;
  let finishReason: string | null = null;
  function event(): string | null {
    const source = data.join('\n'); data = []; frameSize = 0;
    if (!source) return null;
    if (source === '[DONE]') {
      if (!finishReason) throw failure(response, 'incomplete_stream');
      done = true; return null;
    }
    const value = JSON.parse(source);
    if (value.error || !Array.isArray(value.choices) || value.choices.length > 1) throw failure(response, 'invalid_response');
    if (!value.choices.length) return null; // Optional final usage metadata, never billing authority.
    const choice = value.choices[0];
    if (choice.index !== 0 || !textMessage(choice.delta)) throw failure(response, 'invalid_response');
    if (finishReason) {
      // OpenRouter can repeat the empty terminal choice in its final usage frame.
      // Accept metadata only; it cannot append text or change the completed choice.
      if (!value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)
        || choice.finish_reason !== finishReason || (choice.delta.content ?? '') !== '') throw failure(response, 'invalid_response');
      return null;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (!textFinishReasons.has(choice.finish_reason)) throw failure(response, 'invalid_response');
      finishReason = choice.finish_reason;
    }
    const content = choice.delta.content;
    if (content !== undefined && content !== null && typeof content !== 'string') throw failure(response, 'invalid_response');
    return content ?? null;
  }
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) buffer += decoder.decode();
      else {
        total += next.value.length; if (total > 16 * 1024 * 1024) throw failure(response, 'invalid_response');
        buffer += decoder.decode(next.value, { stream: true });
      }
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || !next.done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        frameSize += line.length;
        if (frameSize > 1024 * 1024) throw failure(response, 'invalid_response');
        if (!line) { const content = event(); if (content) yield content; if (done) break; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (buffer.length + frameSize > 1024 * 1024) throw failure(response, 'invalid_response');
      if (next.done) break;
    }
    if (!done) throw failure(response, 'incomplete_stream');
  } catch (error) { failed = true; if (error instanceof ChatResponseError) throw error; throw failure(response, 'invalid_response'); }
  finally { await cleanup(response, reader, failed); }
}
