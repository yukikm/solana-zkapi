import {v0Message as transactionMessage} from './kit-helpers.ts';
import {transactionSignature} from '../src/solana.ts';
import {fixtureSigner, kitAddress, decodeTransaction, addressBytes} from './kit-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

import bs58 from 'bs58';
import { challengePlan, challengerWallet, recoverChallenge, signChallengeStep, refreshChallengeUpload, validateChallengeAttempt, type ChallengePlan } from '../src/challenger.ts';
import { encodeLayout2Args, fromHex, hex, concat, u32, u64, OPERATIONS } from '../src/layout2.ts';
import { discriminator, type BufferState, type FinalizedReceipt, type SignatureStatus, type TransportRpc } from '../src/transport.ts';
const a = JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/a-with-b.json', import.meta.url), 'utf8'));
const signer = (await fixtureSigner(new Uint8Array(32).fill(10)));
const input: ChallengePlan = { programId: kitAddress(fromHex(a.program_id, 32)), pool: kitAddress(fromHex(a.pool, 32)), mint: kitAddress(fromHex(a.mint, 32)), payer: signer.address, noteId: 0,
  payloadHex: hex(encodeLayout2Args({ operation: 'challenge_escape', noteId: 0, auth: a.auth.request, tree: a.trees[2] })), nonceHex: '87'.repeat(32), expires: '3000003600', slot: 3, sequence: '3' };
const blockhash = { blockhash: kitAddress(new Uint8Array(32).fill(9)), lastValidBlockHeight: 100 };
class Rpc implements TransportRpc {
  sent: Uint8Array[] = []; status: SignatureStatus | null = null; receipt: FinalizedReceipt | null = null; height = 10; fail = false;
  async signatureStatus() { return this.status; } async finalizedReceipt() { return this.receipt; } async finalizedBlockHeight() { return this.height; }
  async sendRawTransaction(bytes: Uint8Array) { this.sent.push(bytes.slice()); if (this.fail) throw new Error('lost response'); return transactionSignature(decodeTransaction(bytes)); }
}
test('challenger signs every real v0 step with the existing I04 plan and verifies restored bytes', async () => {
  const plan = await challengePlan(input);
  for (let i = 0; i < plan.steps.length; i++) {
    const attempt = await signChallengeStep(input, i, blockhash, (await challengerWallet(signer.secretKey)));
    assert.equal(attempt.kind, plan.steps[i].kind); assert.ok(attempt.wireHex.length / 2 <= 1232);
    assert.equal(transactionMessage(decodeTransaction(Buffer.from(attempt.wireHex, 'hex'))).version, 0);
    await validateChallengeAttempt(JSON.parse(JSON.stringify(attempt)));
  }
  await assert.rejects(signChallengeStep(input, 999, blockhash, (await challengerWallet(signer.secretKey))), /step/);
});
test('lost challenger execute response and restart rebroadcast exactly the same signature bytes', async () => {
  const plan = await challengePlan(input), rpc = new Rpc(); rpc.fail = true;
  const attempt = await signChallengeStep(input, plan.steps.length - 1, blockhash, (await challengerWallet(signer.secretKey)));
  assert.deepEqual(await recoverChallenge(attempt, rpc), { state: 'unknown' });
  const reopened = JSON.parse(JSON.stringify(attempt)); rpc.fail = false;
  assert.deepEqual(await recoverChallenge(reopened, rpc), { state: 'pending' });
  assert.deepEqual(rpc.sent[0], rpc.sent[1]); assert.equal(rpc.sent.length, 2);
  rpc.status = { slot: 20, confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6006 }] } };
  assert.deepEqual(await recoverChallenge(reopened, rpc), { state: 'pending' }); assert.equal(rpc.sent.length, 2);
  rpc.receipt = { signature: attempt.signature, message: new Uint8Array(decodeTransaction(rpc.sent[0]).messageBytes), slot: 20, err: null };
  assert.deepEqual(await recoverChallenge(reopened, rpc), { state: 'finalized', slot: 20 });
});
test('expired or forged challenger receipts never authorize replacement; finalized stale-root preserves historical proof', async () => {
  const plan = await challengePlan(input), rpc = new Rpc(); rpc.height = 101;
  const attempt = await signChallengeStep(input, plan.steps.length - 1, blockhash, (await challengerWallet(signer.secretKey)));
  assert.deepEqual(await recoverChallenge(attempt, rpc), { state: 'expired_reconcile_required' }); assert.equal(rpc.sent.length, 0);
  rpc.receipt = { signature: attempt.signature, message: new Uint8Array([1]), slot: 20, err: null };
  assert.deepEqual(await recoverChallenge(attempt, rpc), { state: 'unknown' });
  rpc.receipt.message = new Uint8Array(decodeTransaction(Buffer.from(attempt.wireHex, 'hex')).messageBytes);
  rpc.receipt.err = { InstructionError: [1, { Custom: 6006 }] };
  const recovery = await recoverChallenge(attempt, rpc); assert.equal(recovery.state, 'rejected');
  assert.equal(recovery.state === 'rejected' && recovery.needsNewProof, true);
  const corrupt = structuredClone(attempt); corrupt.wireHex = '00' + corrupt.wireHex.slice(2); await assert.rejects(recoverChallenge(corrupt, rpc));
});
test('native challenger bridge signs without RPC and rejects public fee keys with redacted diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zkapi-challenger-'));
  try {
    const path = join(directory, 'fee.json'); writeFileSync(path, JSON.stringify([...signer.secretKey]), { mode: 0o600 });
    const command = { command: 'prepare', plan: input, stepIndex: 0, blockhash, keyFile: path };
    const cli = new URL('../src/challenger-cli.ts', import.meta.url);
    const result = spawnSync(process.execPath, [cli.pathname], { input: JSON.stringify(command), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).kind, 'create');
    const invalid = spawnSync(process.execPath, [cli.pathname], { input: JSON.stringify({ ...command, keyFile: join(directory, 'secret-canary') }), encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.equal(invalid.stderr, 'challenger transport failed\n'); assert.equal(invalid.stdout, '');
  } finally { rmSync(directory, { recursive: true }); }
});

