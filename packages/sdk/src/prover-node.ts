/** Installed native fallback. Secrets and key bytes travel over stdin, never argv. */
import { spawn } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { ProverRejected, ProverUnavailable, type ClientProver } from './prover-runtime.ts';
export class NativeProver implements ClientProver {
  private readonly path: string; private readonly hash: string;
  constructor(executablePath: string, sha256: string) {
    if (!isAbsolute(executablePath) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('installed prover pin required');
    this.path = executablePath; this.hash = sha256;
  }
  async run(command: object): Promise<unknown> {
    const input = JSON.stringify(command);
    if (Buffer.byteLength(input) > 64*1024*1024) throw new ProverRejected();
    const info = await lstat(this.path), path = await realpath(this.path);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || createHash('sha256').update(await readFile(this.path)).digest('hex') !== this.hash) throw new ProverRejected();
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], { shell:false, stdio:['pipe','pipe','pipe'], env:{RAYON_NUM_THREADS:'4'} });
      let finished = false, length = 0; const chunks: Buffer[] = [];
      const done = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else {
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object') throw new Error(); resolve(value); } catch { reject(new ProverRejected()); }
      } };
      const timer = setTimeout(() => done(new ProverUnavailable()), 300_000);
      child.on('error', () => done(new ProverUnavailable())); child.stdin.on('error', () => done(new ProverUnavailable()));
      child.stdout.on('data', (chunk:Buffer) => { length += chunk.length; if (length > 1024*1024) done(new ProverRejected()); else chunks.push(chunk); });
      child.stderr.resume(); child.on('close', code => done(code === 0 ? undefined : new ProverRejected())); child.stdin.end(input);
    });
  }
}
