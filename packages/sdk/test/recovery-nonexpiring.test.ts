/** Actual encrypted backup service + fresh process; synthetic chain/prover
 * observations and real local v0 signatures. Never sends a transaction or AI request. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { address } from '@solana/kit';
import { ControlClient, validateNoteJournal, type NoteJournal, type PreparedSession, type SessionVerifier } from '../src/control.ts';
import { ZkApiClient, type ClientComponents } from '../src/client.ts';
import { EncryptedJournal } from '../src/journal.ts';
import { createRecoveryKit, createRecoveryStorage, openRecoveryStorage, restoreRecoveryStorage, type RecoveryStorage } from '../src/recovery.ts';
import { writeRecoveryKitFile, readRecoveryKitFile, saveRecoverySessionFile, loadRecoverySessionFile } from '../src/recovery-node.ts';
import { NON_EXPIRING_NOTE_EXPIRY } from '../src/deposit-expiry.ts';
import { verifyPoolConfig } from '../src/trust.ts';
import { prepareFinalizationAttempt, vaultAccounts, type V0Wallet } from '../src/transport.ts';
import { chainFixture, key } from './chain-fixture.ts';
import { fixtureSigner, signWith } from './kit-helpers.ts';
import { recoveryEndpoint, recoveryServer } from './recovery-fixture.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const noteIds = ['active-deposit', 'pending-authorization', 'pending-withdrawal'];
const verifier: SessionVerifier = { async prepare() {}, async settle() { assert.fail('recovery must not settle'); } };

test('non-expiring custody restores balances and pending signed work from a file on a fresh device, repeatedly and with owner fencing', { timeout: 30_000 }, async t => {
  const server = await recoveryServer(t), root = await mkdtemp(join(tmpdir(), 'zkapi-noexpiry-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { manifest, poolData } = await chainFixture({ noteTtlSeconds: '0', capMicroUsdc: '100' });
  await verifyPoolConfig(manifest, manifest.genesis_hash, { address: manifest.pool, owner: manifest.program_id,
    executable: false, lamports: 1n, data: poolData, slot: 100n, commitment: 'finalized' }, 100n);
  const signer = await fixtureSigner(new Uint8Array(32).fill(41));
  let signatures = 0, financialEffects = 0;
  const wallet: V0Wallet = { publicKey: signer.address, supportedTransactionVersions: new Set([0]),
    async signTransaction(transaction) { signatures++; return signWith(transaction, [signer]); } };
  const context = { deploymentId: manifest.deployment_id, pool: manifest.pool, wallet: signer.address };
  const verification = { deployment_id: manifest.deployment_id, pool: manifest.pool, vault_binding: manifest.vault_binding,
    state_key: [manifest.state_key.x, manifest.state_key.y] as [string, string], cap_micro_usdc: manifest.cap_micro_usdc,
    control_api_origin: manifest.control_api_origin, inference_api_origin: manifest.inference_api_origin,
    quote_public_key: '00'.repeat(32), receipt_public_key: '00'.repeat(32), request_vk_sha256: '00'.repeat(32), tariff_hashes: ['33'.repeat(32)] };
  const prepared: PreparedSession = {
    request: {
      authorization: { version: '1', deployment_id: manifest.deployment_id, pool: manifest.pool,
        request_id: '12345678-1234-4123-8123-123456789012', quote_hash: '00'.repeat(32), mode: 'direct_openrouter', control_secret_hash: '11'.repeat(32), proxy_secret_hash: null },
      quote: { body: { quote_id: 'synthetic-noexpiry-recovery', deployment_id: manifest.deployment_id, pool: manifest.pool,
        mode: 'direct_openrouter', provider: 'openrouter', models: ['*'], tariff_hash: '33'.repeat(32), cap_micro_usdc: '100',
        issued_at: '100', expires_at: '200', session_ttl_seconds: '60', max_concurrency: '4',
        control_api_origin: manifest.control_api_origin, inference_api_origin: manifest.inference_api_origin }, quote_hash: '00'.repeat(32), signature: 'synthetic-quote-signature' },
      public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'synthetic-proof-not-live-acceptance' },
    },
    control_token: 'zkc1.synthetic-exact-restored-credential', proxy_token: null,
    tariff: { tariff_hash: '33'.repeat(32), version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd',
      valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' }, rerandomization: field(13),
  };
  const fundedNote = (id: number): NoteJournal => ({ schema: 2,
    state: { balance_micro_usdc: '1777123', balance_blinding: field(3), note_leaf: field(4), commitment: { x: field(5), y: field(6) },
      anchor: field(7), state_signature: { r_x: field(9), r_y: field(10), s: field(11) } },
    witness: { secret: field(20 + id), note_id: id, deposit_micro_usdc: '2000000', expiry: NON_EXPIRING_NOTE_EXPIRY },
    wallet: { status: 'active', history: [] }, pending: null, history: [] });
  const kit = createRecoveryKit({ endpoint: recoveryEndpoint, context }), kitPath = join(root, 'independent-backup', 'recovery.json');
  await writeRecoveryKitFile(kitPath, kit);
  const original = await createRecoveryStorage(kit, { fetch: server.fetch }); t.after(() => original.close());
  const journalFor = (storage: RecoveryStorage) => new EncryptedJournal<NoteJournal>(storage.store, storage.key, context, validateNoteJournal);
  const journal = journalFor(original);
  await saveRecoverySessionFile(join(root, 'lost-device', 'session.json'), original.session);
  for (const [id, noteId] of noteIds.entries()) await journal.create(noteId, fundedNote(id));
  const noResponse: typeof fetch = async () => { financialEffects++; throw new Error('synthetic AUTH response lost'); };
  const originalControl = new ControlClient({ context: verification, journal, verifier, fetch: noResponse, now: () => 150n, allowLoopbackHttp: true });
  await originalControl.prepare(noteIds[1], prepared, field(14));
  await assert.rejects(originalControl.submit(noteIds[1]), /response lost/);
  assert.equal(financialEffects, 1);

  // Persist an actual signed v0 finalization attempt, without broadcasting it.
  const financial = await vaultAccounts({ programId: address(manifest.program_id), pool: address(manifest.pool), mint: address(manifest.mint),
    payer: signer.address, tokenOwner: signer.address, operation: 'finalize_escape', noteId: 2,
    destinationOwner: signer.address, treasuryOwner: key(29) });
  const attempt = await prepareFinalizationAttempt({ programId: address(manifest.program_id), pool: address(manifest.pool), noteId: 2,
    feePayer: signer.address, financial, snapshot: { slot: 100, sequence: 3n } },
    { blockhash: key(42), lastValidBlockHeight: 200 }, [wallet], { save: async () => {} });
  const pendingWithdrawal = fundedNote(2), roles = { uploader: signer.address, rentPayer: signer.address, feePayer: signer.address, payer: signer.address, tokenOwner: signer.address };
  pendingWithdrawal.wallet = { status: 'pending_escape', history: [], operation: { id: crypto.randomUUID(), kind: 'finalize_escape', phase: 'ready',
    roles, destinationOwner: signer.address, finalization: attempt.finalization, step: 0, attempts: [attempt], current: attempt.signature, finalized: [] } };
  await journal.compareAndSwap(noteIds[2], 1, pendingWithdrawal);
  const expected = await Promise.all(noteIds.map(id => journal.read(id)));
  assert.equal(expected[1]!.value.pending?.phase, 'send_unknown');
  assert.equal(expected[1]!.value.pending?.exactRequest, JSON.stringify(prepared.request));
  assert.equal(signatures, 1);

  // Wrong context must neither recover the records nor revoke the valid owner.
  for (const wrong of [{ ...context, wallet: key(43) }, { ...context, pool: key(44) }]) {
    await assert.rejects(restoreRecoveryStorage({ ...kit, context: wrong }, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch }));
    assert.deepEqual((await journal.read(noteIds[0]))?.value, expected[0]!.value);
  }
  await rm(join(root, 'lost-device'), { recursive: true });
  await assert.rejects(access(join(root, 'lost-device')), { code: 'ENOENT' });
  // A new process has only the portable file: no old key, journal, session, or manifest object.
  const program = `
    import {readRecoveryKitFile,saveRecoverySessionFile} from ${JSON.stringify(new URL('../src/recovery-node.ts', import.meta.url).href)};
    import {restoreRecoveryStorage} from ${JSON.stringify(new URL('../src/recovery.ts', import.meta.url).href)};
    import {EncryptedJournal} from ${JSON.stringify(new URL('../src/journal.ts', import.meta.url).href)};
    import {validateNoteJournal} from ${JSON.stringify(new URL('../src/control.ts', import.meta.url).href)};
    const kit=await readRecoveryKitFile(process.argv[1]);
    const mappedFetch=(input,init)=>fetch(process.argv[3]+new URL(typeof input==='string'?input:input.url).pathname,init);
    const storage=await restoreRecoveryStorage(kit,{previousOwnerStopped:true,expectedEndpoint:${JSON.stringify(recoveryEndpoint)},fetch:mappedFetch});
    const journal=new EncryptedJournal(storage.store,storage.key,kit.context,validateNoteJournal);
    const records=await Promise.all(${JSON.stringify(noteIds)}.map(id=>journal.read(id)));
    await saveRecoverySessionFile(process.argv[2],storage.session);storage.close();process.stdout.write(JSON.stringify(records));
  `;
  const sessionPath = join(root, 'fresh-device', 'session.json');
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, kitPath, sessionPath, server.origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
  const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0, errors);
  assert.deepEqual(JSON.parse(output), expected, 'full witness, signed successor, exact AUTH, signed transaction, revision and head survive');
  await assert.rejects(journal.read(noteIds[0]));
  await assert.rejects(journal.compareAndSwap(noteIds[0], 1, fundedNote(0)));
  await assert.rejects(original.store.withLock('aa'.repeat(32), async () => assert.fail('revoked owner acquired custody')));
  await assert.rejects(openRecoveryStorage(original.session, { fetch: server.fetch }));

  const session = (await loadRecoverySessionFile(sessionPath))!;
  assert.notEqual(session.ownerToken, original.session.ownerToken);
  const restored = await openRecoveryStorage(session, { fetch: server.fetch }); t.after(() => restored.close());
  const restoredJournal = journalFor(restored), restoredControl = new ControlClient({ context: verification, journal: restoredJournal, verifier, fetch: noResponse, now: () => 150n, allowLoopbackHttp: true });
  const reopenedPool = await chainFixture({ noteTtlSeconds: '0', capMicroUsdc: '100' });
  assert.notEqual(reopenedPool.manifest, manifest, 'new device authenticates its own manifest instance');
  assert.equal(reopenedPool.manifest.pool, context.pool);
  await verifyPoolConfig(reopenedPool.manifest, reopenedPool.manifest.genesis_hash, { address: context.pool, owner: manifest.program_id,
    executable: false, lamports: 1n, data: reopenedPool.poolData, slot: 200n, commitment: 'finalized' }, 200n);
  for (const [index, noteId] of noteIds.entries()) {
    const components = { store: restored.store, noteId, mode: 'direct_openrouter', control: restoredControl,
      models: [{ id: 'fixture-model', provider: 'openrouter', apis: ['chat'], tariff: prepared.tariff }],
      wallet: { manifest: reopenedPool.manifest, journal: restoredJournal, prover: {}, chain: {}, rpc: {}, wallets: [wallet] } } as unknown as ClientComponents;
    const client = new ZkApiClient(components); t.after(() => client.dispose());
    const status = await client.status();
    assert.equal(status.depositExpiryPolicy, 'none'); assert.equal(status.expiry, null);
    assert.equal(status.settledBalanceMicroUsdc, '1777123'); assert.equal(status.canRequest, index === 0);
    if (index === 1) assert.equal(status.session?.phase, 'send_unknown');
    if (index === 2) { assert.equal(status.wallet, 'pending_escape'); assert.equal(status.walletOperation?.signature, attempt.signature); }
    if (index > 0) await assert.rejects(client.chat({ operationId: crypto.randomUUID(), model: 'fixture-model', messages: [{ role: 'user', content: 'Must remain unsent' }], maxOutputTokens: 1 }));
    client.dispose();
  }
  assert.equal(financialEffects, 1, 'recovery/status never resubmits pending AUTH, inference, or withdrawal');
  assert.equal(signatures, 1, 'recovery never asks the wallet to sign replacement work');
  const again = await restoreRecoveryStorage(await readRecoveryKitFile(kitPath), { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch });
  t.after(() => again.close());
  assert.notEqual(again.session.ownerToken, session.ownerToken);
  await assert.rejects(restoredJournal.read(noteIds[0]));
  await assert.rejects(openRecoveryStorage(session, { fetch: server.fetch }));
  assert.deepEqual(await Promise.all(noteIds.map(id => journalFor(again).read(id))), expected, 'repeated restoration preserves every record and checkpoint exactly');
});
