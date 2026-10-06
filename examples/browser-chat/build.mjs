// Reuse the repository's already pinned build tool; no unpinned npx installation.
import { build } from '../../scripts/i10-wallet-ui/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['examples/browser-chat/integration.ts'],
  outfile: 'target/app-sdk-example/integration.js', bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' } });
await build({ absWorkingDir: root, entryPoints: ['packages/sdk/src/prover-worker.ts'],
  outfile: 'target/app-sdk-example/worker.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
await build({ absWorkingDir: root, entryPoints: ['examples/browser-chat/main.ts'],
  outfile: 'target/app-sdk-example/app.js', bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' } });
for (const name of ['index.html', 'styles.css']) await copyFile(`${root}examples/browser-chat/${name}`, `${root}target/app-sdk-example/${name}`);
