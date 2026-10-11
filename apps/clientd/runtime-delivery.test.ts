import test from 'node:test';
import assert from 'node:assert/strict';
import { FrontendDelivery } from './runtime-delivery.ts';

test('Unix response finish alone never confirms delivery; private frontend ack does', async () => {
  const state = new FrontendDelivery(); let confirmed = 0;
  const delivery = state.register(async () => { confirmed++; });
  delivery.finish(true);
  assert.equal(confirmed, 0);
  assert.equal(await state.acknowledge('spoofed'), false);
  assert.equal(await state.acknowledge(delivery.token), true);
  assert.equal(confirmed, 1);
  assert.equal(await state.acknowledge(delivery.token), false);
});

test('early acknowledgement waits for carrier completion and rejects a failed copy', async () => {
  for (const success of [false, true]) {
    const state = new FrontendDelivery(); let confirmed = 0;
    const delivery = state.register(async () => { confirmed++; });
    const acknowledgement = state.acknowledge(delivery.token);
    await Promise.resolve(); assert.equal(confirmed, 0);
    delivery.finish(success);
    assert.equal(await acknowledgement, success);
    assert.equal(confirmed, Number(success));
  }
});

test('obsolete delivery token cannot confirm a later operation', async () => {
  const state = new FrontendDelivery(); let confirmed = 0;
  const old = state.register(async () => { throw Error('obsolete operation'); });
  const current = state.register(async () => { confirmed++; });
  old.finish(true); current.finish(true);
  assert.equal(await state.acknowledge(old.token), false);
  assert.equal(await state.acknowledge(current.token), true);
  assert.equal(confirmed, 1);
});

test('a sequential request waits through the acknowledgement journal save', async () => {
  const state = new FrontendDelivery(); let saved!: () => void; let next = false;
  const saving = new Promise<void>(resolve => { saved = resolve; });
  const delivery = state.register(() => saving); delivery.finish(true);
  const waiting = state.waitForAcknowledgement().then(() => { next = true; });
  const acknowledged = state.acknowledge(delivery.token);
  await Promise.resolve(); assert.equal(next, false);
  saved(); await acknowledged; await waiting; assert.equal(next, true);
});

test('an absent acknowledgement wait expires without confirming and respects cancellation', async () => {
  const state = new FrontendDelivery(); let confirmed = 0;
  const delivery = state.register(async () => { confirmed++; }); delivery.finish(true);
  await state.waitForAcknowledgement(undefined, 1); assert.equal(confirmed, 0);
  const canceled = new AbortController();
  const waiting = state.waitForAcknowledgement(canceled.signal); canceled.abort();
  await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(confirmed, 0);
  await state.acknowledge(delivery.token);
});
