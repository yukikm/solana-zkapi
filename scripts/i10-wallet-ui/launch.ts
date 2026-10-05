/** Explicit local launch only. Configuration may hold an RPC URL, never a wallet key. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseStrictJson} from '../../packages/sdk/src/trust.ts';
import {buildUi} from './build.ts';
import {configuredHost, type HostConfig} from './host.ts';
async function main(): Promise<void> {
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') throw Error('usage: node scripts/i10-wallet-ui/launch.ts --config PRIVATE_CONFIG.json');
const config = parseStrictJson(await readFile(resolve(args[1]))) as unknown as HostConfig;
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.runId)) throw Error('invalid run ID');
const output = resolve('target/i10-wallet-ui', config.runId);
await buildUi(output);
const host = await configuredHost(config, output);
console.log(JSON.stringify({origin: host.origin, run_id: config.runId, transaction_sends_enabled: config.allowTransactions, wallet: 'Phantom', cluster: 'devnet'}));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void host.close().then(() => process.exit(0)); } });

}
void main().catch(() => { console.error('Wallet UI host startup failed; inspect the private configuration locally.'); process.exitCode = 1; });
