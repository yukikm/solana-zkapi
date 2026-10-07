/** Offline orchestration tests. Actual encrypted SDK journal/ControlClient,
 * synthetic provider HTTP, RP and successor verifier; no G3 acceptance claim. */
import assert from 'node:assert/strict';
import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import bs58 from 'bs58';
import {ControlClient, validateNoteJournal, type ClientOptions, type Mode, type NoteJournal, type PreparedSession, type PrivateState,
  type Quote, type Receipt, type Tariff, type VerificationContext} from '../packages/sdk/src/control.ts';
import {EncryptedJournal, importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import {jcsBytes} from '../packages/sdk/src/trust.ts';
import {ProviderAcceptanceFailure, providerAcceptanceBody, runProviderAcceptanceCase, sendProviderAcceptanceOperation,
  type ProviderAcceptanceCase, type ProviderAcceptanceContext} from './provider_acceptance_client.ts';
import {saveProviderFailureDiagnostic, validateCompletedProviderCase} from './i10_devnet_provider.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const key = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 86)]), format: 'der', type: 'pkcs8'});
const publicKey = bs58.encode(createPublicKey(key).export({type: 'spki', format: 'der'}).subarray(-32));
const digest = (value: unknown) => createHash('sha256').update(jcsBytes(value)).digest();
const testCase: ProviderAcceptanceCase = {id: 'fixture-plain', mode: 'proxy', provider: 'openai', model: 'offline-fixture',
  endpoint: 'chat_completions', stream: false, tools: false, max_output_tokens: 32,
  max_cost_micro_usdc: '100', session_ttl_seconds: 60};
const tariffBody = {version: '1', provider: 'openai', model: 'offline-fixture', pricing_basis: 'fixed_usage_rates',
  valid_from: '100', valid_until: '1000', operator_fee_micro_usdc: '0', rates: [
    {unit: 'cache_read_tokens', nano_usdc_numerator: '1', unit_denominator: '1'},
    {unit: 'input_tokens', nano_usdc_numerator: '1', unit_denominator: '1'},
    {unit: 'output_tokens', nano_usdc_numerator: '1', unit_denominator: '1'}]};
const tariff: Tariff = {...tariffBody, tariff_hash: digest(tariffBody).toString('hex')};
const context: VerificationContext = {deployment_id: 'provider-acceptance-fixture', pool: 'fixture-pool', vault_binding: field(1),
  state_key: [field(2), field(3)], cap_micro_usdc: '100', control_api_origin: 'https://control.invalid',
  inference_api_origin: 'https://inference.invalid', quote_public_key: publicKey, receipt_public_key: publicKey,
  request_vk_sha256: '00'.repeat(32), tariff_hashes: [tariff.tariff_hash]};
const initial: PrivateState = {balance_micro_usdc: '1000', balance_blinding: field(3), note_leaf: field(4),
  commitment: {x: field(5), y: field(6)}, anchor: field(7), state_signature: null};
const successor: PrivateState = {...initial, balance_micro_usdc: '999', anchor: field(8), state_signature: {r_x: field(9), r_y: field(10), s: field(11)}};

async function setup(t: TestContext, variant: 'plain' | 'sse' | 'unknown' | 'missing_evidence' | 'sse_fake_tool'
  | 'http502' | 'malformed' | 'stream_break' | 'error_header_canary' = 'plain',
  auth: 'normal' | '503_once' | 'unknown_once' | 'expired_unknown' | 'permanent' | 'slow' = 'normal',
  quoteFault: 'normal' | '503_once' | 'unknown_once' | 'permanent' | 'deadline' | 'slow' | 'invalid_quote' | 'expired_quote' = 'normal',
  mode: Mode = 'proxy') {
  const provider = mode === 'proxy' ? 'openai' : mode === 'direct_oa' ? 'oa' : 'openrouter';
  const price = {...tariffBody, provider, model: mode === 'proxy' ? testCase.model : '*', pricing_basis: mode === 'proxy' ? 'fixed_usage_rates' : 'provider_reported_usd', rates: mode === 'proxy' ? tariffBody.rates : []};
  const selectedTariff: Tariff = {...price, tariff_hash: digest(price).toString('hex')};
  const selectedContext = {...context, tariff_hashes: [selectedTariff.tariff_hash]};
  const directory = await mkdtemp(join(tmpdir(), 'provider-acceptance-sdk-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const aes = await importJournalKey(new Uint8Array(32).fill(87));
  const journal = new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory), aes,
    {deploymentId: context.deployment_id, pool: context.pool}, validateNoteJournal);
  await journal.create('note', {schema: 1, state: initial, pending: null, history: [],
    witness: {secret: field(2), note_id: 0, deposit_micro_usdc: '1000', expiry: '9999999999'},
    wallet: {status: 'active', history: []}});
  const counts = {quote: 0, prepare: 0, reserve: 0, auth: 0, inference: 0, close: 0, settle: 0};
  let requestId = '', operationId = '', observedBody: unknown, reserved = false, now = 150_000, proofs = 0, snapshots = 0;
  const authRequests: {body: string; token: string}[] = [];
  const quoteRequests: string[] = [], issuedQuotes: Quote[] = [];
  let authSignal: AbortSignal | undefined, waitForAuthDeadline = false, slowVerifier = false, verifications = 0, verifierDeadlineAborted = false;
  const clientOptions: ClientOptions = {context: selectedContext, journal, now: () => BigInt(Math.floor(now / 1000)),
    directProviderBases: {direct_oa:'https://direct.invalid/v1', direct_openrouter:'https://direct.invalid/v1'},
    oaVerifier: {base:'https://verifier.invalid',stationId:'fixture-station'},
    verifier: {async prepare() {counts.prepare++;}, async settle(_context, previous, saved, _settlement, receipts, operations) {
      assert.deepEqual(previous, initial); assert.equal(saved.request.authorization.request_id, requestId);
      assert.equal(receipts.length, 1); assert.deepEqual(operations, mode === 'proxy' ? [operationId] : []); counts.settle++; return successor;
    }}, fetch: async (url, init) => {
      init?.signal?.throwIfAborted();
      const path = new URL(String(url)).pathname;
      if (path === '/zkapi/v1/quotes') {
        counts.quote++;
        if (counts.auth === 0) {
          assert.equal(snapshots, 1, 'snapshot is captured before quote retries');
          assert.equal(reserved, false); assert.equal(proofs, 0); assert.equal(counts.prepare, 0);
        }
        assert.ok(init?.signal); quoteRequests.push(String(init!.body));
        if (quoteFault === '503_once' && counts.quote === 1) return new Response(null, {status: 503});
        if (quoteFault === 'permanent') return new Response(null, {status: 400});
        if (quoteFault === 'deadline') { now += 120_001; return new Response(null, {status: 503}); }
        if (quoteFault === 'slow') await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(Error('unbounded quote fixture')), 1000);
          const abort = () => {clearTimeout(timer); reject(init!.signal!.reason);};
          if (init!.signal!.aborted) abort(); else init!.signal!.addEventListener('abort', abort, {once: true});
        });
        const body: Quote['body'] = {quote_id: `12345678-1234-4123-8123-${(123456789011 + counts.quote).toString()}`, deployment_id: context.deployment_id,
          pool: context.pool, mode, provider, models: [selectedTariff.model], tariff_hash: selectedTariff.tariff_hash,
          cap_micro_usdc: '100', issued_at: '140', expires_at: '260', session_ttl_seconds: '60', max_concurrency: '4',
          control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin};
        if (quoteFault === 'expired_quote') {body.issued_at = '100'; body.expires_at = '220'; now = 230_000;}
        const hash = digest(body);
        const quote = {body, quote_hash: hash.toString('hex'), signature: sign(null, hash, key).toString('base64')};
        issuedQuotes.push(structuredClone(quote));
        if (quoteFault === 'unknown_once' && counts.quote === 1) throw new TypeError('fetch failed');
        if (quoteFault === 'invalid_quote') quote.signature = Buffer.alloc(64).toString('base64');
        return Response.json(quote);
      }
      if (path === '/zkapi/v1/sessions') {
        assert.equal(reserved, true, 'durable test budget precedes issuance/admission'); counts.auth++;
        const pending = (await journal.read('note'))!.value.pending!;
        requestId = pending.prepared.request.authorization.request_id;
        assert.equal(pending.phase, 'send_unknown'); assert.equal(init!.body, pending.exactRequest);
        assert.ok(init?.signal, 'authorization deadline reaches the actual SDK HTTP transport');
        authSignal = init.signal;
        authRequests.push({body: String(init!.body), token: new Headers(init!.headers).get('Authorization')!});
        if (auth === '503_once' && counts.auth === 1) return new Response(null, {status: 503});
        if (auth === 'unknown_once' && counts.auth === 1) throw new TypeError('fetch failed');
        if (auth === 'expired_unknown') { now = 260_000; throw new TypeError('fetch failed'); }
        if (auth === 'permanent') return new Response(null, {status: 409});
        if (auth === 'slow') await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(Error('unbounded fixture request')), 1000);
          const abort = () => { clearTimeout(timer); reject(init!.signal!.reason); };
          if (init!.signal!.aborted) abort(); else init!.signal!.addEventListener('abort', abort, {once: true});
        });
        return Response.json({request_id: requestId, mode, state: 'ACTIVE', cap_micro_usdc: '100',
          ...(mode === 'proxy' ? {} : {provider_key:'memory-only-provider-key',provider_api_origin:'https://direct.invalid/v1',expires_at:'210',
            ...(mode === 'direct_oa' ? {provider_key_verification:{verifier_url:'https://verifier.invalid',station_id:'fixture-station',station_recently_attested:true,key_valid_till:210,station_signature:'ab'.repeat(64),org_signature:'cd'.repeat(64)}} : {})})});
      }
      if (path === '/submit_key') {
        verifications++;
        assert.equal(new URL(String(url)).origin,'https://verifier.invalid');
        assert.equal(JSON.parse(String(init!.body)).api_key,'memory-only-provider-key');
        assert.equal((await journal.read('note'))!.value.pending!.providerKey,undefined);
        assert.ok(init!.signal);
        if (slowVerifier) await new Promise<void>((_resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('unbounded verifier request')),5000);
          const aborted=()=>{clearTimeout(timer);verifierDeadlineAborted=init!.signal!.aborted&&init!.signal!.reason?.name==='TimeoutError';reject(init!.signal!.reason);};
          if(init!.signal!.aborted)aborted();else init!.signal!.addEventListener('abort',aborted,{once:true});
        });
        return Response.json({status:'verified'});
      }
      if (path === '/v1/chat/completions') {
        counts.inference++;
        const operation = (await journal.read('note'))!.value.pending!.operations[0];
        operationId = operation.id; assert.equal(operation.phase, 'send_unknown');
        observedBody = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array));
        assert.equal((await journal.read('note'))!.value.pending!.providerKey,undefined);
        if (mode === 'proxy') assert.equal(new Headers(init!.headers).get('Idempotency-Key'), operation.id);
        else assert.equal(new Headers(init!.headers).get('Authorization'),'Bearer memory-only-provider-key');
        assert.equal(counts.inference, 1, 'one actual SDK send');
        if (waitForAuthDeadline) {
          assert.ok(authSignal);assert.notEqual(init!.signal,authSignal);
          if (!authSignal.aborted) await new Promise<void>((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('authorization deadline did not expire')),1000);
            authSignal!.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});
          });
          assert.equal(init!.signal!.aborted,false,'expired AUTH deadline must not abort inference');
        }
        if (variant === 'unknown') throw TypeError('fixture-secret-provider-transport');
        if (variant === 'http502' || variant === 'error_header_canary') return new Response('fixture-secret-provider-body', {status: 502,
          headers: {'x-zkapi-error-code': variant === 'http502' ? 'provider_unavailable' : 'fixture-secret-error-header'}});
        if (variant === 'malformed') return new Response('{fixture-secret-malformed-json', {headers: {'content-type': 'application/json'}});
        if (variant === 'stream_break') return new Response(new ReadableStream({start(controller) {
          controller.error(Error('fixture-secret-stream-error'));
        }}));
        if (variant === 'sse_fake_tool') return new Response('data: {"choices":[{"index":0,"delta":{"content":"I refuse to call acceptance_echo"}}]}\n\ndata: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
        if (variant === 'sse') return new Response('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
        return Response.json({choices: [{message: {content: 'fixture-private-response-canary'}}], usage: {prompt_tokens: 1, completion_tokens: 1}});
      }
      if (path.endsWith('/close')) {
        counts.close++;
        assert.equal(init!.signal!.aborted,false,'expired AUTH deadline must not abort close');
        return Response.json({request_id: requestId, mode, state: 'SETTLED', cap_micro_usdc: '100',
          settlement: {charge_micro_usdc: '1', next_commitment: successor.commitment, next_anchor: successor.anchor,
            blind_delta_srv: field(12), next_state_signature: successor.state_signature}});
      }
      assert.equal(path, `/zkapi/v1/sessions/${requestId}/receipts`);
      if (new URL(String(url)).searchParams.has('cursor')) return Response.json({receipts: [], next_cursor: null});
      const receipt: Receipt = {body: {receipt_id: '12345678-1234-4123-8123-123456789013', operation_id: mode === 'proxy' ? operationId : null,
        billing_effect: 'charge', evidence_kind: variant === 'unknown' ? 'UNKNOWN_OPERATOR_LOSS' : mode === 'proxy' ? 'PROXY_USAGE' : mode === 'direct_oa' ? 'OA_SIGNED_RECEIPT' : 'OPENROUTER_USAGE',
        reason: variant === 'unknown' ? 'waived_unknown' : 'metered', observed_nano_usdc: variant === 'unknown' ? null : '1000',
        ...(variant === 'missing_evidence' ? {} : {provider_evidence_digest: '44'.repeat(32)})}, receipt_hash: '55'.repeat(32), signature: 'synthetic'};
      return Response.json({receipts: [receipt], next_cursor: '1'});
    }};
  const client = new ControlClient(clientOptions);
  const options: ProviderAcceptanceContext = {client, journal, noteId: 'note', tariff: selectedTariff, now: () => now,
    quoteTimeoutMs: quoteFault === 'slow' ? 30 : 120_000,
    authorizationTimeoutMs: auth === 'slow' ? 30 : 120_000,
    testCase: {...testCase, mode, provider, stream: variant === 'sse' || variant === 'sse_fake_tool', tools: variant === 'sse_fake_tool'},
    chain: {async sessionSnapshot() {snapshots++; return {slot: 200, root: field(14), sequence: '1', siblings: [], nextNoteId: 1, clock: '150', paused: false, treasuryOwner: 'fixture'};}},
    prover: {async snapshotPath(){throw Error('synthetic chain does not reconstruct a real tree');},async prepareSession(_witness: unknown, _state: unknown, _root: unknown, _siblings: unknown, quote: Quote, price: Tariff,
      credentials: {requestId: string; controlToken: string; proxyToken: string | null; controlHash: string; proxyHash: string | null}): Promise<PreparedSession> {
      proofs++;
      return {request: {authorization: {version: '1', deployment_id: context.deployment_id, pool: context.pool,
        request_id: credentials.requestId, quote_hash: quote.quote_hash, mode, control_secret_hash: credentials.controlHash,
        proxy_secret_hash: credentials.proxyHash}, quote, public_inputs: Array(12).fill(field(1)),
        proof: {backend: 'groth16_bn254', proof: 'synthetic'}}, control_token: credentials.controlToken,
        proxy_token: credentials.proxyToken, tariff: price, rerandomization: field(13)};
    }}, async reserve(c: ProviderAcceptanceCase) {
      counts.reserve++; if (reserved) throw Error('already reserved'); reserved = true;
      return {case_id: c.id, reserved_micro_usdc: c.max_cost_micro_usdc, plan_sha256: '66'.repeat(32), send_authorized_once: true as const};
    }};
  return {options, counts, journal, observed: () => observedBody, authRequests, proofs: () => proofs, directory, quoteRequests, issuedQuotes,
    waitForAuthDeadline: () => {waitForAuthDeadline=true;options.authorizationTimeoutMs=200;},
    slowVerifier: () => {slowVerifier=true;options.authorizationTimeoutMs=1000;},verifications:()=>verifications,
    verifierDeadlineAborted:()=>verifierDeadlineAborted};
}

