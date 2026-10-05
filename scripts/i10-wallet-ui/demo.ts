/** Presentation only: one fixed sample projected from a slide index.
 * No wallet, SDK, storage, proof, receipt verification, financial state or network.
 * The existing live client owns every real operation. */
export const DEMO_PROMPT = 'Explain zkAPI in one sentence.';
export const DEMO_RESPONSE = 'zkAPI lets you deposit USDC, use AI, pay for your usage, and withdraw the rest.';
export const DEMO_DEPOSIT_MICRO_USDC = 1_000_000n;
export const DEMO_CHARGE_MICRO_USDC = 18n;
export type DemoPhase = 0 | 1 | 2 | 3 | 4;
export type DemoStepState = 'idle' | 'current' | 'done';
export type DemoNodeState = 'idle' | 'active' | 'done';

const PHASES = ['ready', 'deposited', 'responded', 'settled', 'withdrawn'] as const;
const COPY = [
  {
    title: 'Deposit. Use AI. Get the rest back.',
    description: 'Start with 1 USDC. See how your balance pays for AI, one request at a time.',
    next: 'Deposit 1 USDC',
    explanation: 'This walkthrough uses fixed examples. No wallet connection, transfers, or AI requests.',
    status: 'Ready to begin. Start with a deposit.',
  },
  {
    title: '1 USDC, ready to use.',
    description: 'Next, use AI. A ZK proof shows you have enough funds and permission to make the request.',
    next: 'Use AI',
    explanation: 'ZK proves your right to use the API. Your prompt is still visible to the AI provider.',
    status: 'Sample deposit complete. Next: use AI.',
  },
  {
    title: 'Your AI response is here.',
    description: 'The response has arrived. The fee is finalized after usage is recorded.',
    next: 'Settle usage',
    explanation: 'The sample fee is 0.000018 USDC. The next step deducts that amount from your balance.',
    status: 'Sample response shown. The fee is not settled yet.',
  },
  {
    title: 'Pay only for what you used.',
    description: 'The fee is 0.000018 USDC. Your remaining 0.999982 USDC is ready to withdraw.',
    next: 'Withdraw the rest',
    explanation: 'In the live app, your client verifies the signed receipt and updated balance before withdrawal. This receipt is a sample.',
    status: 'Sample fee settled: 0.000018 USDC. Remaining: 0.999982 USDC.',
  },
  {
    title: 'The rest is back in your wallet.',
    description: 'All four steps are complete. You paid 0.000018 USDC and got 0.999982 USDC back in this example.',
    next: 'Demo complete',
    explanation: 'If an AI request has an unknown outcome, the live app checks the saved request and settles it without automatically sending it again.',
    status: 'Demo complete. Paid: 0.000018 USDC. Returned: 0.999982 USDC.',
  },
] as const;

/** Exact six-decimal display; no floating-point currency calculations. */
export function demoAmount(micro: bigint): string {
  if (micro < 0n) throw new RangeError('Demo amount must be nonnegative');
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
}

export function demoView(phase: DemoPhase) {
  if (!Number.isInteger(phase) || phase < 0 || phase > 4) throw new RangeError('Invalid demo phase');
  const settled = phase >= 3;
  const remaining = DEMO_DEPOSIT_MICRO_USDC - DEMO_CHARGE_MICRO_USDC;
  const balanceMicro = phase === 0 || phase === 4 ? 0n : settled ? remaining : DEMO_DEPOSIT_MICRO_USDC;
  const paidMicro = settled ? DEMO_CHARGE_MICRO_USDC : 0n;
  const returnedMicro = phase === 4 ? remaining : 0n;
  const walletMicro = phase === 0 ? DEMO_DEPOSIT_MICRO_USDC : returnedMicro;
  const steps: DemoStepState[] = Array.from({length: 4}, (_, index) => index < phase ? 'done' : index === phase ? 'current' : 'idle');
  const nodes: Record<'wallet' | 'vault' | 'provider' | 'receipt', DemoNodeState> = {
    wallet: phase === 0 || phase === 4 ? 'active' : 'done',
    vault: phase === 1 || phase === 3 ? 'active' : phase > 0 ? 'done' : 'idle',
    provider: phase === 1 ? 'active' : phase >= 2 ? 'done' : 'idle',
    receipt: phase === 2 ? 'active' : settled ? 'done' : 'idle',
  };
  return {
    phase, phaseName: PHASES[phase], ...COPY[phase], steps, nodes,
    stepLabel: phase === 0 ? 'FOUR SIMPLE STEPS' : `${phase} / 4 STEPS COMPLETE`,
    prompt: DEMO_PROMPT,
    balanceMicro, paidMicro, returnedMicro, walletMicro,
    balance: demoAmount(balanceMicro), paid: demoAmount(paidMicro), returned: demoAmount(returnedMicro), walletBalance: demoAmount(walletMicro),
    response: phase >= 2 ? DEMO_RESPONSE : 'Your sample AI response will appear here.',
    responseState: phase >= 2 ? 'Sample response' : 'Not sent',
    receiptState: settled ? 'Settled (sample)' : 'Not settled',
    receiptBody: settled
      ? `Deposit: ${demoAmount(DEMO_DEPOSIT_MICRO_USDC)} USDC\nUsage fee: ${demoAmount(DEMO_CHARGE_MICRO_USDC)} USDC\n${phase === 4 ? 'Returned' : 'Remaining'}: ${demoAmount(remaining)} USDC\nSample only. This is not a signed receipt.`
      : 'Your sample usage fee and remaining balance will appear here.',
  };
}

