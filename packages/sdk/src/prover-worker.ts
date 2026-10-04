/** Dedicated worker entry. Bundle this module into an installed release artifact. */
import { WasmProver, ProverUnavailable } from './prover-runtime.ts';
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void };
let engine: WasmProver | undefined;
let queue = Promise.resolve();
scope.onmessage = event => {
  const message = event.data;
  queue = queue.then(async () => {
    try {
      if (message.kind === 'init' && !engine) {
        engine = await WasmProver.create(message.wasm, message.sha256);
        scope.postMessage({ id:message.id, result:{ready:true} });
      } else if (message.kind === 'run' && engine) scope.postMessage({id:message.id,result:await engine.run(message.command)});
      else throw new Error('invalid worker request');
    } catch (error) { scope.postMessage({id:message.id,error:error instanceof ProverUnavailable ? 'unavailable':'rejected'}); }
  });
};