for (const mode of ['direct_openrouter','direct_oa'] as const) test(`${mode} acceptance uses the authorizing client's volatile key after its AUTH timeout expires`, async t=>{
  const h=await setup(t,'plain','normal','normal',mode);h.waitForAuthDeadline();
  const report=await runProviderAcceptanceCase(h.options);
  assert.equal(report.passed,true);assert.equal(report.inference_sends,1);assert.equal(report.inference_replays,0);
  assert.deepEqual(h.counts,{quote:1,prepare:1,reserve:1,auth:1,inference:1,close:1,settle:1});
  const saved=(await h.journal.read('note'))!.value;
  assert.equal(saved.pending,null);assert.equal(saved.history[0].operations.length,1);
  assert.equal(JSON.stringify(saved).includes('memory-only-provider-key'),false);
  await assert.rejects(runProviderAcceptanceCase(h.options));assert.equal(h.counts.inference,1);
});

for (const mode of ['direct_openrouter','direct_oa'] as const) for (const fault of ['503_once','unknown_once'] as const)
test(`${mode} ${fault} retries only the saved AUTH on the same key-owning client`, async t=>{
  const h=await setup(t,'plain',fault,'normal',mode),report=await runProviderAcceptanceCase(h.options);
  assert.equal(report.authorization_recovery_attempts,2);assert.deepEqual(h.authRequests[0],h.authRequests[1]);
  assert.deepEqual(h.counts,{quote:1,prepare:1,reserve:1,auth:2,inference:1,close:1,settle:1});
  assert.equal(JSON.stringify((await h.journal.read('note'))!.value).includes('memory-only-provider-key'),false);
});

