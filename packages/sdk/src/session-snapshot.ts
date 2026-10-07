/** Private authorization reads: all network selectors are common to the pool.
 * Financial recovery deliberately retains the separate Note/Pending PDA checks.
 * A content hash identifies bytes; the finalized TreeState authenticates them. */
import { Buffer } from 'buffer';
import { address, getAddressEncoder, getAddressDecoder, getProgramDerivedAddress, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { decodeRpcAccount, safeRpcNumber } from './solana-rpc.ts';
const SYSVAR_CLOCK_ADDRESS = address('SysvarC1ock11111111111111111111111111111111');
import { parseField, parseMicroUsdc } from './encoding.ts';
import { discriminator } from './transport.ts';
import { hex } from './layout2.ts';
import { jcsBytes, parseStrictJson, sha256Hex, verifyPoolConfig, type VerifiedManifest } from './trust.ts';

export const MAX_SESSION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_SNAPSHOT_NOTES = 16_384;
export interface SnapshotNote { note_id: string; commitment: string; deposit_micro_usdc: string; expiry: string }
export interface SnapshotPath { root: string; note_id: number; siblings: string[] }
export interface SnapshotPathProver {
  snapshotPath(root: string, nextNoteId: string, notes: readonly SnapshotNote[], noteId: number): Promise<SnapshotPath>;
}
export interface SessionSnapshot {
  root: string; siblings: string[]; slot: number; sequence: string; nextNoteId: number; clock: string; paused: boolean;
}
export interface SessionSnapshotSource {
  /** Required for authorization; optional only on finance-only custom adapters. */
  sessionSnapshot?(noteId: number, prover: SnapshotPathProver, minimumSlot?: number): Promise<SessionSnapshot>;
}
export function authorizationSnapshot(chain: SessionSnapshotSource, noteId: number, prover: SnapshotPathProver, minimumSlot = 0): Promise<SessionSnapshot> {
  if (typeof chain.sessionSnapshot !== 'function') throw Error('private authorization snapshot adapter required');
  return chain.sessionSnapshot(noteId, prover, minimumSlot);
}
function requireTrue(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function record(v: any, keys: string[]): void {
  requireTrue(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'snapshot schema');
}
function uint(v: unknown): bigint {
  requireTrue(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20 && BigInt(v) <= 0xffffffffffffffffn, 'snapshot integer');
  return BigInt(v);
}
function key(value: unknown): void {
  requireTrue(typeof value === 'string' && address(value) === value, 'snapshot public key');
}
function rootView(root: any, pool: string): void {
  record(root, ['pool','root','slot','blockhash','sequence','next_note_id']);
  requireTrue(root.pool === pool && uint(root.slot) <= BigInt(Number.MAX_SAFE_INTEGER) && uint(root.next_note_id) <= (1n << 32n), 'indexer snapshot identity');
  uint(root.sequence); parseField(root.root); key(root.blockhash);
}
async function read(fetcher: typeof fetch, url: string, max: number): Promise<Uint8Array> {
  const response = await fetcher(url, { credentials:'omit', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(30_000) });
  requireTrue(response.ok, 'finalized indexer unavailable');
  const reader=response.body?.getReader(); requireTrue(reader, 'indexer body');
  const parts:Uint8Array[]=[]; let size=0;
  try {
    for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; requireTrue(size<=max,'snapshot response bound'); parts.push(value); }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(parts));
}

export async function privateSessionSnapshot(connection: Rpc<SolanaRpcApi>, manifest: VerifiedManifest, origin: string,
  fetcher: typeof fetch, noteId: number, prover: SnapshotPathProver, minimumSlot = 0): Promise<SessionSnapshot> {
  requireTrue(Number.isSafeInteger(noteId) && noteId >= 0 && noteId <= 0xffffffff, 'snapshot note ID');
  requireTrue(Number.isSafeInteger(minimumSlot) && minimumSlot >= 0, 'invalid minimum snapshot slot');
  const descriptor:any=parseStrictJson(await read(fetcher, origin+'/zkapi/v1/tree/snapshot', 65536));
  record(descriptor, ['snapshot','sha256','download_url']); rootView(descriptor.snapshot,manifest.pool);
  requireTrue(typeof descriptor.sha256==='string' && /^[0-9a-f]{64}$/.test(descriptor.sha256), 'snapshot digest');
  const path='/zkapi/v1/tree/snapshots/'+descriptor.sha256+'.json';
  requireTrue(typeof descriptor.download_url==='string', 'snapshot download URL');
  const supplied=new URL(descriptor.download_url);
  requireTrue(!supplied.username&&!supplied.password&&!supplied.search&&!supplied.hash&&supplied.pathname===path
    &&(supplied.protocol==='https:'||supplied.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(supplied.hostname)), 'snapshot download URL');
  // A relay may use a different logical origin. Only the validated digest path
  // selects the download; never follow the descriptor's origin or redirects.
  const bytes=await read(fetcher, origin+path, MAX_SESSION_SNAPSHOT_BYTES);
  requireTrue(await sha256Hex(bytes)===descriptor.sha256, 'snapshot digest mismatch');
  const file:any=parseStrictJson(bytes, MAX_SESSION_SNAPSHOT_BYTES);
  record(file, ['schema_version','snapshot','active_notes','pending_withdrawals']);
  requireTrue(file.schema_version==='1', 'snapshot schema version'); rootView(file.snapshot,manifest.pool);
  requireTrue(hex(jcsBytes(file.snapshot))===hex(jcsBytes(descriptor.snapshot)), 'snapshot descriptor mismatch');
  requireTrue(hex(jcsBytes(file))===hex(bytes), 'noncanonical snapshot');
  requireTrue(Array.isArray(file.active_notes)&&Array.isArray(file.pending_withdrawals)
    &&file.active_notes.length+file.pending_withdrawals.length<=MAX_SESSION_SNAPSHOT_NOTES,'snapshot note bound');
  const next=uint(file.snapshot.next_note_id), active=new Set<number>();
  for (const [pending,notes] of [[false,file.active_notes],[true,file.pending_withdrawals]] as const) {
    let last=-1;
    for (const item of notes) {
      record(item,pending?['note_id','commitment','deposit_micro_usdc','expiry','nullifier','balance_micro_usdc','destination_owner','deadline','old_root']
        :['note_id','commitment','deposit_micro_usdc','expiry']);
      const id=uint(item.note_id);
      requireTrue(id<next&&id<=0xffffffffn&&Number(id)>last,'snapshot note order');last=Number(id);
      parseField(item.commitment);requireTrue(parseMicroUsdc(item.deposit_micro_usdc)>0n&&uint(item.expiry)>0n,'snapshot note amount/expiry');
      if (pending) {
        requireTrue(!active.has(Number(id))&&parseMicroUsdc(item.balance_micro_usdc)<=parseMicroUsdc(item.deposit_micro_usdc),'snapshot pending overlap/balance');
        parseField(item.nullifier);parseField(item.old_root);key(item.destination_owner);uint(item.deadline);
      } else active.add(Number(id));
    }
  }
  // Pending fields are syntax checked only; the active root does not authenticate
  // them. They must never supply withdrawal/finalization decisions here.
  const root=file.snapshot,program=address(manifest.program_id),pool=address(manifest.pool);
  const [tree,treeBump]=await getProgramDerivedAddress({seeds:[Buffer.from('tree'),getAddressEncoder().encode(pool)],programAddress:program});
  const sourceSlot=Number(root.slot), minimum=Math.max(sourceSlot,minimumSlot);
  const header=(slot:number)=>connection.getBlock(BigInt(slot),{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:1}).send();
  const [genesis,sourceBlock,accounts]=await Promise.all([connection.getGenesisHash().send(),header(sourceSlot),
    connection.getMultipleAccounts([pool,tree,SYSVAR_CLOCK_ADDRESS],{commitment:'finalized',minContextSlot:BigInt(minimum),encoding:'base64'}).send()]);
  const slot=safeRpcNumber(accounts.context.slot,'finalized account slot');
  requireTrue(Number.isSafeInteger(slot)&&slot>=minimum&&accounts.value.length===3&&sourceBlock&&sourceBlock.blockhash===root.blockhash,'RPC/indexer finalized cut changed; retry snapshot');
  const accountBlock=slot===sourceSlot?sourceBlock:await header(slot);
  requireTrue(accountBlock,'RPC finalized account cut block missing or invalid');key(accountBlock.blockhash);
  const [poolAccount,treeAccount,clock]=accounts.value.map(decodeRpcAccount);
  requireTrue(poolAccount&&treeAccount&&clock,'missing finalized accounts');
  const checked=await verifyPoolConfig(manifest,genesis,{address:manifest.pool,owner:poolAccount.owner,executable:poolAccount.executable,
    lamports:BigInt(poolAccount.lamports),data:poolAccount.data,slot:BigInt(slot),commitment:'finalized'},BigInt(minimumSlot));
  requireTrue(treeAccount.owner===program&&!treeAccount.executable&&treeAccount.data.length===66
    &&treeAccount.data[8]===2&&treeAccount.data[9]===treeBump&&hex(treeAccount.data.subarray(0,8))===hex(await discriminator('TreeState','account')),'invalid finalized TreeState');
  const t=new DataView(treeAccount.data.buffer,treeAccount.data.byteOffset,treeAccount.data.length);
  requireTrue('0x'+hex(treeAccount.data.subarray(10,42))===root.root&&t.getBigUint64(42,true)===next&&t.getBigUint64(50,true)===uint(root.sequence),'untrusted indexer root');
  requireTrue(clock.owner==='Sysvar1111111111111111111111111111111111111'&&!clock.executable&&clock.data.length===40,'invalid Clock');
  const time=new DataView(clock.data.buffer,clock.data.byteOffset,clock.data.length).getBigInt64(32,true);requireTrue(time>=0n,'invalid Clock time');
  // Membership selection happens after all shared network reads. Both success
  // and missing-note failures expose the same pool/snapshot selectors.
  requireTrue(active.has(noteId),'active snapshot membership');
  const local=await prover.snapshotPath(root.root,root.next_note_id,file.active_notes,noteId);
  requireTrue(local.root===root.root&&local.note_id===noteId&&Array.isArray(local.siblings)&&local.siblings.length===32,'local snapshot path identity');
  local.siblings.forEach(parseField);
  return {root:root.root,siblings:local.siblings,slot,sequence:root.sequence,nextNoteId:Number(next),clock:time.toString(),paused:checked.paused};
}
