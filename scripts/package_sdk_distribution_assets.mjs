/** Offline public artifact distribution. No RPC, wallet, provider or journal access. */
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson, sha256Hex, verifyManifest, verifyArtifactBundle } from '@zkapi/solana-sdk/trust';

const artifactNames = ['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk', 'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'];
const noticeName = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/;
const maximumNoticeBytes = 1024 * 1024, maximumTotalNoticeBytes = 4 * 1024 * 1024;
function exact(value, required, optional = []) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(required.every(key => Object.hasOwn(value, key)));
  assert.ok(Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
function publicTrust(value) {
  exact(value, ['anchor', 'expected', 'build']);
  exact(value.anchor, value.anchor.kind === 'hash' ? ['kind', 'sha256'] : ['kind', 'publicKey']);
  exact(value.expected, ['deployment_id', 'deployment_environment', 'genesis_hash', 'program_id', 'pool', 'mint', 'token_program', 'control_api_origin', 'inference_api_origin']);
  exact(value.build, ['stateKey', 'clearanceKey', 'circuitProfileHash', 'idlHash', 'setupProfile'], ['transactionFormats', 'verifiedSetupTranscripts']);
  exact(value.build.stateKey, ['x', 'y']); exact(value.build.clearanceKey, ['x', 'y']);
  if (value.build.verifiedSetupTranscripts) exact(value.build.verifiedSetupTranscripts, ['request', 'withdrawal', 'tree']);
  return structuredClone(value);
}

export async function packageDeploymentAssets(configuration, output) {
  const configPath = resolve(configuration), base = dirname(configPath);
  const read = async (path, maximum = 512 * 1024 * 1024) => {
    assert.equal(typeof path, 'string');
    const resolved = resolve(base, path), info = await lstat(resolved);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum);
    const bytes = new Uint8Array(await readFile(resolved));
    assert.ok(bytes.length > 0 && bytes.length <= maximum);
    return bytes;
  };
  const config = parseStrictJson(new Uint8Array(await readFile(configPath)));
  exact(config, ['schema', 'trust', 'manifest', 'artifacts', 'wasm'], ['notices']);
  assert.equal(config.schema, 1);
  exact(config.artifacts, [...artifactNames, 'additional']); exact(config.wasm, ['path', 'sha256']);
  assert.ok(config.artifacts.additional && typeof config.artifacts.additional === 'object' && !Array.isArray(config.artifacts.additional));
  const trust = publicTrust(config.trust), manifestBytes = await read(config.manifest);
  const manifest = await verifyManifest(manifestBytes, trust);
  const artifacts = { additional: Object.create(null) };
  for (const name of artifactNames) artifacts[name] = await read(config.artifacts[name]);
  for (const [name, path] of Object.entries(config.artifacts.additional)) artifacts.additional[name] = await read(path);
  const verified = await verifyArtifactBundle(manifest, artifacts);
  const wasm = await read(config.wasm.path);
  assert.match(config.wasm.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex(wasm), config.wasm.sha256);
  assert.ok(WebAssembly.validate(wasm));
  const notices = Object.create(null), noticePayloads = Object.create(null);
  if (config.notices !== undefined) {
    assert.ok(config.notices && typeof config.notices === 'object' && !Array.isArray(config.notices));
    const names = Object.keys(config.notices).sort();
    assert.ok(names.length > 0 && names.length <= 32);
    let total = 0;
    for (const name of names) {
      assert.ok(noticeName.test(name) && name !== 'bundle.json');
      const bytes = await read(config.notices[name], maximumNoticeBytes);
      total += bytes.length; assert.ok(total <= maximumTotalNoticeBytes);
      notices[name] = name; noticePayloads[name] = bytes;
    }
  }

  // Build and bound the complete descriptor before creating the new directory.
  // Never overwrite a funded deployment; outputs contain no source paths.
  const files = Object.create(null), payloads = Object.create(null), entries = { additional: Object.create(null) };
  const add = async (name, bytes) => {
    assert.ok(!Object.hasOwn(payloads, name) && name !== 'bundle.json', 'public file collision');
    payloads[name] = bytes;
    files[name] = { sha256: await sha256Hex(bytes), bytes: bytes.length };
    return name;
  };
  const manifestFile = await add('manifest.json', manifestBytes);
  for (const name of artifactNames) entries[name] = await add(`${name}.bin`, verified[name]);
  let index = 0;
  for (const name of Object.keys(verified.additional).sort()) {
    // Manifest labels never become filenames, preventing path traversal.
    entries.additional[name] = await add(`additional-${index++}.bin`, verified.additional[name]);
  }
  const wasmFile = await add('prover.wasm', wasm);
  for (const [name, bytes] of Object.entries(noticePayloads)) await add(name, bytes);
  // Schema 1 remains byte-for-byte unchanged when no notices are requested.
  // Schema 2 explicitly authenticates and requires every public notice file.
  const descriptor = { schema: config.notices === undefined ? 1 : 2, trust, manifest: manifestFile, artifacts: entries,
    wasm: { path: wasmFile, sha256: config.wasm.sha256 }, files, ...(config.notices === undefined ? {} : {notices}) };
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2) + '\n');
  assert.ok(bytes.length <= 1024 * 1024);
  assert.ok(Object.values(files).reduce((sum, f) => sum + f.bytes, 0) <= 512 * 1024 * 1024);
  const destination = resolve(output);
  await mkdir(destination, { mode: 0o755 });
  for (const [name, payload] of Object.entries(payloads)) await writeFile(join(destination, name), payload, { flag: 'wx', mode: 0o644 });
  await writeFile(join(destination, 'bundle.json'), bytes, { flag: 'wx', mode: 0o644 });
  return { schema: 1, bundleSha256: await sha256Hex(bytes), manifestHash: manifest.manifest_hash,
    publicFiles: Object.keys(files).length + 1, totalBytes: Object.values(files).reduce((sum, f) => sum + f.bytes, bytes.length),
    networkActions: 0, fundingActions: 0, inferenceActions: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 4);
    console.log(JSON.stringify(await packageDeploymentAssets(process.argv[2], process.argv[3]), null, 2));
  } catch {
    console.error('Public SDK artifact packaging failed. Check independently reviewed pins, exact public inputs and a new output directory. No network action was attempted.');
    process.exitCode = 1;
  }
}
