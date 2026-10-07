/** Challenger uses the I04 transport; this module has no financial state machine.
 * The native owner must durably commit each returned attempt before recover/send.
 */
import { address, createKeyPairFromBytes, getAddressFromPublicKey, getTransactionDecoder, partiallySignTransaction, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { buildUploadPlan, connectionTransport, prepareAttempt, recoverAttempt, restorePlan, type Attempt, type TransportRpc, type V0Wallet, type UploadPlan, type BufferState, refreshExpiredUpload, compileV0 } from './transport.ts';
import { fromHex, hex } from './layout2.ts';

export interface ChallengePlan {
  programId: string; pool: string; mint: string; payer: string; noteId: number;
  payloadHex: string; nonceHex: string; expires: string; slot: number; sequence: string; priorityFeeMicroLamports?: string;
}
export async function challengePlan(input: ChallengePlan): Promise<UploadPlan> {
  const { vaultAccounts } = await import('./transport.ts');
  const programId = address(input.programId), pool = address(input.pool), payer = address(input.payer);
  return buildUploadPlan({ programId, pool, uploader: payer, rentPayer: payer, feePayer: payer,
    operation: 'challenge_escape', payload: fromHex(input.payloadHex, 1252), nonce: fromHex(input.nonceHex, 32), expires: BigInt(input.expires),
    snapshot: { slot: input.slot, sequence: BigInt(input.sequence) }, priorityFeeMicroLamports: BigInt(input.priorityFeeMicroLamports ?? '0'), financial: await vaultAccounts({ programId, pool, payer,
      mint: address(input.mint), noteId: input.noteId, operation: 'challenge_escape' }) });
}
export async function signChallengeStep(input: ChallengePlan, stepIndex: number, blockhash: { blockhash: string; lastValidBlockHeight: number }, wallet: V0Wallet): Promise<Attempt> {
  const plan = await challengePlan(input);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= plan.steps.length || wallet.publicKey!==plan.feePayer) throw new Error('challenger step/payer');
  // Returning a record does not send it. Rust atomically fsyncs this exact record
  // with its immutable payload/job before the separate recovery command can run.
  let saved: Attempt | undefined;
  const attempt = await prepareAttempt(plan, plan.steps[stepIndex], blockhash, [wallet], { save: async value => { saved = structuredClone(value); } });
  if (!saved || saved.signature !== attempt.signature) throw new Error('challenger signing record');
  return saved;
}
export async function recoverChallenge(attempt: Attempt, rpc: TransportRpc, resend = true) {
  if (attempt.plan.operation !== 'challenge_escape') throw new Error('challenger operation');
  return recoverAttempt(attempt, rpc, resend);
}
/** RPC result, including a rejected receipt, is authenticated against exact v0
 * message/signature by I04. Only the block fetched at that finalized receipt's
 * slot is used as the outcome anchor. */
export async function recoverChallengeOnConnection(attempt: Attempt, connection: Rpc<SolanaRpcApi>) {
  let receiptSlot: number | undefined;
  const underlying = connectionTransport(connection);
  const rpc: TransportRpc = { ...underlying, finalizedReceipt: async signature => {
    const receipt = await underlying.finalizedReceipt(signature); receiptSlot = receipt?.slot; return receipt;
  } };
  const result = await recoverChallenge(attempt, rpc);
  if (result.state !== 'finalized' && result.state !== 'rejected') return { result };
  if (receiptSlot === undefined) throw new Error('finalized receipt missing');
  const block = await connection.getBlock(BigInt(receiptSlot), { commitment: 'finalized', transactionDetails: 'none', maxSupportedTransactionVersion: 1, rewards: false }).send();
  if (!block) throw new Error('finalized block missing');
  return { result, slot: receiptSlot, blockhash: block.blockhash };
}
export async function challengerWallet(secret: Uint8Array): Promise<V0Wallet> {
  const keypair = await createKeyPairFromBytes(new Uint8Array(secret));
  return { publicKey: await getAddressFromPublicKey(keypair.publicKey), supportedTransactionVersions: new Set([0]),
    signTransaction: tx => partiallySignTransaction([keypair], tx) };
}
export async function validateChallengeAttempt(attempt: Attempt): Promise<void> {
  const noSend: TransportRpc = { signatureStatus: async () => null, finalizedReceipt: async () => null, finalizedBlockHeight: async () => 0, sendRawTransaction: async () => { throw new Error('send prohibited'); } };
  await recoverChallenge(attempt, noSend, false);
  const plan = await restorePlan(attempt.plan);
  if (hex(plan.digest) !== attempt.planDigest) throw new Error('challenge digest');
}

/** Only I04's finalized-expired, exact-buffer-prefix upload reconciliation can
 * produce a new signature. Nothing is broadcast here; the native owner commits
 * old reconciliation + replacement together before using recoverChallenge. */
export async function refreshChallengeUpload(attempt: Attempt, rpc: TransportRpc, account: BufferState | null, blockhash: { blockhash: string; lastValidBlockHeight: number }, wallet: V0Wallet) {
  if (attempt.plan.operation !== 'challenge_escape' || !['create', 'append', 'seal'].includes(attempt.kind)) throw new Error('only challenger upload may refresh');
  const plan = await restorePlan(attempt.plan);
  const refreshed = await refreshExpiredUpload(attempt, rpc, account, blockhash, [wallet], { save: async () => {} });
  const target = 'next' in refreshed ? refreshed.next.instruction : undefined;
  const message = 'next' in refreshed ? undefined : getTransactionDecoder().decode(fromHex(refreshed.wireHex, refreshed.wireHex.length / 2)).messageBytes;
  const nextStepIndex = plan.steps.findIndex(step => target ? hex(new Uint8Array(step.instruction.data??[]))===hex(new Uint8Array(target.data??[])) && step.instruction.programAddress===target.programAddress : Buffer.from(compileV0(step.instruction, plan.feePayer, blockhash.blockhash, plan.priorityFeeMicroLamports).messageBytes).equals(Buffer.from(message!)));
  if (nextStepIndex < 0 || !account) throw new Error('upload reconciliation step');
  const finalizedHeight = await rpc.finalizedBlockHeight();
  if (finalizedHeight <= attempt.lastValidBlockHeight) throw new Error('upload blockheight rollback');
  return { nextStepIndex, finalizedHeight, accountSlot: account.slot, accountHex: hex(account.data), ...('next' in refreshed ? {} : { replacement: { ...refreshed, stepIndex: nextStepIndex } }) };
}