test('an AUTH deadline also bounds OA verification without saving a key or sending inference',async t=>{
  const h=await setup(t,'plain','normal','normal','direct_oa');h.slowVerifier();
  await assert.rejects(runProviderAcceptanceCase(h.options),error=>{
    assert.ok(error instanceof ProviderAcceptanceFailure);assert.equal(error.diagnostic!.stage,'authorize');return true;
  });
  const pending=(await h.journal.read('note'))!.value.pending!;
  assert.equal(h.verifications(),1,'the deadline is exercised after reaching the independent verifier');
  assert.equal(h.verifierDeadlineAborted(),true,'the per-call TimeoutError, not the watchdog, must stop verifier transport');
  assert.equal(pending.providerKey,undefined);assert.equal(pending.phase,'closing');assert.equal(pending.closeRequested,true);
  assert.deepEqual(pending.operations,[]);assert.equal(pending.exactRequest,h.authRequests[0].body);
  assert.equal(h.counts.auth,1);assert.equal(h.counts.inference,0);assert.equal(h.counts.close,0);
  await assert.rejects(h.options.client.sendDirectOperation('note',crypto.randomUUID(),'/v1/chat/completions',new Uint8Array()));
  assert.equal(h.counts.inference,0);
  await h.options.client.close('note');
  assert.equal((await h.journal.read('note'))!.value.pending,null);
  assert.equal(h.counts.close,1);assert.equal(h.counts.settle,1);assert.equal(h.counts.inference,0);
  assert.equal(h.verifications(),1,'explicit close never retries issuance or verifier delivery');
});

