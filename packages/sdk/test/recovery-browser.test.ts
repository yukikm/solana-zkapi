/** Actual Chromium origin-data deletion and cross-runtime recovery; no simulated IndexedDB. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreRecoveryStorage } from '../src/recovery.ts';
import { recoveryBrowser, recoveryChrome } from './recovery-browser-fixture.ts';
import { recoveryContext, recoveryEndpoint, recoveryNoteId, recoveryState, recoveryJournal, recoveryServer } from './recovery-fixture.ts';
import { NON_EXPIRING_NOTE_EXPIRY } from '../src/deposit-expiry.ts';

for (const [policy, expiry] of [['finite', '1900000000'], ['non-expiring', NON_EXPIRING_NOTE_EXPIRY]]) {
test(`Chromium restores exact latest ${policy} custody after complete origin-data deletion, then Node reads the same backup`, { skip: !recoveryChrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 60_000 }, async t => {
  const server = await recoveryServer(t), browser = await recoveryBrowser(t, server.origin);
  const state = recoveryState(); state.witness.expiry = expiry;
  const original = await browser.createTab();
  const backedUp = await original.cdp.evaluate(`(async () => {
    const recovery = await import('/modules/recovery.js');
    const binding = await import('/modules/recovery-browser.js');
    const {EncryptedJournal} = await import('/modules/journal.js');
    const kit=recovery.createRecoveryKit({endpoint:${JSON.stringify(recoveryEndpoint)},context:${JSON.stringify(recoveryContext)}});
    const storage=await recovery.createRecoveryStorage(kit,{fetch:fixtureFetch});
    await binding.saveRecoverySession('recovery-browser-fixture',storage.session);
    const validate=value=>{if(!value||value.schema!==1||!value.pending?.exactRequest)throw Error('invalid fixture');};
    const journal=new EncryptedJournal(storage.store,storage.key,kit.context,validate);
    const state=${JSON.stringify(state)};const initial=structuredClone(state);initial.state.balance_micro_usdc='2000000';
    await journal.create(${JSON.stringify(recoveryNoteId)},initial);
    await journal.compareAndSwap(${JSON.stringify(recoveryNoteId)},1,state);
    const saved=await journal.read(${JSON.stringify(recoveryNoteId)});
    const local=await binding.loadRecoverySession('recovery-browser-fixture');
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('zkapi-recovery-bindings-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const raw=await new Promise((resolve,reject)=>{const request=db.transaction('sessions').objectStore('sessions').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();
    const hasRawKey=JSON.stringify(raw).includes(storage.session.keyHex);
    localStorage.setItem('synthetic-local-deposit-catalog',JSON.stringify({noteIds:[${JSON.stringify(recoveryNoteId)}]}));
    await storage.close();
    const reopened=await recovery.openRecoveryStorage(local.session,{key:local.key,fetch:fixtureFetch});
    const reread=await new EncryptedJournal(reopened.store,reopened.key,kit.context,validate).read(${JSON.stringify(recoveryNoteId)});await reopened.close();
    return {kit,head:saved.head,reread:reread.value,extractable:local.key.extractable,hasRawKey,sessionHasRawKey:'keyHex' in local.session};
  })()`);
  assert.deepEqual(backedUp.reread, state);
  assert.equal(backedUp.extractable, false); assert.equal(backedUp.hasRawKey, false); assert.equal(backedUp.sessionHasRawKey, false);
  // The portable kit returned above represents the user's independent recovery file.
  // All site state and the original JavaScript realm are now removed.
  await original.cdp.call('Storage.clearDataForOrigin', { origin: browser.origin, storageTypes: 'all' });
  assert.deepEqual(await original.cdp.evaluate(`(async()=>({databases:(await indexedDB.databases()).length,localStorage:localStorage.length}))()`), { databases: 0, localStorage: 0 });
  await original.close();
  const replacement = await browser.createTab();
  const result = await replacement.cdp.evaluate(`(async () => {
    const recovery=await import('/modules/recovery.js');const binding=await import('/modules/recovery-browser.js');const {EncryptedJournal}=await import('/modules/journal.js');
    const missing=await binding.loadRecoverySession('recovery-browser-fixture');
    const kit=${JSON.stringify(backedUp.kit)};
    const storage=await recovery.restoreRecoveryStorage(kit,{previousOwnerStopped:true,expectedEndpoint:${JSON.stringify(recoveryEndpoint)},fetch:fixtureFetch});
    const journal=new EncryptedJournal(storage.store,storage.key,kit.context,value=>{if(!value||value.schema!==1)throw Error('invalid fixture');});
    const saved=await journal.read(${JSON.stringify(recoveryNoteId)});
    await binding.saveRecoverySession('recovery-browser-fixture',storage.session);const local=await binding.loadRecoverySession('recovery-browser-fixture');await storage.close();
    return {missing,saved,extractable:local.key.extractable};
  })()`);
  assert.equal(result.missing, null); assert.equal(result.extractable, false);
  assert.deepEqual(result.saved.value, state); assert.deepEqual(result.saved.head, backedUp.head);
  await replacement.close();
  const node = await restoreRecoveryStorage(backedUp.kit, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch });
  assert.deepEqual((await recoveryJournal(node).read(recoveryNoteId))?.value, state); await node.close();
});
}

test('browser enrollment copies existing nonextractable custody without deleting the source or losing revision', { skip: !recoveryChrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 60_000 }, async t => {
  const server = await recoveryServer(t), browser = await recoveryBrowser(t, server.origin), tab = await browser.createTab();
  const result = await tab.cdp.evaluate(`(async () => {
    const recovery=await import('/modules/recovery.js');const {openBrowserStorage}=await import('/modules/browser-storage.js');const {EncryptedJournal}=await import('/modules/journal.js');
    const context=${JSON.stringify(recoveryContext)},state=${JSON.stringify(recoveryState())};
    const validate=value=>{if(!value||value.schema!==1)throw Error('invalid fixture');};
    const source=await openBrowserStorage('existing-unrecoverable-custody',{initialize:true});
    const original=new EncryptedJournal(source.store,source.key,context,validate);await original.create(${JSON.stringify(recoveryNoteId)},state);
    await original.compareAndSwap(${JSON.stringify(recoveryNoteId)},1,state);
    const kit=recovery.createRecoveryKit({endpoint:${JSON.stringify(recoveryEndpoint)},context});const target=await recovery.createRecoveryStorage(kit,{fetch:fixtureFetch});
    const copied=await original.copyTo(${JSON.stringify(recoveryNoteId)},target);const retained=await original.read(${JSON.stringify(recoveryNoteId)});
    const keyExtractable=source.key.extractable;source.close();target.close();return {kit,copied,retained,keyExtractable};
  })()`);
  assert.equal(result.keyExtractable, false); assert.equal(result.copied.revision, 2);
  assert.deepEqual(result.copied.value, recoveryState()); assert.deepEqual(result.retained.value, recoveryState());
  await tab.cdp.call('Storage.clearDataForOrigin', { origin: browser.origin, storageTypes: 'all' }); await tab.close();
  const restored = await restoreRecoveryStorage(result.kit, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch });
  assert.deepEqual((await recoveryJournal(restored).read(recoveryNoteId))?.value, recoveryState()); await restored.close();
});
