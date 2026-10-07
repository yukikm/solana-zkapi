/** Synthetic public transport fixtures. No real chain/provider/proof or target state. */
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { chainFixture, key } from './chain-fixture.ts';
import { vaultBinding, parseField } from '../src/encoding.ts';
import { discriminator } from '../src/transport.ts';
import { circuitProfileDigest, jcsBytes, manifestDigest, sha256Hex, type Manifest } from '../src/trust.ts';
import type { PublicDeploymentProfile } from '../src/public-profile.ts';

export async function publicProfileFixture() {
  const f = await chainFixture(), m: { -readonly [K in keyof Manifest]: Manifest[K] } = structuredClone(f.manifest);
  m.deployment_environment = 'devnet'; m.genesis_hash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  m.mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  m.control_api_origin = 'https://control.example.com'; m.inference_api_origin = 'https://inference.example.com'; m.proving_keys_base_url = 'https://assets.example.com/';
  m.vault_binding = await vaultBinding(...[m.genesis_hash,m.program_id,m.pool,m.token_program,m.mint].map(bs58.decode) as [Uint8Array,Uint8Array,Uint8Array,Uint8Array,Uint8Array]);
  const tariffBody = {version:'1',provider:'openrouter',model:'*',pricing_basis:'provider_reported_usd',valid_from:'0',valid_until:'9999999999',rates:[],operator_fee_micro_usdc:'0'};
  const tariff = {...tariffBody,tariff_hash:await sha256Hex(jcsBytes(tariffBody))}; m.tariff_hashes = [tariff.tariff_hash];
  const names = ['idl','requestPk','requestVk','withdrawalPk','withdrawalVk','treePk','treeVk','treeSourceBundle','treeVerifierConstants'] as const;
  const files = new Map<string,Uint8Array>();
  const rawArtifacts = Object.fromEntries(await Promise.all(names.map(async name => [name,name === 'idl' ? jcsBytes({address:m.program_id}) : new TextEncoder().encode(name)])));
  const hashes: Record<string,string> = {}; for (const name of names) { hashes[name] = await sha256Hex(rawArtifacts[name]); files.set('https://assets.example.com/'+name+'.bin',rawArtifacts[name]); }
  m.idl_hash=hashes.idl;m.request_pk_hash=hashes.requestPk;m.request_vk_hash=hashes.requestVk;m.withdrawal_pk_hash=hashes.withdrawalPk;m.withdrawal_vk_hash=hashes.withdrawalVk;
  m.tree_proof_artifacts={...m.tree_proof_artifacts,pk_hash:hashes.treePk,vk_hash:hashes.treeVk,source_bundle_hash:hashes.treeSourceBundle,verifier_constants_hash:hashes.treeVerifierConstants};
  m.artifact_digests={};m.circuit_profile_hash=await circuitProfileDigest(m);m.manifest_hash=await manifestDigest(m);
  const trust = {anchor:{kind:'hash' as const,sha256:m.manifest_hash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,
    genesis_hash:m.genesis_hash,program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},
    build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile}};
  files.set('https://assets.example.com/manifest.json',jcsBytes(m));
  const wasm = new Uint8Array([0,97,115,109,1,0,0,0]); files.set('https://assets.example.com/prover.wasm',wasm);
  const descriptor = {schema:1,trust,manifest:'manifest.json',artifacts:{...Object.fromEntries(names.map(n=>[n,n+'.bin'])),additional:{}},
    wasm:{path:'prover.wasm',sha256:await sha256Hex(wasm)},files:Object.fromEntries(await Promise.all([...files].map(async ([url,bytes])=>[new URL(url).pathname.slice(1),{sha256:await sha256Hex(bytes),bytes:bytes.length}])))};
  const descriptorBytes=jcsBytes(descriptor);files.set('https://assets.example.com/bundle.json',descriptorBytes);
  const profile: PublicDeploymentProfile = {schema:1,id:'public-fixture',revision:1,sdkVersions:['0.2.0-devnet.2'],protocolLayoutVersion:2,
    bundle:{url:'https://assets.example.com/bundle.json',sha256:await sha256Hex(descriptorBytes)},rpcUrl:'https://rpc.example.com/',indexerOrigin:'https://indexer.example.com',
    mode:'direct_openrouter',models:[{id:'fixture-model',provider:'openrouter',apis:['chat'],tariff}],modelCapabilities:{'fixture-model':{streaming:true,tools:false}},
    directProviderBases:{direct_openrouter:'https://provider.example.com/v1'}};
  const profileUrl='https://profiles.example.com/devnet-v1.json';
  const poolData=Buffer.from(f.poolData);poolData.set(bs58.decode(m.genesis_hash),10);poolData.set(bs58.decode(m.mint),42);poolData.set(parseField(m.vault_binding),107);poolData.set(Buffer.from(m.circuit_profile_hash,'hex'),358);
  const [tree,bump]=await getProgramDerivedAddress({seeds:[Buffer.from('tree'),getAddressEncoder().encode(address(m.pool))],programAddress:address(m.program_id)});
  const root={pool:m.pool,root:'0x'+'00'.repeat(32),slot:'100',blockhash:key(8),sequence:'0',next_note_id:'0'};
  const snapshot={schema_version:'1',snapshot:root,active_notes:[],pending_withdrawals:[]};
  const treeData=Buffer.alloc(66);treeData.set(await discriminator('TreeState','account'));treeData[8]=2;treeData[9]=bump;
  const clock=Buffer.alloc(40);clock.writeBigInt64LE(2600n,32);
  const state={genesis:m.genesis_hash as string,slot:110,catalogAvailable:true,controlManifest:jcsBytes(m),snapshotDigestValid:true};
  const calls:{url:string;method:string;rpc?:string}[]=[];
  const account=(data:Buffer,owner:string=m.program_id)=>({owner,executable:false,lamports:1,rentEpoch:0,data:[data.toString('base64'),'base64']});
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input),method=init?.method??'GET';const call:{url:string;method:string;rpc?:string}={url,method};calls.push(call);
    if(init?.credentials!=='omit'||init?.redirect!=='error')throw Error('unsafe fixture request');
    if(url===profileUrl)return new Response(jcsBytes(profile) as BodyInit);
    if(files.has(url))return new Response(new Uint8Array(files.get(url)!));
    if(url===m.control_api_origin+'/zkapi/v1/config')return new Response(new Uint8Array(state.controlManifest));
    if(url===m.control_api_origin+'/zkapi/v1/catalog')return Response.json({models:state.catalogAvailable?[{model:'*',provider:'openrouter',modes:['direct_openrouter'],endpoints:[],modalities:['text'],tariff_hash:tariff.tariff_hash}]:[]});
    const snapshotBytes=jcsBytes(snapshot),snapshotHash=await sha256Hex(snapshotBytes);
    if(url===profile.indexerOrigin+'/zkapi/v1/tree/snapshot')return Response.json({snapshot:root,sha256:snapshotHash,download_url:profile.indexerOrigin+'/zkapi/v1/tree/snapshots/'+snapshotHash+'.json'});
    if(url===profile.indexerOrigin+'/zkapi/v1/tree/snapshots/'+snapshotHash+'.json')return new Response(state.snapshotDigestValid?new Uint8Array(snapshotBytes):new Uint8Array([0]));
    if(url===profile.rpcUrl){const request=JSON.parse(String(init?.body));call.rpc=request.method;let result:unknown;
      if(request.method==='getGenesisHash')result=state.genesis;
      else if(request.method==='getAccountInfo')result={context:{slot:state.slot},value:account(poolData)};
      else if(request.method==='getMultipleAccounts'){
        if(JSON.stringify(request.params[0])!==JSON.stringify([m.pool,tree,'SysvarC1ock11111111111111111111111111111111']))throw Error('private selector');
        result={context:{slot:state.slot},value:[account(poolData),account(treeData),account(clock,'Sysvar1111111111111111111111111111111111111')]};
      } else if(request.method==='getBlock')result={blockhash:request.params[0]===100?key(8):key(9),previousBlockhash:key(7),parentSlot:request.params[0]-1,blockHeight:request.params[0],blockTime:2600};
      else throw Error('financial RPC forbidden');return Response.json({jsonrpc:'2.0',id:request.id,result});}
    throw Error('unexpected fixture route');
  };
  return {profile,profileUrl,profileSha256:()=>sha256Hex(jcsBytes(profile)),manifest:m,trust,descriptor,files,fetcher,calls,poolData,treeData,clock,state,snapshot};
}
