/** Native passphrase custody. The random journal key is wrapped, never derived
 * directly from the passphrase. No secrets go in argv, environment or logs. */
import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { open, lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { parseStrictJson } from './trust.ts';

interface Envelope { version: 1; kdf: 'scrypt-32768-8-1'; salt: string; iv: string; ciphertext: string; tag: string }
const aad = Buffer.from('solana-zkapi-journal-key-v1');
async function derive(passphrase: Uint8Array, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 16 || passphrase.length > 4096) throw new Error('passphrase must contain 16–4096 UTF-8 bytes');
  return new Promise((resolve,reject) => scrypt(passphrase,salt,32,{ N:32768,r:8,p:1,maxmem:64*1024*1024 },(e,key)=>e?reject(new Error('key derivation failed')):resolve(key)));
}
async function privatePath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('absolute custody path required');
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) throw new Error('custody requires a private directory');
}
export async function initializeJournalKey(path: string, passphrase: Uint8Array): Promise<Uint8Array> {
  await privatePath(path);
  const salt = randomBytes(32), iv = randomBytes(12), raw = randomBytes(32), wrapping = await derive(passphrase,salt);
  try {
    const cipher = createCipheriv('aes-256-gcm',wrapping,iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(raw),cipher.final()]);
    const envelope: Envelope = {version:1,kdf:'scrypt-32768-8-1',salt:salt.toString('hex'),iv:iv.toString('hex'),ciphertext:ciphertext.toString('hex'),tag:cipher.getAuthTag().toString('hex')};
    // wx prevents accidental reset of the only decryption key. A failed partial
    // initialization must be inspected; reopening will never create a new key.
    const file = await open(path,'wx',0o600);
    try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
    const directory = await open(dirname(path),'r'); try { await directory.sync(); } finally { await directory.close(); }
    return new Uint8Array(raw);
  } finally { wrapping.fill(0); raw.fill(0); }
}
export async function unlockJournalKey(path: string, passphrase: Uint8Array): Promise<Uint8Array> {
  await privatePath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 2048) throw new Error('invalid custody file');
  const e = parseStrictJson(new Uint8Array(await readFile(path))) as unknown as Envelope;
  if (!e || Object.keys(e).sort().join(',') !== 'ciphertext,iv,kdf,salt,tag,version' || e.version !== 1 || e.kdf !== 'scrypt-32768-8-1' || !/^[0-9a-f]{64}$/.test(e.salt) || !/^[0-9a-f]{24}$/.test(e.iv) || !/^[0-9a-f]{64}$/.test(e.ciphertext) || !/^[0-9a-f]{32}$/.test(e.tag)) throw new Error('invalid custody envelope');
  const wrapping = await derive(passphrase,Buffer.from(e.salt,'hex'));
  try {
    const decipher = createDecipheriv('aes-256-gcm',wrapping,Buffer.from(e.iv,'hex')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(e.tag,'hex'));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(e.ciphertext,'hex')),decipher.final()]));
  } catch { throw new Error('unable to unlock journal'); } finally { wrapping.fill(0); }
}
