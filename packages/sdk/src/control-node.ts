/** Native offline crypto bridge. No shell, argv witness material, HTTP or
 * automatic fallback. The binary digest is a pin from the installed release. */
import { spawn } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseStrictJson } from './trust.ts';
import type { SessionVerifier, VerificationContext, PrivateState, PreparedSession, Settlement, Receipt } from './control.ts';

export class NativeSessionVerifier implements SessionVerifier {
  private readonly path: string; private readonly digest: string;
  constructor(executablePath: string, sha256: string) {
    if (!isAbsolute(executablePath) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('installed binary path and SHA256 required');
    this.path = executablePath; this.digest = sha256;
  }
  private async run(command: unknown): Promise<unknown> {
    const input = JSON.stringify(command);
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error('verification input bound');
    const info = await lstat(this.path), executable = await realpath(this.path);
    if (!info.isFile() || (info.mode & 0o022) !== 0
      || createHash('sha256').update(await readFile(this.path)).digest('hex') !== this.digest) throw new Error('native verifier artifact mismatch');
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [], { shell: false, stdio: ['pipe','pipe','pipe'], env: { RAYON_NUM_THREADS: '4' } });
      const chunks: Buffer[] = []; let size = 0; let finished = false;
      const fail = () => { if (!finished) { finished = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error('native verification rejected')); } };
      const timer = setTimeout(fail, 60_000);
      child.on('error', fail); child.stdin.on('error', fail);
      child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 4*1024*1024) fail(); else chunks.push(bytes); });
      child.stderr.resume(); // Never echo potential witness material to diagnostics.
      child.on('close', code => {
        if (finished) return; if (code !== 0) { fail(); return; }
        finished = true; clearTimeout(timer);
        try { resolve(parseStrictJson(new Uint8Array(Buffer.concat(chunks)))); } catch { reject(new Error('invalid native verification response')); }
      });
      child.stdin.end(input);
    });
  }
  async prepare(context: VerificationContext, state: PrivateState, prepared: PreparedSession, now: string, root: string): Promise<void> {
    const result = await this.run({ kind: 'prepare', context, state, prepared, now, root });
    if (!result || typeof result !== 'object' || Object.keys(result).join(',') !== 'verified' || !('verified' in result) || result.verified !== true) throw new Error('verification did not succeed');
  }
  async settle(context: VerificationContext, state: PrivateState, prepared: PreparedSession, settlement: Settlement, receipts: Receipt[], operations: string[]): Promise<PrivateState> {
    return await this.run({ kind: 'settle', context, state, prepared, settlement, receipts, operations }) as PrivateState;
  }
}
