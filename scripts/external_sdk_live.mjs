/** Explicit independent-app devnet acceptance. Copy beside an installed SDK tarball.
 * Every financial/provider action is a separate command. No automatic inference
 * retries, mode changes or transaction resends. This is not a public service. */
import assert from 'node:assert/strict';
import { readFile, writeFile, open, mkdir, lstat, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createZkApiClient } from '@zkapi/solana-sdk';
import { readChatText, readChatDeltas, ChatResponseError } from '@zkapi/solana-sdk/chat';
import { loadDeploymentAssets } from '@zkapi/solana-sdk/deployment';
import { NativeProver } from '@zkapi/solana-sdk/prover-node';
import { NativeJournalStore } from '@zkapi/solana-sdk/journal-node';
import { EncryptedJournal, importJournalKey } from '@zkapi/solana-sdk/journal';
import { initializeJournalKey, unlockJournalKey } from '@zkapi/solana-sdk/secret-custody';
import { validateNoteJournal } from '@zkapi/solana-sdk/control';
import { parseStrictJson, sha256Hex, jcsBytes } from '@zkapi/solana-sdk/trust';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const rpcMethods = new Set(['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight', 'getBlockTime', 'getSlot', 'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getFeeForMessage', 'getSignatureStatuses', 'getTransaction', 'getBlock', 'sendTransaction']);

export function safeFailure(error) {
  if (error instanceof ChatResponseError) return { kind: 'chat_response', code: error.code, status: error.status };
  if (error instanceof assert.AssertionError) return { kind: 'assertion_failed' };
  if (error?.name === 'ClientActionError' && ['busy', 'not_ready', 'invalid_request', 'closed'].includes(error?.code)) return { kind: 'client_action', code: error.code };
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return { kind: 'aborted_or_timeout' };
  return { kind: 'operation_failed' };
}

/** Capture only this explicit new diagnostic response, in the existing private
 * journal directory. Preserve byte order/backpressure; never capture headers,
 * credentials or a replay. Public reports contain only counts and a digest. */
async function captureResponse(response, filename, metrics) {
  if (!response.body) return response;
  const file = await open(filename, 'wx', 0o600), reader = response.body.getReader(), digest = createHash('sha256');
  let closed = false, bytes = 0;
  const close = async reason => {
    if (closed) return; closed = true;
    metrics.bytes = bytes; metrics.sha256 = digest.digest('hex'); metrics.closedBy = reason;
    try { await file.sync(); } finally { await file.close(); }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { await close('eof'); controller.close(); return; }
        bytes += next.value.length; assert.ok(bytes <= 16 * 1024 * 1024);
        digest.update(next.value); await file.writeFile(next.value); metrics.bytes = bytes;
        controller.enqueue(next.value);
      } catch (error) { await close('error'); controller.error(error); }
    },
    async cancel() { try { await reader.cancel(); } finally { await close('cancel'); } },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Same logical origin contracts as the demo's reviewed loopback host; provider
 * inference is sent directly to its independent OpenRouter base. */
