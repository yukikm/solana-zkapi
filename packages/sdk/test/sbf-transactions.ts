import {fixtureSigner, type FixtureSigner, signWith, kitAddress, encodeTransaction} from './kit-helpers.ts';
/** Test-only real-proof fixture bridge for the Rust LiteSVM harness. Never contacts an RPC. */
/** Test-only real-proof fixture bridge for the Rust LiteSVM harness. Never contacts an RPC. */
import { readFileSync } from 'node:fs';

import { encodeLayout2Args, fromHex } from '../src/layout2.ts';
import type { Operation, PublicProof } from '../src/layout2.ts';
import { buildUploadPlan, compileV0, finalizeEscape, signV0, vaultAccounts } from '../src/transport.ts';
import type { V0Wallet } from '../src/transport.ts';
const arg = (name: string) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`); return process.argv[i + 1]; };
const blockhash = arg('--blockhash'), scenario = arg('--scenario');
if (!['close', 'challenge', 'finalize', 'expiry'].includes(scenario)) throw new Error('unknown scenario');
const payer = (await fixtureSigner(new Uint8Array(32).fill(1))), uploader = (await fixtureSigner(new Uint8Array(32).fill(10)));
const wallet = (key: FixtureSigner): V0Wallet => ({ publicKey: key.address, supportedTransactionVersions: new Set([0]), signTransaction: async transaction => { transaction = await signWith(transaction, [key]); return transaction; } });
interface Fixture { id: number; program_id: string; pool: string; mint: string; commitment: string; expiry: number; deposit: number; destination_owner: string; auth: Record<string, PublicProof>; trees: PublicProof[] }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/vault/${name}.json`, import.meta.url), 'utf8'));
const a = fixture('a'), ab = fixture('a-with-b'), ba = fixture('b-with-a');
const transactions: { name: string; base64: string; unix_timestamp: string; expected_ok: boolean }[] = [];
let nonce = 0;
async function add(f: Fixture, operation: Operation | 'finalize_escape', timestamp = 3000000000n) {
  const programId = kitAddress(fromHex(f.program_id, 32)), pool = kitAddress(fromHex(f.pool, 32)), mint = kitAddress(fromHex(f.mint, 32));
  const financial = (await vaultAccounts({ programId, pool, mint, noteId: f.id, payer: payer.address, operation, tokenOwner: payer.address,
    destinationOwner: kitAddress(fromHex(f.destination_owner, 32)), treasuryOwner: kitAddress(new Uint8Array(32).fill(8)), nullifier: fromHex(f.auth.escape.public_inputs[11].slice(2), 32) }));
  if (operation === 'finalize_escape') {
    const step = await finalizeEscape(programId, financial, f.id);
    const signed = await signV0(compileV0(step.instruction, payer.address, blockhash), [wallet(payer)]);
    transactions.push({ name: operation, base64: Buffer.from(encodeTransaction(signed)).toString('base64'), unix_timestamp: timestamp.toString(), expected_ok: true }); return;
  }
  let payload: Uint8Array;
  if (operation === 'deposit') payload = encodeLayout2Args({ operation, expectedId: f.id, expectedRoot: f.trees[0].public_inputs[1], expiry: BigInt(f.expiry), commitment: '0x' + f.commitment, amount: BigInt(f.deposit), tree: f.trees[0] });
  else if (operation === 'challenge_escape') payload = encodeLayout2Args({ operation, noteId: f.id, auth: f.auth.request, tree: f.trees[2] });
  else if (operation === 'claim_expired') payload = encodeLayout2Args({ operation, noteId: f.id, tree: f.trees[1] });
  else payload = encodeLayout2Args({ operation, auth: f.auth[operation === 'mutual_close' ? 'withdrawal' : 'escape'], tree: f.trees[1] });
  const plan = await buildUploadPlan({ programId, pool, uploader: uploader.address, feePayer: payer.address, rentPayer: payer.address,
    nonce: new Uint8Array(32).fill(++nonce), expires: timestamp + 3600n, operation, payload, financial, snapshot: { slot: 0, sequence: 0n } });
  for (const step of plan.steps) {
    const signed = await signV0(compileV0(step.instruction, payer.address, blockhash), [wallet(payer), wallet(uploader)]);
    transactions.push({ name: `${operation}-${nonce}-${step.kind}${step.offset === undefined ? '' : '-' + step.offset}`, base64: Buffer.from(encodeTransaction(signed)).toString('base64'), unix_timestamp: timestamp.toString(), expected_ok: true });
  }
}
await add(a, 'deposit');
if (scenario === 'close') await add(a, 'mutual_close');
if (scenario === 'challenge') { await add(ba, 'deposit'); await add(ab, 'initiate_escape'); await add(ab, 'challenge_escape'); }
if (scenario === 'finalize') { await add(a, 'initiate_escape'); await add(a, 'finalize_escape', 3000086400n); }
if (scenario === 'expiry') await add(a, 'claim_expired', BigInt(a.expiry));
console.log(JSON.stringify({ transactions }));
