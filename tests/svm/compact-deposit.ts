/** Test-only SDK / real proof bridge. No RPC, live wallet, or network calls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encodeLayout2Args, fromHex } from '../../packages/sdk/src/layout2.ts';
import { buildInlineDepositPlan, prepareInlineDepositAttempt, vaultAccounts } from '../../packages/sdk/src/transport.ts';
import type { InlineDepositAttempt, V0Wallet } from '../../packages/sdk/src/transport.ts';

const blockhash = process.argv[2];
assert(blockhash, 'provide the LiteSVM blockhash');
const f = JSON.parse(readFileSync(new URL('../fixtures/vault/a.json', import.meta.url), 'utf8'));
const owner = Keypair.fromSeed(new Uint8Array(32).fill(1));
const programId = new PublicKey(fromHex(f.program_id, 32));
const pool = new PublicKey(fromHex(f.pool, 32));
const mint = new PublicKey(fromHex(f.mint, 32));
const payload = encodeLayout2Args({ operation: 'deposit', expectedId: f.id,
  expectedRoot: f.trees[0].public_inputs[1], expiry: BigInt(f.expiry),
  commitment: `0x${f.commitment}`, amount: BigInt(f.deposit), tree: f.trees[0] });
const plan = await buildInlineDepositPlan({ deploymentId: 'local-sbf-compact-test', manifestHash: 'ab'.repeat(32),
  vaultBinding: f.trees[0].public_inputs[0], programId, pool, feePayer: owner.publicKey,
  payload, financial: vaultAccounts({ programId, pool, mint, noteId: f.id, payer: owner.publicKey,
    tokenOwner: owner.publicKey, operation: 'deposit' }), snapshot: { slot: 1, sequence: 0n },
  priorityFeeMicroLamports: 1n });
let signRequests = 0, durableSaves = 0;
const wallet: V0Wallet = { publicKey: owner.publicKey, supportedTransactionVersions: new Set([0]),
  async signTransaction(tx) { signRequests++; tx.sign([owner]); return tx; } };
let persisted: InlineDepositAttempt | undefined;
const attempt = await prepareInlineDepositAttempt(plan, { blockhash, lastValidBlockHeight: 100 }, [wallet],
  { async save(value) { durableSaves++; persisted = structuredClone(value); } });
assert.equal(signRequests, 1); assert.equal(durableSaves, 1); assert.deepEqual(attempt, persisted);
assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0].kind, 'deposit_inline');
assert.equal(Buffer.from(attempt.wireHex, 'hex').length, 1007);
console.log(JSON.stringify({ signRequests, durableSaves, attempt }));
