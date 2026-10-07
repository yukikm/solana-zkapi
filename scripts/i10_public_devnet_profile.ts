/** Offline public-devnet profile loading. No network, wallet or service secrets.
 * The expected SHA256 must come from the independently installed build review. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createKeyPairSignerFromPrivateKeyBytes} from '@solana/kit';
import {parseField} from '../packages/sdk/src/encoding.ts';
import {base58PublicKey,jcsBytes,parseStrictJson} from '../packages/sdk/src/trust.ts';

const FIXTURE_PROFILE='ba688d8a2be7647499c98d52c335c381b86f0471f39fa6539f7d451b76dafca1';
const FIXTURE_TREE=new Set(['c01b31f6806ce59114fe8befa210967415e20229b0a998018d4955a726fd0f80','9141a035fdba50b13a5776182be029bb23dd15e69cd579c5d6e310b7e2ee5fb7','d4048c4b228fca9ef4342de8f89f96f90f606c9beb74cd3c6606db44925d1bf9']);
const FIXTURE_STATE={x:'0x1323be9e2e992d044776cbcb214a0c48c6b26e75d0e16566205b8d87b7c96426',y:'0x27a29afe44e845c4ece5d6f0fdf72d31229299094efc99ea1b5ead25bdab2564'};
const FIXTURE_CLEARANCE={x:'0x296d8a6f5713ce4ffa2d909907fc3d0236db553d5db9ead9aff81d2c7ebe6109',y:'0x06fb653b4944f6bb8c005f7da3d7c056ca10f329427e4e4dead38c5cba5749d6'};
export const PROFILE_FIELDS=['circuit_id','protocol_layout_version','request_pk_hash','request_vk_hash','withdrawal_pk_hash','withdrawal_vk_hash','setup_profile','setup_transcript_hashes','tree_backend','tree_proof_artifacts','tree_tag_policy'] as const;
const UPSTREAM={request_pk_hash:'c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584',request_vk_hash:'8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97',withdrawal_pk_hash:'8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668',withdrawal_vk_hash:'2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679'};
export const profileSha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface PublicDevnetProfile { directory:string; sha256:string; bytes:Uint8Array; profile:Record<string,any>; circuit:Record<string,any>; artifacts:Record<string,Uint8Array> }
export function publicDevnetOptions(args:readonly string[]) {
 const get=(name:string)=>{const found=args.map((arg,index)=>arg===name?args[index+1]:arg.startsWith(name+'=')?arg.slice(name.length+1):undefined).filter(v=>v!==undefined);assert.ok(found.length<=1,'duplicate '+name);if(args.includes(name))assert.ok(found[0]&&!found[0].startsWith('--'),'missing '+name);return found[0];};
 const directory=get('--public-devnet-profile'),sha256=get('--public-devnet-profile-sha256');
 assert.equal(directory===undefined,sha256===undefined,'public profile and independently installed hash are required together');
 if(!directory)return undefined;
 assert.match(sha256!,/^[0-9a-f]{64}$/,'public profile SHA256 required');
 const path=resolve(directory),legacy=resolve('target/i10-devnet-vault');
 assert.ok(path!==legacy&&!path.startsWith(legacy+'/'),'public profile cannot reuse historical deployment directory');
 return {directory:path,sha256:sha256!,deployment:join(path,'deployment')};
}
export async function loadPublicDevnetProfile(directory:string,expectedHash:string):Promise<PublicDevnetProfile> {
 assert.match(expectedHash,/^[0-9a-f]{64}$/);
 const bytes=new Uint8Array(await readFile(join(directory,'public-profile.json')));
 assert.equal(profileSha(bytes),expectedHash,'independent public profile hash mismatch');
 const p=JSON.parse(JSON.stringify(parseStrictJson(bytes))) as Record<string,any>;
 assert.equal(p.schema,1);assert.equal(p.kind,'public_devnet');assert.equal(p.tree_setup,'single_party_os_random');assert.equal(p.production_eligible,false);
 assert.equal(p.setup_profile,'test_only');assert.deepEqual(p.setup_transcript_hashes,{request:null,tree:null,withdrawal:null});
 assert.ok(Array.isArray(p.limitations)&&p.limitations.length>0&&p.limitations.every((v:unknown)=>typeof v==='string'),'experimental limitations required');
 assert.equal(p.circuit_id,'zkapi-v2-note-bound-v1');assert.equal(p.protocol_layout_version,2);assert.equal(p.tree_backend,'transition_proof');assert.equal(p.tree_tag_policy,'proof_bound');
 for(const [name,value] of Object.entries(UPSTREAM))assert.equal(p[name],value,'unchanged upstream circuit pin');
 const circuit=Object.fromEntries(PROFILE_FIELDS.map(name=>[name,p[name]]));
 assert.equal(profileSha(jcsBytes(circuit)),p.circuit_profile_hash,'circuit profile digest');assert.notEqual(p.circuit_profile_hash,FIXTURE_PROFILE,'deterministic fixture profile');
 const tree=p.tree_proof_artifacts;assert.equal(tree.circuit_id,'solana.zkapi.tree.v1');assert.equal(tree.public_inputs,11);assert.equal(tree.setup_transcript_hash,null);
 for(const name of ['pk_hash','vk_hash','verifier_constants_hash']){assert.match(tree[name],/^[0-9a-f]{64}$/);assert.ok(!FIXTURE_TREE.has(tree[name]),'deterministic fixture tree artifact');}
 const points=[p.state_key,p.clearance_key];
 for(const point of points){assert.deepEqual(Object.keys(point).sort(),['x','y']);parseField(point.x);parseField(point.y);assert.ok(point.x!=='0x'+'00'.repeat(32)||BigInt(point.y)!==1n,'identity signing key');assert.notDeepEqual(point,FIXTURE_STATE,'public fixture state key');assert.notDeepEqual(point,FIXTURE_CLEARANCE,'public fixture clearance key');}
 assert.notDeepEqual(points[0],points[1],'separate role keys required');
 const fixtureEd=await Promise.all([11,12].map(async n=>(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n))).address));
 for(const key of [p.quote_public_key,p.receipt_public_key]){assert.ok(base58PublicKey(key).some(v=>v!==0),'nonzero Ed25519 key');assert.ok(!fixtureEd.includes(key),'public fixture Ed25519 key');}
 assert.notEqual(p.quote_public_key,p.receipt_public_key,'separate Ed25519 roles');
 const expected:Record<string,string>={'request.pk':p.request_pk_hash,'request.vk':p.request_vk_hash,'withdrawal.pk':p.withdrawal_pk_hash,'withdrawal.vk':p.withdrawal_vk_hash,'tree.pk':tree.pk_hash,'tree.vk':tree.vk_hash,'tree-vk-wire.bin':tree.verifier_constants_hash,'circuit-source.tar':tree.source_bundle_hash,'profile.json':p.artifact_hashes?.['profile.json']};
 assert.deepEqual(Object.keys(p.artifact_hashes).sort(),Object.keys(expected).sort(),'fixed public artifact set');
 const artifacts:Record<string,Uint8Array>={};
 for(const [name,digest] of Object.entries(expected)){assert.match(digest,/^[0-9a-f]{64}$/);assert.equal(p.artifact_hashes[name],digest,'artifact/profile digest binding');const data=new Uint8Array(await readFile(join(directory,name)));assert.equal(profileSha(data),digest,'public artifact hash mismatch: '+name);artifacts[name]=data;}
 assert.deepEqual(JSON.parse(JSON.stringify(parseStrictJson(artifacts['profile.json']))),{...circuit,circuit_profile_hash:p.circuit_profile_hash},'exact circuit profile artifact');
 return {directory:resolve(directory),sha256:expectedHash,bytes,profile:p,circuit:{...circuit,circuit_profile_hash:p.circuit_profile_hash},artifacts};
}

/** Public bootstrap does not read a historical I05 or funded deployment manifest. */
export function publicDevnetManifestBase(loaded:PublicDevnetProfile):Record<string,any> {
 const p=loaded.profile;
 return {...loaded.circuit,state_key:p.state_key,clearance_key:p.clearance_key,quote_public_key:p.quote_public_key,receipt_public_key:p.receipt_public_key,decimals:6,transaction_formats:['v0_buffer','v0_inline_deposit_v1'],api_endpoints:['/zkapi/v1/config','/zkapi/v1/catalog','/zkapi/v1/quotes','/zkapi/v1/sessions','/zkapi/v1/withdraw/clearance','/v1/models','/v1/chat/completions','/v1/responses','/v1/messages','/v1/messages/count_tokens'],tariff_hashes:[],db_schema_version:'2'};
}
