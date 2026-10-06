/** Finalized chain/indexer adapter. Every proof path is tied to one actual RPC
 * account cut; a self-reported indexer root alone is never a trust anchor. */
import { Buffer } from 'buffer';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { discriminator, fetchFinalizedBuffer, fetchFinalizedBufferObservation, resolvePreparationCommitment, type BufferState, type FinalizedBufferObservation, type UploadPlan, type TransactionPreparationCommitment } from './transport.ts';
import { hex, u32 } from './layout2.ts';
import { parseField } from './encoding.ts';
import { parseStrictJson, verifyPoolConfig, type VerifiedManifest } from './trust.ts';
import { privateSessionSnapshot, type SessionSnapshot, type SessionSnapshotSource, type SnapshotPathProver } from './session-snapshot.ts';
export interface WalletNote { note_id:number; registration_commitment:string; deposit_micro_usdc:string; expiry:string; status:'active'|'pending_escape'|'closed' }
export interface WalletSnapshot {
  root:string; siblings:string[]; slot:number; sequence:string; nextNoteId:number; clock:string; paused:boolean; treasuryOwner:string;
  note?:WalletNote; pending?:{nullifier:string;balance_micro_usdc:string;destinationOwner:string;deadline:string};
}
export interface WalletChain extends SessionSnapshotSource {
  snapshot(noteId?:number, path?:'active'|'zero'|'none', minimumSlot?:number):Promise<WalletSnapshot>;
  buffer(plan:UploadPlan,minimumSlot?:number):Promise<BufferState|null>;
  /** Required only by explicit expired-create reconciliation. */
  bufferObservation?(plan:UploadPlan,minimumSlot?:number):Promise<FinalizedBufferObservation>;
  blockhash():Promise<{blockhash:string;lastValidBlockHeight:number}>;
}
function integer(value:unknown):bigint { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value)>0xffffffffffffffffn) throw Error('invalid chain integer');return BigInt(value); }
export class SolanaWalletChain implements WalletChain {
  private readonly connection:Connection; private readonly manifest:VerifiedManifest; private readonly origin:string; private readonly fetcher:typeof fetch;
  private readonly preparationCommitment:TransactionPreparationCommitment;
  constructor(connection:Connection, manifest:VerifiedManifest, indexerOrigin:string, options:{fetch?:typeof fetch;allowLoopbackHttp?:boolean;preparationCommitment?:TransactionPreparationCommitment}={}) {
    this.preparationCommitment=resolvePreparationCommitment(options.preparationCommitment);
    const u=new URL(indexerOrigin);if(u.origin!==indexerOrigin||u.username||u.password||(u.protocol!=='https:'&&!(options.allowLoopbackHttp&&u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))) throw Error('trusted indexer origin required');
    this.connection=connection;this.manifest=manifest;this.origin=indexerOrigin;this.fetcher=options.fetch??fetch;
  }
  private async json(path:string):Promise<any> {
    const r=await this.fetcher(this.origin+path,{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(30_000)});
    if(!r.ok)throw Error('finalized indexer unavailable');
    const reader=r.body?.getReader();if(!reader)throw Error('indexer body');let length=0;const parts:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536)throw Error('indexer response bound');parts.push(value);}}finally{await reader.cancel();}
    return parseStrictJson(new Uint8Array(Buffer.concat(parts)));
  }
  sessionSnapshot(noteId:number,prover:SnapshotPathProver,minimumSlot=0):Promise<SessionSnapshot> {
    return privateSessionSnapshot(this.connection,this.manifest,this.origin,this.fetcher,noteId,prover,minimumSlot);
  }
  async snapshot(noteId?:number,path:'active'|'zero'|'none'='active',minimumSlot=0):Promise<WalletSnapshot> {
    if(!Number.isSafeInteger(minimumSlot)||minimumSlot<0)throw Error('invalid minimum snapshot slot');
    const m=this.manifest,program=new PublicKey(m.program_id),pool=new PublicKey(m.pool);
    let p:any;
    if(noteId===undefined){const root=await this.json('/zkapi/v1/tree/root');noteId=Number(integer(root.next_note_id));path='zero';}
    if(!Number.isInteger(noteId)||noteId<0||noteId>0xffffffff)throw Error('tree full or invalid note ID');
    if(path==='none')p={snapshot:await this.json('/zkapi/v1/tree/root'),siblings:[]};
    else p=await this.json(`/zkapi/v1/tree/notes/${noteId}/${path==='zero'?'zero-path':'path'}`);
    const root=p.snapshot;if(!root||root.pool!==m.pool||!Number.isSafeInteger(Number(integer(root.slot))))throw Error('indexer snapshot identity');
    if(path!=='none'&&(p.note_id!==String(noteId)||!Array.isArray(p.siblings)||p.siblings.length!==32))throw Error('indexer path identity');
    parseField(root.root);p.siblings.forEach(parseField);
    const derive=(seed:string,suffix?:Uint8Array)=>PublicKey.findProgramAddressSync([Buffer.from(seed),pool.toBytes(),...(suffix?[suffix]:[])],program);
    const [tree,treeBump]=derive('tree'),[note,noteBump]=derive('note',u32(noteId)),[pending,pendingBump]=derive('pending',u32(noteId));
    const sourceSlot=Number(root.slot),minimum=Math.max(sourceSlot,minimumSlot);
    const header=(slot:number)=>this.connection.getBlock(slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:1});
    const [genesis,sourceBlock,accounts]=await Promise.all([this.connection.getGenesisHash(),header(sourceSlot),this.connection.getMultipleAccountsInfoAndContext([pool,tree,note,pending,SYSVAR_CLOCK_PUBKEY],{commitment:'finalized',minContextSlot:minimum})]);
    const slot=accounts.context.slot;
    const validBlockhash=(value:unknown)=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value;}catch{return false;}};
    if(!Number.isSafeInteger(slot)||slot<minimum||accounts.value.length!==5||!sourceBlock||!validBlockhash(sourceBlock.blockhash)||sourceBlock.blockhash!==root.blockhash)throw Error('RPC/indexer finalized cut changed; retry snapshot');
    // The path's source block must remain authentic. An unchanged tree can then
    // be observed at a later finalized bank without requiring an idle cluster.
    // All account bytes below come from this ONE response, including Clock and
    // current Pool/Note/Pending state. Equal root alone is insufficient (ABA).
    const accountBlock=slot===sourceSlot?sourceBlock:await header(slot);
    if(!accountBlock||!validBlockhash(accountBlock.blockhash))throw Error('RPC finalized account cut block missing or invalid');
    const [poolAccount,treeAccount,noteAccount,pendingAccount,clock]=accounts.value;if(!poolAccount||!treeAccount||!clock)throw Error('missing finalized accounts');
    const checked=await verifyPoolConfig(m,genesis,{address:m.pool,owner:poolAccount.owner.toBase58(),executable:poolAccount.executable,lamports:BigInt(poolAccount.lamports),data:poolAccount.data,slot:BigInt(slot),commitment:'finalized'},BigInt(minimumSlot));
    const check=async(account:typeof treeAccount,name:string,len:number,bump:number)=>{
      if(!account||!account.owner.equals(program)||account.executable||account.data.length!==len||account.data[8]!==2||account.data[9]!==bump||hex(account.data.subarray(0,8))!==hex(await discriminator(name,'account')))throw Error('invalid finalized account');return new DataView(account.data.buffer,account.data.byteOffset,account.data.length);
    };
    const t=await check(treeAccount,'TreeState',66,treeBump);
    if('0x'+hex(treeAccount.data.subarray(10,42))!==root.root||t.getBigUint64(42,true)!==integer(root.next_note_id)||t.getBigUint64(50,true)!==integer(root.sequence))throw Error('untrusted indexer root');
    if(clock.owner.toBase58()!=='Sysvar1111111111111111111111111111111111111'||clock.executable||clock.data.length!==40)throw Error('invalid Clock');
    const cv=new DataView(clock.data.buffer,clock.data.byteOffset,clock.data.length);if(cv.getBigInt64(32,true)<0n)throw Error('invalid Clock time');
    const next=Number(integer(root.next_note_id));if(!Number.isSafeInteger(next)||next>0x100000000)throw Error('next note ID');
    const result:WalletSnapshot={root:root.root,siblings:p.siblings,slot,sequence:root.sequence,nextNoteId:next,clock:cv.getBigInt64(32,true).toString(),paused:checked.paused,treasuryOwner:checked.treasuryOwner};
    if(noteAccount){const n=await check(noteAccount,'Note',63,noteBump);if(n.getUint32(10,true)!==noteId||![1,2,3].includes(noteAccount.data[62]))throw Error('note identity');result.note={note_id:noteId,registration_commitment:'0x'+hex(noteAccount.data.subarray(14,46)),deposit_micro_usdc:n.getBigUint64(46,true).toString(),expiry:n.getBigUint64(54,true).toString(),status:({1:'active',2:'pending_escape',3:'closed'} as const)[noteAccount.data[62] as 1|2|3]};}
    if(pendingAccount){const q=await check(pendingAccount,'PendingWithdrawal',123,pendingBump);if(pendingAccount.data[10]>1)throw Error('invalid Pending');if(pendingAccount.data[10]===1)result.pending={nullifier:'0x'+hex(pendingAccount.data.subarray(43,75)),balance_micro_usdc:q.getBigUint64(75,true).toString(),destinationOwner:new PublicKey(pendingAccount.data.subarray(83,115)).toBase58(),deadline:q.getBigUint64(115,true).toString()};}
    if(result.note?.status==='pending_escape'&&!result.pending)throw Error('missing Pending');
    if(path==='active'&&result.note?.status!=='active'||path==='zero'&&noteId!==next&&result.note?.status!=='pending_escape')throw Error('path status mismatch');
    return result;
  }
  buffer(plan:UploadPlan,minimumSlot?:number):Promise<BufferState|null>{return fetchFinalizedBuffer(this.connection,plan,minimumSlot);}
  bufferObservation(plan:UploadPlan,minimumSlot?:number):Promise<FinalizedBufferObservation>{return fetchFinalizedBufferObservation(this.connection,plan,minimumSlot);}
  blockhash():Promise<{blockhash:string;lastValidBlockHeight:number}>{return this.connection.getLatestBlockhash(this.preparationCommitment);}
}
