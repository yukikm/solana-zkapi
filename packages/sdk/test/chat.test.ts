import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatDeltas, readChatText, ChatResponseError } from '../src/chat.ts';
const encode = (s: string) => new TextEncoder().encode(s);
function chunks(bytes: Uint8Array, split: number, type = 'text/event-stream') {
  let cancelled = false;
  return { response: new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); }, cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': type, 'X-Zkapi-Operation-Id': 'test-operation' } }), cancelled: () => cancelled };
}
async function text(response: Response) { let result = ''; for await (const part of readChatDeltas(response)) result += part; return result; }
test('Chat SSE accepts UTF-8, comments, CRLF splits, usage events and multiline data at every byte boundary', async () => {
  const sse = ': comment\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"日本語"}}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n';
  const bytes = encode(sse);
  for (let i = 0; i <= bytes.length; i++) assert.equal(await text(chunks(bytes, i).response), '日本語');
});
test('SSE rejects truncated streams, provider errors, bad UTF-8 and oversized frames', async () => {
  for (const bytes of [encode('data: {"choices":[]}\n\n'), encode('data: [DONE]'), encode('data: {"error":{"message":"PRIVATE"}}\n\n'), Uint8Array.of(255), encode('data: ' + 'x'.repeat(1024 * 1024 + 1))]) {
    await assert.rejects(text(chunks(bytes, 1).response), e => e instanceof ChatResponseError && !e.message.includes('PRIVATE'));
  }
});
test('SSE accepts CR-only event endings, including a final CR at EOF', async () => {
  const bytes = encode('data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r');
  for (let split = 0; split <= bytes.length; split++) assert.equal(await text(chunks(bytes, split).response), 'answer');
});
test('breaking delta iteration cancels unread response; HTTP errors are bounded and redacted', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(encode('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  for await (const delta of readChatDeltas(response)) { assert.equal(delta, 'a'); break; }
  assert.equal(cancelled, true);
  await assert.rejects(readChatText(new Response('secret provider error', { status: 502 })), e => e instanceof ChatResponseError && e.code === 'http_error' && !e.message.includes('secret'));
});
test('text helper accepts one text choice and refuses tool-only, malformed and oversized responses', async () => {
  assert.equal(await readChatText(Response.json({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] })), 'answer');
  for (const body of [{ choices: [] }, { choices: [{ message: { content: null, tool_calls: [] } }] }, { error: 'secret' }]) await assert.rejects(readChatText(Response.json(body)), ChatResponseError);
  await assert.rejects(readChatText(new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })), ChatResponseError);
});
test('reader and cancellation failures never expose private errors from text or SSE helpers', async () => {
  for (const [type, consume] of [['application/json', readChatText], ['text/event-stream', text]] as const) {
    for (const brokenRead of [true, false]) {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (brokenRead) controller.error(new Error('PRIVATE upstream failure'));
          else controller.enqueue(encode(type === 'application/json' ? 'x'.repeat(4 * 1024 * 1024 + 1) : 'data: invalid\n\n'));
        },
        cancel() { throw new Error('PRIVATE cancellation failure'); },
      }), { headers: { 'Content-Type': type, 'X-Zkapi-Operation-Id': 'failed-operation' } });
      await assert.rejects(consume(response), error => error instanceof ChatResponseError
        && error.code === 'invalid_response' && error.operationId === 'failed-operation' && !error.message.includes('PRIVATE'));
      assert.equal(response.body!.locked, false);
    }
  }
  const response = new Response(new ReadableStream({ cancel() { throw new Error('PRIVATE HTTP cancellation failure'); } }), { status: 502 });
  await assert.rejects(readChatText(response), error => error instanceof ChatResponseError && error.code === 'http_error');
});
test('SSE cancellation failures after DONE or early exit are redacted', async () => {
  for (const earlyExit of [false, true]) {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encode(earlyExit
        ? 'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n' : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); },
      cancel() { throw new Error('PRIVATE cancellation failure'); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    const consume = async () => { for await (const delta of readChatDeltas(response)) { assert.equal(delta, 'answer'); if (earlyExit) break; } };
    await assert.rejects(consume(), error => error instanceof ChatResponseError && error.code === 'invalid_response');
    assert.equal(response.body!.locked, false);
  }
});

test('text helpers refuse tool calls mixed with text and missing or unsupported terminal reasons', async () => {
  for (const message of [
    { content: 'partial answer', tool_calls: [{ id: 'call', function: { arguments: 'PRIVATE' } }] },
    { content: 'partial answer', function_call: { arguments: 'PRIVATE' } },
  ]) {
    await assert.rejects(readChatText(Response.json({ choices: [{ message, finish_reason: 'stop' }] })), ChatResponseError);
    const source = `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    await assert.rejects(text(chunks(encode(source), 1).response), ChatResponseError);
  }
  for (const finish_reason of [undefined, 'tool_calls', 'function_call', 'unknown']) {
    await assert.rejects(readChatText(Response.json({ choices: [{ message: { content: 'partial answer' }, finish_reason }] })), ChatResponseError);
    const source = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason }] })}\n\ndata: [DONE]\n\n`;
    await assert.rejects(text(chunks(encode(source), 1).response), ChatResponseError);
  }
  for (const finish_reason of ['stop', 'length', 'content_filter']) {
    assert.equal(await readChatText(Response.json({ choices: [{ message: { content: 'answer' }, finish_reason }] })), 'answer');
  }
});

test('SSE requires a terminal choice before DONE and rejects content after a terminal choice', async () => {
  for (const source of ['data: [DONE]\n\n', 'data: {"choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n']) {
    await assert.rejects(text(chunks(encode(source), 1).response), e => e instanceof ChatResponseError && e.code === 'incomplete_stream');
  }
  const source = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n';
  await assert.rejects(text(chunks(encode(source), 1).response), ChatResponseError);
});
