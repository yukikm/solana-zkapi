import { rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
// Keep source execution and packaged runtime on the exact package version.
const metadata = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
await writeFile(new URL('src/version.ts', import.meta.url), `/** Generated from packages/sdk/package.json by build.mjs. */\nexport const SDK_VERSION = ${JSON.stringify(metadata.version)};\n`);
// Remove stale products so removed source files cannot leak into a new tarball.
await rm(new URL('dist/', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// TypeScript rewrites runtime imports but leaves .ts specifiers in declarations.
// Export only normal .js specifiers, resolved by TypeScript to sibling .d.ts.
for (const name of await readdir(new URL('dist/', import.meta.url))) {
  if (!name.endsWith('.d.ts')) continue;
  const path = new URL('dist/' + name, import.meta.url);
  const original = await readFile(path, 'utf8');
  const declarations = original.replace(/((?:from|import)\s*(?:\(\s*)?['"])(\.\/[\w-]+)\.ts(?=['"])/g, '$1$2.js');
  await writeFile(path, declarations);
}
