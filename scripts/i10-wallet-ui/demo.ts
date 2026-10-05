/** Presentation only: one fixed sample projected from a slide index.
 * No wallet, SDK, storage, proof, receipt verification, financial state or network.
 * The existing live client owns every real operation. */
export const DEMO_PROMPT = 'zkAPIの仕組みを、一文で教えて。';
export const DEMO_RESPONSE = 'USDCを預けてAIを使い、利用料だけを払い、残りはウォレットへ戻せます。';
export const DEMO_DEPOSIT_MICRO_USDC = 1_000_000n;
export const DEMO_CHARGE_MICRO_USDC = 18n;
export type DemoPhase = 0 | 1 | 2 | 3 | 4;
export type DemoStepState = 'idle' | 'current' | 'done';
export type DemoNodeState = 'idle' | 'active' | 'done';

const PHASES = ['ready', 'deposited', 'responded', 'settled', 'withdrawn'] as const;
const COPY = [
  {
    title: '預けて、使って、残りを戻す。',
    description: 'まず1 USDCを預けます。その残高から、AIの利用料だけを支払う流れを見てみましょう。',
    next: '1 USDCを預ける',
    explanation: '表示はすべて固定サンプルです。実際の接続、送金、AIへのリクエストは行いません。',
    status: 'デモの準備ができました。入金から始められます。',
  },
  {
    title: '1 USDCを預けました。',
    description: '次はAIを利用します。支払える残高があることをZK証明で示し、利用する権限を得る流れです。',
    next: 'AIを使う',
    explanation: '利用権限の確認にZK証明を使います。プロンプト自体を隠す仕組みではなく、AIの提供元には内容が届きます。',
    status: '入金の表示が完了しました。次は利用権限の確認とAI利用です。',
  },
  {
    title: 'AIから返答が届きました。',
    description: '返答を受け取った段階では、まだ精算前です。利用量を確認してから料金を確定します。',
    next: '利用料を精算する',
    explanation: 'このサンプルの利用料は0.000018 USDCです。次のステップで、その金額だけを残高から差し引きます。',
    status: 'AIの返答サンプルを表示しました。料金はまだ精算していません。',
  },
  {
    title: '使った分だけ、精算しました。',
    description: '利用料は0.000018 USDC。残りの0.999982 USDCを、ウォレットへ戻せます。',
    next: '残りを引き出す',
    explanation: '実際の操作では、署名された利用明細と精算後の状態をSDKが検証してから出金へ進みます。ここでは表示例だけを示しています。',
    status: '0.000018 USDCの精算例を表示しました。残高は0.999982 USDCです。',
  },
  {
    title: '残りは、ウォレットへ。',
    description: '0.999982 USDCを戻して、4つのステップが完了しました。この例のUSDC利用料は0.000018 USDCです。',
    next: 'デモ完了',
    explanation: '送信済みか分からないAIリクエストは自動で再送しません。実際の画面では、保存済みの状態を使って確認と精算を進めます。',
    status: 'デモ完了。利用料0.000018 USDC、返却額0.999982 USDCです。',
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
    stepLabel: phase === 0 ? '4つのステップでわかる' : `${phase} / 4 ステップ完了`,
    prompt: DEMO_PROMPT,
    balanceMicro, paidMicro, returnedMicro, walletMicro,
    balance: demoAmount(balanceMicro), paid: demoAmount(paidMicro), returned: demoAmount(returnedMicro), walletBalance: demoAmount(walletMicro),
    response: phase >= 2 ? DEMO_RESPONSE : 'AIを利用すると、ここに返答のサンプルを表示します。',
    responseState: phase >= 2 ? '返答サンプル' : 'まだ利用していません',
    receiptState: settled ? '精算済みの表示例' : 'まだ精算していません',
    receiptBody: settled
      ? `預け入れ　${demoAmount(DEMO_DEPOSIT_MICRO_USDC)} USDC\n利用料　　${demoAmount(DEMO_CHARGE_MICRO_USDC)} USDC\n${phase === 4 ? '返却額' : '残高'}　　${demoAmount(remaining)} USDC\nこの表示はサンプルで、実際の署名済み明細ではありません。`
      : 'AIを利用した後、利用料と残高のサンプルをここに表示します。',
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
    auto.textContent = playing ? '一時停止' : '自動で見る';
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
    render('次のステップの表示に進んでいます。実際の操作は行っていません。');
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
    render('自動再生を一時停止しました。ボタンで続きから進められます。');
  }
  function restart() {
    if (disposed) return;
    clearTimers(); phase = 0; playing = false; busy = false; render();
  }
  function toggleAuto() {
    if (disposed || phase === 4) return;
    if (playing) { pause(); return; }
    playing = true; render('自動再生を開始しました。いつでも一時停止できます。');
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
