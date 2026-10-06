import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { vaultBinding, parseField } from '../src/encoding.ts';
import { parseStrictJson, jcsBytes, sha256Hex, manifestDigest, circuitProfileDigest, verifyManifest, verifyPoolConfig, verifyArtifactBundle, supportsInlineDeposit } from '../src/trust.ts';
import { verifiedClientBundle, verifiedClientContext } from '../src/control.ts';
import type { Manifest, ManifestTrustPolicy, ArtifactBundle, FinalizedPoolAccount, VerifiedManifest } from '../src/trust.ts';
import { createZkApiClient, type CreateClientOptions } from '../src/client.ts';
import { createBrowserClient } from '../src/browser.ts';
import { importJournalKey } from '../src/journal.ts';
import type { Connection } from '@solana/web3.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] extends object ? Mutable<T[K]> : T[K] };
const utf8 = (text: string) => new TextEncoder().encode(text);
const read = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url));
const key = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte));
const distribution = generateKeyPairSync('ed25519');
const distributionKey = bs58.encode(distribution.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const profile = JSON.parse(read('tests/fixtures/layout2/profile.json').toString());
const original = JSON.parse(read('tests/fixtures/layout2/a.json').toString());
const poolSeed = new Uint8Array(32).fill(17);

async function resign(manifest: Mutable<Manifest>): Promise<void> {
  manifest.circuit_profile_hash = await circuitProfileDigest(manifest);
  manifest.manifest_hash = await manifestDigest(manifest);
  manifest.manifest_signature = sign(null, Buffer.from(manifest.manifest_hash, 'hex'), distribution.privateKey).toString('base64');
}
async function fixture() {
  const idl = read('docs/contracts/zkapi_vault.json');
  const program = JSON.parse(idl.toString()).address;
  const pool = PublicKey.findProgramAddressSync([utf8('pool'), poolSeed], new PublicKey(program))[0].toBase58();
  const authority = { authority: key(20), program_id: key(21), config_hash: '77'.repeat(32), threshold: 2 as const, members: [key(22), key(23), key(24)] };
  const manifest: Mutable<Manifest> = {
    ...structuredClone(profile), deployment_id: 'sdk-trust-fixture', deployment_environment: 'local',
    manifest_hash: '00'.repeat(32), manifest_signature: Buffer.alloc(64).toString('base64'),
    genesis_hash: key(0), program_id: program, pool, mint: key(4), token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6,
    vault_binding: '', state_key: { x: original.auth.escape.public_inputs[4], y: original.auth.escape.public_inputs[5] },
    clearance_key: { x: original.auth.escape.public_inputs[6], y: original.auth.escape.public_inputs[7] },
    quote_public_key: key(30), receipt_public_key: key(31), transaction_formats: ['v0_buffer'], cap_micro_usdc: '1000000',
    note_ttl_seconds: '2592000', challenge_seconds: '86400', control_api_origin: 'http://127.0.0.1:8788', inference_api_origin: 'http://127.0.0.1:8789',
    proving_keys_base_url: 'http://127.0.0.1:8788/keys', idl_hash: await sha256Hex(idl), api_endpoints: ['/zkapi/v1/config'], tariff_hashes: [],
    artifact_digests: { vault_idl: await sha256Hex(idl) }, db_schema_version: '2', authorities: { admin: authority, upgrade: { ...authority, authority: key(25) } },
  };
  manifest.vault_binding = await vaultBinding(...[manifest.genesis_hash, manifest.program_id, manifest.pool, manifest.token_program, manifest.mint].map(bs58.decode) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]);
  await resign(manifest);
  return { manifest, idl, policy: policyFor(manifest) };
}
function policyFor(m: Manifest): ManifestTrustPolicy {
  return {
    anchor: { kind: 'ed25519', publicKey: distributionKey },
    expected: { deployment_id: m.deployment_id, deployment_environment: m.deployment_environment, genesis_hash: m.genesis_hash, program_id: m.program_id, pool: m.pool, mint: m.mint, token_program: m.token_program, control_api_origin: m.control_api_origin, inference_api_origin: m.inference_api_origin },
    build: { stateKey: { ...m.state_key }, clearanceKey: { ...m.clearance_key }, circuitProfileHash: m.circuit_profile_hash, idlHash: m.idl_hash, setupProfile: m.setup_profile },
  };
}
async function devnetSingleKeyFixture() {
  const { manifest } = await fixture();
  manifest.deployment_environment = 'devnet';
  manifest.genesis_hash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  manifest.control_api_origin = 'https://control.example'; manifest.inference_api_origin = 'https://inference.example';
  manifest.proving_keys_base_url = 'https://keys.example/keys';
  manifest.authorities = { admin: { kind: 'devnet_test_single_key', authority: key(20) }, upgrade: { kind: 'devnet_test_single_key', authority: key(25) } };
  manifest.vault_binding = await vaultBinding(...[manifest.genesis_hash, manifest.program_id, manifest.pool, manifest.token_program, manifest.mint].map(bs58.decode) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]);
  await resign(manifest);
  return manifest;
}
async function poolAccount(m: Manifest): Promise<FinalizedPoolAccount> {
  const bytes = new Uint8Array(422); const view = new DataView(bytes.buffer);
  bytes.set(createHash('sha256').update('account:PoolConfig').digest().subarray(0, 8)); bytes[8] = 2;
  bytes[9] = PublicKey.findProgramAddressSync([utf8('pool'), poolSeed], new PublicKey(m.program_id))[1];
  for (const [offset, value] of [[10, m.genesis_hash], [42, m.mint], [74, m.token_program], [139, m.authorities.admin.authority], [171, key(29)]] as const) bytes.set(bs58.decode(value), offset);
  bytes[106] = 6;
  for (const [offset, value] of [[107, m.vault_binding], [203, m.state_key.x], [235, m.state_key.y], [267, m.clearance_key.x], [299, m.clearance_key.y]] as const) bytes.set(parseField(value), offset);
  view.setBigUint64(331, BigInt(m.note_ttl_seconds), true); view.setBigUint64(339, BigInt(m.challenge_seconds), true); view.setBigUint64(347, BigInt(m.cap_micro_usdc), true);
  bytes[356] = 1; bytes[357] = 1; bytes.set(Buffer.from(m.circuit_profile_hash, 'hex'), 358); bytes.set(poolSeed, 390);
  return { address: m.pool, owner: m.program_id, executable: false, lamports: 1n, data: bytes, slot: 123n, commitment: 'finalized' };
}