for(const mode of ['direct_openrouter','direct_oa'] as const)test(`${mode} uncertain inference closes once and never replays after orchestration failure`,async t=>{
  const h=await setup(t,'unknown','normal','normal',mode);
  await assert.rejects(runProviderAcceptanceCase(h.options));
  const saved=(await h.journal.read('note'))!.value;assert.equal(saved.pending,null);
  assert.equal(saved.history[0].operations[0].phase,'send_unknown');
  assert.deepEqual(h.counts,{quote:1,prepare:1,reserve:1,auth:1,inference:1,close:1,settle:1});
  await assert.rejects(runProviderAcceptanceCase(h.options));assert.equal(h.counts.inference,1);
});

for (const fault of ['503_once', 'unknown_once'] as const) test(`quote ${fault} repeats fixed parameters before one proof/reservation/AUTH/inference`, async t => {
  const h = await setup(t, 'plain', 'normal', fault);
  const report = await runProviderAcceptanceCase(h.options);
  assert.equal(report.quote_request_attempts, 2); assert.equal(report.authorization_recovery_attempts, 1);
  assert.equal(h.quoteRequests.length, 2); assert.equal(h.quoteRequests[0], h.quoteRequests[1]);
  assert.deepEqual(h.counts, {quote: 2, prepare: 1, reserve: 1, auth: 1, inference: 1, close: 1, settle: 1});
  assert.equal(h.proofs(), 1);
  const saved = (await h.journal.read('note'))!.value.history[0].prepared.request.quote;
  assert.deepEqual(saved, h.issuedQuotes.at(-1));
  if (fault === 'unknown_once') assert.notEqual(saved.quote_hash, h.issuedQuotes[0].quote_hash, 'lost quote is unused');
});

