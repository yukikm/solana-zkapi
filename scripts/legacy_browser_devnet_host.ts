/** Serve a separately built legacy demo; never build or import application UI. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';
import {configuredHost, type HostConfig} from './devnet-browser-relay/host.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--ui-dir') {
    throw Error('usage: node scripts/legacy_browser_devnet_host.ts --config PRIVATE_CONFIG.json --ui-dir BUILT_CLIENT_DIRECTORY');
  }
  const config = parseStrictJson(await readFile(resolve(args[1]))) as unknown as HostConfig;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.runId)) throw Error('invalid run ID');
  const host = await configuredHost(config, resolve(args[3]));
  console.log(JSON.stringify({origin: host.origin, run_id: config.runId, transaction_sends_enabled: config.allowTransactions, cluster: 'devnet'}));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (!stopping) { stopping = true; void host.close().then(() => process.exit(0)); }
  });
}
void main().catch(() => { console.error('Browser host startup failed; inspect the private configuration locally.'); process.exitCode = 1; });
