/** stdin/stdout bridge. Errors are deliberately fixed; RPC URLs and fee keys
 * never appear in diagnostics. The only network mutation is explicit recover. */
import { readFile, stat } from 'node:fs/promises';
import { Connection } from '@solana/web3.js';
import { challengePlan, challengerWallet, recoverChallengeOnConnection, signChallengeStep, refreshChallengeUpload, type ChallengePlan } from './challenger.ts';
import { connectionTransport, fetchFinalizedBuffer, restorePlan, readBuffer, closePayload, prepareAttempt, type Attempt } from './transport.ts';

try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of process.stdin) { size += part.length; if (size > 2_000_000) throw new Error('input limit'); chunks.push(part); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  let result: unknown;
  if (input.command === 'plan') {
    const plan = await challengePlan(input.plan as ChallengePlan);
    result = { buffer: plan.buffer.toBase58(), steps: plan.steps.map(step => step.kind) };
  } else if (input.command === 'prepare') {
    const info = await stat(input.keyFile);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('private key file mode');
    const wallet = challengerWallet(Uint8Array.from(JSON.parse(await readFile(input.keyFile, 'utf8'))));
    result = await signChallengeStep(input.plan, input.stepIndex, input.blockhash, wallet);
  } else if (input.command === 'inspect-buffer' || input.command === 'prepare-close') {
    const attempt = input.attempt as Attempt;
    if (attempt.plan.operation !== 'challenge_escape') throw new Error('challenger operation');
    const plan = await restorePlan(attempt.plan);
    if (input.command === 'inspect-buffer') {
      const url = new URL(input.rpcUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('RPC transport');
      const connection = new Connection(input.rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true});
      const requestedSlot=input.minContextSlot??plan.snapshot.slot;
      if(!Number.isSafeInteger(requestedSlot)||requestedSlot<0)throw new Error('invalid minimum buffer slot');
      const minContextSlot=Math.max(plan.snapshot.slot,requestedSlot);
      const account = await connection.getAccountInfoAndContext(plan.buffer,{commitment:'finalized',minContextSlot});
      if(!Number.isSafeInteger(account.context.slot)||account.context.slot<minContextSlot)throw new Error('stale finalized buffer observation');
      if(account.value) await readBuffer(plan,{address:plan.buffer,owner:account.value.owner,data:account.value.data,slot:account.context.slot,commitment:'finalized'});
      const block = await connection.getBlock(account.context.slot,{commitment:'finalized',transactionDetails:'none',maxSupportedTransactionVersion:1,rewards:false});
      if(!block)throw new Error('buffer block missing');
      result={absent:account.value===null,slot:account.context.slot,blockhash:block.blockhash};
    } else {
      const info=await stat(input.keyFile);
      if(!info.isFile() || (process.platform!=='win32' && (info.mode&0o077)!==0))throw new Error('private key file mode');
      const wallet=challengerWallet(Uint8Array.from(JSON.parse(await readFile(input.keyFile,'utf8'))));
      result=await prepareAttempt(plan,await closePayload(plan),input.blockhash,[wallet],{save:async()=>{}});
    }
  } else if (input.command === 'refresh') {
    const attempt = input.attempt as Attempt;
    if (!['create', 'append', 'seal'].includes(attempt.kind)) throw new Error('financial refresh prohibited');
    const url = new URL(input.rpcUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC transport');
    const connection = new Connection(input.rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true });
    const plan = await restorePlan(attempt.plan);
    const account = await fetchFinalizedBuffer(connection, plan);
    const blockhash = await connection.getLatestBlockhash('finalized');
    const info = await stat(input.keyFile);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('private key file mode');
    const wallet = challengerWallet(Uint8Array.from(JSON.parse(await readFile(input.keyFile, 'utf8'))));
    const reconciliation = await refreshChallengeUpload(attempt, connectionTransport(connection), account, blockhash, wallet);
    const block = await connection.getBlock(reconciliation.accountSlot, { commitment: 'finalized', transactionDetails: 'none', maxSupportedTransactionVersion: 1, rewards: false });
    if (!block) throw new Error('reconciliation block missing');
    result = { ...reconciliation, blockhash: block.blockhash };
  } else if (input.command === 'recover') {
    const url = new URL(input.rpcUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC transport');
    result = await recoverChallengeOnConnection(input.attempt as Attempt, new Connection(input.rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true }));
  } else throw new Error('command');
  process.stdout.write(JSON.stringify(result));
} catch { process.stderr.write('challenger transport failed\n'); process.exitCode = 1; }