export function externalRelay(profile, hostOrigin, onDispatch = async () => {}, fetcher = fetch) {
  const host = new URL(hostOrigin), p = structuredClone(profile);
  assert.equal(host.origin, hostOrigin); assert.equal(host.protocol, 'http:'); assert.ok(['127.0.0.1', '[::1]'].includes(host.hostname));
  assert.equal(p.rpcUrl, 'https://rpc.zkapi.invalid'); assert.equal(p.indexerOrigin, 'https://indexer.zkapi.invalid');
  assert.equal(p.mode, 'direct_openrouter'); assert.equal(p.directProviderBases.direct_openrouter, 'https://openrouter.ai/api/v1');
  const control = p.trust.expected.control_api_origin;
  const session = new RegExp(`^/zkapi/v1/sessions/${UUID}(?:/close|/receipts|/operations/${UUID})?$`);
  return async (input, init = {}) => {
    assert.ok(typeof input === 'string' || input instanceof URL);
    const url = new URL(String(input)), method = init.method ?? 'GET';
    assert.ok(!url.username && !url.password && !url.hash && ['GET', 'POST'].includes(method));
    let destination, kind, rpc;
    if (url.origin === p.rpcUrl && url.pathname === '/' && !url.search && method === 'POST') {
      assert.equal(typeof init.body, 'string'); assert.ok(Buffer.byteLength(init.body) <= 16 * 1024);
      rpc = parseStrictJson(new TextEncoder().encode(init.body));
      assert.ok(rpc.jsonrpc === '2.0' && rpcMethods.has(rpc.method) && Array.isArray(rpc.params));
      destination = hostOrigin + '/rpc'; kind = 'rpc';
    } else if (url.origin === p.indexerOrigin && method === 'GET' && !url.search && /^\/zkapi\/v1\/tree\/(root|snapshot|snapshots\/[0-9a-f]{64}\.json|notes\/(0|[1-9][0-9]{0,9})\/(path|zero-path))$/.test(url.pathname)) {
      destination = hostOrigin + '/indexer' + url.pathname; kind = 'indexer';
    } else if (url.origin === control) {
      const publicPath = ['/zkapi/v1/config', '/zkapi/v1/catalog', '/zkapi/v1/attestation'].includes(url.pathname) || /^\/zkapi\/v1\/tariffs\/[0-9a-f]{64}$/.test(url.pathname);
      const read = method === 'GET' && (publicPath || session.test(url.pathname)) && (!url.search || url.pathname.endsWith('/receipts') && /^\?cursor=[1-9][0-9]{0,18}$/.test(url.search));
      const write = method === 'POST' && !url.search && (['/zkapi/v1/quotes', '/zkapi/v1/sessions', '/zkapi/v1/withdraw/clearance'].includes(url.pathname) || new RegExp(`^/zkapi/v1/sessions/${UUID}/close$`).test(url.pathname));
      assert.ok(read || write); destination = hostOrigin + '/control' + url.pathname + url.search;
      kind = url.pathname === '/zkapi/v1/sessions' && method === 'POST' ? 'auth' : 'control';
    } else if (url.href === p.directProviderBases.direct_openrouter + '/chat/completions' && method === 'POST') {
      destination = url.href; kind = 'inference';
    }
    assert.ok(destination); assert.ok(method !== 'GET' || init.body === undefined || init.body === null);
    await onDispatch({ kind, method, path: url.pathname, rpc, body: init.body });
    const headers = new Headers(init.headers);
    if (destination.startsWith(hostOrigin + '/')) headers.set('Origin', hostOrigin);
    return fetcher(destination, { ...init, headers, method, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(kind === 'inference' ? 180_000 : 120_000)]) : AbortSignal.timeout(kind === 'inference' ? 180_000 : 120_000) });
  };
}

