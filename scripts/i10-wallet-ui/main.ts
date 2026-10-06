import {Buffer} from 'buffer';
import {Connection, PublicKey} from '@solana/web3.js';
import {parseStrictJson, verifyManifest, type ArtifactBundle, type ManifestTrustPolicy} from '../../packages/sdk/src/trust.ts';
import {ControlClient, verifiedClientBundle} from '../../packages/sdk/src/control.ts';
import {NoteProver} from '../../packages/sdk/src/prover.ts';
import {WorkerProver} from '../../packages/sdk/src/prover-runtime.ts';
import {SolanaWalletChain} from '../../packages/sdk/src/wallet-chain.ts';
import {connectionTransport, resolvePreparationCommitment, type TransactionPreparationCommitment} from '../../packages/sdk/src/transport.ts';
import {mountWalletUi} from './app.ts';
import {ProverSessionVerifier} from '../../packages/sdk/src/control-prover.ts';
import type {UiProviderConfiguration} from './provider.ts';
import type {UiProviderBudget} from './demo-notes.ts';

interface Configuration {runId: string; policy: ManifestTrustPolicy; wasmSha256: string; artifactNames: string[]; allowTransactions: boolean; preparationCommitment?: TransactionPreparationCommitment; provider?: UiProviderConfiguration}
const read = async (path: string) => { const response = await fetch(path, {credentials: 'omit', cache: 'no-store', redirect: 'error'}); if (!response.ok) throw Error('pinned local input unavailable'); return new Uint8Array(await response.arrayBuffer()); };
async function main() {
  document.getElementById('status')!.textContent = 'Verifying the pinned devnet configuration and RPC…';
  const config = parseStrictJson(await read('/config')) as unknown as Configuration;
  const preparationCommitment = resolvePreparationCommitment(config.preparationCommitment);
  const manifest = await verifyManifest(await read('/manifest'), config.policy);
  const logicalRpc = 'https://rpc.zkapi.invalid', logicalIndexer = 'https://indexer.zkapi.invalid';
  let snapshotSignal: AbortSignal | undefined;
  const proxyFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let path: string;
    if (url.origin === logicalRpc && url.pathname === '/' && !url.search) path = '/rpc';
    else if (url.origin === logicalIndexer && /^\/zkapi\/v1\/tree\/(root|snapshot|snapshots\/[0-9a-f]{64}\.json|notes\/\d+\/(path|zero-path))$/.test(url.pathname) && !url.search) path = '/indexer' + url.pathname;
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
    ...(config.provider ? {providerBudget: async () => parseStrictJson(await read('/provider-budget')) as unknown as UiProviderBudget} : {}),
    fee: async tx => { const result = await connection.getFeeForMessage(tx.message, preparationCommitment); if (result.value === null) throw Error('fee unavailable'); return result.value; },
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
      const chain = new SolanaWalletChain(connection, manifest, logicalIndexer, {fetch: proxyFetch, preparationCommitment});
      // Bound retries only for coherent read snapshots; signed attempts retain
      // the existing SDK recovery policy and require an explicit UI action.
      const boundedSnapshot = <A extends unknown[], R>(read: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
        const deadline = performance.now() + 300_000, controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300_000); snapshotSignal = controller.signal;
        try {
          for (;;) {
            try { const result = await read(...args); if (performance.now() >= deadline) throw Error('snapshot wait expired'); return result; }
            catch (error) {
              if (!(error instanceof Error) || !['finalized indexer unavailable', 'RPC/indexer finalized cut changed; retry snapshot', 'untrusted indexer root'].includes(error.message) || performance.now() >= deadline) throw error;
              await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - performance.now()))));
            }
          }
        } finally { snapshotSignal = undefined; controller.abort(); clearTimeout(timer); }
      };
      chain.snapshot = boundedSnapshot(chain.snapshot.bind(chain));
      chain.sessionSnapshot = boundedSnapshot(chain.sessionSnapshot.bind(chain));
      return {manifest, prover, chain, rpc: connectionTransport(connection, {preparationCommitment}), fetch: proxyFetch,
        ...(config.provider ? {providerOptions: {configuration: config.provider, prover, chain,
          client: new ControlClient({context: bundle.context, journal, verifier: new ProverSessionVerifier(engine), fetch: proxyFetch})}} : {})};
    }});
  if (!config.allowTransactions) document.getElementById('scope')!.textContent += ' · Server transaction sends DISABLED';
  const network = document.getElementById('live-network-status');
  if (network) {
    network.textContent = 'Devnet RPC verified. Checking indexed chain history…';
    // Read-only status, separate from proof validation and financial actions.
    // A reachable root does not replace the SDK's finalized snapshot checks.
    const checkHistory = async () => {
      try {
        const response = await fetch('/indexer/zkapi/v1/tree/root', {credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000)});
        network.textContent = response.ok
          ? 'Devnet RPC verified · indexed history available. The SDK checks each operation before signing.'
          : 'Devnet RPC verified · chain history is syncing. Preparing a proof may take a few minutes.';
        return response.ok;
      } catch { network.textContent = 'Devnet RPC verified · indexer unavailable. Keep this page and your saved state.'; return false; }
    };
    void (async () => { for (let attempt = 0; attempt < 30; attempt++) { if (await checkHistory()) break; await new Promise(resolve => setTimeout(resolve, 10_000)); } })();
  }
}
// web3 and the pinned SDK use the exact-pinned browser Buffer implementation.
Object.assign(globalThis, {Buffer});
void main().catch(() => {
  document.getElementById('status')!.textContent = 'The live devnet connection is unavailable. Your saved state is preserved. Restore the local services, then reload this same URL.';
  const network = document.getElementById('live-network-status'); if (network) network.textContent = 'Live connection unavailable. This page has not submitted a new transaction or AI request. Previously saved operations are preserved.';
});
