/** Transport fixtures exercise privacy selectors and fail-closed trust checks.
 * Original Poseidon reconstruction is tested separately in the native/WASM prover. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { SolanaWalletChain } from '../src/wallet-chain.ts';
import { authorizationSnapshot, MAX_SESSION_SNAPSHOT_BYTES, type SnapshotPathProver } from '../src/session-snapshot.ts';
import { discriminator } from '../src/transport.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';
import { chainFixture, key } from './chain-fixture.ts';

const field=(n:number)=>'0x'+BigInt(n).toString(16).padStart(64,'0');
async function fixture() {
  const {manifest,poolData}=await chainFixture();
  const program=new PublicKey(manifest.program_id),pool=new PublicKey(manifest.pool);
  const [tree,bump]=PublicKey.findProgramAddressSync([Buffer.from('tree'),pool.toBytes()],program);
  const root={pool:manifest.pool,root:field(1),slot:'100',blockhash:key(8),sequence:'7',next_note_id:'3'};
  const note=(id:number)=>({note_id:String(id),commitment:field(42+id),deposit_micro_usdc:'100',expiry:'3000000000'});
  const file={schema_version:'1',snapshot:root,active_notes:[note(0),note(2)],pending_withdrawals:[] as any[]};
  const treeData=Buffer.alloc(66);treeData.set(await discriminator('TreeState','account'));treeData[8]=2;treeData[9]=bump;
  treeData.set(Buffer.from(root.root.slice(2),'hex'),10);treeData.writeBigUInt64LE(3n,42);treeData.writeBigUInt64LE(7n,50);
  const clock=Buffer.alloc(40);clock.writeBigInt64LE(2600n,32);
  const account=(data:Buffer,owner=manifest.program_id)=>({owner,executable:false,lamports:1,rentEpoch:0,data});
  const accounts:(ReturnType<typeof account>|null)[]=[account(poolData),account(treeData),account(clock,'Sysvar1111111111111111111111111111111111111')];
  const state={slot:110,sourceHash:key(8),targetHash:key(9),genesis:manifest.genesis_hash,missingBlock:false,
    descriptor:(d:any)=>d, bytes:(b:Uint8Array)=>b, corruptDigest:false, proverFault:''};
  const urls:string[]=[],rpc:{method:string;params:any[]}[]=[],local:number[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('http://127.0.0.1:19891')) {
      urls.push(String(url));assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
      const bytes=state.bytes(jcsBytes(file)),digest=await sha256Hex(bytes);
      if(String(url).endsWith('/snapshot'))return Response.json(state.descriptor({snapshot:root,sha256:digest,
        download_url:'https://logical-indexer.invalid/zkapi/v1/tree/snapshots/'+digest+'.json'}));
      assert.equal(new URL(String(url)).pathname,'/zkapi/v1/tree/snapshots/'+digest+'.json');
      return new Response(Buffer.from(state.corruptDigest?new Uint8Array([1]):bytes));
    }
    const {id,method,params}=JSON.parse(String(init?.body));rpc.push({method,params});let result:any;
    if(method==='getGenesisHash')result=state.genesis;
    else if(method==='getBlock')result=state.missingBlock?null:{blockhash:params[0]===100?state.sourceHash:state.targetHash,
      previousBlockhash:key(7),parentSlot:params[0]-1,blockHeight:params[0],blockTime:2600};
    else if(method==='getMultipleAccounts') {
      assert.deepEqual(params[0],[pool,tree,SYSVAR_CLOCK_PUBKEY].map(p=>p.toBase58()),'authorization reads only shared accounts');
      assert.equal(params[1].commitment,'finalized');
      result={context:{slot:state.slot},value:accounts.map(a=>a&&({...a,data:[a.data.toString('base64'),'base64']}))};
    } else throw Error('unexpected RPC '+method);
    return Response.json({jsonrpc:'2.0',id,result});
  };
  const prover:SnapshotPathProver={async snapshotPath(root,next,notes,id) {
    local.push(id);assert.equal(next,file.snapshot.next_note_id);assert.deepEqual(jcsBytes(notes),jcsBytes(file.active_notes));
    if(state.proverFault==='throw')throw Error('local root mismatch');
    return {root:state.proverFault==='root'?field(8):root,note_id:state.proverFault==='id'?99:id,
      siblings:Array(state.proverFault==='length'?31:32).fill(state.proverFault==='field'?'invalid':field(0))};
  }};
  const chain=new SolanaWalletChain(new Connection('http://127.0.0.1:19890',{fetch:fetcher}),manifest,'http://127.0.0.1:19891',{fetch:fetcher,allowLoopbackHttp:true});
  return {chain,prover,state,file,accounts,treeData,clock,urls,rpc,local};
}

test('different selected notes and missing membership have identical network selectors',async()=>{
  const f=await fixture();
  const run=async(id:number)=>{
    f.urls.length=0;f.rpc.length=0;
    const result=await f.chain.sessionSnapshot(id,f.prover,105).catch(e=>e);
    return {result,urls:[...f.urls],rpc:structuredClone(f.rpc)};
  };
  const a=await run(0),b=await run(2),missing=await run(1);
  if(a.result instanceof Error)throw a.result;
  if(b.result instanceof Error)throw b.result;
  assert.equal(a.result.clock,'2600');assert.equal(b.result.nextNoteId,3);
  assert.deepEqual(a.urls,b.urls);assert.deepEqual(a.rpc,b.rpc);
  assert.deepEqual(a.urls,missing.urls);assert.deepEqual(a.rpc,missing.rpc);
  assert.match(missing.result.message,/active snapshot membership/);
  assert.deepEqual(f.local,[0,2]);assert.equal(a.urls.length,2);
  assert(a.urls.every(u=>!u.includes('/notes/')&&!u.includes('logical-indexer')));
  assert.equal(a.rpc.find(c=>c.method==='getMultipleAccounts')!.params[1].minContextSlot,105);
  assert.equal('note' in a.result,false);assert.equal('pending' in a.result,false);
});

test('no authorization fallback to note-selecting finance adapters',()=>{
  let called=false;
  const finance={snapshot(){called=true;throw Error('must not call');}};
  assert.throws(()=>authorizationSnapshot(finance as any,0,{} as any),/private authorization snapshot adapter required/);
  assert.equal(called,false);
});

test('snapshot data, canonical form and descriptor identity are checked before proving',async()=>{
  const cases:((f:Awaited<ReturnType<typeof fixture>>)=>void)[]=[
    f=>{f.state.corruptDigest=true;},
    f=>{f.state.bytes=b=>new Uint8Array([...b,10]);},
    f=>{f.state.bytes=b=>Buffer.from(new TextDecoder().decode(b).replace('"schema_version":"1"','"schema_version":"1","schema_version":"1"'));},
    f=>{f.state.descriptor=d=>({...d,snapshot:{...d.snapshot,sequence:'8'}});},
    f=>{f.file.schema_version='2';},
    f=>{f.file.active_notes.push({...f.file.active_notes[0]});},
    f=>{f.file.active_notes.reverse();},
    f=>{f.file.active_notes[0].note_id='00';},
    f=>{f.file.active_notes[0].deposit_micro_usdc='0';},
    f=>{f.file.active_notes[0].commitment='0x'+'ff'.repeat(32);},
    f=>{f.file.active_notes[0].expiry='18446744073709551616';},
    f=>{f.file.snapshot.next_note_id='4294967297';},
    f=>{f.file.pending_withdrawals.push({...f.file.active_notes[0],nullifier:field(9),balance_micro_usdc:'90',destination_owner:key(11),deadline:'2700',old_root:field(3)});},
    f=>{f.file.active_notes=Array(16385).fill(f.file.active_notes[0]);},
    f=>{f.state.bytes=()=>new Uint8Array(MAX_SESSION_SNAPSHOT_BYTES+1);},
  ];
  for(const change of cases){const f=await fixture();change(f);await assert.rejects(f.chain.sessionSnapshot(0,f.prover));assert.equal(f.local.length,0);}
});

test('descriptor paths cannot redirect selected reads to an untrusted origin or endpoint',async()=>{
  for(const change of [(s:string)=>s.replace('/snapshots/','/notes/'),(s:string)=>s+'?id=0',(s:string)=>s+'#id=0',
    (s:string)=>s.replace('https:','http:'),(s:string)=>s.replace('https://','https://user:pass@')]) {
    const f=await fixture();f.state.descriptor=d=>({...d,download_url:change(d.download_url)});
    await assert.rejects(f.chain.sessionSnapshot(0,f.prover),/snapshot download URL/);
    assert.equal(f.urls.length,1);assert.equal(f.rpc.length,0);
  }
});

test('finalized tree root, sequence, next ID and independent pool/genesis pins cannot be substituted',async()=>{
  const changes:((f:Awaited<ReturnType<typeof fixture>>)=>void)[]=[
    f=>f.treeData.fill(0,10,42),f=>f.treeData.writeBigUInt64LE(4n,42),f=>f.treeData.writeBigUInt64LE(8n,50),
    f=>{f.accounts[0]!.owner=key(22);},f=>{f.accounts[0]!.data[42]^=1;},f=>{f.accounts[1]!.owner=key(22);},
    f=>{f.state.genesis=key(99);},f=>{f.state.sourceHash=key(99);},f=>{f.state.missingBlock=true;},
    f=>{f.state.slot=104;},f=>{f.state.slot=Number.MAX_SAFE_INTEGER+1;},f=>{f.state.targetHash='invalid';},
    f=>{f.accounts[2]!.owner=key(22);},f=>f.clock.writeBigInt64LE(-1n,32),f=>{f.accounts.pop();},
  ];
  for(const change of changes){const f=await fixture();change(f);await assert.rejects(f.chain.sessionSnapshot(0,f.prover,105));assert.equal(f.local.length,0);}
});

test('local verification failure and malformed worker output fail closed without network fallback',async()=>{
  for(const fault of ['throw','root','id','length','field']) {
    const f=await fixture();f.state.proverFault=fault;await assert.rejects(f.chain.sessionSnapshot(0,f.prover));
    assert.equal(f.urls.length,2);assert.equal(f.rpc.filter(c=>c.method==='getMultipleAccounts').length,1);
  }
});

test('invalid selected IDs and minimum slots are rejected before any network request',async()=>{
  for(const id of [-1,0.5,NaN,4294967296]){const f=await fixture();await assert.rejects(f.chain.sessionSnapshot(id,f.prover));assert.equal(f.urls.length,0);}
  for(const slot of [-1,0.5,NaN,Number.MAX_SAFE_INTEGER+1]){const f=await fixture();await assert.rejects(f.chain.sessionSnapshot(0,f.prover,slot));assert.equal(f.urls.length,0);}
});