test('strict parser preserves JCS ordering/numbers and rejects duplicate/invalid JSON before hashing', () => {
  const example = parseStrictJson(utf8('{"z":-0,"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"a":"€"}'));
  assert.equal(new TextDecoder().decode(jcsBytes(example)), '{"a":"€","numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"z":0}');
  assert.equal(new TextDecoder().decode(jcsBytes({ '\uE000': 1, '😀': 2, '\r': 3, '1': 4 })), '{"\\r":3,"1":4,"😀":2,"":1}');
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"x":0,"x":1}}', '"\\ud800"', '"\\udfff"', '1e999', '01', 'true false', '\ufeff{}', '[1,]', '{"a":1,}', '{"a":undefined}']) assert.throws(() => parseStrictJson(utf8(text)), text);
  assert.throws(() => parseStrictJson(Uint8Array.of(0x22, 0xc0, 0x80, 0x22)));
  for (const value of [NaN, Infinity, 1n, undefined, new Date(), { x: undefined }, { x: '\ud800' }, new Array(1)]) assert.throws(() => jcsBytes(value));
  const cycle: any = {}; cycle.x = cycle; assert.throws(() => jcsBytes(cycle));
  assert.equal(new TextDecoder().decode(jcsBytes(parseStrictJson(utf8('{"__proto__":{"ok":true}}')))), '{"__proto__":{"ok":true}}');
});

