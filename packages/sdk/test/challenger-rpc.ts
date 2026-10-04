/** Local synthetic JSON-RPC outcomes over an actual-SBF archive. This fixture
 * tests process/persistence/orchestration, not an independent validator. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { discriminator } from '../src/transport.ts';
const root=new URL('../../../',import.meta.url);
const history=JSON.parse(readFileSync(new URL('target/i04/sdk-svm-history.json',root),'utf8'));
const scenario=history.scenarios.find((s:any)=>s.name==='challenge'), cut=scenario.checkpoints[2], tip=cut.slot;
const a=JSON.parse(readFileSync(new URL('tests/fixtures/vault/a.json',root),'utf8'));
const genesis=new PublicKey(Buffer.from(a.genesis.replace(/^0x/,''),'hex')).toBase58();
const block=scenario.blocks.find((b:any)=>b.slot===tip).block;
const execute=Buffer.from(await discriminator('execute_payload'));
const create=Buffer.from(await discriminator('create_payload')),append=Buffer.from(await discriminator('append_payload')),seal=Buffer.from(await discriminator('seal_payload'));
const close=Buffer.from(await discriminator('close_payload'));
const bufferDisc=Buffer.from(await discriminator('PayloadBuffer','account'));
const buffers=new Map<string,{raw:Buffer,owner:string}>();
const records=new Map<string,{tx:VersionedTransaction,err:unknown}>();
let mode='normal', sends=0, failedOnce=false, lostOnce=false;
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')), p=body.params;
    let result:any;
    switch(body.method){
      case 'testSetMode':mode=p[0];result=true;break;
      case 'testStats':result={sends,signatures:[...records.keys()]};break;
      case 'getGenesisHash':result=mode==='wrong-genesis'?'wrong-genesis':genesis;break;
      case 'getSlot':result=tip;break;
      case 'getBlocks':result=scenario.blocks.map((b:any)=>b.slot).filter((s:number)=>s>=p[0]&&s<=p[1]);break;
      case 'getBlock':result=scenario.blocks.find((b:any)=>b.slot===p[0]).block;break;
      case 'getMultipleAccounts':result={context:{slot:tip},value:p[0].map((k:string)=>cut.accounts[k])};break;
      case 'getAccountInfo':{
        const b=buffers.get(p[0]);result={context:{slot:tip},value:b?{owner:b.owner,lamports:10000000,executable:false,rentEpoch:0,data:[b.raw.toString('base64'),'base64']}:cut.accounts[p[0]]??null};break;
      }
      case 'getLatestBlockhash':result={context:{slot:tip},value:{blockhash:mode==='expired'?new PublicKey(new Uint8Array(32).fill(99)).toBase58():block.blockhash,lastValidBlockHeight:mode==='expired'?100100:100000}};break;
      case 'getBlockHeight':result=mode==='expired'?100001:50;break;
      case 'getSignatureStatuses':result={context:{slot:tip},value:p[0].map((sig:string)=>records.has(sig)&&mode!=='expired'?{slot:tip,confirmations:mode==='confirmed'?1:null,confirmationStatus:mode==='confirmed'?'confirmed':'finalized',err:records.get(sig)!.err}:null)};break;
      case 'getTransaction':{
        const record=records.get(p[0]);
        if(!record||mode==='confirmed'||mode==='expired'){result=null;break;}
        const tx=record.tx,m=tx.message;
        result={slot:tip,blockTime:block.blockTime,version:0,meta:{err:record.err,fee:5000,preBalances:[],postBalances:[],logMessages:[],preTokenBalances:[],postTokenBalances:[],rewards:[],loadedAddresses:{writable:[],readonly:[]}},transaction:{signatures:tx.signatures.map(s=>bs58.encode(s)),message:{header:m.header,accountKeys:m.staticAccountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,instructions:m.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,accounts:[...i.accountKeyIndexes],data:bs58.encode(i.data)})),addressTableLookups:[]}}};break;
      }
      case 'sendTransaction':{
        const tx=VersionedTransaction.deserialize(Buffer.from(p[0],'base64')),signature=bs58.encode(tx.signatures[0]);sends++;
        const isExecute=tx.message.compiledInstructions.some(i=>Buffer.from(i.data).subarray(0,8).equals(execute));
        const isAppend=tx.message.compiledInstructions.some(i=>Buffer.from(i.data).subarray(0,8).equals(append));
        const err=!failedOnce && (mode==='stale-once'&&isExecute || mode==='buffer-expired'&&isExecute || mode==='upload-rejected'&&isAppend)?{InstructionError:[1,{Custom:mode==='stale-once'?6006:6017}]}:null;
        if(err)failedOnce=true;
        if(err===null)for(const ix of tx.message.compiledInstructions){
          const data=Buffer.from(ix.data),keys=ix.accountKeyIndexes.map(i=>tx.message.staticAccountKeys[i]);
          if(data.subarray(0,8).equals(create)){
            const length=data.readUInt32LE(9),raw=Buffer.alloc(160+length),program=tx.message.staticAccountKeys[ix.programIdIndex];
            const nonce=data.subarray(45,77),bump=PublicKey.findProgramAddressSync([Buffer.from('payload'),keys[1].toBuffer(),keys[2].toBuffer(),nonce],program)[1];
            bufferDisc.copy(raw);raw[8]=2;raw[9]=bump;keys[2].toBuffer().copy(raw,10);raw[42]=data[8];raw.writeUInt32LE(length,43);data.subarray(13,45).copy(raw,47);data.subarray(77,85).copy(raw,84);keys[3].toBuffer().copy(raw,92);raw.writeUInt32LE(length,124);nonce.copy(raw,128+length);buffers.set(keys[0].toBase58(),{raw,owner:program.toBase58()});
          } else if(data.subarray(0,8).equals(append)){
            const b=buffers.get(keys[0].toBase58())!;const offset=data.readUInt32LE(8),length=data.readUInt32LE(12);data.subarray(16).copy(b.raw,128+offset);b.raw.writeUInt32LE(offset+length,79);
          } else if(data.subarray(0,8).equals(seal)){buffers.get(keys[0].toBase58())!.raw[83]=1;} else if(data.subarray(0,8).equals(close)){buffers.delete(keys[0].toBase58());}
        }
        records.set(signature,{tx,err});
        if(mode==='lose-once'&&!lostOnce){lostOnce=true;req.socket.destroy();return;}
        result=signature;break;
      }
      default:throw new Error('fixture method');
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  }catch{res.statusCode=500;res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:(server.address() as any).port})+'\n'));
