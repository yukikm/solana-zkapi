/** Offline design analysis only. No RPC, wallet, secret files, proof verification, or sends.
 * Run: target/i08-toolchain/bin/node scripts/analyze_single_deposit_transaction.ts
 * The proposed compact instruction does not exist in the deployed Vault.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import type { AccountMeta, MessageV0 } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, MAX_TRANSACTION_BYTES, MAX_COMPUTE_UNITS,
  buildUploadPlan, discriminator, financialMetas, vaultAccounts,
} from '../packages/sdk/src/transport.ts';
import type { FinancialAccounts } from '../packages/sdk/src/transport.ts';
import { concat, encodeLayout2Args, fromHex, hex, u32, u64 } from '../packages/sdk/src/layout2.ts';
import { parseField } from '../packages/sdk/src/encoding.ts';

const root = new URL('../', import.meta.url);
const input = 'tests/fixtures/vault/a.json';
const fixture = JSON.parse(readFileSync(new URL(input, root), 'utf8'));
const sourceFiles = [
  'scripts/analyze_single_deposit_transaction.ts', input,
  'packages/sdk/src/transport.ts', 'packages/sdk/src/layout2.ts', 'packages/sdk/src/encoding.ts',
  'programs/zkapi-vault/src/lib.rs', 'programs/zkapi-vault/src/accounts.rs',
  'programs/zkapi-vault/src/handlers.rs', 'crates/zkapi-layout2/src/lib.rs',
  'docs/specs/tree-transition.md', 'docs/adr/0001-proof-bound-tree-transition.md',
];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Public sizing identifiers only. No private key is created, loaded, or used.
const publicId = (name: string): PublicKey => new PublicKey(createHash('sha256').update(`single-deposit-analysis:${name}`).digest());
const publicKey = (value: string): PublicKey => new PublicKey(fromHex(value, 32));
const field = (value: bigint): Uint8Array => parseField(`0x${value.toString(16).padStart(64, '0')}`);
const programId = publicKey(fixture.program_id), pool = publicKey(fixture.pool), mint = publicKey(fixture.mint);
const tokenOwner = publicId('user'), sponsor = publicId('sponsor'), feeSponsor = publicId('fee-sponsor');
const blockhash = publicId('blockhash').toBase58();
const tree = fixture.trees[0];
const canonical = encodeLayout2Args({
  operation: 'deposit', expectedId: fixture.id, expectedRoot: tree.public_inputs[1],
  expiry: BigInt(fixture.expiry), commitment: `0x${fixture.commitment}`,
  amount: BigInt(fixture.deposit), tree,
});
assert.equal(canonical.length, 692);
const compact = concat(
  u32(fixture.id), parseField(tree.public_inputs[1]), u64(BigInt(fixture.expiry)),
  parseField(`0x${fixture.commitment}`), u64(BigInt(fixture.deposit)),
  parseField(tree.public_inputs[2]), parseField(tree.public_inputs[5]),
  parseField(tree.public_inputs[10]), fromHex(tree.proof_wire_hex, 256),
);
assert.equal(compact.length, 436);

// Model expansion with the authenticated PoolConfig.vault_binding supplied separately.
// A future on-chain entry point must validate the actual PoolConfig before expansion.
function expandCompact(bytes: Uint8Array, validatedPoolBinding: Uint8Array): Uint8Array {
  assert.equal(bytes.length, 436);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = view.getUint32(0, true), expiry = view.getBigUint64(36, true), amount = view.getBigUint64(76, true);
  const oldRoot = bytes.slice(4, 36), commitment = bytes.slice(44, 76);
  const fields = [validatedPoolBinding, oldRoot, bytes.slice(84, 116), field(BigInt(id)), field(0n),
    bytes.slice(116, 148), commitment, field(amount), field(expiry), field(0n), bytes.slice(148, 180)];
  for (const value of fields) parseField(`0x${hex(value)}`);
  return concat(u32(id), oldRoot, u64(expiry), commitment, u64(amount), ...fields, bytes.slice(180));
}
const expanded = expandCompact(compact, parseField(tree.public_inputs[0]));
assert.deepEqual(expanded, canonical);
assert.deepEqual(expanded.slice(84, 436), concat(...tree.public_inputs.map(parseField)));
assert.deepEqual(expanded.slice(436), fromHex(tree.proof_wire_hex, 256));
assert.throws(() => expandCompact(compact.slice(1), parseField(tree.public_inputs[0])));
assert.throws(() => expandCompact(concat(compact, Uint8Array.of(0)), parseField(tree.public_inputs[0])));
const invalidField = compact.slice(); invalidField.fill(255, 84, 116);
assert.throws(() => expandCompact(invalidField, parseField(tree.public_inputs[0])));

function shortvec(number: number): Uint8Array {
  const bytes: number[] = [];
  do { const byte = number & 127; number = Math.floor(number / 128); bytes.push(byte | (number ? 128 : 0)); } while (number);
  return Uint8Array.from(bytes);
}
// Independent exact wire serialization permits measuring oversized candidates that
// web3.js rejects inside its fixed 1,232-byte message buffer. Passing cases are also
// byte-compared with web3.js serialization and deserialize/serialize round trips.
function serializeMessage(message: MessageV0): Uint8Array {
  const h = message.header;
  return concat(Uint8Array.of(128, h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts),
    shortvec(message.staticAccountKeys.length), ...message.staticAccountKeys.map(k => k.toBytes()),
    new PublicKey(message.recentBlockhash).toBytes(), shortvec(message.compiledInstructions.length),
    ...message.compiledInstructions.map(ix => concat(Uint8Array.of(ix.programIdIndex),
      shortvec(ix.accountKeyIndexes.length), Uint8Array.from(ix.accountKeyIndexes), shortvec(ix.data.length), ix.data)),
    shortvec(message.addressTableLookups.length), ...message.addressTableLookups.map(table => concat(table.accountKey.toBytes(),
      shortvec(table.writableIndexes.length), Uint8Array.from(table.writableIndexes),
      shortvec(table.readonlyIndexes.length), Uint8Array.from(table.readonlyIndexes))));
}
function measure(instructions: TransactionInstruction[], feePayer: PublicKey, tables: AddressLookupTableAccount[]) {
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
  const wireMessage = serializeMessage(message);
  const wire = concat(shortvec(message.header.numRequiredSignatures), new Uint8Array(64 * message.header.numRequiredSignatures), wireMessage);
  let nativeSerializedBytes: number | null = null, nativeSerializationError: string | null = null;
  try {
    const actual = new VersionedTransaction(message).serialize();
    assert.deepEqual(actual, wire);
    assert.deepEqual(VersionedTransaction.deserialize(actual).serialize(), actual);
    nativeSerializedBytes = actual.length;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    nativeSerializationError = String(error);
    assert.ok(wire.length > MAX_TRANSACTION_BYTES, 'Every fitting candidate must pass native serialization');
  }
  const resolved = message.getAccountKeys({ addressLookupTableAccounts: tables });
  assert.equal(resolved.length, message.staticAccountKeys.length + message.numAccountKeysFromLookups);
  return {
    transaction_bytes: wire.length, message_bytes: wireMessage.length,
    limit_bytes: MAX_TRANSACTION_BYTES, margin_bytes: MAX_TRANSACTION_BYTES - wire.length,
    fits_1232_bytes: wire.length <= MAX_TRANSACTION_BYTES,
    signature_slots: message.header.numRequiredSignatures,
    signatures_are_zero_placeholders: true,
    static_account_keys: message.staticAccountKeys.length,
    lookup_account_keys: message.numAccountKeysFromLookups,
    address_lookup_tables: message.addressTableLookups.length,
    instruction_account_indices: instructions.map(ix => ix.keys.length),
    instruction_data_bytes: instructions.map(ix => ix.data.length),
    native_serialized_bytes: nativeSerializedBytes, native_serialization_error: nativeSerializationError,
    unsigned_transaction_sha256: sha(wire),
  };
}
const computeBudget = [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000n })];
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
function existingAccounts(financial: FinancialAccounts): AccountMeta[] {
  return [...financialMetas(financial, true), meta(financial.tokenOwner, false, true)];
}
// Comparison only: omits unused placeholder accounts and duplicate owner signer.
// Keep associated-token program so adapting to the existing Financial handler is
// possible. This list is not the current Anchor account contract.
function reducedAccounts(financial: FinancialAccounts): AccountMeta[] {
  return [meta(financial.pool), meta(financial.tree, true), meta(financial.note, true),
    meta(financial.vaultAuthority), meta(financial.mint), meta(financial.source, true), meta(financial.vault, true),
    meta(financial.tokenOwner, false, true), meta(financial.payer, true, true),
    meta(TOKEN_PROGRAM), meta(ASSOCIATED_TOKEN_PROGRAM), meta(SystemProgram.programId)];
}
const profiles = [
  { name: 'same_user_all_roles', payer: tokenOwner, feePayer: tokenOwner, expectedSigners: 1 },
  { name: 'user_and_sponsor', payer: sponsor, feePayer: sponsor, expectedSigners: 2 },
  { name: 'user_rent_sponsor_fee_sponsor', payer: sponsor, feePayer: feeSponsor, expectedSigners: 3 },
];
const cases: object[] = [], bufferBaselines: object[] = [];
for (const profile of profiles) {
  const financial = vaultAccounts({ programId, pool, mint, noteId: fixture.id, payer: profile.payer, tokenOwner, operation: 'deposit' });
  // All eight addresses are stable for this pool and deployment; no user source
  // ATA, note PDA, wallet, or buffer address is inserted into this model table.
  const stableAddresses = [pool, financial.tree, financial.vaultAuthority, mint, financial.vault,
    TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SystemProgram.programId];
  const table = new AddressLookupTableAccount({ key: publicId('stable-pool-table'), state: {
    deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
    authority: undefined, addresses: stableAddresses,
  } });
  for (const candidate of [
    { name: 'existing_deposit', instructionName: 'deposit', args: canonical, keys: existingAccounts(financial), deployedEntry: true },
    { name: 'compact_same_accounts', instructionName: 'deposit_compact_v1', args: compact, keys: existingAccounts(financial), deployedEntry: false },
    { name: 'raw_reduced_accounts_comparison', instructionName: 'deposit_reduced_analysis', args: canonical, keys: reducedAccounts(financial), deployedEntry: false },
    { name: 'compact_reduced_accounts_comparison', instructionName: 'deposit_compact_reduced_analysis', args: compact, keys: reducedAccounts(financial), deployedEntry: false },
  ]) {
    const instruction = new TransactionInstruction({ programId, keys: candidate.keys,
      data: Buffer.from(concat(await discriminator(candidate.instructionName), candidate.args)) });
    for (const lookup of ['none', 'preexisting_stable_pool_alt'] as const) {
      const measured = measure([...computeBudget, instruction], profile.feePayer, lookup === 'none' ? [] : [table]);
      assert.equal(measured.signature_slots, profile.expectedSigners);
      cases.push({ role_profile: profile.name, candidate: candidate.name, lookup_model: lookup,
        entry_point_exists_in_source: candidate.deployedEntry,
        argument_bytes: candidate.args.length, ...measured });
    }
  }
  const plan = await buildUploadPlan({ programId, pool, uploader: tokenOwner, rentPayer: profile.payer,
    feePayer: profile.feePayer, nonce: publicId('buffer-nonce').toBytes(), expires: 3000003600n,
    operation: 'deposit', payload: canonical, financial, priorityFeeMicroLamports: 1000n,
    snapshot: { slot: 1, sequence: 0n } });
  bufferBaselines.push({ role_profile: profile.name, steps: plan.steps.map(step => ({ kind: step.kind,
    ...measure([...computeBudget, step.instruction], profile.feePayer, []) })) });
}
const report = {
  schema: 1, generated_at: new Date().toISOString(), status: 'offline_serialization_analysis_only',
  command: 'target/i08-toolchain/bin/node scripts/analyze_single_deposit_transaction.ts',
  node_version: process.version, web3_version: JSON.parse(readFileSync(new URL('node_modules/@solana/web3.js/package.json', root), 'utf8')).version,
  sources_sha256: Object.fromEntries(sourceFiles.map(path => [path, sha(readFileSync(new URL(path, root)))])),
  compute_budget: { unit_limit: MAX_COMPUTE_UNITS, micro_lamports_per_unit: '1000', both_instructions_included: true, measured_compute_units: null },
  compact_wire: {
    instruction_name: 'deposit_compact_v1', argument_bytes: 436, discriminator_bytes: 8,
    fields: ['expected_id:u32le', 'expected_root:Fr32be', 'expiry:u64le', 'commitment:Fr32be', 'amount:u64le',
      'new_root:Fr32be', 'new_leaf:Fr32be', 'transition_tag:Fr32be', 'proof:256bytes'],
    reconstructed_public_inputs: ['validated_pool.vault_binding', 'expected_root', 'new_root', 'Fr(expected_id)', 'Fr(0)',
      'new_leaf', 'commitment', 'Fr(amount)', 'Fr(expiry)', 'Fr(0)', 'transition_tag'],
    canonical_expansion_bytes: expanded.length, canonical_expansion_matches_fixture: true,
    all_11_public_inputs_match_fixture: true, original_256_byte_proof_unchanged: true,
    malformed_length_and_noncanonical_field_rejected_by_analysis_model: true,
    canonical_payload_sha256: sha(canonical), compact_payload_sha256: sha(compact),
    cryptographic_verification_performed: false,
  },
  stable_alt_model: {
    addresses: ['pool', 'tree', 'vault_authority', 'mint', 'vault_ata', 'token_program', 'associated_token_program', 'system_program'],
    already_created_and_frozen_assumption: true, actual_table_exists: 'unverified',
    creation_or_extension_in_deposit: false,
    excludes_dynamic_note_and_source_and_buffer_addresses: true,
    limitations: ['This is an in-memory table model, not a fetched or deployed ALT.',
      'Production must pin and validate table owner, address, exact contents, activation slot and authority/deactivation state.',
      'Table provisioning is separate operator work; creating it during deposit would add transactions.',
      'Signer addresses remain static; wallet ALT support and recovery are unverified.'],
  },
  cases, current_buffer_baselines: bufferBaselines,
  interpretation: {
    recommended_new_entry: 'deposit_compact_v1 with existing DepositAccounts; restore canonical payload and call shared handler',
    lower_program_change_alternative: 'existing deposit plus a provisioned stable-pool ALT fits one or two signers; the three-signer case is 1241 bytes and fails the 1232-byte limit',
    same_account_contract_recommended: true,
    proof_or_hash_change_required: false,
    program_runtime_sdk_wallet_implementation_complete: false,
    single_user_signature_meaning: 'One user token-owner signature; distinct rent/fee sponsors add their own co-signatures to the same transaction.',
  },
  limitations: [
    'Serialization and fixture roundtrip only. No SBF execution, compute measurement, on-chain state checks, wallet approval or proof verification was performed.',
    'Fixture public proof bytes are reused solely for byte-layout equivalence; this report is not a fresh proof-validity result.',
    'Unsigned transactions contain zero-filled signature slots; signature lengths are exact but no transaction is cryptographically signed.',
    'Compact instructions and reduced account contracts are proposed models; only the original deposit entry exists in source.',
    'Current manifests and SDK advertise v0_buffer only. New transport advertisement and journal/recovery integration require implementation and acceptance.',
    'Stale roots, note IDs, expiry boundaries or unknown financial sends still require existing finalized reconciliation; one transaction is the normal successful path, not a retry guarantee.',
    'All values, program IDs and table contents used here are public test fixtures or deterministic sizing identifiers; no credentials, real wallet keys, RPCs, services or provider calls were accessed.',
  ],
};
const output = new URL('docs/evidence/I10-single-deposit-transport-analysis.json', root);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: fileURLToPath(output), status: report.status, cases: cases.length,
  compact_args_bytes: compact.length, canonical_roundtrip: true }));
