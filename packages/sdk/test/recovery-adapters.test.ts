/** Synthetic custody bindings; no live account, wallet or payment is used. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryKit, type RecoverySession } from '../src/recovery.ts';
import { saveRecoverySessionFile, loadRecoverySessionFile, writeRecoveryKitFile, readRecoveryKitFile } from '../src/recovery-node.ts';
import { recoveryBrowser, recoveryChrome } from './recovery-browser-fixture.ts';

const session = (): RecoverySession => ({ schema: 1, endpoint: 'https://recovery.example.test/recovery/v1', vaultId: '11'.repeat(32),
  context: { deploymentId: 'adapter-fixture', pool: 'fixture-pool', wallet: 'fixture-wallet' }, ownerToken: '22'.repeat(32), keyHex: '33'.repeat(32) });
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zkapi-recovery-adapters-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Node recovery device binding is private, idempotent and requires explicit same-custody owner rotation', async t => {
  const root = await directory(t), path = join(root, 'new-private-device', 'session.json'), original = session();
  assert.equal(await loadRecoverySessionFile(path), null);
  await saveRecoverySessionFile(path, original);
  assert.equal((await stat(join(root, 'new-private-device'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await loadRecoverySessionFile(path), original);
  await saveRecoverySessionFile(path, original);
  const replacement = { ...original, ownerToken: '44'.repeat(32) };
  await assert.rejects(saveRecoverySessionFile(path, replacement), /explicit restore/);
  assert.deepEqual(await loadRecoverySessionFile(path), original);
  await saveRecoverySessionFile(path, replacement, { replaceOwner: true });
  assert.deepEqual(await loadRecoverySessionFile(path), replacement);
  for (const candidate of [
    { ...replacement, vaultId: '55'.repeat(32) },
    { ...replacement, endpoint: 'https://different.example.test/recovery/v1' },
    { ...replacement, context: { ...replacement.context, wallet: 'another-wallet' } },
    { ...replacement, context: { ...replacement.context, deploymentId: 'another-deployment' } },
    { ...replacement, context: { ...replacement.context, pool: 'another-pool' } },
    { ...replacement, keyHex: '66'.repeat(32) },
  ]) {
    await assert.rejects(saveRecoverySessionFile(path, candidate, { replaceOwner: true }), /different custody/);
    assert.deepEqual(await loadRecoverySessionFile(path), replacement);
  }
});

test('Node portable recovery kit is separately stored and cannot silently overwrite an existing file', async t => {
  const root = await directory(t), path = join(root, 'separate-backup', 'kit.json');
  const kit = createRecoveryKit({ endpoint: session().endpoint, context: session().context });
  await writeRecoveryKitFile(path, kit);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readRecoveryKitFile(path), kit);
  await assert.rejects(writeRecoveryKitFile(path, { ...kit, secret: '77'.repeat(32) }), { code: 'EEXIST' });
  assert.deepEqual(await readRecoveryKitFile(path), kit);
});

test('Node recovery adapters reject public files, symlinks, malformed files and relative paths', async t => {
  const root = await directory(t), path = join(root, 'session.json');
  await saveRecoverySessionFile(path, session());
  const before = await readFile(path, 'utf8');
  await chmod(path, 0o644);
  await assert.rejects(loadRecoverySessionFile(path), /private recovery file/);
  await assert.rejects(saveRecoverySessionFile(path, session()), /private recovery file/);
  await chmod(path, 0o600);
  const alias = join(root, 'session-link.json');
  await symlink(path, alias);
  await assert.rejects(loadRecoverySessionFile(alias));
  await assert.rejects(saveRecoverySessionFile(alias, session(), { replaceOwner: true }));
  assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(saveRecoverySessionFile('relative-session.json', session()), /Absolute recovery file path/);
  await chmod(root, 0o755);
  await assert.rejects(loadRecoverySessionFile(path), /private owned directory/);
  await assert.rejects(saveRecoverySessionFile(path, session()), /private owned directory/);
  await chmod(root, 0o700);
  await writeFile(path, '{"schema":1,"schema":1}', { mode: 0o600 });
  await assert.rejects(loadRecoverySessionFile(path));
});

test('Node concurrent session initialization never replaces another custody binding', async t => {
  const root = await directory(t), path = join(root, 'session.json');
  const first = session(), second = { ...session(), vaultId: 'aa'.repeat(32), keyHex: 'bb'.repeat(32) };
  const results = await Promise.allSettled([saveRecoverySessionFile(path, first), saveRecoverySessionFile(path, second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = await loadRecoverySessionFile(path);
  assert.ok(JSON.stringify(saved) === JSON.stringify(first) || JSON.stringify(saved) === JSON.stringify(second));
});

test('Chromium recovery binding refuses cross-custody replacement and requires explicit owner rotation', { skip: !recoveryChrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 60_000 }, async t => {
  const browser = await recoveryBrowser(t, 'http://127.0.0.1:1'), tab = await browser.createTab();
  const result = await tab.cdp.evaluate(`(async () => {
    const {saveRecoverySession,loadRecoverySession}=await import('/modules/recovery-browser.js');
    const original=${JSON.stringify(session())},name='binding-collision-fixture';
    await saveRecoverySession(name,original);await saveRecoverySession(name,original);
    const changed={...original,ownerToken:'44'.repeat(32)};
    let ownerRefused=false;try{await saveRecoverySession(name,changed);}catch{ownerRefused=true;}
    await saveRecoverySession(name,changed,{replaceOwner:true});
    const candidates=[{...changed,vaultId:'55'.repeat(32)}, {...changed,endpoint:'https://different.example.test/recovery/v1'},
      {...changed,context:{...changed.context,wallet:'another-wallet'}}, {...changed,context:{...changed.context,pool:'another-pool'}},
      {...changed,context:{...changed.context,deploymentId:'another-deployment'}}, {...changed,keyHex:'66'.repeat(32)}];
    let refused=0;for(const candidate of candidates){try{await saveRecoverySession(name,candidate,{replaceOwner:true});}catch{refused++;}}
    const saved=await loadRecoverySession(name);await saveRecoverySession(name,saved.session,{key:saved.key});
    return {ownerRefused,refused,owner:saved.session.ownerToken,extractable:saved.key.extractable,keyHexPresent:'keyHex' in saved.session};
  })()`);
  assert.deepEqual(result, { ownerRefused: true, refused: 6, owner: '44'.repeat(32), extractable: false, keyHexPresent: false });
});