test('strict parser defaults to 1 MiB and permits only an explicit bounded local archive size', () => {
  const archive = 'a'.repeat(1024 * 1024), bytes = utf8(JSON.stringify({archive}));
  assert.ok(bytes.length > 1024 * 1024);
  assert.throws(() => parseStrictJson(bytes), /JSON size/);
  assert.deepEqual({...parseStrictJson(bytes, bytes.length) as Record<string, unknown>}, {archive});
  assert.throws(() => parseStrictJson(bytes, bytes.length - 1), /JSON size/);
  assert.equal(parseStrictJson(utf8('0'), 512 * 1024 * 1024), 0);
  // Count encoded bytes, including multibyte UTF-8, rather than JS characters.
  const euro = utf8('"€"');
  assert.equal(parseStrictJson(euro, euro.length), '€');
  assert.throws(() => parseStrictJson(euro, euro.length - 1), /JSON size/);
  for (const limit of [0, -1, 0.5, NaN, Infinity, -Infinity, 512 * 1024 * 1024 + 1,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '1024', null, {}]) {
    assert.throws(() => parseStrictJson(utf8('0'), limit as number), /JSON size limit/);
  }
});

test('expanded local archive limit retains duplicate, fatal UTF-8, depth and number checks', () => {
  const padding = ' '.repeat(1024 * 1024);
  for (const [document, error] of [
    ['{"a":1,"\\u0061":2}', /duplicate JSON key/],
    ['['.repeat(65) + '0' + ']'.repeat(65), /JSON nesting/],
    ['1e999', /nonfinite JSON number/],
    ['"\\ud800"', /unpaired UTF-16 surrogate/],
  ] as const) {
    const bytes = utf8(padding + document);
    assert.throws(() => parseStrictJson(bytes, bytes.length), error);
  }
  const invalidUtf8 = Buffer.concat([utf8(padding), Uint8Array.of(0x22, 0xc0, 0x80, 0x22)]);
  assert.throws(() => parseStrictJson(invalidUtf8, invalidUtf8.length), /encoded data|encoding/i);
});

test('authenticates a full OpenAPI manifest via external distribution signature or digest; immutable result', async () => {
  const { manifest, policy } = await fixture();
  const schema = JSON.parse(read('docs/contracts/openapi.json').toString()).components.schemas.Manifest;
  assert.deepEqual(Object.keys(manifest).sort(), schema.required.sort());
  assert.equal(await circuitProfileDigest(manifest), profile.circuit_profile_hash);
  for (const selected of [policy, { ...policy, anchor: { kind: 'hash' as const, sha256: manifest.manifest_hash } }]) {
    const verified = await verifyManifest(utf8(JSON.stringify(manifest, null, 2)), selected);
    assert.equal(verified.manifest_hash, manifest.manifest_hash); assert.ok(Object.isFrozen(verified)); assert.ok(Object.isFrozen(verified.state_key));
    assert.throws(() => { (verified.state_key as any).x = manifest.clearance_key.x; });
  }
  await assert.rejects(verifyManifest(jcsBytes(manifest), { ...policy, anchor: { kind: 'hash', sha256: '11'.repeat(32) } }), /distribution hash pin/);
  await assert.rejects(verifyManifest(jcsBytes(manifest), { ...policy, anchor: { kind: 'ed25519', publicKey: key(1) } }));
  const tampered = structuredClone(manifest); tampered.manifest_signature = Buffer.alloc(64).toString('base64');
  await assert.rejects(verifyManifest(jcsBytes(tampered), policy), /Ed25519/);
});

