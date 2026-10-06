import { createZkApiClient, type CreateClientOptions } from './client.ts';
import { WorkerProver } from './prover-runtime.ts';
import { openBrowserStorage } from './browser-storage.ts';
import { sha256Hex } from './trust.ts';
export { openBrowserStorage, BrowserStorageMissing } from './browser-storage.ts';
export { walletStandardAdapter } from './wallet-standard.ts';
export type { StandardWallet, StandardAccount } from './wallet-standard.ts';

export interface CreateBrowserClientOptions extends Omit<CreateClientOptions, 'prover' | 'storage'> {
  storageName: string;
  /** Only on the user's explicit first-wallet creation. Normal reload omits this. */
  initializeStorage?: boolean;
  /** Application-bundled worker entry, independent of fetched configuration. */
  createWorker(): Worker;
  wasm: Uint8Array;
  wasmSha256: string;
}
export async function createBrowserClient(options: CreateBrowserClientOptions) {
  // Scope custody by account and independently installed deployment identity.
  const expected = structuredClone(options.deployment.trust.expected);
  const name = JSON.stringify([options.storageName, expected.deployment_id, expected.pool, options.wallet.publicKey.toBase58()]);
  const wasm = new Uint8Array(options.wasm), sha256 = options.wasmSha256, createWorker = options.createWorker;
  // Snapshot mutable inputs before opening asynchronous custody.
  const input = { ...options, models: structuredClone(options.models),
    directProviderBases: structuredClone(options.directProviderBases), oaVerifier: structuredClone(options.oaVerifier),
    deployment: { ...options.deployment, manifest: new Uint8Array(options.deployment.manifest),
      trust: structuredClone(options.deployment.trust), artifacts: structuredClone(options.deployment.artifacts) } };
  if (!/^[0-9a-f]{64}$/.test(sha256) || await sha256Hex(wasm) !== sha256) throw new Error('browser WASM hash mismatch');
  const storage = await openBrowserStorage(name, { initialize: input.initializeStorage });
  let engine: WorkerProver | undefined;
  try {
    engine = new WorkerProver(createWorker(), wasm, sha256);
    const client = await createZkApiClient({ ...input, storage, prover: engine });
    const ownedEngine = engine;
    return { client, dispose() { client.dispose(); ownedEngine.terminate(); storage.close(); } };
  } catch (error) { engine?.terminate(); storage.close(); throw error; }
}
