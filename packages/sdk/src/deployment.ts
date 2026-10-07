/** Public artifact loading for independent applications. Never sends AUTH/inference. */
import { parseStrictJson, sha256Hex, verifyManifest, verifyArtifactBundle,
  type ArtifactBundle, type ManifestTrustPolicy, type VerifiedManifest } from './trust.ts';

const artifactNames = ['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk', 'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'] as const;
const maximumTotalBytes = 512 * 1024 * 1024;
const maximumNoticeBytes = 1024 * 1024, maximumTotalNoticeBytes = 4 * 1024 * 1024;
const noticeName = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/;
export interface LoadedDeploymentAssets {
  manifest: Uint8Array;
  trust: ManifestTrustPolicy;
  artifacts: ArtifactBundle;
  wasm: Uint8Array;
  wasmSha256: string;
  verifiedManifest: VerifiedManifest;
  /** Authenticated schema-2 public license/provenance files; empty for schema 1. */
  notices: Record<string, Uint8Array>;
}
export interface LoadDeploymentAssetsOptions {
  /** Independently installed SHA-256 of exact bundle.json bytes. */
  bundleSha256: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Overall download/verification deadline; default 120 seconds, maximum 300. */
  timeoutMs?: number;
}
export class DeploymentAssetsError extends Error {
  constructor() { super('deployment assets unavailable or verification failed'); this.name = 'DeploymentAssetsError'; }
}
function requireValue(value: unknown): asserts value { if (!value) throw new DeploymentAssetsError(); }
function object(value: unknown): asserts value is Record<string, any> { requireValue(value && typeof value === 'object' && !Array.isArray(value)); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  object(value); requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw new DeploymentAssetsError(); }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new DeploymentAssetsError()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
async function boundedRead(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    requireValue(response.ok && response.body);
    const length = response.headers.get('content-length');
    requireValue(length === null || /^[0-9]+$/.test(length) && Number(length) <= limit);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await abortable(reader.read(), signal); if (next.done) break;
      size += next.value.length; requireValue(size <= limit); chunks.push(next.value);
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } finally {
    // Custom response streams may never resolve cancel(). Begin cleanup without
    // letting an untrusted stream hold the deadline or replace a redacted error.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else void response.body?.cancel().catch(() => {});
  }
}

/** Load the output of package_sdk_distribution_assets.mjs through ordinary static
 * hosting. The caller authenticates the descriptor hash outside this download.
 * Only flat same-directory public files are requested, without cookies/retries. */
export async function loadDeploymentAssets(bundleUrl: string | URL, options: LoadDeploymentAssetsOptions): Promise<LoadedDeploymentAssets> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expected = options.bundleSha256, fetcher = options.fetch ?? fetch, timeout = options.timeoutMs ?? 120_000;
    requireValue(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    timer = setTimeout(() => controller.abort(), timeout);
    signal.throwIfAborted();
    requireValue(/^[0-9a-f]{64}$/.test(expected));
    const url = new URL(String(bundleUrl));
    requireValue(!url.username && !url.password && !url.search && !url.hash);
    requireValue(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const get = async (address: URL, limit: number) => {
      signal.throwIfAborted();
      const pending = fetcher(address, {
        method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      });
      // Even a custom fetch that ignores AbortSignal cannot keep this call open.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      return boundedRead(await abortable(pending, signal), limit, signal);
    };
    const descriptorBytes = await get(url, 1024 * 1024);
    requireValue(await sha256Hex(descriptorBytes) === expected);
    const descriptor: unknown = parseStrictJson(descriptorBytes);
    object(descriptor);
    requireValue(descriptor.schema === 1 || descriptor.schema === 2);
    exact(descriptor, ['schema', 'trust', 'manifest', 'artifacts', 'wasm', 'files', ...(descriptor.schema === 2 ? ['notices'] : [])]);
    object(descriptor.trust); exact(descriptor.artifacts, [...artifactNames, 'additional']);
    object(descriptor.artifacts.additional); exact(descriptor.wasm, ['path', 'sha256']); object(descriptor.files);
    const noticeFiles: Record<string, string> = descriptor.schema === 2 ? descriptor.notices : {};
    object(noticeFiles);
    const noticeNames = Object.keys(noticeFiles);
    requireValue(descriptor.schema === 1 || noticeNames.length > 0 && noticeNames.length <= 32);
    requireValue(noticeNames.every(name => noticeName.test(name) && name !== 'bundle.json'));
    const names = [descriptor.manifest, ...artifactNames.map(name => descriptor.artifacts[name]),
      ...Object.values(descriptor.artifacts.additional), descriptor.wasm.path, ...Object.values(noticeFiles)];
    requireValue(names.every(name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name) && name !== '.' && name !== '..'));
    requireValue(new Set(names).size === names.length);
    requireValue(Object.keys(descriptor.files).length === names.length && names.every(name => Object.hasOwn(descriptor.files, name)));
    let noticeTotal = 0;
    for (const name of Object.values(noticeFiles)) {
      requireValue(noticeName.test(name) && name !== 'bundle.json');
      const file = descriptor.files[name]; object(file);
      requireValue(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= maximumNoticeBytes);
      noticeTotal += file.bytes; requireValue(noticeTotal <= maximumTotalNoticeBytes);
    }
    let total = 0;
    for (const file of Object.values(descriptor.files)) {
      exact(file, ['sha256', 'bytes']);
      requireValue(typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256));
      requireValue(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= maximumTotalBytes);
      total += file.bytes; requireValue(total <= maximumTotalBytes);
    }
    const read = async (name: string) => {
      const file = descriptor.files[name], bytes = await get(new URL(name, url), file.bytes);
      requireValue(bytes.length === file.bytes && await sha256Hex(bytes) === file.sha256); return bytes;
    };
    const manifest = await read(descriptor.manifest), trust = descriptor.trust as ManifestTrustPolicy;
    const verifiedManifest = await verifyManifest(manifest, trust);
    const bundle: Record<string, any> = { additional: Object.create(null) };
    for (const name of artifactNames) bundle[name] = await read(descriptor.artifacts[name]);
    for (const [name, file] of Object.entries(descriptor.artifacts.additional)) bundle.additional[name] = await read(file as string);
    const artifacts = await verifyArtifactBundle(verifiedManifest, bundle as ArtifactBundle);
    const wasm = await read(descriptor.wasm.path), wasmSha256 = descriptor.wasm.sha256;
    requireValue(typeof wasmSha256 === 'string' && /^[0-9a-f]{64}$/.test(wasmSha256) && await sha256Hex(wasm) === wasmSha256 && WebAssembly.validate(new Uint8Array(wasm)));
    const notices: Record<string, Uint8Array> = Object.create(null);
    for (const [name, file] of Object.entries(noticeFiles)) notices[name] = await read(file);
    signal.throwIfAborted();
    return { manifest, trust, artifacts, wasm, wasmSha256, verifiedManifest, notices };
  } catch { throw new DeploymentAssetsError(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