test('rejects signed mismatched deployment, role keys, build/profile, binding, and malformed wire', async () => {
  const { manifest, policy } = await fixture();
  const edits: ((m: any) => void)[] = [
    m => { m.deployment_id = 'another-deployment'; }, m => { m.genesis_hash = key(1); }, m => { m.pool = key(2); }, m => { m.mint = key(3); },
    m => { m.control_api_origin = 'https://evil.invalid'; }, m => { m.deployment_environment = 'devnet'; },
    m => { [m.state_key, m.clearance_key] = [m.clearance_key, m.state_key]; }, m => { m.quote_public_key = m.receipt_public_key; },
    m => { m.state_key.extra = 'unknown'; }, m => { m.extra = true; }, m => { delete m.idl_hash; },
    m => { m.request_pk_hash = 'ab'.repeat(32); }, m => { m.idl_hash = 'ab'.repeat(32); }, m => { m.vault_binding = '0x' + '00'.repeat(32); },
    m => { m.cap_micro_usdc = 1000000; }, m => { m.cap_micro_usdc = '01'; }, m => { m.cap_micro_usdc = '9007199254740992'; },
    m => { m.note_ttl_seconds = '18446744073709551616'; }, m => { m.transaction_formats = ['v1_inline']; }, m => { m.transaction_formats.push('v0_buffer'); },
    m => { m.tree_proof_artifacts.public_inputs = 10; }, m => { m.tree_proof_artifacts.setup_transcript_hash = 'aa'.repeat(32); },
    m => { m.proving_keys_base_url = 'http://not-loopback.invalid/keys'; }, m => { m.control_api_origin += '/'; },
    m => { m.authorities.admin.members[2] = m.authorities.admin.members[0]; },
  ];
  for (const edit of edits) { const changed = structuredClone(manifest); edit(changed); await resign(changed); await assert.rejects(verifyManifest(jcsBytes(changed), policy), edit.toString()); }
  const badHash = structuredClone(manifest); badHash.manifest_hash = 'aa'.repeat(32);
  await assert.rejects(verifyManifest(jcsBytes(badHash), policy), /manifest hash mismatch/);
  await assert.rejects(verifyManifest(utf8(JSON.stringify(manifest).replace('"deployment_id":', '"deployment_id":"injected","deployment_id":')), policy), /duplicate/);
});

test('ceremony assertion requires independently reviewed transcripts and mainnet rejects relabeled public test keys', async () => {
  const { manifest } = await fixture();
  manifest.deployment_environment = 'mainnet';
  manifest.control_api_origin = 'https://control.example'; manifest.inference_api_origin = 'https://inference.example'; manifest.proving_keys_base_url = 'https://keys.example/keys';
  await resign(manifest); await assert.rejects(verifyManifest(jcsBytes(manifest), policyFor(manifest)), /mainnet test setup/);
  manifest.setup_profile = 'ceremony_verified'; manifest.setup_transcript_hashes = { request: 'aa'.repeat(32), withdrawal: 'bb'.repeat(32), tree: 'cc'.repeat(32) };
  manifest.tree_proof_artifacts.setup_transcript_hash = manifest.setup_transcript_hashes.tree; await resign(manifest);
  const policy = policyFor(manifest);
  await assert.rejects(verifyManifest(jcsBytes(manifest), policy), /unreviewed setup transcripts/);
  await assert.rejects(verifyManifest(jcsBytes(manifest), { ...policy, build: { ...policy.build, verifiedSetupTranscripts: manifest.setup_transcript_hashes } }), /known test artifacts/);
});

