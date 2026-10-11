/** Private frontend acknowledgement. This marker owns no financial state;
 * the SDK callback still checks the original operation and durable hold. */
import { randomUUID } from 'node:crypto';

export const gatewayDeliveryHeader = 'x-zkapi-frontend-delivery';
export const gatewayDeliveryPath = '/zkapi/_frontend-delivery';

export class FrontendDelivery {
  private pending?: { token: string; ready: Promise<boolean>; finish(success: boolean): void; confirm(): Promise<void>; timer: NodeJS.Timeout; acknowledging: boolean; settled: Promise<void>; settle(): void };

  register(confirm: () => Promise<void>): { token: string; finish(success: boolean): void } {
    // The shared journal allows one unsettled gateway delivery per note.
    // An explicit recovery/new operation discards an obsolete in-memory marker.
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.finish(false); this.pending.settle(); }
    let finish!: (success: boolean) => void;
    const ready = new Promise<boolean>(resolve => { finish = resolve; });
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const token = randomUUID();
    const timer = setTimeout(() => {
      if (this.pending?.token === token) this.pending = undefined;
      finish(false);
      settle();
    }, 900_000);
    timer.unref();
    this.pending = { token, ready, finish, confirm, timer, acknowledging: false, settled, settle };
    return { token, finish };
  }

  async acknowledge(token: string): Promise<boolean> {
    const pending = this.pending;
    if (!pending || token !== pending.token || pending.acknowledging) return false;
    // Acknowledge at most once, and tolerate the frontend EOF racing the
    // runtime's successful finish notification without confirming early.
    pending.acknowledging = true;
    try {
      if (!await pending.ready) return false;
      await pending.confirm();
      return true;
    } finally {
      clearTimeout(pending.timer);
      if (this.pending === pending) this.pending = undefined;
      pending.settle();
    }
  }

  async waitForAcknowledgement(signal?: AbortSignal, timeoutMs = 1000): Promise<void> {
    signal?.throwIfAborted();
    const pending = this.pending;
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    const abort = () => finish();
    let finish!: () => void;
    const bounded = new Promise<void>(resolve => {
      finish = resolve;
      timer = setTimeout(resolve, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([pending.settled, bounded]); signal?.throwIfAborted(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
