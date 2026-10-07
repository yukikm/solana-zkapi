import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRequest, ClientStatus } from '@zkapi/solana-sdk';
import { Conversation, canLeaveNote, formatUsdc, microUsdc, privacyNotice } from './chat-model.ts';

function status(canRequest = true): ClientStatus {
  return { noteId: 'test-note', mode: 'proxy', wallet: 'active', settledBalanceMicroUsdc: '2000000', authorizationCapMicroUsdc: '1000000',
    canRequest, canReconcileUnacceptedAuthorization: false, canPrepareEmergencyEscape: false, canReconcileChallengedEscape: false, emergencyEscape: null,
    busy: false, session: null, walletOperation: null, expiry: { severity: 'normal', message: 'fixture' }, lastSettlement: null, privacyNotice: 'fixture' };
}
const answer = (text: string) => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const input = { model: 'configured-model', text: 'hello', maxOutputTokens: 100, stream: false };

test('USDC input is exact integer arithmetic and rejects rounding, exponent and negative inputs', () => {
  assert.equal(microUsdc('9007199254.740993'), '9007199254740993');
  assert.equal(microUsdc('0.000001'), '1');
  assert.equal(formatUsdc('9007199254740993'), '9007199254.740993');
  for (const value of ['0', '-1', '1e6', '0.0000001', '1.', '.1', 'NaN', '18446744073709.551616']) assert.throws(() => microUsdc(value));
});
test('only completed turns become future context; each explicit send gets one distinct operation ID', async () => {
  const conversation = new Conversation(), calls: ChatRequest[] = [];
  const client = { status: async () => status(), chat: async (request: ChatRequest) => { calls.push(request); return answer(calls.length === 1 ? '<img src=x>' : 'second'); } };
  await conversation.send(client, input);
  await conversation.send(client, { ...input, text: 'follow-up', model: 'other-configured-model' });
  assert.equal(calls.length, 2); assert.notEqual(calls[0].operationId, calls[1].operationId);
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '<img src=x>' }, { role: 'user', content: 'follow-up' }]);
  assert.equal(conversation.turns[1].outcome, 'complete');
  assert.equal(calls[1].model, 'other-configured-model');
});
test('uncertain inference is not replayed and incomplete content is excluded from the next explicit send', async () => {
  const conversation = new Conversation(), calls: ChatRequest[] = [];
  let fail = true;
  const client = { status: async () => status(), chat: async (request: ChatRequest) => { calls.push(request); if (fail) throw new Error('SECRET_PROVIDER_ERROR'); return answer('ok'); } };
  await assert.rejects(conversation.send(client, input), error => error instanceof Error && !error.message.includes('SECRET_PROVIDER_ERROR'));
  assert.equal(calls.length, 1); assert.equal(conversation.turns[0].outcome, 'interrupted');
  fail = false; await conversation.send(client, { ...input, text: 'new request' });
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: 'new request' }]);
  assert.notEqual(calls[0].operationId, calls[1].operationId);
});
test('a truncated SSE answer is visible as interrupted and never reused as conversation context', async () => {
  const conversation = new Conversation(), calls: ChatRequest[] = [];
  const client = { status: async () => status(), chat: async (request: ChatRequest) => {
    calls.push(request);
    return calls.length === 1
      ? new Response('data: {"choices":[{"index":0,"delta":{"content":"partial answer"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : answer('new answer');
  } };
  await assert.rejects(conversation.send(client, { ...input, stream: true }), /did not complete/);
  assert.equal(conversation.turns[0].assistant, 'partial answer');
  assert.equal(conversation.turns[0].outcome, 'interrupted');
  await conversation.send(client, { ...input, text: 'separate explicit request' });
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: 'separate explicit request' }]);
  assert.equal(calls.length, 2);
});
test('pending or expired status prevents inference even with a stale presentation state', async () => {
  let calls = 0; const conversation = new Conversation();
  await assert.rejects(conversation.send({ status: async () => status(false), chat: async () => { calls++; return answer('forbidden'); } }, input));
  assert.equal(calls, 0); assert.equal(conversation.turns.length, 0); assert.equal(conversation.busy, false);
  assert.equal(canLeaveNote(status(false)), false);
  assert.equal(canLeaveNote({ ...status(false), wallet: 'closed' }), true);
  assert.equal(canLeaveNote({ ...status(false), wallet: 'closed', session: { id: 'saved', phase: 'closing', operations: [] } }), false);
});
test('cancel holds the conversation lock through delayed response cleanup and never dispatches a second request', async () => {
  const conversation = new Conversation();
  let calls = 0, cleanupStarted = false, release!: () => void, streamController!: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const encode = new TextEncoder();
  const client = { status: async () => status(), chat: async (request: ChatRequest) => {
    calls++;
    request.signal!.addEventListener('abort', () => streamController.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n')));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')); },
      async cancel() { cleanupStarted = true; await cleanup; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } };
  const running = conversation.send(client, { ...input, stream: true });
  const rejection = assert.rejects(running, /cancelled/);
  for (let i = 0; i < 20 && !conversation.turns[0]?.assistant; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(conversation.turns[0].assistant, 'partial'); conversation.cancel();
  for (let i = 0; i < 20 && !cleanupStarted; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupStarted, true); assert.equal(conversation.busy, true);
  await assert.rejects(conversation.send(client, input), /already in progress/); assert.throws(() => conversation.clear());
  assert.equal(calls, 1); release(); await rejection;
  assert.equal(conversation.busy, false); assert.equal(conversation.turns[0].outcome, 'interrupted');
  assert.equal(conversation.turns[0].assistant, 'partial');
});
test('privacy copy distinguishes operator content visibility from direct provider usage and metadata', () => {
  assert.match(privacyNotice('proxy'), /proxy operator.*read your prompts/);
  for (const mode of ['direct_oa', 'direct_openrouter'] as const) {
    assert.match(privacyNotice(mode), /operator issues credentials and settles provider-reported usage/);
    assert.match(privacyNotice(mode), /does not hide your IP/);
  }
});
