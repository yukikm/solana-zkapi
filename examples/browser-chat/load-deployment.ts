/** App-owned public asset loader. Trust pins are compiled into the app separately. */
import { Connection } from '@solana/web3.js';
import type { ArtifactBundle, ClientDeployment, CreateClientOptions, ManifestTrustPolicy, ModelConfiguration, Mode } from '@zkapi/solana-sdk';
import { parseStrictJson } from '@zkapi/solana-sdk/trust';

export interface ReviewedBrowserProfile {
  trust: ManifestTrustPolicy;
  manifestUrl: string;
  artifacts: Record<Exclude<keyof ArtifactBundle, 'additional'>, string> & { additional: Record<string, string> };
  wasmUrl: string;
  wasmSha256: string;
  models: readonly ModelConfiguration[];
  /** Public RPC endpoint or an app-owned relay; never embed a private RPC credential. */
  rpcUrl: string;
  indexerOrigin: string;
  directProviderBases?: CreateClientOptions['directProviderBases'];
  oaVerifier?: CreateClientOptions['oaVerifier'];
}
/** One independently reviewed route. Selection is explicit; failures never change it. */
export interface ReviewedChatProfile extends ReviewedBrowserProfile {
  id: string;
  label: string;
  chain: 'solana:devnet';
  mode: Mode;
}
async function read(url: string, maximum: number): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('Public deployment asset unavailable');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length;
      if (length > maximum) throw new Error('Public deployment asset exceeds size limit'); parts.push(item.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function loadDeployment(profile: ReviewedBrowserProfile) {
  const p = structuredClone(profile);
  const manifest = await read(p.manifestUrl, 1024 * 1024);
  parseStrictJson(manifest); // fail early on malformed public JSON; factory authenticates it
  const artifacts: Record<string, Uint8Array> = {}, additional: Record<string, Uint8Array> = {};
  for (const [name, url] of Object.entries(p.artifacts)) {
    if (name === 'additional') continue;
    artifacts[name] = await read(url as string, 64 * 1024 * 1024);
  }
  for (const [name, url] of Object.entries(p.artifacts.additional)) additional[name] = await read(url, 64 * 1024 * 1024);
  const deployment: ClientDeployment = { manifest, trust: p.trust, artifacts: { ...artifacts, additional } as unknown as ArtifactBundle,
    connection: new Connection(p.rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true }), indexerOrigin: p.indexerOrigin };
  return { deployment, models: p.models, wasm: await read(p.wasmUrl, 64 * 1024 * 1024), wasmSha256: p.wasmSha256,
    directProviderBases: p.directProviderBases, oaVerifier: p.oaVerifier };
}