for (const fault of ['permanent', 'deadline', 'slow', 'invalid_quote', 'expired_quote'] as const) test(`quote ${fault} stops without any financial journal write/proof/reservation/AUTH/inference`, async t => {
  const h = await setup(t, 'plain', 'normal', fault), before = (await h.journal.read('note'))!;
  await assert.rejects(runProviderAcceptanceCase(h.options), error => {
    assert.ok(error instanceof ProviderAcceptanceFailure);
    assert.equal(error.diagnostic!.stage, 'quote'); assert.equal(error.diagnostic!.inference, null);
    assert.equal(error.diagnostic!.settlement, 'not_started');
    assert.equal(error.diagnostic!.control_http_status, fault === 'permanent' ? 400 : fault === 'deadline' ? 503 : null);
    return true;
  });
  assert.deepEqual(await h.journal.read('note'), before);
  assert.equal(h.proofs(), 0);
  assert.deepEqual(h.counts, {quote: 1, prepare: 0, reserve: 0, auth: 0, inference: 0, close: 0, settle: 0});
});

test('retried quote keeps its signed AUTH expiry and is never replaced after AUTH becomes uncertain', async t => {
  const h = await setup(t, 'plain', 'expired_unknown', '503_once');
  await assert.rejects(runProviderAcceptanceCase(h.options), /preserve SDK journal/);
  const saved = (await h.journal.read('note'))!.value.pending!;
  assert.equal(saved.phase, 'send_unknown'); assert.deepEqual(saved.operations, []);
  assert.deepEqual(saved.prepared.request.quote, h.issuedQuotes.at(-1));
  assert.equal(saved.prepared.request.quote.body.expires_at, '260');
  assert.deepEqual(h.counts, {quote: 2, prepare: 1, reserve: 1, auth: 1, inference: 0, close: 0, settle: 0});
  assert.equal(h.proofs(), 1);
  await assert.rejects(runProviderAcceptanceCase(h.options));
  assert.equal(h.counts.quote, 2); assert.equal(h.counts.auth, 1); assert.equal(h.counts.inference, 0);
});

