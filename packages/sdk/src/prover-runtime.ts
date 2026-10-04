/** Offline byte-only WASM ABI, suitable for an isolated dedicated Worker. */
export interface ClientProver { run(command: object): Promise<unknown> }
export class ProverUnavailable extends Error { constructor() { super('local prover unavailable; witness retained for explicit native fallback'); } }
export class ProverRejected extends Error { constructor() { super('offline prover rejected input'); } }
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  zkapi_alloc(length: number): number;
  zkapi_free(pointer: number, length: number): void;
  zkapi_run(pointer: number, length: number): bigint;
}
export class WasmProver implements ClientProver {
  private readonly wasm: Exports;
  private poisoned=false;
  private constructor(wasm: Exports) { this.wasm = wasm; }
  static async create(bytes: Uint8Array, expectedSha256: string): Promise<WasmProver> {
    const copy = new Uint8Array(bytes);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), b => b.toString(16).padStart(2, '0')).join('');
    if (!/^[0-9a-f]{64}$/.test(expectedSha256) || digest !== expectedSha256) throw new ProverRejected();
    let wasm: Exports | undefined;
    try {
      // uuid's shared server quote issuer retains wasm-bindgen descriptors even
      // though this ABI never calls it. Trap those unreachable glue hooks; all
      // wallet/proof randomness comes through the explicit CSPRNG import below.
      const unreachable = () => { throw new ProverUnavailable(); };
      const result = await WebAssembly.instantiate(copy, {
        __wbindgen_placeholder__: { __wbindgen_describe:unreachable },
        __wbindgen_externref_xform__: { __wbindgen_externref_table_grow:unreachable,__wbindgen_externref_table_set_null:unreachable },
        zkapi: { random_fill(pointer: number, length: number) {
        if (!wasm || !Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0 || pointer + length > wasm.memory.buffer.byteLength) return 1;
        for (let i = 0; i < length; i += 65536) crypto.getRandomValues(new Uint8Array(wasm.memory.buffer, pointer + i, Math.min(65536, length-i)));
        return 0;
      } } });
      wasm = result.instance.exports as Exports;
      if (!wasm.memory || !wasm.zkapi_run || !wasm.zkapi_alloc || !wasm.zkapi_free) throw new ProverUnavailable();
      return new WasmProver(wasm);
    } catch { throw new ProverUnavailable(); }
  }
  async run(command: object): Promise<unknown> {
    if(this.poisoned)throw new ProverUnavailable();
    const input = new TextEncoder().encode(JSON.stringify(command));
    if (input.length > 64*1024*1024) throw new ProverRejected();
    let ptr: number | undefined, outputPtr: number | undefined, outputLength = 0;
    try {
      ptr = this.wasm.zkapi_alloc(input.length);
      new Uint8Array(this.wasm.memory.buffer, ptr, input.length).set(input);
      const result = this.wasm.zkapi_run(ptr, input.length);
      outputPtr = Number(result & 0xffffffffn); outputLength = Number(result >> 32n);
      if (outputLength > 1024*1024) throw new ProverRejected();
      const decoded = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(new Uint8Array(this.wasm.memory.buffer, outputPtr, outputLength)));
      if (!decoded || typeof decoded !== 'object' || 'error' in decoded) throw new ProverRejected();
      return decoded;
    } catch (error) { if (error instanceof ProverRejected) throw error; this.poisoned=true;throw new ProverUnavailable(); }
    finally {
      input.fill(0);
      if (!this.poisoned&&ptr !== undefined) this.wasm.zkapi_free(ptr, input.length);
      if (!this.poisoned&&outputPtr !== undefined) this.wasm.zkapi_free(outputPtr, outputLength);
    }
  }
}

/** Caller supplies an independently installed/pinned worker bundle and WASM hash.
 * Termination invalidates every pending call. Only availability failures use the
 * configured native fallback; invalid witness/proof results never bypass checks. */
export class WorkerProver implements ClientProver {
  private sequence = 0; private ended = false;
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly ready: Promise<unknown>;
  private readonly fallback?: ClientProver;
  private readonly timeout: number;
  constructor(worker: Worker, wasm: Uint8Array, sha256: string, options: { timeoutMs?: number; nativeFallback?: ClientProver } = {}) {
    this.worker = worker; this.fallback = options.nativeFallback; this.timeout = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('worker timeout');
    worker.onmessage = event => {
      const value = event.data; const item = this.pending.get(value?.id); if (!item) return;
      clearTimeout(item.timer); this.pending.delete(value.id);
      value.error ? item.reject(value.error === 'unavailable' ? new ProverUnavailable() : new ProverRejected()) : item.resolve(value.result);
    };
    worker.onerror = () => this.terminate(); worker.onmessageerror = () => this.terminate();
    const bytes = new Uint8Array(wasm);
    this.ready = this.call({ kind:'init', wasm:bytes, sha256 }, [bytes.buffer]);
    // Keep rejected startup observable through run(), without unhandled rejection.
    void this.ready.catch(() => {});
  }
  terminate(): void {
    this.ended = true; this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ProverUnavailable()); }
    this.pending.clear();
  }
  private call(message: object, transfer: Transferable[] = []): Promise<unknown> {
    if (this.ended) return Promise.reject(new ProverUnavailable());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ ...message, id }, transfer); } catch { this.terminate(); }
    });
  }
  async run(command: object): Promise<unknown> {
    const copy = structuredClone(command);
    try { await this.ready; return await this.call({ kind:'run', command:copy }); }
    catch (error) {
      if (!(error instanceof ProverUnavailable) || !this.fallback) throw error;
      return this.fallback.run(copy);
    }
  }
}