test('explicit devnet test-only single-key custody preserves distribution and finalized PoolConfig admin pins', async () => {
  const manifest = await devnetSingleKeyFixture();
  const verified = await verifyManifest(jcsBytes(manifest), policyFor(manifest));
  const account = await poolAccount(verified);
  await verifyPoolConfig(verified, manifest.genesis_hash, account, 123n);
  const changed = { ...account, data: account.data.slice() }; changed.data[139] ^= 1;
  await assert.rejects(verifyPoolConfig(verified, manifest.genesis_hash, changed, 123n), /PoolConfig manifest mismatch/);
  const tampered = structuredClone(manifest); tampered.authorities.admin.authority = key(26); await resign(tampered);
  await assert.rejects(verifyManifest(jcsBytes(tampered), { ...policyFor(manifest), anchor: { kind: 'hash', sha256: manifest.manifest_hash } }), /distribution hash pin/);
  // Each role may independently retain the original multisig encoding.
  const legacy = (await fixture()).manifest.authorities;
  for (const role of ['admin', 'upgrade'] as const) {
    const mixed = structuredClone(manifest); mixed.authorities[role] = legacy[role]; await resign(mixed);
    await verifyManifest(jcsBytes(mixed), policyFor(mixed));
  }
});

test('single-key custody cannot be relabeled as local, mainnet, another genesis, or ceremony verified', async () => {
  const base = await devnetSingleKeyFixture(), legacy = (await fixture()).manifest.authorities;
  for (const role of ['admin', 'upgrade'] as const) {
    for (const scenario of ['local', 'mainnet_test', 'mainnet_ceremony', 'ceremony', 'wrong_genesis']) {
      const manifest = structuredClone(base);
      manifest.authorities[role === 'admin' ? 'upgrade' : 'admin'] = legacy[role === 'admin' ? 'upgrade' : 'admin'];
      if (scenario === 'local') manifest.deployment_environment = 'local';
      if (scenario.startsWith('mainnet')) manifest.deployment_environment = 'mainnet';
      if (scenario === 'wrong_genesis') manifest.genesis_hash = key(0);
      if (scenario.includes('ceremony')) {
        manifest.setup_profile = 'ceremony_verified';
        manifest.setup_transcript_hashes = { request: 'aa'.repeat(32), withdrawal: 'bb'.repeat(32), tree: 'cc'.repeat(32) };
        manifest.tree_proof_artifacts.setup_transcript_hash = manifest.setup_transcript_hashes.tree;
      }
      await resign(manifest);
      const originalPolicy = policyFor(manifest);
      const policy = { ...originalPolicy, build: { ...originalPolicy.build, verifiedSetupTranscripts: manifest.setup_transcript_hashes } };
      await assert.rejects(verifyManifest(jcsBytes(manifest), policy), /single-key authority requires devnet test-only setup|mainnet test setup/, role + '/' + scenario);
    }
  }
});

test('single-key authority discriminant and fields are strict for both roles', async () => {
  const manifest = await devnetSingleKeyFixture();
  for (const role of ['admin', 'upgrade'] as const) {
    for (const authority of [
      { authority: key(20) }, { kind: 'single_key', authority: key(20) },
      { kind: 'devnet_test_single_key' }, { kind: 'devnet_test_single_key', authority: 'not-a-pubkey' },
      ...['program_id', 'config_hash', 'threshold', 'members', 'extra'].map(field => ({ kind: 'devnet_test_single_key', authority: key(20), [field]: 'unexpected' })),
    ]) {
      const changed: any = structuredClone(manifest); changed.authorities[role] = authority; await resign(changed);
      await assert.rejects(verifyManifest(jcsBytes(changed), policyFor(changed)), role + '/' + JSON.stringify(authority));
    }
  }
});