test('invalid quote retry limits fail before quote, proof, reservation or AUTH', async t => {
  const h = await setup(t), before = await h.journal.read('note');
  for (const quoteTimeoutMs of [0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(runProviderAcceptanceCase({...h.options, quoteTimeoutMs}));
    assert.deepEqual(await h.journal.read('note'), before);
  }
  assert.equal(h.proofs(), 0);
  assert.deepEqual(h.counts, {quote: 0, prepare: 0, reserve: 0, auth: 0, inference: 0, close: 0, settle: 0});
});

for (const variant of ['unknown', 'http502', 'malformed', 'stream_break', 'error_header_canary', 'missing_evidence'] as const) {
  test(`${variant} persists static failure diagnostics after SDK settlement, with no body/error/token or replay`, async t => {
    const h = await setup(t, variant);
    let failure: ProviderAcceptanceFailure | undefined;
    await assert.rejects(runProviderAcceptanceCase(h.options), error => {
      assert.ok(error instanceof ProviderAcceptanceFailure); failure = error; return true;
    });
    assert.ok(failure?.diagnostic);
    const d = failure.diagnostic;
    assert.equal(d.stage, 'acceptance'); assert.equal(d.settlement, 'completed');
    assert.equal(d.inference_replays, 0); assert.equal(d.inference!.sdk_send_invoked, true);
    const stage = {unknown: 'send', http502: 'response_status', malformed: 'response_decode', stream_break: 'response_read',
      error_header_canary: 'response_status', missing_evidence: 'complete'}[variant];
    assert.equal(d.inference!.stage, stage);
    assert.equal(d.inference!.http_status, variant === 'unknown' ? null : ['http502', 'error_header_canary'].includes(variant) ? 502 : 200);
    assert.equal(d.inference!.service_error_code, variant === 'http502' ? 'provider_unavailable' : variant === 'error_header_canary' ? 'other' : null);
    assert.ok(Number.isSafeInteger(d.elapsed_ms) && d.elapsed_ms >= 0);
    const path = join(h.directory, 'failure.json');
    await saveProviderFailureDiagnostic(path, h.options.testCase.id, '66'.repeat(32), failure);
    const raw = await readFile(path, 'utf8'), saved = (await h.journal.read('note'))!;
    assert.ok(!raw.includes('fixture-secret')); assert.ok(!raw.includes('fixture-private-response'));
    assert.ok(!raw.includes(saved.value.history[0].prepared.control_token));
    assert.ok(!raw.includes(saved.value.history[0].prepared.proxy_token!));
    assert.deepEqual(JSON.parse(raw).diagnostic, d);
    assert.equal(h.counts.inference, 1); assert.equal(h.counts.close, 1); assert.equal(h.counts.settle, 1);
    await assert.rejects(runProviderAcceptanceCase(h.options));
    assert.equal(h.counts.inference, 1); assert.equal(await readFile(path, 'utf8'), raw);
  });
}

for (const fault of ['503_once', 'unknown_once'] as const) test(`${fault} recovers identical durable AUTH before one inference`, async t => {
  const h = await setup(t, 'plain', fault);
  const report = await runProviderAcceptanceCase(h.options);
  assert.equal(report.authorization_recovery_attempts, 2);
  assert.deepEqual(h.counts, {quote: 1, prepare: 1, reserve: 1, auth: 2, inference: 1, close: 1, settle: 1});
  assert.equal(h.proofs(), 1); assert.equal(h.authRequests.length, 2);
  assert.deepEqual(h.authRequests[0], h.authRequests[1], 'same AUTH, proof, quote, UUID and bearer');
  assert.equal((await h.journal.read('note'))!.value.history.length, 1);
});

for (const fault of ['expired_unknown', 'permanent', 'slow'] as const) test(`${fault} preserves uncertain AUTH without inference, replacement or restart replay`, async t => {
  const h = await setup(t, 'plain', fault);
  await assert.rejects(runProviderAcceptanceCase(h.options), /preserve SDK journal/);
  const before = (await h.journal.read('note'))!;
  assert.equal(before.value.pending!.phase, 'send_unknown');
  assert.deepEqual(before.value.pending!.operations, []); assert.deepEqual(before.value.history, []);
  assert.equal(before.value.pending!.exactRequest, h.authRequests[0].body);
  assert.equal(h.proofs(), 1);
  assert.deepEqual(h.counts, {quote: 1, prepare: 1, reserve: 1, auth: 1, inference: 0, close: 0, settle: 0});
  await assert.rejects(runProviderAcceptanceCase(h.options), /preserve SDK journal/);
  assert.deepEqual(await h.journal.read('note'), before);
  assert.equal(h.counts.auth, 1); assert.equal(h.counts.reserve, 1); assert.equal(h.proofs(), 1);
});

test('native request bodies bound output and disallow silent mode/provider changes', () => {
  const chat = JSON.parse(new TextDecoder().decode(providerAcceptanceBody(testCase)));
  assert.equal(chat.max_completion_tokens, 32); assert.equal(chat.model, 'offline-fixture');
  const responses = JSON.parse(new TextDecoder().decode(providerAcceptanceBody({...testCase, endpoint: 'responses', stream: true, tools: true})));
  assert.equal(responses.store, false); assert.equal(responses.background, false); assert.equal(responses.max_output_tokens, 32);
  assert.equal(responses.tools[0].name, 'acceptance_echo');
  for (const change of [{provider: 'oa'}, {max_output_tokens: 0}, {max_output_tokens: 4097},
    {max_cost_micro_usdc: '10000001'}, {mode: 'direct_openrouter', provider: 'openai'},
    {mode: 'direct_oa', provider: 'oa', session_ttl_seconds: 61}]) {
    assert.throws(() => providerAcceptanceBody({...testCase, ...change} as ProviderAcceptanceCase));
  }
});

for (const variant of ['plain', 'sse'] as const) test(`actual SDK ${variant} sends once, verifies settlement and never returns raw provider text`, async t => {
  const h = await setup(t, variant);
  const result = await runProviderAcceptanceCase(h.options).catch(e => {t.diagnostic(JSON.stringify(h.counts)); throw e;});
  assert.equal(result.passed, true); assert.equal(result.full_g3_passed, false);
  assert.deepEqual(h.counts, {quote: 1, prepare: 1, reserve: 1, auth: 1, inference: 1, close: 1, settle: 1});
  assert.equal((h.observed() as {max_completion_tokens: number}).max_completion_tokens, 32);
  assert.equal((await h.journal.read('note'))!.value.pending, null);
  assert.ok(!JSON.stringify(result).includes('fixture-private-response-canary'));
  // A repeated invocation cannot reuse a campaign reservation or resend the
  // previous operation, even though the SDK has a valid successor note.
  await assert.rejects(runProviderAcceptanceCase(h.options), /preserve SDK journal/);
  assert.equal(h.counts.auth, 1); assert.equal(h.counts.inference, 1);
});

test('uncertain inference closes same session, retains durable send and cannot pass on a waived receipt', async t => {
  const h = await setup(t, 'unknown');
  await assert.rejects(runProviderAcceptanceCase(h.options), error => error instanceof Error
    && error.message.includes('preserve SDK journal') && !error.message.includes('fixture-secret'));
  const saved = (await h.journal.read('note'))!.value;
  assert.equal(h.counts.inference, 1); assert.equal(h.counts.close, 1);
  assert.equal(saved.history[0].operations[0].phase, 'send_unknown');
  assert.equal(saved.history[0].receipts[0].body.reason, 'waived_unknown');
  await assert.rejects(runProviderAcceptanceCase(h.options));
  assert.equal(h.counts.inference, 1);
});

test('missing provider evidence fails acceptance even if an injected fixture verifier accepts settlement', async t => {
  const h = await setup(t, 'missing_evidence');
  await assert.rejects(runProviderAcceptanceCase(h.options));
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.inference, 1);
});

