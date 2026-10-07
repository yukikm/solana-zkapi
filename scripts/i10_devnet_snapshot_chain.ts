/** Read-only acceptance deadlines around the existing private/common AUTH and
 * financial snapshot adapters. This wrapper never signs, sends or falls back. */
import type {WalletChain} from '../packages/sdk/src/wallet-chain.ts';
import type {SessionSnapshotSource} from '../packages/sdk/src/session-snapshot.ts';

export type DevnetSnapshotChain = WalletChain & Required<SessionSnapshotSource>
  & Required<Pick<WalletChain, 'bufferObservation'>>;
export interface SnapshotWaitStats {
  retries: number; calls: number; totalElapsedMs: number; maxElapsedMs: number; timeouts: number;
}
export function snapshotWaitStats(): SnapshotWaitStats {
  return {retries: 0, calls: 0, totalElapsedMs: 0, maxElapsedMs: 0, timeouts: 0};
}
export function boundedDevnetSnapshotChain(options: {
  chain: DevnetSnapshotChain;
  /** A fresh adapter whose indexer AND RPC reads use the supplied signal. */
  createReadChain(signal: AbortSignal): DevnetSnapshotChain;
  waitMs: number; stats: SnapshotWaitStats;
  retryMs?: number;
}): DevnetSnapshotChain {
  const {chain, waitMs, stats} = options, retryMs = options.retryMs ?? 500;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 1_800_000
    || !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 500) throw Error('bounded snapshot wait required');
  const retryable = new Set(['finalized indexer unavailable', 'RPC/indexer finalized cut changed; retry snapshot',
    'indexer snapshot identity', 'indexer transport', 'pinned service transport', 'untrusted indexer root']);
  async function read<T>(operation: (reader: DevnetSnapshotChain) => Promise<T>): Promise<T> {
    const started = performance.now(), deadline = started + waitMs, abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), waitMs); stats.calls++;
    try {
      const reader = options.createReadChain(abort.signal);
      while (performance.now() < deadline) {
        try {
          const value = await operation(reader);
          if (performance.now() >= deadline) break;
          return value;
        } catch (error) {
          if (abort.signal.aborted || performance.now() >= deadline) break;
          if (!(error instanceof Error) || !retryable.has(error.message)) throw error;
          stats.retries++;
        }
        const remaining = deadline - performance.now();
        if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(retryMs, remaining)));
      }
      stats.timeouts++;
      throw Error('coherent finalized indexer cut unavailable before acceptance wait deadline');
    } finally {
      clearTimeout(timer); abort.abort();
      const elapsed = Math.round(performance.now() - started);
      stats.totalElapsedMs += elapsed; stats.maxElapsedMs = Math.max(stats.maxElapsedMs, elapsed);
    }
  }
  return {
    snapshot: (noteId, path = 'active', minimumSlot = 0) => read(reader => reader.snapshot(noteId, path, minimumSlot)),
    sessionSnapshot: (noteId, prover, minimumSlot = 0) => read(reader => reader.sessionSnapshot(noteId, prover, minimumSlot)),
    buffer: chain.buffer.bind(chain),
    bufferObservation: chain.bufferObservation.bind(chain),
    blockhash: chain.blockhash.bind(chain),
  };
}