test('checks finalized raw Vault PoolConfig PDA/owner/layout/role pins/cap/profile and never trusts an unverified object', async () => {
  const { manifest, policy } = await fixture(); const verified = await verifyManifest(jcsBytes(manifest), policy); const account = await poolAccount(verified);
  assert.deepEqual(await verifyPoolConfig(verified, manifest.genesis_hash, account, 123n), { paused: false, slot: 123n, treasuryOwner: key(29) });
  const paused = { ...account, data: account.data.slice() }; paused.data[355] = 1;
  assert.equal((await verifyPoolConfig(verified, manifest.genesis_hash, paused, 123n)).paused, true);
  await assert.rejects(verifyPoolConfig(manifest as unknown as VerifiedManifest, manifest.genesis_hash, account, 0n), /not verified/);
  await assert.rejects(verifyPoolConfig(verified, key(1), account, 0n), /genesis/);
  await assert.rejects(verifyPoolConfig(verified, manifest.genesis_hash, account, 124n), /context/);
  for (const edit of [{ owner: key(1) }, { address: key(1) }, { executable: true }, { lamports: 0n }, { commitment: 'confirmed' }, { data: account.data.subarray(1) }]) {
    await assert.rejects(verifyPoolConfig(verified, manifest.genesis_hash, { ...account, ...edit } as FinalizedPoolAccount, 0n));
  }
  for (const offset of [0, 8, 9, 10, 42, 74, 106, 107, 139, 203, 235, 267, 299, 331, 339, 347, 356, 357, 358, 390]) {
    const changed = { ...account, data: account.data.slice() }; changed.data[offset] ^= 1;
    await assert.rejects(verifyPoolConfig(verified, manifest.genesis_hash, changed, 0n), `offset ${offset}`);
  }
});

