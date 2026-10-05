/** Presentation-only tests. Synthetic DOM/timers; no live wallet/browser claim. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoAmount, demoView, mountDemo, DEMO_RESPONSE, type DemoPhase} from './demo.ts';

test('fixed demo projections conserve integer USDC and charge only on settlement', () => {
  const expected = [
    [0n, 0n, 0n, 1_000_000n],
    [1_000_000n, 0n, 0n, 0n],
    [1_000_000n, 0n, 0n, 0n],
    [999_982n, 18n, 0n, 0n],
    [0n, 18n, 999_982n, 999_982n],
  ];
  for (let index = 0; index < expected.length; index++) {
    const view = demoView(index as DemoPhase);
    assert.deepEqual([view.balanceMicro, view.paidMicro, view.returnedMicro, view.walletMicro], expected[index]);
    assert.equal(view.balanceMicro + view.paidMicro + view.walletMicro, 1_000_000n);
    assert.equal(view.steps.filter(step => step === 'current').length, index === 4 ? 0 : 1);
    assert.equal(view.steps.filter(step => step === 'done').length, Math.min(index, 4));
    assert.equal(view.response === DEMO_RESPONSE, index >= 2);
    assert.match(view.receiptBody, index >= 3 ? /Sample only\. This is not a signed receipt\./ : /sample/);
  }
  assert.equal(demoView(3).paid, '0.000018');
  assert.equal(demoView(4).returned, '0.999982');
  assert.equal(demoAmount(1n), '0.000001');
  assert.equal(demoAmount(1_000_000n), '1.000000');
  assert.throws(() => demoAmount(-1n));
  for (const bad of [-1, 5, 1.5, Number.NaN]) assert.throws(() => demoView(bad as DemoPhase));
});

class Element {
  textContent = ''; disabled = false; dataset: Record<string, string> = {};
  attributes = new Map<string, string>(); listeners = new Map<string, Set<() => void>>();
  set innerHTML(_value: string) { throw Error('HTML insertion is forbidden in the demo controller'); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  addEventListener(name: string, callback: () => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
  }
  removeEventListener(name: string, callback: () => void) { this.listeners.get(name)?.delete(callback); }
  click() { if (!this.disabled) for (const callback of this.listeners.get('click') ?? []) callback(); }
}
function fixture(reduced = false) {
  const ids = ['demo-next', 'demo-reset', 'demo-auto', 'demo-workspace', 'demo-status', 'demo-step-label', 'demo-title',
    'demo-description', 'demo-next-label', 'demo-balance', 'demo-paid', 'demo-returned', 'demo-wallet-balance',
    'demo-response', 'demo-response-state', 'demo-receipt-state', 'demo-receipt-body', 'demo-explanation'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const steps = Array.from({length: 4}, () => new Element());
  const nodes = Object.fromEntries(['wallet', 'vault', 'provider', 'receipt'].map(name => [name, new Element()]));
  const timers = new Map<number, {callback: () => void; ms: number}>(); let nextId = 0;
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      const step = selector.match(/^\[data-demo-step="([0-3])"\]$/);
      return step ? steps[Number(step[1])] : nodes[selector.match(/^\[data-demo-node="([a-z]+)"\]$/)?.[1] ?? ''] ?? null;
    },
    defaultView: {
      setTimeout(callback: () => void, ms: number) { const id = ++nextId; timers.set(id, {callback, ms}); return id; },
      clearTimeout(id: number) { timers.delete(id); },
      matchMedia() { return {matches: reduced}; },
      get localStorage() { throw Error('live storage access forbidden'); },
      get indexedDB() { throw Error('live journal access forbidden'); },
      fetch() { throw Error('network access forbidden'); },
    },
  } as unknown as Document;
  const controller = mountDemo(document);
  const element = (id: string) => elements.get(id)!;
  const nextTimer = () => { const next = timers.entries().next().value; assert.ok(next); return next; };
  const runTimer = () => { const [id, timer] = nextTimer(); timers.delete(id); timer.callback(); };
  return {controller, element, steps, timers, nextTimer, runTimer};
}

test('manual next is single-step, and reset fences an already queued transition', () => {
  const f = fixture();
  assert.equal(f.steps[0].attributes.get('aria-current'), 'step');
  f.element('demo-next').click(); f.controller.advance();
  assert.equal(f.timers.size, 1); assert.equal(f.controller.state.busy, true);
  assert.equal(f.element('demo-next').disabled, true);
  const stale = f.nextTimer()[1].callback;
  f.element('demo-reset').click(); stale();
  assert.deepEqual(f.controller.state, {phase: 0, playing: false, busy: false});
  assert.equal(f.timers.size, 0); assert.equal(f.element('demo-paid').textContent, '0.000000');
  f.element('demo-next').click(); f.runTimer();
  assert.equal(f.controller.state.phase, 1);
  assert.equal(f.steps[0].attributes.has('aria-current'), false);
  assert.equal(f.steps[1].attributes.get('aria-current'), 'step');
  assert.equal(f.element('demo-workspace').dataset.phase, 'deposited');
  f.controller.dispose();
});

test('autoplay pauses without stale progress, then finishes once and disposes timers', () => {
  const f = fixture(true);
  f.element('demo-auto').click();
  assert.equal(f.nextTimer()[1].ms, 0, 'reduced motion removes the transition delay');
  f.runTimer(); assert.equal(f.controller.state.phase, 1);
  const stale = f.nextTimer()[1].callback;
  f.element('demo-auto').click(); stale();
  assert.deepEqual(f.controller.state, {phase: 1, playing: false, busy: false});
  assert.equal(f.timers.size, 0);
  assert.equal(f.element('demo-auto').attributes.get('aria-pressed'), 'false');
  f.element('demo-auto').click();
  for (let count = 0; f.timers.size && count < 10; count++) f.runTimer();
  assert.deepEqual(f.controller.state, {phase: 4, playing: false, busy: false});
  assert.equal(f.element('demo-paid').textContent, '0.000018');
  assert.equal(f.element('demo-returned').textContent, '0.999982');
  f.controller.advance(); assert.equal(f.controller.state.phase, 4); assert.equal(f.timers.size, 0);
  f.element('demo-reset').click(); f.element('demo-auto').click();
  const afterDispose = f.nextTimer()[1].callback;
  f.controller.dispose(); afterDispose(); f.element('demo-next').click();
  assert.equal(f.controller.state.phase, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.element('demo-next').listeners.get('click')!.size, 0);
});