test('tool-name refusal cannot pass SSE acceptance or trigger replay after the same SDK session settles', async t => {
  const h = await setup(t, 'sse_fake_tool');
  await assert.rejects(runProviderAcceptanceCase(h.options), /preserve SDK journal/);
  assert.equal(h.counts.inference, 1); assert.equal(h.counts.close, 1); assert.equal(h.counts.settle, 1);
  const saved = (await h.journal.read('note'))!.value;
  assert.equal(saved.pending, null); assert.equal(saved.history[0].operations[0].phase, 'send_unknown');
  await assert.rejects(runProviderAcceptanceCase(h.options));
  assert.equal(h.counts.inference, 1); assert.equal(h.counts.auth, 1);
});

// These narrowly test response evidence through the real send wrapper; the
// encrypted-journal tests above separately exercise the actual SDK send path.
async function streamObservation(endpoint: ProviderAcceptanceCase['endpoint'], body: string | Uint8Array, tools = true) {
  const counts = {prepare: 0, send: 0};
  const client = {async prepareOperation() { counts.prepare++; }, async sendOperation() {
    counts.send++; return new Response(typeof body === 'string' ? body : Uint8Array.from(body), {headers: {'content-type': 'text/event-stream'}});
  }} as unknown as ControlClient;
  try {
    return await sendProviderAcceptanceOperation(client, 'note', {...testCase, stream: true, tools, endpoint,
      provider: endpoint === 'messages' ? 'anthropic' : 'openai'});
  } finally { assert.deepEqual(counts, {prepare: 1, send: 1}); }
}
const sse = (value: unknown, event = '') => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
const chatTool = sse({choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'acceptance_echo', arguments: '{"word":"ok"}'}}]}}]});
const responseTool = sse({type: 'response.output_item.added', item: {type: 'function_call', id: 'fc_1', name: 'acceptance_echo'}}, 'response.output_item.added');
const messageTool = sse({type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'tool_1', name: 'acceptance_echo', input: {}}}, 'content_block_start');
const terminals = {chat_completions: 'data: [DONE]\n\n',
  responses: sse({type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 1, output_tokens: 1}}}, 'response.completed'),
  messages: sse({type: 'message_stop'}, 'message_stop')};

for (const endpoint of ['chat_completions', 'responses', 'messages'] as const) {
  test(`${endpoint} SSE requires an actual tool event and a dispatched successful terminal`, async () => {
    const tool = {chat_completions: chatTool, responses: responseTool, messages: messageTool}[endpoint];
    const terminal = terminals[endpoint];
    const result = await streamObservation(endpoint, ': heartbeat\n\n' + tool + terminal);
    assert.equal(result.inference_sends, 1); assert.equal(result.http_status, 200);
    assert.ok(!JSON.stringify(result).includes('acceptance_echo'));
    await streamObservation(endpoint, (tool + terminal).replace(/\n/g, '\r\n'));
    const ordinary = endpoint === 'chat_completions'
      ? {choices: [{index: 0, delta: {content: 'acceptance_echo', refusal: 'acceptance_echo'}}]}
      : endpoint === 'responses' ? {type: 'response.output_text.delta', delta: 'acceptance_echo response.completed'}
        : {type: 'content_block_delta', delta: {type: 'text_delta', text: 'acceptance_echo message_stop'}};
    const wrongTool = tool.replace('acceptance_echo', 'another_tool');
    const wrongKind = endpoint === 'chat_completions' ? tool.replace('"tool_calls":', '"not_tool_calls":')
      : tool.replace(endpoint === 'responses' ? '"function_call"' : '"tool_use"', '"text"');
    for (const bad of [sse(ordinary) + terminal, wrongTool + terminal, wrongKind + terminal,
      `: acceptance_echo\n\n${terminal}`, tool, tool + sse({text: terminal}),
      tool + terminal.trimEnd(), terminal + tool,
      tool + sse({error: {message: 'acceptance_echo'}}) + terminal,
      tool + 'data: not-json\n\n' + terminal]) {
      await assert.rejects(streamObservation(endpoint, bad), Error, bad);
    }
    // Plain streaming remains valid without any tool call.
    await streamObservation(endpoint, sse(ordinary) + terminal, false);
    await assert.rejects(streamObservation(endpoint, Buffer.concat([Buffer.from(tool), Buffer.from([0xc3, 0x28]), Buffer.from(terminal)])));
    await assert.rejects(streamObservation(endpoint, ': ' + 'x'.repeat(8 * 1024 * 1024) + '\n\n' + tool + terminal));
  });
}

test('chat fragmented tool names bind one choice/tool index, and ambiguous or wrong-endpoint events fail', async () => {
  const start = sse({choices: [{index: 0, delta: {tool_calls: [{index: 0, type: 'function', function: {name: 'acceptance_'}}]}}]});
  const end = sse({choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {name: 'echo'}}]}}]});
  await streamObservation('chat_completions', start + end + terminals.chat_completions);
  await assert.rejects(streamObservation('chat_completions', start + end.replace('"index":0,"function"', '"index":1,"function"') + terminals.chat_completions));
  await assert.rejects(streamObservation('chat_completions', responseTool + terminals.chat_completions));
  await assert.rejects(streamObservation('responses', messageTool + terminals.responses));
  await assert.rejects(streamObservation('messages', responseTool + terminals.messages));
  await assert.rejects(streamObservation('responses', responseTool.replace('event: response.output_item.added', 'event: response.output_text.delta') + terminals.responses));
  await assert.rejects(streamObservation('responses', responseTool + terminals.responses.replace('"status":"completed"', '"status":"failed"')));
  await assert.rejects(streamObservation('messages', messageTool + 'event: message_stop\ndata: {"type":"message_stop","type":"error"}\n\n'));
});

