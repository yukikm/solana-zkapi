/** Empty-vault key validation uses the actual service; all keys/state are synthetic. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRecoveryKit, createRecoveryStorage, openRecoveryStorage, restoreRecoveryStorage } from '../src/recovery.ts';
import { importJournalKey } from '../src/journal.ts';
import { recoveryContext, recoveryEndpoint, recoveryJournal, recoveryNoteId, recoveryServer, recoveryState } from './recovery-fixture.ts';

test('an empty recovery vault authenticates its AES key before any new deposit journal can be created', async t => {
  const server = await recoveryServer(t), kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const storage = await createRecoveryStorage(kit, { fetch: server.fetch });
  const persisted = JSON.parse(await readFile(join(server.directory, kit.vaultId + '.json'), 'utf8'));
  assert.equal(Object.keys(persisted.records).length, 1, 'key check is committed before storage is returned');
  const wrong = storage.session.keyHex === '99'.repeat(32) ? '88'.repeat(32) : '99'.repeat(32);
  const methods: string[] = [];
  const observed: typeof fetch = (input, init) => { methods.push(init?.method ?? 'GET'); return server.fetch(input, init); };
  await assert.rejects(openRecoveryStorage({ ...storage.session, keyHex: wrong }, { fetch: observed }));
  await assert.rejects(openRecoveryStorage(storage.session, { key: await importJournalKey(new Uint8Array(32).fill(42)), fetch: observed }));
  assert.ok(methods.every(method => method === 'GET'), 'invalid keys never write or initialize another marker');
  const reopened = await openRecoveryStorage(storage.session, { fetch: server.fetch });
  await recoveryJournal(reopened).create(recoveryNoteId, recoveryState()); reopened.close(); storage.close();
  const restored = await restoreRecoveryStorage(kit, { expectedEndpoint: recoveryEndpoint, previousOwnerStopped: true, fetch: server.fetch });
  assert.deepEqual((await recoveryJournal(restored).read(recoveryNoteId))?.value, recoveryState()); restored.close();
});

test('missing and corrupt encrypted key checks fail closed on open and restore without repairing the record', async t => {
  const server = await recoveryServer(t);
  for (const mode of ['missing', 'corrupt']) {
    const kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
    const storage = await createRecoveryStorage(kit, { fetch: server.fetch }); storage.close();
    let writes = 0;
    const changed: typeof fetch = async (input, init) => {
      if (init?.method === 'PUT') writes++;
      const response = await server.fetch(input, init);
      if (init?.method === 'GET' && String(input).includes('/records/') && response.ok) {
        const value = await response.json() as { record: { ciphertextHex: string } | null };
        assert.ok(value.record);
        if (mode === 'missing') value.record = null;
        else value.record.ciphertextHex = (value.record.ciphertextHex[0] === '0' ? '1' : '0') + value.record.ciphertextHex.slice(1);
        return Response.json(value);
      }
      return response;
    };
    await assert.rejects(openRecoveryStorage(storage.session, { fetch: changed }));
    await assert.rejects(restoreRecoveryStorage(kit, { expectedEndpoint: recoveryEndpoint, previousOwnerStopped: true, fetch: changed }));
    assert.equal(writes, 0);
    const restored = await restoreRecoveryStorage(kit, { expectedEndpoint: recoveryEndpoint, previousOwnerStopped: true, fetch: server.fetch });
    assert.equal(await recoveryJournal(restored).read(recoveryNoteId), null); restored.close();
  }
});

test('failed initial key-check commit never exposes usable storage and an incomplete vault is not silently initialized on restore', async t => {
  const server = await recoveryServer(t), kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const failed: typeof fetch = (input, init) => init?.method === 'PUT'
    ? Promise.resolve(Response.json({ error: 'storage_unavailable' }, { status: 503 })) : server.fetch(input, init);
  await assert.rejects(createRecoveryStorage(kit, { fetch: failed }));
  await assert.rejects(restoreRecoveryStorage(kit, { expectedEndpoint: recoveryEndpoint, previousOwnerStopped: true, fetch: server.fetch }));
  const persisted = JSON.parse(await readFile(join(server.directory, kit.vaultId + '.json'), 'utf8'));
  assert.deepEqual(persisted.records, {});
  const replacement = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const storage = await createRecoveryStorage(replacement, { fetch: server.fetch }); storage.close();
});

test('lost acknowledgement of the initial key check is reconciled from the exact durable ciphertext', async t => {
  const server = await recoveryServer(t), kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  let lost = false;
  const uncertain: typeof fetch = async (input, init) => {
    const response = await server.fetch(input, init);
    if (!lost && init?.method === 'PUT' && response.ok) { lost = true; await response.body?.cancel(); throw new Error('synthetic lost key-check acknowledgement'); }
    return response;
  };
  const storage = await createRecoveryStorage(kit, { fetch: uncertain }); assert.equal(lost, true); storage.close();
  const reopened = await openRecoveryStorage(storage.session, { fetch: server.fetch }); reopened.close();
  const restored = await restoreRecoveryStorage(kit, { expectedEndpoint: recoveryEndpoint, previousOwnerStopped: true, fetch: server.fetch }); restored.close();
});
