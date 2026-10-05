import {build} from 'esbuild';
import {mkdir, copyFile, rm} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const directory = dirname(fileURLToPath(import.meta.url));
export async function buildUi(output: string, fixture = false): Promise<void> {
  await mkdir(output, {recursive: true});
  await build({entryPoints: [resolve(directory, fixture ? 'fixture.ts' : 'main.ts')], outfile: resolve(output, 'app.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', sourcemap: false,
    define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent'});
  if (!fixture) {
    await build({entryPoints: [resolve(directory, '../../packages/sdk/src/prover-worker.ts')],
      outfile: resolve(output, 'worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: 'silent'});
    await build({entryPoints: [resolve(directory, 'demo-entry.ts')], outfile: resolve(output, 'demo.js'),
      bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', sourcemap: false, logLevel: 'silent'});
    await copyFile(resolve(directory, 'demo.css'), resolve(output, 'demo.css'));
    await copyFile(resolve(directory, 'demo.html'), resolve(output, 'demo.html'));
  } else {
    // A reused build directory must still open the original browser fixture.
    await Promise.all(['demo.html', 'demo.css', 'demo.js'].map(name => rm(resolve(output, name), {force: true})));
  }
  await copyFile(resolve(directory, 'index.html'), resolve(output, 'index.html'));
  await copyFile(resolve(directory, 'style.css'), resolve(output, 'style.css'));
}