for (const endpoint of ['chat_completions', 'responses', 'messages'] as const) {
  test(`${endpoint} nonstream tools require the endpoint-specific tool type and name`, async () => {
    const observation = async (call: unknown) => {
      let sends = 0;
      const value = endpoint === 'chat_completions' ? {choices: [{message: {tool_calls: [call]}}]}
        : endpoint === 'responses' ? {output: [call]} : {content: [call]};
      const client = {async prepareOperation() {}, async sendOperation() {
        sends++; return Response.json(value);
      }} as unknown as ControlClient;
      try {
        return await sendProviderAcceptanceOperation(client, 'note', {...testCase, tools: true, endpoint,
          provider: endpoint === 'messages' ? 'anthropic' : 'openai'});
      } finally { assert.equal(sends, 1); }
    };
    const type = {chat_completions: 'function', responses: 'function_call', messages: 'tool_use'}[endpoint];
    const correct = endpoint === 'chat_completions'
      ? {type, function: {name: 'acceptance_echo', arguments: '{"word":"ok"}'}}
      : {type, name: 'acceptance_echo'};
    assert.equal((await observation(correct)).inference_sends, 1);
    for (const call of [null, {...correct, type: 'text'}, {...correct, type: undefined},
      {type, name: 'wrong', function: {name: 'wrong'}, text: 'acceptance_echo'},
      {type: 'refusal', name: 'acceptance_echo', function: {name: 'acceptance_echo'}, text: 'I will not call acceptance_echo'},
      endpoint === 'chat_completions' ? {type, name: 'acceptance_echo'} : {type, function: {name: 'acceptance_echo'}}]) {
      await assert.rejects(observation(call));
    }
  });
}

test('denied budget leaves SDK AUTH absent and does not send to provider', async t => {
  const h = await setup(t);
  const before = (await h.journal.read('note'))!;
  h.options.reserve = async () => {throw Error('budget exhausted');};
  await assert.rejects(runProviderAcceptanceCase(h.options));
  assert.deepEqual(await h.journal.read('note'), before);
  assert.equal(h.counts.auth, 0); assert.equal(h.counts.inference, 0); assert.equal(h.counts.prepare, 0);
});

test('completed-case resume binds exact budget, plan, tariff, SDK bytes, receipt and successor without sending', async t => {
  const h = await setup(t);
  const report = await runProviderAcceptanceCase(h.options);
  const note = (await h.journal.read('note'))!.value;
  const budget = {identity: {schema: 1, campaign_id: 'offline-test', plan_sha256: report.plan_sha256, budget_micro_usdc: '10000000'},
    reservations: [{case_id: testCase.id, max_cost_micro_usdc: testCase.max_cost_micro_usdc, state: 'reserved_no_automatic_replay'}]};
  const before = structuredClone(h.counts);
  let verifications = 0;
  const verifier = {async prepare() {throw Error('no new proof');}, async settle(_context: unknown, previous: PrivateState,
    prepared: PreparedSession, _settlement: unknown, receipts: Receipt[], operations: string[]) {
    assert.deepEqual(previous, initial); assert.equal(prepared.tariff.tariff_hash, tariff.tariff_hash);
    assert.equal(receipts[0].receipt_hash, report.receipt_hash); assert.deepEqual(operations, [report.operation_id]);
    verifications++; return successor;
  }};
  await validateCompletedProviderCase(report, testCase, report.plan_sha256, note, budget, context, verifier, tariff);
  assert.equal(verifications, 1); assert.deepEqual(h.counts, before);
  const bad: Parameters<typeof validateCompletedProviderCase>[] = [];
  const args = [report, testCase, report.plan_sha256, note, budget, context, verifier, tariff] as Parameters<typeof validateCompletedProviderCase>;
  for (const change of [{receipt_hash: '00'.repeat(32)}, {plan_sha256: '11'.repeat(32)}, {charged_micro_usdc: '101'},
    {endpoint: '/v1/responses'}, {tariff_hash: '22'.repeat(32)}, {inference_replays: 1}]) {
    bad.push([{...report, ...change} as typeof report, ...args.slice(1)] as Parameters<typeof validateCompletedProviderCase>);
  }
  const changedNote = structuredClone(note); changedNote.history[0].operations[0].bodyBase64 = Buffer.from('{}').toString('base64');
  bad.push([report, testCase, report.plan_sha256, changedNote, budget, context, verifier, tariff]);
  bad.push([report, testCase, report.plan_sha256, note, {...budget, reservations: []}, context, verifier, tariff]);
  const changedSuccessor = structuredClone(note); changedSuccessor.state.anchor = field(100);
  bad.push([report, testCase, report.plan_sha256, changedSuccessor, budget, context, verifier, tariff]);
  for (const values of bad) await assert.rejects(validateCompletedProviderCase(...values));
  assert.deepEqual(h.counts, before); assert.deepEqual((await h.journal.read('note'))!.value, note);
});
