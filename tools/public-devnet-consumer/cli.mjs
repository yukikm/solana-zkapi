#!/usr/bin/env node
import { loadPublicDeploymentProfile, preflightPublicDeployment, PublicProfileError } from '@zkapi/solana-sdk/public-profile';
import { installNativeInputs } from './native-inputs.mjs';

const usage = 'node cli.mjs preflight|install-native --profile-url HTTPS_URL --profile-sha256 REVIEWED_SHA256 [--installed-profile-sha256 ORIGINAL_SHA256] [--output /absolute/new-directory --runtime-network direct|tor --runtime-socks5 127.0.0.1:9050 --admission-token-file /absolute/private/invitation]. Installation downloads/preflight always use direct HTTPS; runtime-network configures subsequent clientd only.';
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' && !args.length) { console.log(usage); return; }
  if (!['preflight', 'install-native'].includes(command) || args.length % 2) throw new Error('arguments');
  const flags = Object.create(null);
  const allowed = ['--profile-url', '--profile-sha256', '--installed-profile-sha256',
    ...(command === 'install-native' ? ['--output', '--runtime-network', '--runtime-socks5', '--admission-token-file'] : [])];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || Object.hasOwn(flags, args[i]) || !args[i + 1]) throw new Error('arguments');
    flags[args[i]] = args[i + 1];
  }
  if (!flags['--profile-url'] || !/^[0-9a-f]{64}$/.test(flags['--profile-sha256'] ?? '')) throw new Error('arguments');
  if (command === 'install-native' && (!flags['--output'] || !flags['--runtime-network'])) throw new Error('arguments');
  const loaded = await loadPublicDeploymentProfile(flags['--profile-url'], {
    profileSha256: flags['--profile-sha256'], installedProfileSha256: flags['--installed-profile-sha256'] });
  const preflight = await preflightPublicDeployment(loaded);
  const installation = command === 'install-native'
    ? await installNativeInputs(loaded, flags['--output'], { mode: flags['--runtime-network'], socks5: flags['--runtime-socks5'],
      admissionTokenFile: flags['--admission-token-file'] }) : undefined;
  console.log(JSON.stringify({ installationTransport: 'direct_https', preflight, ...(installation ? { installation } : {}) }, null, 2));
}
main().catch(error => {
  // Never echo server bodies, URLs, headers, paths, or raw nested errors.
  console.error(JSON.stringify({ error: error instanceof PublicProfileError ? error.component : 'consumer_setup_failed',
    message: 'No financial action was performed. Check the reviewed profile, connectivity and new output directory.', usage }));
  process.exitCode = 1;
});
