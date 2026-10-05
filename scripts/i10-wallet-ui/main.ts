import {Buffer} from 'buffer';
import {Connection, PublicKey} from '@solana/web3.js';
import {parseStrictJson, verifyManifest, type ArtifactBundle, type ManifestTrustPolicy} from '../../packages/sdk/src/trust.ts';
import {ControlClient, verifiedClientBundle} from '../../packages/sdk/src/control.ts';
import {NoteProver} from '../../packages/sdk/src/prover.ts';
import {WorkerProver} from '../../packages/sdk/src/prover-runtime.ts';
import {SolanaWalletChain} from '../../packages/sdk/src/wallet-chain.ts';
import {connectionTransport} from '../../packages/sdk/src/transport.ts';
import {mountWalletUi} from './app.ts';
import {ProverSessionVerifier} from '../../packages/sdk/src/control-prover.ts';
import type {UiProviderConfiguration} from './provider.ts';

interface Configuration {runId: string; policy: ManifestTrustPolicy; wasmSha256: string; artifactNames: string[]; allowTransactions: boolean; provider?: UiProviderConfiguration}
const read = async (path: string) => { const response = await fetch(path, {credentials: 'omit', cache: 'no-store', redirect: 'error'}); if (!response.ok) throw Error('pinned local input unavailable'); return new Uint8Array(await response.arrayBuffer()); };
async function main() {
  const config = parseStrictJson(await read('/config')) as unknown as Configuration;
  const manifest = await verifyManifest(await read('/manifest'), config.policy);
  const logicalRpc = 'https://rpc.zkapi.invalid', logicalIndexer = 'https://indexer.zkapi.invalid';
  let snapshotSignal: AbortSignal | undefined;
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let path: string;
    if (url.origin === logicalRpc && url.pathname === '/' && !url.search) path = '/rpc';
    else if (url.origin === logicalIndexer && /^\/zkapi\/v1\/tree\/(root|notes\/\d+\/(path|zero-path))$/.test(url.pathname) && !url.search) path = '/indexer' + url.pathname;
    else if (url.origin === manifest.control_api_origin && url.pathname === '/zkapi/v1/withdraw/clearance' && !url.search) path = '/clearance';
    else if (config.provider && url.origin === manifest.control_api_origin && url.pathname.startsWith('/zkapi/v1/') && !url.hash) path = '/control' + url.pathname + url.search;
    else if (config.provider && url.origin === manifest.inference_api_origin && url.pathname === '/v1/chat/completions' && !url.search && !url.hash) path = '/inference' + url.pathname;
    else throw Error('unconfigured network destination');
    return fetch(path, {...init, ...(snapshotSignal ? {signal: init?.signal ? AbortSignal.any([snapshotSignal, init.signal]) : snapshotSignal} : {}), credentials: 'omit', redirect: 'error', cache: 'no-store'});
  };
  const connection = new Connection(logicalRpc, {commitment: 'finalized', fetch: proxyFetch, disableRetryOnRateLimit: true});
  const genesis = await connection.getGenesisHash();
  if (genesis !== config.policy.expected.genesis_hash) throw Error('devnet genesis mismatch');
  mountWalletUi({fixtureOnly: false, financialEnabled: config.allowTransactions, targetWallet: 'Phantom', runId: config.runId, manifest,
    fee: async tx => { const result = await connection.getFeeForMessage(tx.message, 'finalized'); if (result.value === null) throw Error('fee unavailable'); return result.value; },
    initialize: async journal => {
      const artifacts: Record<string, Uint8Array> = Object.create(null), additional: Record<string, Uint8Array> = Object.create(null);
      for (const name of config.artifactNames) {
        const value = await read('/artifact/' + encodeURIComponent(name));
        if (name.startsWith('additional:')) additional[name.slice(11)] = value; else artifacts[name] = value;
      }
      const observed = await connection.getAccountInfoAndContext(new PublicKey(manifest.pool), 'finalized');
      if (!observed.value) throw Error('finalized pool unavailable');
      const a = observed.value, bundle = await verifiedClientBundle(manifest, genesis, {address: manifest.pool,
        owner: a.owner.toBase58(), executable: a.executable, lamports: BigInt(a.lamports), data: a.data,
        slot: BigInt(observed.context.slot), commitment: 'finalized'}, BigInt(observed.context.slot), {...artifacts, additional} as unknown as ArtifactBundle);
      const engine = new WorkerProver(new Worker('/worker.js', {type: 'module'}), await read('/wasm'), config.wasmSha256);
      const prover = await NoteProver.create(manifest, bundle.artifacts, engine);
      const chain = new SolanaWalletChain(connection, manifest, logicalIndexer, {fetch: proxyFetch});
      // Bound retries only for coherent read snapshots; signed attempts retain
      // the existing SDK recovery policy and require an explicit UI action.
      const rawSnapshot = chain.snapshot.bind(chain);
      chain.snapshot = async (...args) => {
        const deadline = performance.now() + 300_000, controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300_000); snapshotSignal = controller.signal;
        try {
          for (;;) {
            try { const result = await rawSnapshot(...args); if (performance.now() >= deadline) throw Error('snapshot wait expired'); return result; }
            catch (error) {
              if (!(error instanceof Error) || !['finalized indexer unavailable', 'RPC/indexer finalized cut changed; retry snapshot', 'untrusted indexer root'].includes(error.message) || performance.now() >= deadline) throw error;
              await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - performance.now()))));
            }
          }
        } finally { snapshotSignal = undefined; controller.abort(); clearTimeout(timer); }
      };
      return {manifest, prover, chain, rpc: connectionTransport(connection), fetch: proxyFetch,
        ...(config.provider ? {providerOptions: {configuration: config.provider, prover, chain,
          client: new ControlClient({context: bundle.context, journal, verifier: new ProverSessionVerifier(engine), fetch: proxyFetch})}} : {})};
    }});
  if (!config.allowTransactions) document.getElementById('scope')!.textContent += ' · Server transaction sends DISABLED';
}
// web3 and the pinned SDK use the exact-pinned browser Buffer implementation.
Object.assign(globalThis, {Buffer});
void main().catch(() => { document.getElementById('status')!.textContent = 'Pinned devnet setup failed. No wallet operation is available.'; });
