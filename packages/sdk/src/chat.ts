import { ChatCompletionStreamParser, ChatStreamError } from './chat-stream.ts';

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
async function cleanup(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, failed: boolean, complete = false): Promise<void> {
  try { if (!complete) await reader.cancel(); }
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

/** Bounded text-only Chat Completions SSE parser. Each pending read has a
 * ten-minute deadline; time spent processing a yielded delta is excluded.
 * Success requires terminal SSE and HTTP EOF. Breaking iteration cancels that
 * body branch; native clone/tee siblings can continue independently. */
export async function* readChatDeltas(response: Response): AsyncGenerator<string> {
  await check(response, true);
  const reader = response.body?.getReader(); if (!reader) throw failure(response, 'invalid_response');
  const parser = new ChatCompletionStreamParser({ textOnly: true });
  let failed = false, complete = false;
  function read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    // One timer per pending read, with no timer/reaction retained after it ends.
    // A slow consumer or a sibling draining buffered bytes is not a stalled
    // transport. The SDK separately bounds the whole upstream transport.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure(response, 'incomplete_stream')), 600_000);
      reader!.read().then(value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); });
    });
  }
  try {
    for (;;) {
      const next = await read();
      if (next.done) { yield* parser.finish(); complete = true; break; }
      yield* parser.push(next.value);
    }
  } catch (error) {
    failed = true;
    if (error instanceof ChatResponseError) throw error;
    throw failure(response, error instanceof ChatStreamError ? error.code : 'invalid_response');
  } finally { await cleanup(response, reader, failed, complete); }
}
