/** Offline metadata checks using synthetic tree bytes; never a deployment/setup test. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Keypair} from '@solana/web3.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {jcsBytes,manifestDigest,verifyManifest} from '../packages/sdk/src/trust.ts';
import {vaultBinding} from '../packages/sdk/src/encoding.ts';
import bs58 from 'bs58';
import {publicDevnetOptions,loadPublicDevnetProfile,profileSha,PROFILE_FIELDS,publicDevnetManifestBase} from './i10_public_devnet_profile.ts';
const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const encode=(p:unknown)=>Buffer.from(JSON.stringify(p));
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'zkapi-public-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const p=JSON.parse(await readFile('tests/fixtures/layout2/profile.json','utf8'));
 const artifacts:Record<string,string>={};
 for(const [file,key] of [['tree.pk','pk_hash'],['tree.vk','vk_hash'],['tree-vk-wire.bin','verifier_constants_hash'],['circuit-source.tar','source_bundle_hash']]){const b=Buffer.from('synthetic offline fixture '+file);await writeFile(join(dir,file),b);p.tree_proof_artifacts[key]=profileSha(b);artifacts[file]=profileSha(b);}
 for(const file of ['request.pk','request.vk','withdrawal.pk','withdrawal.vk']){await copyFile('vendor/ethereum-zkapi/protocol/setup/v2/'+file,join(dir,file));artifacts[file]=profileSha(await readFile(join(dir,file)));}
 const body=Object.fromEntries(PROFILE_FIELDS.map(k=>[k,p[k]]));p.circuit_profile_hash=profileSha(jcsBytes(body));
 const circuit=encode({...body,circuit_profile_hash:p.circuit_profile_hash});await writeFile(join(dir,'profile.json'),circuit);artifacts['profile.json']=profileSha(circuit);
 Object.assign(p,{schema:1,kind:'public_devnet',tree_setup:'single_party_os_random',production_eligible:false,limitations:['Synthetic metadata only; not a sound or deployable setup'],state_key:{x:field(2),y:field(3)},clearance_key:{x:field(4),y:field(5)},quote_public_key:Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58(),receipt_public_key:Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey.toBase58(),artifact_hashes:artifacts});
 const save=async(v:any)=>{const b=encode(v);await writeFile(join(dir,'public-profile.json'),b);return profileSha(b);};
 return {dir,p,save,sha:await save(p)};
}
test('public profile options need an independent pin and cannot select funded legacy directories',()=>{
 assert.equal(publicDevnetOptions([]),undefined);
 const sha='12'.repeat(32),d=resolve('target/public-devnet/offline-example');
 assert.deepEqual(publicDevnetOptions(['--public-devnet-profile',d,'--public-devnet-profile-sha256='+sha]),{directory:d,sha256:sha,deployment:join(d,'deployment')});
 for(const args of [['--public-devnet-profile',d],['--public-devnet-profile-sha256',sha],['--public-devnet-profile'],['--public-devnet-profile',d,'--public-devnet-profile='+d,'--public-devnet-profile-sha256',sha],['--public-devnet-profile=target/i10-devnet-vault','--public-devnet-profile-sha256='+sha],['--public-devnet-profile=target/i10-devnet-vault/pools/wallet','--public-devnet-profile-sha256='+sha]])assert.throws(()=>publicDevnetOptions(args));
});
test('public profile authenticates all artifact bytes without service/wallet secrets',async t=>{
 const f=await fixture(t);const loaded=await loadPublicDevnetProfile(f.dir,f.sha);assert.equal(loaded.sha256,f.sha);assert.equal(Buffer.from(loaded.artifacts['tree.pk']).toString(),'synthetic offline fixture tree.pk');assert.equal(Object.keys(loaded.artifacts).length,9);
 await assert.rejects(loadPublicDevnetProfile(f.dir,'00'.repeat(32)),/independent public profile hash/);
 await writeFile(join(f.dir,'tree.pk'),'replacement');await assert.rejects(loadPublicDevnetProfile(f.dir,f.sha),/artifact hash mismatch/);
});
test('operator repinning cannot relabel fixture keys, ceremony or mismatched artifact bindings',async t=>{
 const f=await fixture(t);const old=JSON.parse(await readFile('tests/fixtures/layout2/profile.json','utf8'));
 const oldInputs=JSON.parse(await readFile('tests/fixtures/crypto/withdrawal-signed.json','utf8')).public_inputs;
 for(const mutation of ['state','clearance','quote','receipt','tree','ceremony','shared','binding','unknown-artifact']){
  const p=structuredClone(f.p);
  if(mutation==='state')p.state_key={x:oldInputs[4],y:oldInputs[5]};
  if(mutation==='clearance')p.clearance_key={x:oldInputs[6],y:oldInputs[7]};
  if(mutation==='quote')p.quote_public_key=Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
  if(mutation==='receipt')p.receipt_public_key=Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58();
  if(mutation==='tree')p.tree_proof_artifacts.pk_hash=old.tree_proof_artifacts.pk_hash;
  if(mutation==='ceremony')p.setup_profile='ceremony_verified';
  if(mutation==='shared')p.state_key=p.clearance_key;
  if(mutation==='binding')p.artifact_hashes['tree.pk']='00'.repeat(32);
  if(mutation==='unknown-artifact')p.artifact_hashes['private/state.seed']='11'.repeat(32);
  await assert.rejects(loadPublicDevnetProfile(f.dir,await f.save(p)),undefined,mutation);
 }
});

test('launcher offline validation completes without RPC or wallet configuration',async t=>{
 const f=await fixture(t);
 const {stdout}=await promisify(execFile)(process.execPath,['scripts/run_i10_devnet_vault.ts','--public-devnet-profile',f.dir,'--public-devnet-profile-sha256',f.sha,'--validate-public-profile'],{env:{PATH:process.env.PATH},timeout:30000});
 const report=JSON.parse(stdout);assert.equal(report.validated,true);assert.equal(report.production_eligible,false);assert.equal(report.public_profile_sha256,f.sha);assert.equal(report.deployment_directory,join(f.dir,'deployment'));
});

test('fresh public base produces an independently pinned SDK manifest without I05 state',async t=>{
 const f=await fixture(t),loaded=await loadPublicDevnetProfile(f.dir,f.sha);
 const key=(n:number)=>Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
 const base=publicDevnetManifestBase(loaded),genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',program=key(61),pool=key(62),mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
 const authority={kind:'devnet_test_single_key',authority:key(63)};
 const manifest:any={...base,deployment_id:'offline-public-profile',deployment_environment:'devnet',genesis_hash:genesis,program_id:program,pool,mint,token_program:token,control_api_origin:'https://control.invalid',inference_api_origin:'https://inference.invalid',proving_keys_base_url:'https://control.invalid/keys',note_ttl_seconds:'3600',challenge_seconds:'60',cap_micro_usdc:'1000000',idl_hash:'1a'.repeat(32),vault_binding:await vaultBinding(...[genesis,program,pool,token,mint].map(bs58.decode) as [Uint8Array,Uint8Array,Uint8Array,Uint8Array,Uint8Array]),authorities:{admin:authority,upgrade:authority},artifact_digests:{public_devnet_profile:f.sha},manifest_signature:Buffer.alloc(64).toString('base64')};
 manifest.manifest_hash=await manifestDigest(manifest);
 const verified=await verifyManifest(encode(manifest),{anchor:{kind:'hash',sha256:manifest.manifest_hash},expected:{deployment_id:manifest.deployment_id,deployment_environment:'devnet',genesis_hash:genesis,program_id:program,pool,mint,token_program:token,control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin},build:{stateKey:f.p.state_key,clearanceKey:f.p.clearance_key,circuitProfileHash:f.p.circuit_profile_hash,idlHash:manifest.idl_hash,setupProfile:'test_only',transactionFormats:['v0_buffer','v0_inline_deposit_v1']}});
 assert.equal(verified.circuit_profile_hash,f.p.circuit_profile_hash);assert.equal(verified.quote_public_key,f.p.quote_public_key);
});
