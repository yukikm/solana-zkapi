/** Offline test input only. No wallet, RPC, deployment, or provider operation.
 * Rebind the existing I04/I05/I09 public fixtures into a disposable devnet
 * configuration so the real native trust checks can run on a clean CI runner.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromPrivateKeyBytes, signBytes } from '@solana/kit';
import bs58 from 'bs58';
import { vaultBinding } from '../packages/sdk/src/encoding.ts';
import { manifestDigest, verifyManifest, type Manifest } from '../packages/sdk/src/trust.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export async function prepareOfflineChallengerFixture(output: string) {
  const inputs = ['target/i05/public-manifest.json', 'docs/contracts/zkapi_vault.json',
    'target/i04-sbf/zkapi_vault.so', 'target/i09-challenger/test-tree.pk'];
  const bytes = await Promise.all(inputs.map(path => readFile(join(root, path))));
  const [baseBytes, sourceIdl, program, treeKey] = bytes;
  const base: Manifest = JSON.parse(baseBytes.toString());
  assert.equal(base.deployment_id, 'i05-local');
  assert.equal(base.deployment_environment, 'local');
  assert.equal(base.setup_profile, 'test_only');
  const idlValue = JSON.parse(sourceIdl.toString());
  assert.equal(idlValue.address, base.program_id);
  assert.equal(program.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(sha(treeKey), base.tree_proof_artifacts.pk_hash);

  // Native devnet trust deliberately rejects the local I04 [43; 32] program.
  // Match the existing native devnet_config test's synthetic address pattern;
  // change only the IDL address, never its compiler-generated wire contract.
  // The unchanged I04 ELF is used for offline hash binding, not deployed here.
  const programAddress = bs58.encode(new Uint8Array(32).fill(71));
  const idl = encoded({ ...idlValue, address: programAddress });

  // This deterministic seed is public test material, never a user key. It only
  // signs the fixture manifest; no Solana transaction is constructed or sent.
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(91));
  const build = { schema: 1, deployment_environment: 'devnet', setup_profile: 'test_only',
    program_id: programAddress, deployment_authority: signer.address, genesis_hash: genesis,
    mint, token_program: tokenProgram, idl_sha256: sha(idl), program_sha256: sha(program),
    state_key: base.state_key, clearance_key: base.clearance_key,
    circuit_profile_hash: base.circuit_profile_hash };
  const buildBytes = encoded(build);
  const manifest = { ...base, deployment_id: 'i10-offline-challenger-fixture',
    deployment_environment: 'devnet' as const, genesis_hash: genesis, program_id: programAddress,
    mint, token_program: tokenProgram,
    control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid',
    proving_keys_base_url: 'https://control.invalid/keys', idl_hash: sha(idl),
    vault_binding: await vaultBinding(bs58.decode(genesis), bs58.decode(programAddress),
      bs58.decode(base.pool), bs58.decode(tokenProgram), bs58.decode(mint)),
    authorities: { admin: { kind: 'devnet_test_single_key' as const, authority: signer.address },
      upgrade: { kind: 'devnet_test_single_key' as const, authority: signer.address } },
    artifact_digests: { vault_idl: sha(idl), vault_program: sha(program), devnet_build_manifest: sha(buildBytes) } };
  manifest.manifest_hash = await manifestDigest(manifest);
  manifest.manifest_signature = Buffer.from(await signBytes(signer.keyPair.privateKey,
    Buffer.from(manifest.manifest_hash, 'hex'))).toString('base64');
  await verifyManifest(encoded(manifest), {
    anchor: { kind: 'ed25519', publicKey: signer.address },
    expected: manifest,
    build: { stateKey: manifest.state_key, clearanceKey: manifest.clearance_key,
      circuitProfileHash: manifest.circuit_profile_hash, idlHash: sha(idl), setupProfile: 'test_only',
      transactionFormats: manifest.transaction_formats },
  });
  const deployment = { schema: 1, genesis, program_id: manifest.program_id, pool: manifest.pool,
    mint, token_program: tokenProgram, initializer: signer.address };
  const files = { 'public-manifest.json': encoded(manifest), 'deployment.json': encoded(deployment),
    'build-manifest.json': buildBytes, 'vault-idl.json': idl, 'zkapi_vault.so': program,
    // This is a synthetic start slot, not evidence of an on-chain initialize.
    'initialize-receipt.json': encoded({ slot: 1, offline_fixture: true }) };
  await mkdir(output, { mode: 0o700 }); // Refuse an existing fixture directory.
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(output, name), content, { flag: 'wx', mode: 0o600 });
  }
  const report = { schema: 1, offline_fixture: true, sdk_manifest_signature_verified: true,
    idl_rebinding: { changed_fields: ['address'], original_program: base.program_id,
      synthetic_program: programAddress, elf_bytes_unchanged: true },
    input_sha256: Object.fromEntries(inputs.map((path, i) => [path, sha(bytes[i])])),
    output_sha256: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha(content)])),
    manifest_hash: manifest.manifest_hash, network_requests: 0, live_deployment_verified: false };
  await writeFile(join(output, 'fixture-report.json'), encoded(report), { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'provide one new disposable fixture directory');
  console.log(JSON.stringify(await prepareOfflineChallengerFixture(resolve(process.argv[2]))));
}
