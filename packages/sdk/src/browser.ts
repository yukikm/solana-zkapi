import { createZkApiClient, validateClientSelectionPins, type CreateClientOptions, type ClientStorage } from './client.ts';
import { WorkerProver } from './prover-runtime.ts';
import { openBrowserStorage, type BrowserStoragePersistence } from './browser-storage.ts';
import { sha256Hex, verifyManifest } from './trust.ts';
import { validateGatewayConfiguration } from './gateway.ts';
export { openBrowserStorage, BrowserStorageMissing } from './browser-storage.ts';
export type { BrowserStoragePersistence } from './browser-storage.ts';
export { walletStandardAdapter } from './wallet-standard.ts';
export type { StandardWallet, StandardAccount } from './wallet-standard.ts';

export interface CreateBrowserClientOptions extends Omit<CreateClientOptions, 'prover' | 'storage'> {
  /** Explicit application transport contract; the v2 framed API exposes octets
   * and trailers without converting them to a browser Fetch Response. */
  gatewayCapabilities?: readonly ['finite_http_v1','opaque_header_bytes','response_trailers'];
  storageName: string;
  /** Application-owned custody, including recoverable storage. The factory
   * retains its trust/WASM validation but never closes supplied storage.
   * Omitting this retains the existing same-origin browser custody behavior. */
  storage?: ClientStorage & { persistence?: BrowserStoragePersistence };
  /** Explicit first-wallet creation; also requests persistent origin storage.
   * Normal reload omits this and does not request storage permission. */
  initializeStorage?: boolean;
  /** Application-bundled worker entry, independent of fetched configuration. */
  createWorker(): Worker;
  wasm: Uint8Array;
  wasmSha256: string;
}
export async function createBrowserClient(options: CreateBrowserClientOptions) {
  // Scope custody by account and independently installed deployment identity.
  const expected = structuredClone(options.deployment.trust.expected);
  const name = JSON.stringify([options.storageName, expected.deployment_id, expected.pool, options.wallet.publicKey]);
  const wasm = new Uint8Array(options.wasm), sha256 = options.wasmSha256, createWorker = options.createWorker;
  const suppliedStorage = options.storage && { store: options.storage.store, key: options.storage.key,
    binding: structuredClone(options.storage.binding), persistence: options.storage.persistence ?? 'unknown' as const };
  // Snapshot mutable inputs before opening asynchronous custody.
  const input = { ...options, models: structuredClone(options.models), services:structuredClone(options.services), gateway:structuredClone(options.gateway),
    directProviderBases: structuredClone(options.directProviderBases), oaVerifier: structuredClone(options.oaVerifier),
    deployment: { ...options.deployment, manifest: new Uint8Array(options.deployment.manifest),
      trust: structuredClone(options.deployment.trust), artifacts: structuredClone(options.deployment.artifacts) } };
  if (!/^[0-9a-f]{64}$/.test(sha256) || await sha256Hex(wasm) !== sha256) throw new Error('browser WASM hash mismatch');
  if(input.services?.some(service=>service.tariff.api.version==='2')){
    if(JSON.stringify(input.gatewayCapabilities)!=='["finite_http_v1","opaque_header_bytes","response_trailers"]')throw Error('explicit browser gateway capabilities required');
    if(input.gateway)validateGatewayConfiguration(input.gateway,input.services,input.models);
    const manifest=await verifyManifest(input.deployment.manifest,input.deployment.trust);
    await validateClientSelectionPins({models:input.models,services:input.services},manifest,undefined,input.deployment.trust.build.gatewayAdapters);
  }
  const ownedStorage = suppliedStorage ? undefined : await openBrowserStorage(name, { initialize: input.initializeStorage });
  const storage = suppliedStorage ?? ownedStorage!;
  let engine: WorkerProver | undefined;
  try {
    engine = new WorkerProver(createWorker(), wasm, sha256);
    const client = await createZkApiClient({ ...input, storage, prover: engine });
    const ownedEngine = engine;
    return { client, persistence: storage.persistence,
      dispose() { client.dispose(); ownedEngine.terminate(); ownedStorage?.close(); } };
  } catch (error) { engine?.terminate(); ownedStorage?.close(); throw error; }
}
