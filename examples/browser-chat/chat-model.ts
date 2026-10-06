import type { ChatRequest, ClientStatus, InferenceApi, InferenceRequest, Mode } from '@zkapi/solana-sdk';
import { readChatDeltas, readChatText } from '@zkapi/solana-sdk/chat';
import { readNativeDeltas, readNativeText } from './native-responses.ts';

export function microUsdc(value: string): string {
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(value)) throw new Error('Enter a positive USDC amount with at most six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount < 1n || amount > 18_446_744_073_709_551_615n) throw new Error('USDC amount is outside the supported range.');
  return amount.toString();
}
export function formatUsdc(value: string): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
}
export function modeName(mode: Mode): string {
  return { proxy: 'Proxy', direct_oa: 'Direct · OA organization', direct_openrouter: 'Direct · OpenRouter' }[mode];
}
export function privacyNotice(mode: Mode): string {
  return mode === 'proxy'
    ? 'The proxy operator and the selected provider can read your prompts and responses. They also see network and usage metadata.'
    : 'Prompts and responses travel directly to the selected provider, which sees content and network metadata. The operator issues credentials and settles provider-reported usage. Direct mode does not hide your IP from the provider.';
}
export function canLeaveNote(status: ClientStatus | undefined): boolean {
  return !!status && !status.busy && !status.session && !status.walletOperation
    && (status.wallet === 'empty' || status.wallet === 'closed');
}
export interface Turn {
  operationId: string;
  model: string;
  api: InferenceApi;
  user: string;
  assistant: string;
  outcome: 'receiving' | 'complete' | 'interrupted';
}
export interface ChatPort {
  status(): Promise<ClientStatus>;
  chat(request: ChatRequest): Promise<Response>;
  request?(request: InferenceRequest): Promise<Response>;
}
/** Only UI transcript state lives here; financial truth stays in the SDK journal.
 * History is memory-only, and incomplete answers never become future context. */
export class Conversation {
  readonly turns: Turn[] = [];
  private active: AbortController | undefined;
  private sending = false;
  get busy() { return this.sending; }
  cancel(): void { this.active?.abort(); }
  clear(): void {
    if (this.sending) throw new Error('Finish or cancel the current request first.');
    this.turns.length = 0;
  }
  async send(client: ChatPort, input: { model: string; api?: InferenceApi; text: string; maxOutputTokens: number; stream: boolean },
    changed: () => void = () => {}): Promise<void> {
    if (this.sending) throw new Error('A request is already in progress.');
    if (!input.text.trim() || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 32_768) {
      throw new Error('Enter a message and an output limit from 1 to 32768 tokens.');
    }
    this.sending = true;
    const abort = new AbortController(); this.active = abort;
    let turn: Turn | undefined;
    try {
      if (!(await client.status()).canRequest) throw new Error('Inspect saved status and recover pending work before sending.');
      abort.signal.throwIfAborted();
      const messages: ChatRequest['messages'][number][] = this.turns.filter(t => t.outcome === 'complete')
        .flatMap(t => [{ role: 'user' as const, content: t.user }, { role: 'assistant' as const, content: t.assistant }]);
      messages.push({ role: 'user', content: input.text });
      const api = input.api ?? 'chat';
      turn = { operationId: crypto.randomUUID(), model: input.model, api, user: input.text, assistant: '', outcome: 'receiving' };
      this.turns.push(turn); changed();
      const common = { operationId: turn.operationId, model: input.model, signal: abort.signal };
      if (api !== 'chat' && !client.request) throw new Error('Native request support is required.');
      const response = api === 'chat'
        ? await client.chat({ ...common, messages, maxOutputTokens: input.maxOutputTokens, stream: input.stream })
        : await client.request!({ ...common, api,
          body: api === 'responses' ? { input: messages, max_output_tokens: input.maxOutputTokens, stream: input.stream, store: false }
            : { messages, max_tokens: input.maxOutputTokens, stream: input.stream },
          ...(api === 'messages' ? { anthropicVersion: '2023-06-01' } : {}) });
      if (input.stream) {
        for await (const delta of (api === 'chat' ? readChatDeltas(response) : readNativeDeltas(response, api))) {
          if (abort.signal.aborted) break;
          turn.assistant += delta; changed();
        }
      } else turn.assistant = await (api === 'chat' ? readChatText(response) : readNativeText(response, api));
      abort.signal.throwIfAborted();
      turn.outcome = 'complete';
    } catch {
      if (turn) turn.outcome = 'interrupted';
      throw new Error(abort.signal.aborted
        ? 'Request cancelled. Provider work may still be charged; inspect settlement and pending status.'
        : 'Request did not complete. Inspect status and recover pending work. Inference was not replayed.');
    } finally { this.active = undefined; this.sending = false; changed(); }
  }
}
