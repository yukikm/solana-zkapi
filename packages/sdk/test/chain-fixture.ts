/** Synthetic account/manifest fixtures for RPC adapter tests. No generated proof
 * artifacts, target/ files, real provider or public deployment are used here. */
import { readFile } from 'node:fs/promises';
import { address, getAddressDecoder, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { createSolanaRpcWithFetch } from '../src/solana.ts';
import { vaultBinding, parseField } from '../src/encoding.ts';
import { discriminator } from '../src/transport.ts';
import { circuitProfileDigest, jcsBytes, manifestDigest, sha256Hex, verifyManifest, type Manifest } from '../src/trust.ts';

export const key=(n:number)=>getAddressDecoder().decode(new Uint8Array(32).fill(n));
export async function chainFixture() {
  const read=async(p:string)=>new Uint8Array(await readFile(new URL('../../../'+p,import.meta.url)));
  const profile=JSON.parse(new TextDecoder().decode(await read('tests/fixtures/layout2/profile.json')));
  const original=JSON.parse(new TextDecoder().decode(await read('tests/fixtures/layout2/a.json')));
  const idl=await read('docs/contracts/zkapi_vault.json'),program=JSON.parse(new TextDecoder().decode(idl)).address;
  const seed=new Uint8Array(32).fill(17),[pool,bump]=await getProgramDerivedAddress({seeds:[Buffer.from('pool'),seed],programAddress:address(program)});
  const authority={authority:key(20),program_id:key(21),config_hash:'77'.repeat(32),threshold:2 as const,members:[key(22),key(23),key(24)]};
  const m:{-readonly [K in keyof Manifest]:Manifest[K]}={...profile,deployment_id:'synthetic-chain-adapter',deployment_environment:'local',
    manifest_hash:'00'.repeat(32),manifest_signature:Buffer.alloc(64).toString('base64'),genesis_hash:key(0),program_id:program,pool:pool,
    mint:key(4),token_program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6,vault_binding:'',
    state_key:{x:original.auth.escape.public_inputs[4],y:original.auth.escape.public_inputs[5]},
    clearance_key:{x:original.auth.escape.public_inputs[6],y:original.auth.escape.public_inputs[7]},
    quote_public_key:key(30),receipt_public_key:key(31),transaction_formats:['v0_buffer'],cap_micro_usdc:'1000000',note_ttl_seconds:'2592000',challenge_seconds:'86400',
    control_api_origin:'http://127.0.0.1:8788',inference_api_origin:'http://127.0.0.1:8789',proving_keys_base_url:'http://127.0.0.1:8788/keys',
    idl_hash:await sha256Hex(idl),api_endpoints:['/zkapi/v1/config'],tariff_hashes:[],artifact_digests:{vault_idl:await sha256Hex(idl)},db_schema_version:'2',
    authorities:{admin:authority,upgrade:{...authority,authority:key(25)}}};
  m.vault_binding=await vaultBinding(...[m.genesis_hash,m.program_id,m.pool,m.token_program,m.mint].map(bs58.decode) as [Uint8Array,Uint8Array,Uint8Array,Uint8Array,Uint8Array]);
  m.circuit_profile_hash=await circuitProfileDigest(m);m.manifest_hash=await manifestDigest(m);
  const manifest=await verifyManifest(jcsBytes(m),{anchor:{kind:'hash',sha256:m.manifest_hash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,
    genesis_hash:m.genesis_hash,program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},
    build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile}});
  const data=Buffer.alloc(422);data.set(await discriminator('PoolConfig','account'));data[8]=2;data[9]=bump;
  for(const [offset,value] of [[10,m.genesis_hash],[42,m.mint],[74,m.token_program],[139,m.authorities.admin.authority],[171,key(29)]] as const)data.set(bs58.decode(value),offset);
  data[106]=6;
  for(const [offset,value] of [[107,m.vault_binding],[203,m.state_key.x],[235,m.state_key.y],[267,m.clearance_key.x],[299,m.clearance_key.y]] as const)data.set(parseField(value),offset);
  data.writeBigUInt64LE(BigInt(m.note_ttl_seconds),331);data.writeBigUInt64LE(BigInt(m.challenge_seconds),339);data.writeBigUInt64LE(BigInt(m.cap_micro_usdc),347);
  data[356]=1;data[357]=1;data.set(Buffer.from(m.circuit_profile_hash,'hex'),358);data.set(seed,390);
  return {manifest,poolData:data};
}

/** Inject synthetic HTTP responses into native Kit request/response transforms. */
export function fixtureRpc(fetcher: typeof fetch, url = 'http://127.0.0.1:19890') {
  return createSolanaRpcWithFetch(url,fetcher);
}