/** Only the presentation phase is mutable. Reset never touches live journals. */
export function mountDemo(document: Document) {
  const element = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing demo element: ${id}`);
    return node as T;
  };
  const next = element<HTMLButtonElement>('demo-next');
  const reset = element<HTMLButtonElement>('demo-reset');
  const auto = element<HTMLButtonElement>('demo-auto');
  const workspace = element('demo-workspace');
  const status = element('demo-status');
  const window = document.defaultView;
  if (!window) throw new Error('Demo document requires a window');
  let phase: DemoPhase = 0, playing = false, busy = false, disposed = false, generation = 0;
  const timers = new Set<number>();
  const clearTimers = () => { generation++; for (const id of timers) window.clearTimeout(id); timers.clear(); };
  const later = (callback: () => void, ms: number) => {
    const current = generation;
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!disposed && current === generation) callback();
    }, ms);
    timers.add(id);
  };
  const setText = (id: string, text: string) => { element(id).textContent = text; };
  function render(message?: string) {
    const view = demoView(phase);
    workspace.dataset.phase = view.phaseName;
    workspace.dataset.busy = String(busy);
    for (const [id, value] of Object.entries({
      'demo-step-label': view.stepLabel, 'demo-title': view.title, 'demo-description': view.description,
      'demo-next-label': view.next, 'demo-balance': view.balance, 'demo-paid': view.paid,
      'demo-returned': view.returned, 'demo-wallet-balance': view.walletBalance,
      'demo-response': view.response, 'demo-response-state': view.responseState,
      'demo-receipt-state': view.receiptState, 'demo-receipt-body': view.receiptBody,
      'demo-explanation': view.explanation,
    })) setText(id, value);
    status.textContent = message ?? view.status;
    status.setAttribute('role', 'status');
    workspace.setAttribute('aria-busy', String(busy));
    next.disabled = busy || phase === 4;
    auto.disabled = phase === 4;
    auto.setAttribute('aria-pressed', String(playing));
    auto.textContent = playing ? 'Pause' : 'Autoplay';
    for (const [index, state] of view.steps.entries()) {
      const node = document.querySelector<HTMLElement>(`[data-demo-step="${index}"]`);
      if (!node) continue;
      node.dataset.state = state;
      if (state === 'current') node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    }
    for (const [name, state] of Object.entries(view.nodes)) {
      const node = document.querySelector<HTMLElement>(`[data-demo-node="${name}"]`);
      if (node) node.dataset.state = state;
    }
  }
  function scheduleNext() {
    if (playing && phase < 4 && !busy) later(advance, 2400);
  }
  function advance() {
    if (disposed || busy || phase === 4) return;
    clearTimers(); busy = true;
    render('Showing the next step. No real transaction is taking place.');
    const reduced = window!.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    later(() => {
      phase = (phase + 1) as DemoPhase; busy = false;
      if (phase === 4) playing = false;
      render(); scheduleNext();
    }, reduced ? 0 : 300);
  }
  function pause() {
    if (disposed) return;
    clearTimers(); playing = false; busy = false;
    render('Paused. Continue at your own pace.');
  }
  function restart() {
    if (disposed) return;
    clearTimers(); phase = 0; playing = false; busy = false; render();
  }
  function toggleAuto() {
    if (disposed || phase === 4) return;
    if (playing) { pause(); return; }
    playing = true; render('Autoplay started. You can pause at any time.');
    if (!busy) advance();
  }
  next.addEventListener('click', advance);
  reset.addEventListener('click', restart);
  auto.addEventListener('click', toggleAuto);
  render();
  return {
    advance, pause, reset: restart,
    get state() { return {phase, playing, busy}; },
    dispose() {
      if (disposed) return;
      clearTimers(); disposed = true;
      next.removeEventListener('click', advance); reset.removeEventListener('click', restart); auto.removeEventListener('click', toggleAuto);
    },
  };
}
