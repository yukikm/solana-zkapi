/** Coherent finalized-cut adapter tests. Account mutations are local RPC fixtures;
 * no public network, transaction submission, or independent Merkle implementation. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Connection,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {SolanaWalletChain} from '../src/wallet-chain.ts';
import {discriminator} from '../src/transport.ts';
import {u32} from '../src/layout2.ts';
import {json,walletFixture} from './wallet-fixture.ts';

const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const field=(n:number)=>'0x'+BigInt(n).toString(16).padStart(64,'0');
async function fixture(status:'active'|'pending'|'closed'|'deposit'='active'){
  const {manifest}=await walletFixture(), exported=await json('target/i05/chain.json');
  const program=new PublicKey(manifest.program_id),pool=new PublicKey(manifest.pool);
  const derive=(name:string,suffix?:Uint8Array)=>PublicKey.findProgramAddressSync([Buffer.from(name),pool.toBytes(),...(suffix?[suffix]:[])],program);
  const [tree,treeBump]=derive('tree'),[note,noteBump]=derive('note',u32(0)),[pending,pendingBump]=derive('pending',u32(0));
  const state={sourceSlot:100,targetSlot:110,minimum:0,sourceHash:key(8),targetHash:key(9),missingSource:false,missingTarget:false};
  const root={pool:manifest.pool,root:field(1),slot:'100',blockhash:key(8),sequence:'7',next_note_id:status==='deposit'?'0':'1'};
  const account=(data:Buffer,owner=manifest.program_id)=>({owner,executable:false,lamports:1,rentEpoch:0,data});
  const bytes=async(name:string,length:number,bump:number)=>{const b=Buffer.alloc(length);b.set(await discriminator(name,'account'));b[8]=2;b[9]=bump;return b;};
  const poolAccount=account(Buffer.from(exported.pool_account.data[0],'base64'));
  const treeData=await bytes('TreeState',66,treeBump);treeData.set(Buffer.from(root.root.slice(2),'hex'),10);treeData.writeBigUInt64LE(BigInt(root.next_note_id),42);treeData.writeBigUInt64LE(7n,50);
  const noteData=await bytes('Note',63,noteBump);noteData.writeUInt32LE(0,10);noteData.set(Buffer.from(field(2).slice(2),'hex'),14);noteData.writeBigUInt64LE(100n,46);noteData.writeBigUInt64LE(3000000000n,54);noteData[62]=status==='pending'?2:status==='closed'?3:1;
  const pendingData=await bytes('PendingWithdrawal',123,pendingBump);pendingData[10]=1;pendingData.set(Buffer.from(field(3).slice(2),'hex'),11);pendingData.set(Buffer.from(field(4).slice(2),'hex'),43);pendingData.writeBigUInt64LE(90n,75);pendingData.set(new PublicKey(key(11)).toBytes(),83);pendingData.writeBigUInt64LE(2500n,115);
  const clock=Buffer.alloc(40);clock.writeBigUInt64LE(BigInt(state.targetSlot));clock.writeBigInt64LE(2600n,32);
  const accounts:(ReturnType<typeof account>|null)[]=[poolAccount,account(treeData),status==='deposit'?null:account(noteData),status==='pending'?account(pendingData):null,account(clock,'Sysvar1111111111111111111111111111111111111')];
  const calls:{method:string;params:any[]}[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('http://127.0.0.1:19891')){
      root.slot=String(state.sourceSlot);
      return Response.json(String(url).endsWith('/root')?root:{snapshot:root,note_id:'0',leaf:field(0),siblings:Array(32).fill(field(0))});
    }
    const request=JSON.parse(String(init?.body));const {method,params}=request;calls.push({method,params});let result:any;
    if(method==='getGenesisHash')result=manifest.genesis_hash;
    else if(method==='getBlock'){
      assert.equal(params[1].commitment,'finalized');assert.equal(params[1].transactionDetails,'none');assert.equal(params[1].maxSupportedTransactionVersion,1,'mixed-block reader cap does not change v0 transaction transport');
      const source=params[0]===state.sourceSlot;
      result=(source?state.missingSource:state.missingTarget)?null:{blockhash:source?state.sourceHash:state.targetHash,previousBlockhash:key(7),parentSlot:params[0]-1,blockHeight:params[0],blockTime:2600};
    }else if(method==='getMultipleAccounts'){
      assert.deepEqual(params[0],[pool,tree,note,pending,SYSVAR_CLOCK_PUBKEY].map(p=>p.toBase58()));
      assert.equal(params[1].commitment,'finalized');state.minimum=params[1].minContextSlot;
      result={context:{slot:state.targetSlot},value:accounts.map(a=>a&&({...a,data:[a.data.toString('base64'),'base64']}))};
    }else throw Error('unexpected RPC '+method);
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  };
  const connection=new Connection('http://127.0.0.1:19890',{fetch:fetcher});
  const chain=new SolanaWalletChain(connection,manifest,'http://127.0.0.1:19891',{fetch:fetcher,allowLoopbackHttp:true});
  return {chain,state,root,accounts,calls};
}

test('wallet snapshot promotes unchanged tree to one newer finalized account cut and propagates minimum slot',async()=>{
  const f=await fixture();f.accounts[0]!.data[355]=1;f.accounts[0]!.data.set(new PublicKey(key(12)).toBytes(),171);
  const s=await f.chain.snapshot(0,'active',105);
  assert.equal(f.state.minimum,105);assert.equal(s.slot,110);assert.equal(s.sequence,'7');assert.equal(s.root,f.root.root);
  assert.equal(s.clock,'2600');assert.equal(s.paused,true);assert.equal(s.treasuryOwner,key(12));assert.equal(s.note?.status,'active');
  assert.equal(f.calls.filter(c=>c.method==='getMultipleAccounts').length,1);
  assert.deepEqual(f.calls.filter(c=>c.method==='getBlock').map(c=>c.params[0]),[100,110]);
  f.state.sourceSlot=110;f.root.blockhash=f.state.sourceHash;f.calls.length=0;
  assert.equal((await f.chain.snapshot(0,'active',110)).slot,110);
  assert.equal(f.calls.filter(c=>c.method==='getBlock').length,1,'equal-slot path remains valid');
});

test('wallet snapshot refuses changed root, next ID and restored-root ABA sequence',async()=>{
  for(const change of ['root','next','sequence']){
    const f=await fixture();const tree=f.accounts[1]!.data;
    if(change==='root')tree.set(Buffer.from(field(5).slice(2),'hex'),10);
    if(change==='next')tree.writeBigUInt64LE(2n,42);
    if(change==='sequence')tree.writeBigUInt64LE(9n,50); // Old root restored after escape + challenge.
    await assert.rejects(f.chain.snapshot(0,'active'),/untrusted indexer root/,change);
  }
});

test('wallet snapshot refuses stale or unsafe account cuts and invalid minimums',async()=>{
  for(const slot of [99,104,-1,Number.MAX_SAFE_INTEGER+1,NaN]){
    const f=await fixture();f.state.targetSlot=slot;
    await assert.rejects(f.chain.snapshot(0,'active',105));
  }
  for(const minimum of [-1,NaN,0.5,Number.MAX_SAFE_INTEGER+1]){
    const f=await fixture();await assert.rejects(f.chain.snapshot(0,'active',minimum),/minimum snapshot slot/);assert.equal(f.calls.length,0);
  }
});

test('wallet snapshot requires authentic source block and present canonical finalized target block',async()=>{
  for(const fault of ['source-mismatch','source-missing','source-invalid','target-missing','target-invalid']){
    const f=await fixture();
    if(fault==='source-mismatch')f.state.sourceHash=key(13);
    if(fault==='source-missing')f.state.missingSource=true;
    if(fault==='source-invalid'){f.state.sourceHash='not-a-blockhash';f.root.blockhash=f.state.sourceHash;}
    if(fault==='target-missing')f.state.missingTarget=true;
    if(fault==='target-invalid')f.state.targetHash='not-a-blockhash';
    await assert.rejects(f.chain.snapshot(0,'active'),/finalized.*(cut|block)/,fault);
  }
});

test('advanced cut still validates Pool, Note, Pending and Clock account bytes',async()=>{
  for(const fault of ['pool-owner','pool-mint','tree-owner','note-owner','note-id','note-status','pending-owner','pending-flag','missing-pending','clock-owner','clock-time','account-count']){
    const f=await fixture('pending');
    if(fault==='pool-owner')f.accounts[0]!.owner=key(20);
    if(fault==='pool-mint')f.accounts[0]!.data[42]^=1;
    if(fault==='tree-owner')f.accounts[1]!.owner=key(20);
    if(fault==='note-owner')f.accounts[2]!.owner=key(20);
    if(fault==='note-id')f.accounts[2]!.data.writeUInt32LE(1,10);
    if(fault==='note-status')f.accounts[2]!.data[62]=4;
    if(fault==='pending-owner')f.accounts[3]!.owner=key(20);
    if(fault==='pending-flag')f.accounts[3]!.data[10]=2;
    if(fault==='missing-pending')f.accounts[3]=null;
    if(fault==='clock-owner')f.accounts[4]!.owner=key(20);
    if(fault==='clock-time')f.accounts[4]!.data.writeBigInt64LE(-1n,32);
    if(fault==='account-count')f.accounts.pop();
    await assert.rejects(f.chain.snapshot(0,'zero'),fault);
  }
  const pending=await fixture('pending'),s=await pending.chain.snapshot(0,'zero');
  assert.equal(s.slot,110);assert.equal(s.pending?.deadline,'2500');assert.equal(s.pending?.nullifier,field(4));assert.equal(s.note?.status,'pending_escape');
  const closed=await fixture('closed');assert.equal((await closed.chain.snapshot(0,'none',105)).note?.status,'closed');
  const deposit=await fixture('deposit');assert.equal((await deposit.chain.snapshot()).nextNoteId,0);
});
