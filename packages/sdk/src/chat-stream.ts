/** Internal wire validation only. Completion never verifies provider billing. */
export class ChatStreamError extends Error {
  readonly code: 'invalid_response' | 'incomplete_stream';
  constructor(code: ChatStreamError['code']) {
    super(`Chat ${code}`); this.name = 'ChatStreamError'; this.code = code;
  }
}

const textFinishReasons = new Set(['stop', 'length', 'content_filter']);
const finishReasons = new Set([...textFinishReasons, 'tool_calls', 'function_call']);
const maxFrame = 1024 * 1024, maxTotal = 16 * 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(value: unknown): boolean { return value == null || typeof value === 'string'; }
function functionDelta(value: unknown): boolean {
  return record(value) && optionalString(value.name) && optionalString(value.arguments);
}
function validDelta(value: unknown, textOnly: boolean): value is Record<string, unknown> {
  if (!record(value) || value.role !== undefined && value.role !== 'assistant' || !optionalString(value.content)) return false;
  if (textOnly) return (value.tool_calls == null || Array.isArray(value.tool_calls) && value.tool_calls.length === 0)
    && value.function_call == null;
  if (value.function_call != null && !functionDelta(value.function_call)) return false;
  if (value.tool_calls != null) {
    if (!Array.isArray(value.tool_calls)) return false;
    for (const call of value.tool_calls) {
      if (!record(call) || !Number.isSafeInteger(call.index) || (call.index as number) < 0
        || !optionalString(call.id) || call.type != null && call.type !== 'function'
        || call.function != null && !functionDelta(call.function)) return false;
    }
  }
  return true;
}
function emptyTerminalDelta(delta: Record<string, unknown>, textOnly: boolean): boolean {
  if ((delta.content ?? '') !== '' || delta.function_call != null
    || delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 0)) return false;
  // Reasoning and refusal are valid raw extensions, but a usage-only repetition
  // must not append more generated output after that choice has terminated.
  return textOnly || ['reasoning', 'reasoning_content', 'refusal'].every(key => delta[key] == null || delta[key] === '')
    && (delta.reasoning_details == null || Array.isArray(delta.reasoning_details) && delta.reasoning_details.length === 0);
}

/** Drain each generator before pushing another chunk. Each consumer owns its
 * own parser; the transport drains its instance before forwarding exact bytes.
 * The generator preserves text delivery before a later malformed SSE event. */
export class ChatCompletionStreamParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly textOnly: boolean;
  private readonly expectedChoices: number;
  private readonly choices = new Map<number, string | null>();
  private buffer = '';
  private data: string[] = [];
  private frameSize = 0;
  private total = 0;
  private done = false;
  private ended = false;
  private error?: ChatStreamError;

  constructor(options: { textOnly?: boolean; expectedChoices?: number } = {}) {
    this.textOnly = options.textOnly ?? false;
    this.expectedChoices = options.expectedChoices ?? 1;
    if (!Number.isSafeInteger(this.expectedChoices) || this.expectedChoices < 1
      || this.textOnly && this.expectedChoices !== 1) throw new ChatStreamError('invalid_response');
  }

  private fail(code: ChatStreamError['code'] = 'invalid_response'): never { throw new ChatStreamError(code); }
  private remember(error: unknown): never {
    this.error ??= error instanceof ChatStreamError ? error : new ChatStreamError('invalid_response');
    throw this.error;
  }
  private *event(): Generator<string> {
    const source = this.data.join('\n'); this.data = []; this.frameSize = 0;
    if (!source) return;
    if (this.done) this.fail();
    if (source === '[DONE]') {
      if (this.choices.size !== this.expectedChoices || [...this.choices.values()].some(reason => reason === null))
        this.fail('incomplete_stream');
      this.done = true; return;
    }
    const value: unknown = JSON.parse(source);
    if (!record(value) || value.error || !Array.isArray(value.choices)
      || value.choices.length > this.expectedChoices) this.fail();
    const indexes = new Set<number>();
    // Empty choices are permitted for optional usage metadata, never billing.
    for (const choice of value.choices) {
      if (!record(choice) || !Number.isSafeInteger(choice.index) || (choice.index as number) < 0
        || (choice.index as number) >= this.expectedChoices || !validDelta(choice.delta, this.textOnly)) this.fail();
      const index = choice.index as number, delta = choice.delta;
      if (indexes.has(index)) this.fail();
      indexes.add(index);
      const previous = this.choices.get(index);
      if (previous) {
        // OpenRouter repeats each empty terminal choice in its final usage frame.
        if (!record(value.usage) || choice.finish_reason !== previous || !emptyTerminalDelta(delta, this.textOnly)) this.fail();
        continue;
      }
      let reason: string | null = null;
      if (choice.finish_reason != null) {
        if (typeof choice.finish_reason !== 'string'
          || !(this.textOnly ? textFinishReasons : finishReasons).has(choice.finish_reason)) this.fail();
        reason = choice.finish_reason;
      }
      this.choices.set(index, reason);
      if (typeof delta.content === 'string' && delta.content) yield delta.content;
    }
  }
  private nextLine(eof: boolean): string | undefined {
    const match = /\r\n|\r|\n/.exec(this.buffer);
    if (!match || !eof && match[0] === '\r' && match.index === this.buffer.length - 1) return undefined;
    const line = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length);
    return line;
  }
  private *lines(eof: boolean): Generator<string> {
    for (;;) {
      const line = this.nextLine(eof); if (line === undefined) break;
      this.frameSize += line.length;
      if (this.frameSize > maxFrame || this.done && line && !line.startsWith(':')) this.fail();
      if (!line) {
        for (const content of this.event()) {
          // Only a final ambiguous CR can remain at EOF. Text there has no
          // following DONE event and cannot qualify as a completed response.
          if (eof) this.fail('incomplete_stream');
          yield content;
        }
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (this.buffer.length + this.frameSize > maxFrame) this.fail();
  }
  *push(bytes: Uint8Array): Generator<string> {
    try {
      if (this.error) throw this.error;
      if (this.ended) this.fail();
      this.total += bytes.length; if (this.total > maxTotal) this.fail();
      this.buffer += this.decoder.decode(bytes, { stream: true });
      yield* this.lines(false);
    } catch (error) { this.remember(error); }
  }
  *finish(): Generator<string> {
    try {
      if (this.error) throw this.error;
      if (this.ended) return;
      this.buffer += this.decoder.decode();
      yield* this.lines(true);
      if (this.done && this.buffer && !this.buffer.startsWith(':')) this.fail();
      if (!this.done) this.fail('incomplete_stream');
      this.ended = true;
    } catch (error) { this.remember(error); }
  }
}
