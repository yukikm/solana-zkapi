import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeResponseError, readNativeDeltas, readNativeText, type NativeApi} from './native-responses.ts';

const responseBody = (text = 'Hello 世界') => ({status: 'completed', output: [
  {type: 'reasoning', summary: []}, {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]},
]});
const messageBody = (text = 'Hello 世界') => ({type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{type: 'text', text}]});
const frame = (type: string, fields = {}, newline = '\n') => `event: ${type}${newline}data: ${JSON.stringify({type, ...fields})}${newline}${newline}`;
const responses = (newline = '\n') => frame('response.created', {response: {status: 'in_progress'}}, newline)
  + frame('response.output_text.delta', {delta: 'Hello 世界'}, newline)
  + frame('response.completed', {response: responseBody()}, newline);
const messages = (newline = '\n') => frame('ping', {}, newline)
  + frame('message_start', {message: {type: 'message', role: 'assistant', content: []}}, newline)
  + frame('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}, newline)
  + frame('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'Hello 世界'}}, newline)
  + frame('content_block_stop', {index: 0}, newline)
  + frame('message_delta', {usage: {output_tokens: 3}}, newline)
  + frame('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 5}}, newline)
  + frame('message_stop', {}, newline);
function stream(source: string, split?: number) {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({start(controller) {
    if (split !== undefined) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); }
    else controller.enqueue(bytes);
    controller.close();
  }}), {headers: {'Content-Type': 'text/event-stream'}});
}
async function consume(response: Response, api: NativeApi) { let text = ''; for await (const delta of readNativeDeltas(response, api)) text += delta; return text; }
function redacted(error: unknown) {
  assert.ok(error instanceof NativeResponseError);
  assert.doesNotMatch(error.message, /PRIVATE|provider credential|hidden prompt/); return true;
}

test('native JSON text readers normalize Responses and Anthropic text without trusting usage', async () => {
  assert.equal(await readNativeText(Response.json({...responseBody(), usage: {cost: 'not billing'}}), 'responses'), 'Hello 世界');
  assert.equal(await readNativeText(Response.json(messageBody()), 'messages'), 'Hello 世界');
  assert.equal(await readNativeText(Response.json({...messageBody('Cannot help.'), stop_reason: 'refusal'}), 'messages'), 'Cannot help.');
  assert.equal(await readNativeText(Response.json({status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'refusal', refusal: 'Cannot help.'}]}]}), 'responses'), 'Cannot help.');
});

test('native JSON rejects provider errors, partial Responses and unsupported tool output with redacted errors', async () => {
  for (const [api, value] of [
    ['responses', {...responseBody(), status: 'incomplete'}], ['responses', {...responseBody(), error: {message: 'PRIVATE hidden prompt'}}],
    ['responses', {status: 'completed', output: [{type: 'function_call', arguments: 'PRIVATE'}]}],
    ['messages', {...messageBody(), stop_reason: 'tool_use'}],
    ['messages', {...messageBody(), content: [{type: 'tool_use', input: 'PRIVATE'}]}],
  ] as const) await assert.rejects(readNativeText(Response.json(value), api), redacted);
});

test('both native SSE readers handle every byte split, UTF-8 and CR/CRLF termination', async () => {
  for (const [api, build] of [['responses', responses], ['messages', messages]] as const) {
    for (const newline of ['\n', '\r', '\r\n']) {
      const text = build(newline), length = new TextEncoder().encode(text).length;
      for (let split = 0; split <= length; split++) assert.equal(await consume(stream(text, split), api), 'Hello 世界', `${api}:${JSON.stringify(newline)}:${split}`);
    }
  }
});

test('terminal native events are mandatory; a Chat Completions DONE marker is insufficient', async () => {
  for (const api of ['responses', 'messages'] as const) {
    await assert.rejects(consume(stream('data: [DONE]\n\n'), api), redacted);
    await assert.rejects(consume(stream(''), api), (error: unknown) => error instanceof NativeResponseError && error.code === 'incomplete_stream');
  }
  await assert.rejects(consume(stream(frame('response.output_text.delta', {delta: 'partial'})), 'responses'), /Inspect saved SDK status/);
  await assert.rejects(consume(stream(messages().replace(frame('message_stop'), '')), 'messages'), /Inspect saved SDK status/);
});

test('Responses completion must agree with displayed deltas and rejects failed/incomplete events', async () => {
  for (const terminal of [
    frame('response.completed', {response: responseBody('different')}),
    frame('response.failed', {response: {error: 'PRIVATE'}}),
    frame('response.incomplete', {response: {...responseBody(), status: 'incomplete'}}),
  ]) await assert.rejects(consume(stream(frame('response.output_text.delta', {delta: 'partial'}) + terminal), 'responses'), redacted);
  await assert.rejects(consume(stream(frame('response.output_item.added', {item: {type: 'function_call', arguments: 'PRIVATE'}})), 'responses'), redacted);
});

test('Anthropic block order and terminal reason must complete before a turn is retained', async () => {
  for (const source of [
    messages().replace('"index":0,"delta"', '"index":1,"delta"'),
    messages().replace(frame('content_block_stop', {index: 0}), ''),
    messages().replace('"stop_reason":"end_turn"', '"stop_reason":"tool_use"'),
    messages().replace('"type":"text_delta"', '"type":"input_json_delta"'),
    frame('message_stop'),
  ]) await assert.rejects(consume(stream(source), 'messages'), redacted);
});

test('provider error frames and event type mismatches never expose their payloads', async () => {
  for (const api of ['responses', 'messages'] as const) {
    await assert.rejects(consume(stream(frame('error', {error: {message: 'PRIVATE provider credential'}})), api), redacted);
    await assert.rejects(consume(stream('event: error\ndata: {"type":"ping","message":"PRIVATE"}\n\n'), api), redacted);
  }
});

test('early stream exit awaits cancellation, including a delayed SDK settlement attempt', async () => {
  let cancelled = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame('response.output_text.delta', {delta: 'one'}))); },
    async cancel() { cancelled = true; await pending; },
  }), {headers: {'Content-Type': 'text/event-stream'}});
  const reader = readNativeDeltas(response, 'responses');
  assert.deepEqual(await reader.next(), {done: false, value: 'one'});
  let finished = false; const stopped = reader.return(undefined).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true); assert.equal(finished, false);
  release(); await stopped; assert.equal(finished, true);
});

test('HTTP rejection, decode failures and cleanup failures stay redacted', async () => {
  await assert.rejects(readNativeText(new Response('PRIVATE', {status: 503}), 'messages'), error => error instanceof NativeResponseError && error.code === 'http_error');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0xff])); },
    cancel() { throw new Error('PRIVATE cleanup secret'); },
  }), {headers: {'Content-Type': 'application/json'}});
  await assert.rejects(readNativeText(response, 'responses'), redacted);
  const broken = new Response(new ReadableStream<Uint8Array>({start(controller) { controller.error(new Error('PRIVATE read secret')); }}), {headers: {'Content-Type': 'text/event-stream'}});
  await assert.rejects(consume(broken, 'messages'), redacted);
});

test('response and SSE event bounds cancel oversized inputs', async () => {
  let jsonCancelled = false, streamCancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { jsonCancelled = true; },
  }), {headers: {'Content-Type': 'application/json'}});
  await assert.rejects(readNativeText(oversized, 'responses'), redacted); assert.equal(jsonCancelled, true);
  const event = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024 + 1))); }, cancel() { streamCancelled = true; },
  }), {headers: {'Content-Type': 'text/event-stream'}});
  await assert.rejects(consume(event, 'messages'), redacted); assert.equal(streamCancelled, true);
});
