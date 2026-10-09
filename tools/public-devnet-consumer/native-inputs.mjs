/** Derive native setup inputs from an authenticated public SDK profile.
 * No custody, tokens, wallet operations, provider calls, or existing file writes. */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname, basename, join } from 'node:path';
import { publicProfileClientOptions } from '@zkapi/solana-sdk/public-profile';
import { sha256Hex } from '@zkapi/solana-sdk/trust';

const artifactNames = ['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk',
  'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'];

export function nativeNetwork(profile, manifest, { mode, socks5, admissionTokenFile } = {}) {
  if (!['direct', 'tor'].includes(mode)) throw new Error('explicit direct or tor network mode required');
  if (mode === 'direct' && socks5 !== undefined) throw new Error('SOCKS5 requires tor mode');
  if (mode === 'tor' && (typeof socks5 !== 'string' || !/^127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(socks5)
    || Number(socks5.split(':')[1]) > 65535)) throw new Error('numeric loopback SOCKS5 endpoint required');
  if (admissionTokenFile !== undefined && (typeof admissionTokenFile !== 'string' ||
    !isAbsolute(admissionTokenFile) || resolve(admissionTokenFile) !== admissionTokenFile ||
    /[\x00-\x1f\x7f]/.test(admissionTokenFile))) throw new Error('canonical absolute admission token file required');
  const routes = [];
  function add(base, suffix = '') {
    const u = new URL(base);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
      throw new Error('public HTTPS route required');
    const prefix = (u.pathname === '/' ? '' : u.pathname) + suffix || '/';
    if (prefix.includes('%') || prefix.includes('//') || prefix.includes('/../')) throw new Error('canonical route required');
    if (!routes.some(r => r.origin === u.origin && r.prefix === prefix)) routes.push({ origin: u.origin, prefix });
  }
  add(manifest.control_api_origin, '/zkapi/v1');
  add(profile.indexerOrigin, '/zkapi/v1/tree');
  add(profile.rpcUrl);
  if (profile.mode === 'proxy') add(manifest.inference_api_origin, '/v1');
  else {
    const provider = profile.directProviderBases?.[profile.mode];
    if (!provider) throw new Error('explicit provider base required');
    // ControlClient replaces its /v1 prefix with this reviewed provider base.
    add(provider);
    if (profile.mode === 'direct_oa') add(profile.oaVerifier.base, '/submit_key');
  }
  return { mode, ...(socks5 === undefined ? {} : { socks5 }), routes,
    ...(admissionTokenFile === undefined ? {} : {
      admission: { origin: manifest.control_api_origin, token_file: admissionTokenFile } }) };
}

export async function installNativeInputs(loaded, destination, networkOptions) {
  // The SDK retrieves an authenticated private snapshot, not mutable display data.
  const options = publicProfileClientOptions(loaded);
  const profile = loaded.profile;
  const assets = loaded.assets;
  const manifestView = assets.verifiedManifest;
  const network = nativeNetwork(profile, manifestView, networkOptions);
  if (!isAbsolute(destination) || resolve(destination) !== destination) throw new Error('canonical absolute new directory required');
  const parent = await realpath(dirname(destination));
  if (join(parent, basename(destination)) !== destination) throw new Error('symlinked destination parent rejected');
  // Refuse an existing directory, including partial earlier installation. Never reset it.
  await mkdir(destination, { mode: 0o700 });
  const write = async (name, bytes) => {
    const path = join(destination, name);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return path;
  };
  const json = value => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
  const manifest = await write('manifest.json', options.deployment.manifest);
  const artifacts = { additional: Object.create(null) };
  for (const name of artifactNames) artifacts[name] = await write(name + '.bin', options.deployment.artifacts[name]);
  // Never use untrusted additional-artifact names as filesystem paths.
  let index = 0;
  for (const [name, bytes] of Object.entries(options.deployment.artifacts.additional))
    artifacts.additional[name] = await write(`additional-${index++}.bin`, bytes);
  // Retain every hash-verified public notice; labels never become output paths.
  const notices = Object.create(null);
  for (const [i, [label, bytes]] of Object.entries(assets.notices).entries()) {
    const file = `notice-${i}.bin`;
    await write(file, bytes);
    notices[label] = { file, sha256: await sha256Hex(bytes), bytes: bytes.length };
  }
  const noticesBytes = json({ schema: 1, notices });
  const noticesPath = await write('notices.json', noticesBytes);
  const models = [];
  for (const [i, model] of options.models.entries()) {
    models.push({ id: model.id, provider: model.provider, apis: model.apis,
      capabilities: model.capabilities, tariff: await write(`tariff-${i}.json`, json(model.tariff)) });
  }
  const runtime = { manifest, policy: options.deployment.trust, artifacts, mode: options.mode,
    models, rpc: profile.rpcUrl, indexer: profile.indexerOrigin, key_reuse_seconds: 60,
    ...(options.mode === 'direct_openrouter' ? { settlement_wait_ms: 120_000 } : {}),
    ...(profile.preparationCommitment ? { preparation_commitment: profile.preparationCommitment } : {}),
    ...(options.directProviderBases ? { direct_provider_bases: options.directProviderBases } : {}),
    ...(options.oaVerifier ? { oa_verifier: options.oaVerifier } : {}) };
  const runtimeBytes = json(runtime), networkBytes = json(network);
  const runtimePath = await write('runtime.json', runtimeBytes);
  const networkPath = await write('network.json', networkBytes);
  const receipt = { schema: 1, profileId: profile.id, profileSha256: loaded.profileSha256,
    bundleSha256: profile.bundle.sha256, manifestHash: manifestView.manifest_hash,
    runtime: runtimePath, runtimeSha256: await sha256Hex(runtimeBytes),
    network: networkPath, networkSha256: await sha256Hex(networkBytes),
    notices: noticesPath, noticesSha256: await sha256Hex(noticesBytes),
    custodyInitialized: false, funded: false };
  await write('installation.json', json(receipt));
  return receipt;
}
