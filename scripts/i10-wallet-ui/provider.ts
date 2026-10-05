/** Browser orchestration only; the SDK NoteJournal owns every financial transition. */
import {Buffer} from 'buffer';
import {ControlClient, createCredentials, type NoteJournal, type Tariff, type PreparedSession} from '../../packages/sdk/src/control.ts';
import type {EncryptedJournal} from '../../packages/sdk/src/journal.ts';
import type {NoteProver} from '../../packages/sdk/src/prover.ts';
import type {WalletChain} from '../../packages/sdk/src/wallet-chain.ts';
import {parseStrictJson, sha256Hex} from '../../packages/sdk/src/trust.ts';
import {ProviderResponseError} from './provider-diagnostics.ts';

export interface UiProviderConfiguration {
  testCase: {id: string; mode: string; provider: string; model: string; endpoint: string; stream: boolean; tools: boolean;
    max_output_tokens: number; max_cost_micro_usdc: string; session_ttl_seconds: number};
  tariff: Tariff; planSha256: string; requestPolicy?: 'explicit_demo';
}
export interface UiProviderOptions {
  configuration: UiProviderConfiguration; journal: EncryptedJournal<NoteJournal>; client: ControlClient;
  prover: Pick<NoteProver, 'prepareSession'>; chain: Pick<WalletChain, 'snapshot'>;
}
function requireTrue(value: unknown): asserts value { if (!value) throw Error('fixed OpenAI acceptance state required'); }
export function uiProviderBody(configuration: UiProviderConfiguration): Uint8Array {
  const c = configuration.testCase;
  requireTrue(configuration.requestPolicy === undefined || configuration.requestPolicy === 'explicit_demo');
  requireTrue(c.id === 'openai-chat-plain' && c.mode === 'proxy' && c.provider === 'openai'
    && c.endpoint === 'chat_completions' && c.stream === false && c.tools === false
    && typeof c.model === 'string' && /^[\x21-\x7e]{1,200}$/.test(c.model) && c.model !== '*'
    && c.max_output_tokens === 128 && c.session_ttl_seconds === 300
    && /^[1-9][0-9]{0,7}$/.test(c.max_cost_micro_usdc) && BigInt(c.max_cost_micro_usdc) <= 10_000_000n
    && /^[0-9a-f]{64}$/.test(configuration.planSha256)
    && configuration.tariff.provider === 'openai' && configuration.tariff.model === c.model);
  return new TextEncoder().encode(JSON.stringify({model: c.model, messages: [{role: 'user', content: 'Reply with the single word ok.'}], max_completion_tokens: c.max_output_tokens}));
}
export class UiProvider {
  readonly configuration: UiProviderConfiguration;
  private readonly o: UiProviderOptions;
  private readonly body: Uint8Array;
  constructor(options: UiProviderOptions) {
    this.configuration = structuredClone(options.configuration); this.body = uiProviderBody(this.configuration);
    this.o = {...options, configuration: this.configuration};
  }
  private checkPrepared(p: PreparedSession): void {
    const c = this.configuration.testCase, q = p.request.quote.body;
    requireTrue(p.request.authorization.mode === 'proxy' && q.mode === 'proxy' && q.provider === 'openai'
      && q.models.length === 1 && q.models[0] === c.model && q.session_ttl_seconds === String(c.session_ttl_seconds)
      && q.tariff_hash === this.configuration.tariff.tariff_hash && JSON.stringify(p.tariff) === JSON.stringify(this.configuration.tariff));
  }
  private async record(noteId: string) {
    const r = await this.o.journal.read(noteId); requireTrue(r?.value.witness && r.value.wallet);
    if (this.configuration.requestPolicy !== 'explicit_demo') requireTrue(r.value.history.length <= 1);
    for (const h of r.value.history) this.checkPrepared(h.prepared);
    if (r.value.pending) {
      this.checkPrepared(r.value.pending.prepared);
      requireTrue((this.configuration.requestPolicy === 'explicit_demo' || r.value.history.length === 0) && r.value.pending.operations.length <= 1);
      for (const op of r.value.pending.operations) requireTrue(op.path === '/v1/chat/completions'
        && op.anthropicVersion === '' && op.bodyBase64 === Buffer.from(this.body).toString('base64'));
    }
    return r;
  }
  // A separate intent lock serializes UI clicks across tabs without recursively
  // taking the SDK's note lock or storing a parallel operation state.
  private locked<T>(noteId: string, action: () => Promise<T>): Promise<T> {
    return this.o.journal.withNoteLock('ui-provider:' + noteId, action);
  }
  async prepare(noteId: string): Promise<void> {
    return this.locked(noteId, async () => {
      const r = await this.record(noteId), v = r.value;
      requireTrue(v.pending === null && (this.configuration.requestPolicy === 'explicit_demo' || v.history.length === 0) && v.wallet!.status === 'active'
        && !v.wallet!.operation && !v.wallet!.clearance);
      // Capture the coherent chain view before the signed quote's 120s clock starts.
      const snapshot = await this.o.chain.snapshot(v.witness!.note_id, 'active');
      const c = this.configuration.testCase;
      const quote = await this.o.client.quote({mode: 'proxy', provider: 'openai', models: [c.model], session_ttl_seconds: String(c.session_ttl_seconds)}, this.configuration.tariff);
      requireTrue(BigInt(v.state.balance_micro_usdc) >= BigInt(quote.body.cap_micro_usdc));
      const prepared = await this.o.prover.prepareSession(v.witness!, v.state, snapshot.root, snapshot.siblings,
        quote, this.configuration.tariff, await createCredentials('proxy'));
      await this.o.client.prepare(noteId, prepared, snapshot.root);
    });
  }
  async sendOnce(noteId: string): Promise<{text: string; operationId: string; httpStatus: 200; responseBytes: number; responseSha256: string}> {
    return this.locked(noteId, async () => {
      let r = await this.record(noteId); requireTrue(r.value.pending && !r.value.pending.closeRequested);
      requireTrue(r.value.pending.operations.every(op => op.phase === 'prepared'));
      if (['prepared', 'send_unknown'].includes(r.value.pending.phase)) await this.o.client.submit(noteId);
      r = await this.record(noteId);
      requireTrue(r.value.pending?.phase === 'active' && r.value.pending.serverState === 'ACTIVE' && !r.value.pending.closeRequested);
      let operationId = r.value.pending.operations[0]?.id;
      if (!operationId) { operationId = crypto.randomUUID(); await this.o.client.prepareOperation(noteId, operationId, '/v1/chat/completions', this.body); }
      const response = await this.o.client.sendOperation(noteId, operationId);
      const reader = response.body?.getReader();
      try {
        if (response.status !== 200) throw new ProviderResponseError(response.status, response.headers.get('x-zkapi-error-code'));
        if (!reader) throw Error('provider response body missing');
        const chunks: Uint8Array[] = []; let length = 0;
        for (;;) { const {done, value} = await reader.read(); if (done) break; length += value.length;
          if (length > 1024 * 1024) throw Error('provider response limit'); chunks.push(value); }
        const bytes = new Uint8Array(Buffer.concat(chunks));
        let result: {choices?: {message?: {role?: unknown; content?: unknown; refusal?: unknown}; finish_reason?: unknown}[]};
        try { result = parseStrictJson(bytes) as typeof result; } catch { throw Error('provider response invalid'); }
        const choice = result?.choices?.[0];
        if (!(Array.isArray(result?.choices) && result.choices.length === 1 && choice?.message?.role === 'assistant'
          && typeof choice.message.content === 'string' && choice.message.content.length > 0
          && !choice.message.refusal && choice.finish_reason === 'stop')) throw Error('provider response invalid');
        return {text: choice.message.content, operationId, httpStatus: 200, responseBytes: length, responseSha256: await sha256Hex(bytes)};
      } finally { await reader?.cancel().catch(() => {}); }
    });
  }
  async recoverClose(noteId: string): Promise<string> {
    return this.locked(noteId, async () => {
      const p = (await this.record(noteId)).value.pending; requireTrue(p);
      if (p.phase === 'prepared') { await this.o.client.cancelUnsent(noteId); return 'Never-sent authorization cancelled; funds remain available.'; }
      const status = p.phase === 'closing' ? await this.o.client.recover(noteId) : await this.o.client.close(noteId);
      return status.state === 'SETTLED' ? 'Signed receipts and successor verified. The note is available for mutual close.'
        : `Session ${status.state}. Use recover again to check finalized settlement; inference is never replayed.`;
    });
  }
  async reconcileAbsent(noteId: string): Promise<void> {
    return this.locked(noteId, async () => { const p = (await this.record(noteId)).value.pending;
      requireTrue(p?.phase === 'closing' && p.operations.some(op => op.phase === 'send_unknown'));
      await this.o.client.reconcileAbsentOperations(noteId);
    });
  }
}