test('expired challenger append/seal uses finalized exact buffer prefix and a fresh hash; financial/missing buffer stays unresolved', async () => {
  const plan = await challengePlan(input), rpc = new Rpc(); rpc.height = 101;
  const wallet = (await challengerWallet(signer.secretKey));
  const fresh = { blockhash: kitAddress(new Uint8Array(32).fill(19)), lastValidBlockHeight: 200 };
  const account = async (offset: number, sealed = false): Promise<BufferState> => ({ address: plan.buffer, owner: plan.programId, slot: 50, commitment: 'finalized', data: concat(await discriminator('PayloadBuffer','account'), Uint8Array.of(2,plan.bump), addressBytes(plan.uploader),Uint8Array.of(OPERATIONS[plan.operation].op),u32(plan.payload.length),plan.digest,u32(offset),Uint8Array.of(sealed?1:0),u64(plan.expires),addressBytes(plan.rentPayer),u32(plan.payload.length),plan.payload.slice(0,offset),new Uint8Array(plan.payload.length-offset),plan.nonce) });
  const append = await signChallengeStep(input,1,blockhash,wallet);
  const retry = await refreshChallengeUpload(append,rpc,await account(0),fresh,wallet);
  assert.ok(retry.replacement); assert.equal(retry.nextStepIndex,1); assert.notEqual(retry.replacement.signature,append.signature);
  assert.equal(retry.replacement.planDigest,append.planDigest); assert.equal(retry.replacement.buffer,append.buffer);
  const progressed = await refreshChallengeUpload(append,rpc,await account(plan.steps[1].endOffset!),fresh,wallet);
  assert.equal(progressed.nextStepIndex,2); assert.equal(progressed.replacement,undefined);
  const sealIndex = plan.steps.findIndex(s=>s.kind==='seal'), seal = await signChallengeStep(input,sealIndex,blockhash,wallet);
  const reseal = await refreshChallengeUpload(seal,rpc,await account(plan.payload.length),fresh,wallet);
  assert.equal(reseal.nextStepIndex,sealIndex); assert.ok(reseal.replacement);
  const sealed = await refreshChallengeUpload(seal,rpc,await account(plan.payload.length,true),fresh,wallet);
  assert.equal(sealed.nextStepIndex,plan.steps.length-1); assert.equal(sealed.replacement,undefined);
  await assert.rejects(refreshChallengeUpload(append,rpc,null,fresh,wallet),/missing buffer/);
  const execute = await signChallengeStep(input,plan.steps.length-1,blockhash,wallet);
  await assert.rejects(refreshChallengeUpload(execute,rpc,await account(plan.payload.length,true),fresh,wallet),/only challenger upload/);
  assert.equal(rpc.sent.length,0);
});

test('priority fee is signed and immutable in each upload plan; chunk sizing still fits 1232 bytes', async () => {
  const priced = { ...input, priorityFeeMicroLamports: '100000' }, plan = await challengePlan(priced);
  const plain = await challengePlan(input);
  assert.ok(plan.steps[1].endOffset! < plain.steps[1].endOffset!);
  for(let i=0;i<plan.steps.length;i++){
    const attempt = await signChallengeStep(priced,i,blockhash,(await challengerWallet(signer.secretKey)));
    assert.equal(attempt.plan.priorityFeeMicroLamports,'100000');assert.ok(attempt.wireHex.length/2<=1232);
    await validateChallengeAttempt(attempt);
    const changed=structuredClone(attempt);changed.plan.priorityFeeMicroLamports='200000';
    await assert.rejects(validateChallengeAttempt(changed),/signed message/);
  }
});

test('challenger buffer absence inspection requires a finalized cut at the failure slot or later', async t => {
  const attempt=await signChallengeStep(input,0,blockhash,(await challengerWallet(signer.secretKey)));
  let slot=79;const minimums:number[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result:unknown;
    if(request.method==='getAccountInfo'){minimums.push(request.params[1].minContextSlot);result={context:{slot},value:null};}
    else if(request.method==='getBlock'){assert.equal(request.params[1].maxSupportedTransactionVersion,1);result={blockhash:blockhash.blockhash,previousBlockhash:blockhash.blockhash,parentSlot:slot-1,blockTime:null,blockHeight:slot};}
    else throw Error('unexpected fixture RPC');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const rpcUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const run=()=>new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>{
    const child=spawn(process.execPath,[new URL('../src/challenger-cli.ts',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('close',code=>resolve({code,stdout,stderr}));
    child.stdin.end(JSON.stringify({command:'inspect-buffer',attempt,rpcUrl,minContextSlot:80}));
  });
  const stale=await run();assert.equal(stale.code,1);assert.equal(stale.stdout,'');assert.equal(stale.stderr,'challenger transport failed\n');
  slot=80;const current=await run();assert.equal(current.code,0);assert.deepEqual(JSON.parse(current.stdout),{absent:true,slot:80,blockhash:blockhash.blockhash});assert.deepEqual(minimums,[80,80]);
});
