/** Node device bindings and portable recovery-kit files. File contents are
 * secrets: private directories/files only, atomic fsync commits and no logging.
 * Keep the recovery kit outside the device data directory being protected. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeJournalStore } from './journal-node.ts';
import { parseStrictJson } from './trust.ts';
import { validateRecoveryKit, validateRecoverySession, type RecoveryKit, type RecoverySession } from './recovery.ts';

const maximumBytes = 16_384;
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function sameIdentity(a: RecoverySession, b: RecoverySession): boolean {
  return a.endpoint === b.endpoint && a.vaultId === b.vaultId && a.context.deploymentId === b.context.deploymentId
    && a.context.pool === b.context.pool && a.context.wallet === b.context.wallet && a.keyHex === b.keyHex;
}
async function privateParent(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Absolute recovery file path required');
  const parent = dirname(path);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || process.getuid && info.uid !== process.getuid()) throw new Error('Recovery files require a private owned directory');
}
async function readPrivate(path: string): Promise<unknown> {
  await privateParent(path, false);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maximumBytes
      || process.getuid && info.uid !== process.getuid()) throw new Error('Invalid private recovery file');
    return parseStrictJson(new Uint8Array(await file.readFile()), maximumBytes);
  } finally { await file.close(); }
}
async function writePrivate(path: string, value: unknown, replace: boolean): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maximumBytes) throw new Error('Recovery file too large');
  const parent = dirname(path), temporary = join(parent, '.' + basename(path) + '.' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(encoded, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // A hard link provides atomic create-if-absent. Only an explicit owner
    // replacement, after checking the existing binding under a process lock,
    // may atomically replace a device session.
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

/** Saves the current device session, never a different custody binding.
 * replaceOwner is only for explicit restoration of the same vault/key after
 * its previous device owner has been fenced. Raw key material stays in this
 * private file; this file is not the separately retained recovery kit. */
export async function saveRecoverySessionFile(path: string, session: RecoverySession, options: { replaceOwner?: boolean } = {}): Promise<void> {
  const snapshot = structuredClone(session);
  validateRecoverySession(snapshot);
  await privateParent(path, true);
  const locks = await NativeJournalStore.open(dirname(path));
  await locks.withLock('recovery-session:' + basename(path), async () => {
    const previous = await loadRecoverySessionFile(path);
    if (previous) {
      if (!sameIdentity(previous, snapshot)) throw new Error('Recovery file already belongs to different custody; no replacement allowed');
      if (previous.ownerToken === snapshot.ownerToken) return;
      if (!options.replaceOwner) throw new Error('Recovery owner changed; explicit restore is required');
    }
    await writePrivate(path, snapshot, previous !== null);
  });
}

/** Missing data returns null; opening never initializes a replacement key. */
export async function loadRecoverySessionFile(path: string): Promise<RecoverySession | null> {
  let value: unknown;
  try { value = await readPrivate(path); }
  catch (error) { if (missing(error)) return null; throw error; }
  validateRecoverySession(value);
  return structuredClone(value);
}

/** Export to a separate private location before funding. Existing files are
 * never overwritten. Anyone with this kit can recover the encrypted journal. */
export async function writeRecoveryKitFile(path: string, kit: RecoveryKit): Promise<void> {
  const snapshot = structuredClone(kit);
  validateRecoveryKit(snapshot);
  await privateParent(path, true);
  await writePrivate(path, snapshot, false);
}

export async function readRecoveryKitFile(path: string): Promise<RecoveryKit> {
  const value = await readPrivate(path);
  validateRecoveryKit(value);
  return structuredClone(value);
}
