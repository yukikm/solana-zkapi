import {fixtureSigner, kitAddress} from './kit-helpers.ts';
/** Actual Vault SBF harness input. TEST fee key only, known-public entropy. */
/** Actual Vault SBF harness input. TEST fee key only, known-public entropy. */
import { readFileSync } from 'node:fs';

import { challengePlan, challengerWallet, signChallengeStep, type ChallengePlan } from '../src/challenger.ts';
import { fromHex } from '../src/layout2.ts';
import { closePayload, prepareAttempt } from '../src/transport.ts';
const root = new URL('../../../', import.meta.url), a = JSON.parse(readFileSync(new URL('tests/fixtures/vault/a.json', root), 'utf8'));
const secret = (await fixtureSigner(new Uint8Array(32).fill(10)));
const input: ChallengePlan = { programId: kitAddress(fromHex(a.program_id,32)), pool: kitAddress(fromHex(a.pool,32)), mint:kitAddress(fromHex(a.mint,32)), payer:secret.address, noteId:0, payloadHex:readFileSync(new URL('target/i09-challenger/generated-challenge.bin',root)).toString('hex'), nonceHex:(process.argv[4]==='cleanup'?'d4':'d3').repeat(32), expires:(BigInt(process.argv[3])+3600n).toString(), slot:1,sequence:'3',priorityFeeMicroLamports:'100000' };
const plan=await challengePlan(input), transactions=[];
for(let i=0;i<plan.steps.length;i++) transactions.push(await signChallengeStep(input,i,{blockhash:process.argv[2],lastValidBlockHeight:999999},(await challengerWallet(secret.secretKey))));
if(process.argv[4]==='cleanup')transactions.push(await prepareAttempt(plan,await closePayload(plan),{blockhash:process.argv[2],lastValidBlockHeight:999999},[(await challengerWallet(secret.secretKey))],{save:async()=>{}}));
process.stdout.write(JSON.stringify({buffer:plan.buffer,transactions}));