async function privateBytes(path, max = 65536) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= max);
  return new Uint8Array(await readFile(path));
}
async function durableJson(path, value, exclusive = false) {
  const filePath = exclusive ? path : path + '.' + randomUUID() + '.tmp';
  const file = await open(filePath, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(filePath, path);
  const directory = await open(resolve(path, '..'), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

export async function runExternalLive(configPath, command) {
  assert.ok(['init', 'inspect', 'deposit', 'plain', 'sse', 'sse-validation', 'sse-fixed', 'tools', 'recover', 'settle', 'advance', 'withdraw', 'reconcile-unaccepted', 'prove', 'retry-rejected', 'recover-expired-setup'].includes(command));
  const cfg = parseStrictJson(await privateBytes(configPath));
  const required = ['schema', 'profile', 'profileSha256', 'bundleDirectory', 'bundleSha256', 'nativeProver', 'nativeProverSha256', 'walletFile', 'passphraseFile', 'journalDirectory', 'noteId', 'hostOrigin', 'depositMicroUsdc'];
  assert.deepEqual(Object.keys(cfg).sort(), required.sort()); assert.equal(cfg.schema, 1);
  assert.match(cfg.depositMicroUsdc, /^[1-9][0-9]{0,6}$/); assert.ok(BigInt(cfg.depositMicroUsdc) <= 2_000_000n);
  const profileBytes = new Uint8Array(await readFile(cfg.profile)); assert.equal(hash(profileBytes), cfg.profileSha256);
  const profile = parseStrictJson(profileBytes); assert.equal(profile.chain, 'solana:devnet'); assert.equal(profile.mode, 'direct_openrouter');
  assert.equal(profile.trust.expected.genesis_hash, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const assets = await loadDeploymentAssets('https://bundle.zkapi.invalid/bundle.json', { bundleSha256: cfg.bundleSha256,
    fetch: async (input, init) => {
      init?.signal?.throwIfAborted(); const url = new URL(String(input));
      assert.equal(url.origin, 'https://bundle.zkapi.invalid'); assert.match(url.pathname, /^\/[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
      return new Response(await readFile(join(cfg.bundleDirectory, url.pathname.slice(1))));
    } });
  assert.equal(hash(jcsBytes(profile.trust)), hash(jcsBytes(assets.trust)));
  assert.equal(assets.verifiedManifest.deployment_environment, 'devnet');
  assert.equal(hash(await readFile(cfg.nativeProver)), cfg.nativeProverSha256);
  const secret = await privateBytes(cfg.walletFile), keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(new TextDecoder().decode(secret)))); secret.fill(0);
  const wallet = { publicKey: keypair.publicKey, supportedTransactionVersions: new Set([0]),
    async signTransaction(tx) {
      const copy = VersionedTransaction.deserialize(tx.serialize());
      assert.equal(copy.version, 0); assert.equal(copy.message.header.numRequiredSignatures, 1);
      assert.ok(copy.message.staticAccountKeys[0].equals(keypair.publicKey));
      copy.sign([keypair]); return copy;
    } };
  await mkdir(cfg.journalDirectory, { recursive: true, mode: 0o700 });
  const store = await NativeJournalStore.open(cfg.journalDirectory), statePath = join(cfg.journalDirectory, 'external-acceptance.json');
  return await store.withLock('external-acceptance', async () => {
    const custodyPath = join(cfg.journalDirectory, 'journal-key.json'), passphrase = await privateBytes(cfg.passphraseFile, 4096);
    let rawKey;
    try {
      try { await lstat(custodyPath); rawKey = await unlockJournalKey(custodyPath, passphrase); }
      catch (error) {
        if (error.code !== 'ENOENT' || !['init', 'deposit'].includes(command)) throw error;
        rawKey = await initializeJournalKey(custodyPath, passphrase);
      }
    } finally { passphrase.fill(0); }
    const key = await importJournalKey(rawKey); rawKey.fill(0);
    let saved;
    try { saved = parseStrictJson(await privateBytes(statePath, 1024 * 1024)); }
    catch (error) {
      if (error.code !== 'ENOENT' || !['init', 'deposit'].includes(command)) throw error;
      saved = { schema: 1, noteId: cfg.noteId, manifestHash: assets.verifiedManifest.manifest_hash, actions: {}, authSends: 0, inferenceSends: 0, transactions: [] };
      await durableJson(statePath, saved, true);
    }
    assert.equal(saved.noteId, cfg.noteId); assert.equal(saved.manifestHash, assets.verifiedManifest.manifest_hash);
    const save = () => durableJson(statePath, saved);
    let result = {}, stage = 'initialize';
    const relay = externalRelay(profile, cfg.hostOrigin, async ({ kind, rpc, body }) => {
      if (kind === 'rpc' && rpc.method === 'sendTransaction') {
        const wire = Buffer.from(rpc.params[0], 'base64'), tx = VersionedTransaction.deserialize(wire), signature = bs58.encode(tx.signatures[0]);
        assert.ok(!saved.transactions.some(t => t.signature === signature), 'automatic exact-signature resend refused');
        saved.transactions.push({ signature, wireSha256: hash(wire), bytes: wire.length, sendRecordedAt: new Date().toISOString() });
        await save();
      } else if (kind === 'auth') { saved.authSends++; await save(); }
      else if (kind === 'inference') {
        const current = saved.actions[command];
        assert.ok(current && !current.inferenceSent, 'inference replay refused');
        current.inferenceSent = true; current.requestBodySha256 = hash(typeof body === 'string' ? Buffer.from(body) : new Uint8Array(body));
        saved.inferenceSends++; await save();
      }
    }, async (url, init) => {
      const response = await fetch(url, init);
      if (!['sse-validation', 'sse-fixed'].includes(command) || String(url) !== profile.directProviderBases.direct_openrouter + '/chat/completions') return response;
      result.providerCapture = { bytes: 0, contentType: response.headers.get('content-type')?.split(';')[0] === 'text/event-stream' ? 'text/event-stream' : 'other', status: response.status };
      return captureResponse(response, join(cfg.journalDirectory, command + '-response.bin'), result.providerCapture);
    });
    const connection = new Connection(profile.rpcUrl, { commitment: 'confirmed', fetch: relay, disableRetryOnRateLimit: true });
    const client = await createZkApiClient({ deployment: { manifest: assets.manifest, trust: assets.trust, artifacts: assets.artifacts,
      connection, indexerOrigin: profile.indexerOrigin, fetch: relay, preparationCommitment: 'confirmed' }, storage: { store, key },
      prover: new NativeProver(cfg.nativeProver, cfg.nativeProverSha256), wallet, noteId: cfg.noteId, mode: profile.mode,
      models: profile.models, directProviderBases: profile.directProviderBases });
    const journal = new EncryptedJournal(store, key, { deploymentId: assets.verifiedManifest.deployment_id, pool: assets.verifiedManifest.pool }, validateNoteJournal);
    const driveWallet = async () => {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const status = await client.status(); if (!status.walletOperation) return;
        const signature = status.walletOperation.signature;
        if (signature && saved.transactions.some(t => t.signature === signature)) {
          const observed = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
          if (observed?.confirmationStatus !== 'finalized') { await delay(1500); continue; }
        }
        const outcome = await client.advanceWallet();
        if (['unknown', 'expired_reconcile_required', 'rejected', 'proof_required'].includes(outcome.state)) throw Error('wallet outcome requires explicit recovery');
        if (outcome.state !== 'complete' && outcome.state !== 'ready' && outcome.state !== 'finalized') await delay(1500);
      }
      throw Error('wallet wait deadline; saved operation retained');
    };
    try {
      stage = 'precheck';
      if (['sse-validation', 'sse-fixed'].includes(command)) {
        const previous = await journal.read(cfg.noteId), status = await client.status();
        assert.equal(status.session, null); assert.equal(status.canRequest, true);
        const settledIds = new Set(previous.value.history.flatMap(item => item.operations.map(operation => operation.id)));
        for (const prior of Object.values(saved.actions)) if (prior.inferenceSent) assert.ok(settledIds.has(prior.operationId));
      }
      if (['deposit', 'plain', 'sse', 'sse-validation', 'sse-fixed', 'tools', 'withdraw'].includes(command)) {
        assert.ok(!saved.actions[command], 'action already attempted; use inspect/recover/advance without replay');
        saved.actions[command] = { startedAt: new Date().toISOString(), operationId: randomUUID() }; await save();
      }
      if (command === 'deposit') { assert.equal((await client.status()).wallet, 'empty'); await client.prepareDeposit(cfg.depositMicroUsdc); await driveWallet(); }
      else if (command === 'withdraw') { await client.prepareWithdrawal(wallet.publicKey.toBase58()); await driveWallet(); }
      else if (command === 'advance') await driveWallet();
      else if (command === 'recover') await client.recover();
      else if (command === 'settle') await client.settle();
      else if (command === 'reconcile-unaccepted') await client.reconcileUnacceptedAuthorization();
      else if (command === 'prove') await client.resumeWalletProof();
      else if (command === 'retry-rejected') await client.retryRejectedWalletOperation();
      else if (command === 'recover-expired-setup') await client.recoverExpiredWalletSetup();
      else if (['plain', 'sse', 'sse-validation', 'sse-fixed', 'tools'].includes(command)) {
        const operationId = saved.actions[command].operationId, model = profile.models[0].id;
        const body = command === 'tools'
          ? { messages: [{ role: 'user', content: 'Call echo with text set to hello.' }], max_tokens: 64,
              tools: [{ type: 'function', function: { name: 'echo', description: 'Return a supplied text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }],
              tool_choice: { type: 'function', function: { name: 'echo' } }, stream: false }
          : { messages: [{ role: 'user', content: command === 'sse-fixed' ? 'Reply exactly STREAM VERIFIED.' : command === 'sse-validation' ? 'Reply exactly STREAM READY.' : 'Reply with the word hello.' }], max_tokens: 16, stream: ['sse', 'sse-validation', 'sse-fixed'].includes(command) };
        stage = 'request';
        const response = await client.request({ operationId, model, api: 'chat', body });
        result.httpStatus = response.status;
        if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw Error('provider HTTP status'); }
        if (['sse', 'sse-validation', 'sse-fixed'].includes(command)) {
          stage = 'consume_sse'; result.chars = 0; result.deltas = 0;
          for await (const delta of readChatDeltas(response)) { result.chars += delta.length; result.deltas++; }
          stage = 'assert_sse'; assert.ok(result.chars > 0 && result.deltas > 0);
        }
        else if (command === 'plain') { stage = 'consume_json'; result.responseChars = (await readChatText(response)).length; assert.ok(result.responseChars > 0); }
        else {
          stage = 'consume_tools';
          assert.equal(response.status, 200); const reader = response.body.getReader(), chunks = []; let size = 0;
          try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; assert.ok(size <= 1024 * 1024); chunks.push(next.value); } }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const parsed = parseStrictJson(new Uint8Array(Buffer.concat(chunks)));
          const calls = parsed.choices?.[0]?.message?.tool_calls; assert.ok(Array.isArray(calls) && calls.length === 1 && calls[0].function?.name === 'echo');
          const argumentsValue = JSON.parse(calls[0].function.arguments); assert.equal(argumentsValue.text, 'hello');
          result.toolCalls = calls.length; result.toolName = 'echo';
        }
        saved.actions[command].response = result; await save();
        stage = 'assert_settlement';
        const settled = await client.status();
        assert.equal(settled.session, null); assert.ok(settled.lastSettlement?.operationIds.includes(operationId));
      }
      const status = await client.status(), record = await journal.read(cfg.noteId);
      const finalized = (record?.value.wallet?.history ?? []).flatMap(op => op.finalized.map(f => ({ ...f, kind: op.kind })));
      const summary = { command, completedAt: new Date().toISOString(), result, status, authSends: saved.authSends, inferenceSends: saved.inferenceSends,
        inferenceReplays: 0, automaticTransactionResends: 0, transactions: saved.transactions, finalized };
      if (saved.actions[command]) { saved.actions[command].completedAt = summary.completedAt; saved.actions[command].result = result; await save(); }
      await durableJson(join(cfg.journalDirectory, 'last-result.json'), summary);
      return summary;
    } catch (error) {
      const summary = { command, completedAt: new Date().toISOString(), failed: true, status: await client.status(), authSends: saved.authSends,
        inferenceSends: saved.inferenceSends, transactions: saved.transactions, result,
        failedStage: stage, error: safeFailure(error),
        failure: 'Operation did not complete; retain the same encrypted journal and inspect or recover explicitly. No inference was replayed.' };
      await durableJson(join(cfg.journalDirectory, 'last-result.json'), summary); return summary;
    } finally { client.dispose(); keypair.secretKey.fill(0); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 4);
    const result = await runExternalLive(resolve(process.argv[2]), process.argv[3]);
    console.log(JSON.stringify(result, null, 2)); if (result.failed) process.exitCode = 1;
  } catch {
    console.error('Independent SDK acceptance stopped before completion. Inspect the same private configuration and retained journal; no secret error detail is printed.'); process.exitCode = 1;
  }
}