async function artifactFixture() {
  const { manifest, idl } = await fixture();
  // Synthetic PK payloads exercise distribution integrity only; this test does not claim proof generation.
  const bundle: ArtifactBundle = { idl, requestPk: utf8('request PK test bytes'), requestVk: read('vendor/ethereum-zkapi/protocol/setup/v2/request.vk'), withdrawalPk: utf8('withdrawal PK test bytes'), withdrawalVk: read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'), treePk: utf8('tree PK test bytes'), treeVk: read('tests/fixtures/layout2/test-tree.vk'), treeSourceBundle: utf8('source archive test bytes'), treeVerifierConstants: read('tests/fixtures/layout2/tree-vk-wire.bin'), additional: { vault_idl: idl } };
  manifest.request_pk_hash = await sha256Hex(bundle.requestPk); manifest.withdrawal_pk_hash = await sha256Hex(bundle.withdrawalPk);
  manifest.tree_proof_artifacts.pk_hash = await sha256Hex(bundle.treePk); manifest.tree_proof_artifacts.source_bundle_hash = await sha256Hex(bundle.treeSourceBundle);
  await resign(manifest); const verified = await verifyManifest(jcsBytes(manifest), policyFor(manifest));
  return { manifest, bundle, verified };
}

test('application factory authenticates independent pins, tariffs and finalized pool without sending or running proofs', async () => {
  const { manifest, bundle } = await artifactFixture();
  const body = {version:'1',provider:'openrouter',model:'fixture',pricing_basis:'fixed_usage_rates',valid_from:'0',valid_until:'9999999999',rates:[],operator_fee_micro_usdc:'0'};
  const tariff = {...body,tariff_hash:await sha256Hex(jcsBytes(body))};manifest.tariff_hashes=[tariff.tariff_hash];await resign(manifest);
  const pool=await poolAccount(manifest);let reads=0;
  const options:CreateClientOptions={deployment:{manifest:jcsBytes(manifest),trust:policyFor(manifest),artifacts:bundle,indexerOrigin:'http://127.0.0.1:8790',
    connection:{getGenesisHash:async()=>{reads++;return manifest.genesis_hash;},getAccountInfoAndContext:async()=>{reads++;return {context:{slot:123},value:{owner:new PublicKey(manifest.program_id),executable:false,lamports:1,data:pool.data}};}} as unknown as Connection},
    storage:{key:await importJournalKey(new Uint8Array(32).fill(2)),store:{read:async()=>null,compareAndSwap:async()=>{throw Error('unexpected write');},withLock:async(_key,action)=>action()}},
    prover:{run:async()=>{throw Error('unexpected proof');}},wallet:{publicKey:new PublicKey(key(10)),supportedTransactionVersions:new Set([0]),signTransaction:async()=>{throw Error('unexpected signature');}},
    mode:'proxy',noteId:'first',models:[{id:'fixture',provider:'openrouter',apis:['chat'],tariff}]};
  const client=await createZkApiClient(options);assert.equal((await client.status()).wallet,'empty');assert.equal(reads,2);
  const tampered=structuredClone(options.deployment.artifacts);tampered.requestPk[0]^=1;
  await assert.rejects(createZkApiClient({...options,deployment:{...options.deployment,artifacts:tampered}}),/artifact mismatch/);
  await assert.rejects(createZkApiClient({...options,models:[{...options.models[0],tariff:{...tariff,operator_fee_micro_usdc:'1'}}]}),/tariff/);
  const wrongTrust={...options.deployment.trust,expected:{...options.deployment.trust.expected,pool:key(5)}};
  await assert.rejects(createZkApiClient({...options,deployment:{...options.deployment,trust:wrongTrust}}),/trust/);
  const corruptStore={...options.storage.store,read:async()=>({schema:1 as const,revision:1,ivHex:'00'.repeat(12),ciphertextHex:'00'.repeat(20)})};
  await assert.rejects(createZkApiClient({...options,storage:{...options.storage,store:corruptStore}}),/journal/);
  const wrongConnection={...options.deployment.connection,getGenesisHash:async()=>key(11)} as Connection;
  await assert.rejects(createZkApiClient({...options,deployment:{...options.deployment,connection:wrongConnection}}),/genesis/);
  await assert.rejects(createBrowserClient({...options,storageName:'test',createWorker:()=>{throw Error('must not create worker');},wasm:new Uint8Array([1]),wasmSha256:'00'.repeat(32)}),/WASM hash mismatch/);
});

test('compact deposit requires authenticated capability and an independent build capability pin', async () => {
  const { manifest, policy } = await fixture();
  const legacy = await verifyManifest(jcsBytes(manifest), policy);
  assert.equal(supportsInlineDeposit(legacy), false);
  assert.throws(() => supportsInlineDeposit(manifest as unknown as VerifiedManifest), /not verified/);
  manifest.transaction_formats.push('v0_inline_deposit_v1');
  await resign(manifest);
  await assert.rejects(verifyManifest(jcsBytes(manifest), policy), /build capability pin/);
  const build = { ...policy.build, transactionFormats: ['v0_buffer', 'v0_inline_deposit_v1'] as const };
  const current = await verifyManifest(jcsBytes(manifest), { ...policy, build });
  assert.equal(supportsInlineDeposit(current), true);
  assert.equal(current.circuit_profile_hash, legacy.circuit_profile_hash);
  await assert.rejects(verifyManifest(jcsBytes(manifest), { ...policy, build: { ...build, idlHash: '00'.repeat(32) } }), /IDL\/setup build pin/);
  for (const formats of [['v0_inline_deposit_v1'], ['v0_buffer', 'v0_inline_deposit_v2'], ['v0_buffer', 'v0_inline_deposit_v1', 'v0_inline_deposit_v1']]) {
    const changed = { ...manifest, transaction_formats: formats } as Mutable<Manifest>;
    await resign(changed);
    await assert.rejects(verifyManifest(jcsBytes(changed), { ...policy, build }));
  }
});

test('compact capability rejects a pinned but incompatible IDL before any wallet signing', async () => {
  const { manifest, bundle } = await artifactFixture();
  manifest.transaction_formats.push('v0_inline_deposit_v1');
  const originalIdl = JSON.parse(new TextDecoder().decode(bundle.idl));
  const verify = async (idl: unknown) => {
    const bytes = jcsBytes(idl);
    manifest.idl_hash = await sha256Hex(bytes);
    manifest.artifact_digests.vault_idl = manifest.idl_hash;
    await resign(manifest);
    const policy = policyFor(manifest);
    const verified = await verifyManifest(jcsBytes(manifest), { ...policy, build: { ...policy.build,
      transactionFormats: ['v0_buffer', 'v0_inline_deposit_v1'] } });
    return verifyArtifactBundle(verified, { ...bundle, idl: bytes, additional: { vault_idl: bytes } });
  };
  await verify(originalIdl);
  const missing = structuredClone(originalIdl);
  missing.instructions = missing.instructions.filter((i: { name: string }) => i.name !== 'deposit_compact_v1');
  await assert.rejects(verify(missing), /compact deposit IDL instruction/);
  for (const mutation of ['discriminator', 'args', 'accounts', 'duplicate']) {
    const bad = structuredClone(originalIdl);
    const instruction = bad.instructions.find((i: { name: string }) => i.name === 'deposit_compact_v1');
    if (mutation === 'discriminator') instruction.discriminator[0] ^= 1;
    if (mutation === 'args') instruction.args.pop();
    if (mutation === 'accounts') instruction.accounts[1].signer = false;
    if (mutation === 'duplicate') bad.instructions.push(instruction);
    await assert.rejects(verify(bad), /compact deposit IDL/);
  }
});

test('hashes exact artifact bytes, rejects each changed/missing artifact, and returns detached copies', async () => {
  const { bundle, verified } = await artifactFixture();
  const result = await verifyArtifactBundle(verified, bundle);
  assert.deepEqual(result.requestPk, new Uint8Array(bundle.requestPk)); assert.notEqual(result.idl, bundle.idl);
  for (const name of Object.keys(bundle).filter(name => name !== 'additional') as (Exclude<keyof ArtifactBundle, 'additional'>)[]) {
    const bytes = new Uint8Array(bundle[name]); bytes[0] ^= 1;
    await assert.rejects(verifyArtifactBundle(verified, { ...bundle, [name]: bytes }), new RegExp(`artifact mismatch ${name}`));
  }
  await assert.rejects(verifyArtifactBundle(verified, { ...bundle, additional: {} }), /missing additional artifact/);
  await assert.rejects(verifyArtifactBundle(verified, { ...bundle, additional: { vault_idl: utf8('wrong') } }), /artifact mismatch vault_idl/);
  await assert.rejects(verifyArtifactBundle(verified, { ...bundle, treePk: new Uint8Array() }), /missing artifact treePk/);
  bundle.requestPk[0] ^= 1; assert.notEqual(result.requestPk[0], bundle.requestPk[0]);
});

test('verified client bundle retains entry-time pool and artifact snapshots for the prover', async () => {
  const { bundle, verified } = await artifactFixture(), pool = await poolAccount(verified);
  const expectedPk = bundle.requestPk.slice();
  const pending = verifiedClientBundle(verified, verified.genesis_hash, pool, 123n, bundle);
  pool.data[0] ^= 1; bundle.requestPk[0] ^= 1;
  const result = await pending;
  assert.equal(result.context.pool, verified.pool); assert.equal(result.context.request_vk_sha256, verified.request_vk_hash);
  assert.deepEqual(result.artifacts.requestPk, expectedPk); assert.notEqual(result.artifacts.requestPk, bundle.requestPk);
  bundle.requestPk[1] ^= 1;
  assert.deepEqual(result.artifacts.requestPk, expectedPk);
});

test('client context rejects initially altered artifacts even if buffers change during pool verification', async () => {
  const { bundle, verified } = await artifactFixture(), pool = await poolAccount(verified);
  const context = await verifiedClientContext(verified, verified.genesis_hash, pool, 123n, bundle);
  assert.equal(context.pool, verified.pool);
  bundle.requestPk[0] ^= 1;
  const pending = verifiedClientContext(verified, verified.genesis_hash, pool, 123n, bundle);
  bundle.requestPk[0] ^= 1;
  await assert.rejects(pending, /artifact mismatch requestPk/);
});
