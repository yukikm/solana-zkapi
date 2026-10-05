/** Read-only, public structural observations. Never a signature verifier or an
 * authorization to accept a wallet-modified transaction. */
import {ComputeBudgetProgram, TransactionMessage, type TransactionInstruction, type VersionedTransaction} from '@solana/web3.js';

export interface InstructionDiagnostic {
  /** Null means the program is behind an unresolved address lookup. */
  programId: string | null;
  dataLength: number;
  computeBudget?: {
    kind: 'RequestHeapFrame' | 'SetComputeUnitLimit' | 'SetComputeUnitPrice' | 'SetLoadedAccountsDataSizeLimit';
    value: string;
  };
}
export interface SigningDiagnostic {
  version: {original: VersionedTransaction['version']; returned: VersionedTransaction['version']};
  message_equal: boolean;
  header_equal: boolean;
  blockhash_equal: boolean;
  accounts_equal: boolean;
  ALT_equal: boolean;
  original_instructions: InstructionDiagnostic[];
  returned_instructions: InstructionDiagnostic[];
  /** Null means account lookup resolution/decompilation was unavailable. */
  original_non_compute_instructions_retained: boolean | null;
  non_compute_instructions_equal: boolean | null;
}
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const equalNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const computeProgram = ComputeBudgetProgram.programId.toBase58();

function instructions(transaction: VersionedTransaction): InstructionDiagnostic[] {
  return transaction.message.compiledInstructions.map(instruction => {
    const programId = transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() ?? null;
    const summary: InstructionDiagnostic = {programId, dataLength: instruction.data.length};
    // Only decode the exact, account-free known ComputeBudget wire layouts.
    // Other instruction payloads (including Vault proof data) are never exposed.
    if (programId === computeProgram && instruction.accountKeyIndexes.length === 0) {
      const bytes = instruction.data, opcode = bytes[0];
      const kind = opcode === 1 ? 'RequestHeapFrame' : opcode === 2 ? 'SetComputeUnitLimit'
        : opcode === 3 ? 'SetComputeUnitPrice' : opcode === 4 ? 'SetLoadedAccountsDataSizeLimit' : undefined;
      if (kind && bytes.length === (opcode === 3 ? 9 : 5)) {
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        summary.computeBudget = {kind, value: (opcode === 3 ? data.getBigUint64(1, true) : BigInt(data.getUint32(1, true))).toString()};
      }
    }
    return summary;
  });
}
function nonCompute(transaction: VersionedTransaction): TransactionInstruction[] | null {
  try {
    return TransactionMessage.decompile(transaction.message).instructions.filter(instruction => !instruction.programId.equals(ComputeBudgetProgram.programId));
  } catch { return null; }
}
function exactInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  return a.programId.equals(b.programId) && equalBytes(a.data, b.data) && a.keys.length === b.keys.length
    && a.keys.every((key, index) => key.pubkey.equals(b.keys[index].pubkey)
      && key.isSigner === b.keys[index].isSigner && key.isWritable === b.keys[index].isWritable);
}

/** Snapshot the original transaction before awaiting the wallet, e.g. with
 * VersionedTransaction.deserialize(transaction.serialize()). No account address,
 * blockhash, transaction bytes, signature bytes or non-compute data is returned.
 * The existing SDK must still perform every exact-message/signature check. */
export function signingDiagnostics(original: VersionedTransaction, returned: VersionedTransaction): SigningDiagnostic {
  const a = original.message, b = returned.message, originalNonCompute = nonCompute(original), returnedNonCompute = nonCompute(returned);
  let retained: boolean | null = null, exact: boolean | null = null;
  if (originalNonCompute && returnedNonCompute) {
    let cursor = 0;
    for (const instruction of returnedNonCompute) {
      if (cursor < originalNonCompute.length && exactInstruction(originalNonCompute[cursor], instruction)) cursor++;
    }
    retained = cursor === originalNonCompute.length;
    exact = originalNonCompute.length === returnedNonCompute.length
      && originalNonCompute.every((instruction, index) => exactInstruction(instruction, returnedNonCompute[index]));
  }
  let messageEqual = false;
  try { messageEqual = equalBytes(a.serialize(), b.serialize()); } catch { /* Malformed messages cannot be equal. */ }
  return {
    version: {original: original.version, returned: returned.version},
    message_equal: messageEqual,
    header_equal: a.header.numRequiredSignatures === b.header.numRequiredSignatures
      && a.header.numReadonlySignedAccounts === b.header.numReadonlySignedAccounts
      && a.header.numReadonlyUnsignedAccounts === b.header.numReadonlyUnsignedAccounts,
    blockhash_equal: a.recentBlockhash === b.recentBlockhash,
    accounts_equal: a.staticAccountKeys.length === b.staticAccountKeys.length
      && a.staticAccountKeys.every((key, index) => key.equals(b.staticAccountKeys[index])),
    ALT_equal: a.addressTableLookups.length === b.addressTableLookups.length
      && a.addressTableLookups.every((lookup, index) => lookup.accountKey.equals(b.addressTableLookups[index].accountKey)
        && equalNumbers(lookup.writableIndexes, b.addressTableLookups[index].writableIndexes)
        && equalNumbers(lookup.readonlyIndexes, b.addressTableLookups[index].readonlyIndexes)),
    original_instructions: instructions(original), returned_instructions: instructions(returned),
    original_non_compute_instructions_retained: retained, non_compute_instructions_equal: exact,
  };
}
