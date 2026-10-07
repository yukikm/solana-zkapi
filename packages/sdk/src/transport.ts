/** I04 v0 transport. No RPC endpoint, key, network, or implicit proof regeneration is selected here. */
import { address, blockhash as asBlockhash, signature as asSignature, AccountRole, getProgramDerivedAddress, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransactionMessage, getCompiledTransactionMessageEncoder, getBase64Encoder, getBase64Decoder, type Address, type AccountMeta, type Instruction, type Transaction, type TransactionMessageBytes, type Rpc, type SolanaRpcApi, type Base64EncodedWireTransaction, type ReadonlyUint8Array } from '@solana/kit';
import { SYSTEM_PROGRAM, addressBytes, encodeTransaction, decodeTransaction, transactionMessage, transactionBlockhash, transactionSignature } from './solana.ts';
import { safeRpcNumber, decodeRpcAccount } from './solana-rpc.ts';
export { createSolanaRpcWithFetch } from './solana.ts';
import { concat, hex, fromHex, u32, u64, OPERATIONS, validatePayload, compactDepositPayload, expandCompactDepositPayload } from './layout2.ts';
import type { Operation } from './layout2.ts';

export const TRANSACTION_FORMATS = Object.freeze(['v0_buffer', 'v0_inline_deposit_v1'] as const);
export const MAX_TRANSACTION_BYTES = 1232;
export const MAX_COMPUTE_UNITS = 1_000_000;
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const FINANCIAL_ACCOUNT_ORDER = ['pool', 'tree', 'note', 'pending', 'exit', 'vaultAuthority', 'mint', 'source', 'vault', 'destinationOwner', 'destination', 'treasuryOwner', 'treasury', 'tokenOwner', 'payer'] as const;
export type FinancialAccounts = Record<typeof FINANCIAL_ACCOUNT_ORDER[number], Address>;
export interface BufferPlanInput {
  programId: Address; pool: Address; uploader: Address; rentPayer: Address; feePayer: Address;
  nonce: Uint8Array; expires: bigint; operation: Operation; payload: Uint8Array; financial: FinancialAccounts;
  snapshot: { slot: number; sequence: bigint };
  /** Immutable per-plan CU price; omitted/zero preserves the original wire. */
  priorityFeeMicroLamports?: bigint;
}
export interface Step { kind: 'create' | 'append' | 'seal' | 'execute' | 'close' | 'finalize' | 'deposit_inline'; instruction: Instruction<Address, readonly AccountMeta[]> & {data: Uint8Array}; offset?: number; endOffset?: number }
export interface UploadPlan extends BufferPlanInput { buffer: Address; bump: number; digest: Uint8Array; steps: Step[] }
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))); }
export async function discriminator(name: string, namespace = 'global'): Promise<Uint8Array> { return (await sha256(new TextEncoder().encode(`${namespace}:${name}`))).slice(0, 8); }
const equal = (a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const meta = (address: Address, isWritable = false, isSigner = false): AccountMeta => ({ address, role: (isWritable ? AccountRole.WRITABLE : AccountRole.READONLY) | (isSigner ? AccountRole.READONLY_SIGNER : AccountRole.READONLY) });
function raw32(bytes: Uint8Array): Uint8Array { if (bytes.length !== 32) throw new Error('expected 32 bytes'); return bytes; }
export function financialMetas(financial: FinancialAccounts, deposit = false): AccountMeta[] {
  const writable = new Set([1, 2, 3, 4, 7, 8, 10, 12, 14]);
  return [...FINANCIAL_ACCOUNT_ORDER.map((name, i) => meta(financial[name], writable.has(i), i === 14 || (i === 13 && deposit))),
    meta(TOKEN_PROGRAM), meta(ASSOCIATED_TOKEN_PROGRAM), meta(SYSTEM_PROGRAM)];
}
export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  return (await getProgramDerivedAddress({seeds: [addressBytes(owner), addressBytes(TOKEN_PROGRAM), addressBytes(mint)], programAddress: ASSOCIATED_TOKEN_PROGRAM}))[0];
}
export async function vaultAccounts(args: { programId: Address; pool: Address; mint: Address; noteId: number; payer: Address; operation: Operation | 'finalize_escape'; tokenOwner?: Address; destinationOwner?: Address; treasuryOwner?: Address; nullifier?: Uint8Array }): Promise<FinancialAccounts> {
  args = {...args,...(args.nullifier ? {nullifier:args.nullifier.slice()} : {})};
  const { programId, pool, mint, payer, operation } = args;
  const pda = async (seed: string, suffix?: Uint8Array) => (await getProgramDerivedAddress({seeds: [seed, addressBytes(pool), ...(suffix ? [suffix] : [])], programAddress: programId}))[0];
  const deposit = operation === 'deposit';
  const exiting = operation === 'mutual_close' || operation === 'initiate_escape';
  const pending = operation === 'initiate_escape' || operation === 'challenge_escape' || operation === 'finalize_escape';
  const paysDestination = operation === 'mutual_close' || operation === 'finalize_escape';
  const paysTreasury = paysDestination || operation === 'claim_expired';
  if (deposit && !args.tokenOwner || (exiting || paysDestination) && !args.destinationOwner || paysTreasury && !args.treasuryOwner || exiting && !args.nullifier) throw new Error('missing operation accounts');
  const vaultAuthority = await pda('vault');
  return { pool, tree: await pda('tree'), note: await pda('note', u32(args.noteId)), pending: pending ? await pda('pending', u32(args.noteId)) : payer,
    exit: exiting ? await pda('exit', raw32(args.nullifier!)) : payer, vaultAuthority, mint,
    source: deposit ? await associatedTokenAddress(args.tokenOwner!, mint) : payer, vault: await associatedTokenAddress(vaultAuthority, mint),
    destinationOwner: (exiting || paysDestination) ? args.destinationOwner! : payer, destination: paysDestination ? await associatedTokenAddress(args.destinationOwner!, mint) : payer,
    treasuryOwner: paysTreasury ? args.treasuryOwner! : payer, treasury: paysTreasury ? await associatedTokenAddress(args.treasuryOwner!, mint) : payer,
    tokenOwner: deposit ? args.tokenOwner! : payer, payer };
}
async function ix(programId: Address, name: string, keys: AccountMeta[], args: Uint8Array = new Uint8Array()): Promise<Step['instruction']> {
  return { programAddress: programId, accounts: keys, data: concat(await discriminator(name), args) };
}
/** Includes all signatures (zero placeholders before signing), account keys and ComputeBudget. No ALT required. */
/** The deployed journal schema fixes encounter order within signer/writable groups.
 * Kit deliberately sorts same-role addresses; remap its compiled indices to the
 * existing SDK order before encoding, preserving historical signed message bytes. */
export function compileV0(instruction: Instruction, feePayer: Address, blockhash: string, priorityFeeMicroLamports = 0n): Transaction {
  u64(priorityFeeMicroLamports);
  const compute = address('ComputeBudget111111111111111111111111111111');
  const instructions: Instruction[] = [
    {programAddress: compute, data: concat(Uint8Array.of(2),u32(MAX_COMPUTE_UNITS))},
    ...(priorityFeeMicroLamports > 0n ? [{programAddress: compute, data: concat(Uint8Array.of(3),u64(priorityFeeMicroLamports))}] : []), instruction];
  const message = appendTransactionMessageInstructions(instructions, setTransactionMessageLifetimeUsingBlockhash(
    {blockhash:asBlockhash(blockhash),lastValidBlockHeight:0n},setTransactionMessageFeePayer(feePayer,createTransactionMessage({version:0}))));
  const compiled = compileTransactionMessage(message);
  const accounts = new Map<Address, AccountRole>([[feePayer,AccountRole.WRITABLE_SIGNER]]);
  for (const item of instructions) {
    if (!accounts.has(item.programAddress)) accounts.set(item.programAddress,AccountRole.READONLY);
    for (const account of item.accounts ?? []) accounts.set(account.address,(accounts.get(account.address) ?? AccountRole.READONLY) | account.role);
  }
  const staticAccounts = [...accounts].sort(([left,a],[right,b]) => left === feePayer ? -1 : right === feePayer ? 1 : b-a).map(([key])=>key);
  const index = new Map(staticAccounts.map((key,i)=>[key,i]));
  const remap = (i: number): number => { const value = index.get(compiled.staticAccounts[i]); if(value === undefined) throw new Error('missing compiled account'); return value; };
  const normalized = {...compiled,staticAccounts,instructions:compiled.instructions.map(item=>({...item,programAddressIndex:remap(item.programAddressIndex),...(item.accountIndices ? {accountIndices:item.accountIndices.map(remap)} : {})}))};
  const transaction: Transaction = {messageBytes:getCompiledTransactionMessageEncoder().encode(normalized) as TransactionMessageBytes,
    signatures:Object.fromEntries(staticAccounts.slice(0,compiled.header.numSignerAccounts).map(key=>[key,null]))};
  try { if (encodeTransaction(transaction).length > MAX_TRANSACTION_BYTES) throw new Error('too large'); }
  catch { throw new Error('transaction exceeds 1232-byte v0 limit'); }
  return transaction;
}
export async function buildUploadPlan(input: BufferPlanInput): Promise<UploadPlan> {
  input = {...input,nonce:input.nonce.slice(),payload:input.payload.slice(),financial:{...input.financial},snapshot:{...input.snapshot}};
  validatePayload(input.operation, input.payload); raw32(input.nonce); u64(input.expires); u64(input.snapshot.sequence); u64(input.priorityFeeMicroLamports ?? 0n);
  if (!Number.isSafeInteger(input.snapshot.slot) || input.snapshot.slot < 0) throw new Error('invalid snapshot slot');
  if (!(input.pool === input.financial.pool)) throw new Error('pool mismatch');
  const [buffer, bump] = await getProgramDerivedAddress({seeds: ['payload', addressBytes(input.pool), addressBytes(input.uploader), input.nonce], programAddress: input.programId});
  if ((buffer === input.rentPayer)) throw new Error('rent payer cannot be buffer');
  const plan: UploadPlan = { ...input, nonce: input.nonce.slice(), payload: input.payload.slice(), financial: { ...input.financial }, snapshot: { ...input.snapshot }, buffer, bump, digest: await sha256(input.payload), steps: [] };
  const common = [meta(buffer, true), meta(plan.pool), meta(plan.uploader, false, true)];
  plan.steps.push({ kind: 'create', instruction: await ix(plan.programId, 'create_payload', [...common, meta(plan.rentPayer, true, true), meta(SYSTEM_PROGRAM)],
    concat(Uint8Array.of(OPERATIONS[plan.operation].op), u32(plan.payload.length), plan.digest, plan.nonce, u64(plan.expires))) });
  // Choose each chunk from its actual serialized transaction size, including independent fee payer/uploader.
  for (let offset = 0; offset < plan.payload.length;) {
    let low = 1, high = plan.payload.length - offset, best: Step['instruction'] | undefined, count = 0;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const candidate = await ix(plan.programId, 'append_payload', common, concat(u32(offset), u32(size), plan.payload.slice(offset, offset + size)));
      try { compileV0(candidate, plan.feePayer, SYSTEM_PROGRAM, plan.priorityFeeMicroLamports); best = candidate; count = size; low = size + 1; }
      catch { high = size - 1; }
    }
    if (!best || count === 0) throw new Error('cannot fit append transaction');
    plan.steps.push({ kind: 'append', offset, endOffset: offset + count, instruction: best }); offset += count;
  }
  plan.steps.push({ kind: 'seal', instruction: await ix(plan.programId, 'seal_payload', common) });
  plan.steps.push({ kind: 'execute', instruction: await ix(plan.programId, 'execute_payload', [meta(buffer, true), meta(plan.uploader, false, true), meta(plan.rentPayer, true), ...financialMetas(plan.financial, plan.operation === 'deposit')], plan.digest) });
  for (const step of plan.steps) compileV0(step.instruction, plan.feePayer, SYSTEM_PROGRAM, plan.priorityFeeMicroLamports);
  return plan;
}
export async function closePayload(plan: UploadPlan, closer = plan.uploader): Promise<Step> {
  return { kind: 'close', instruction: await ix(plan.programId, 'close_payload', [meta(plan.buffer, true), meta(plan.pool), meta(closer, false, true), meta(plan.rentPayer, true)]) };
}
export async function finalizeEscape(programId: Address, financial: FinancialAccounts, noteId: number): Promise<Step> {
  return { kind: 'finalize', instruction: await ix(programId, 'finalize_escape', financialMetas(financial), u32(noteId)) };
}

export interface V0Wallet {
  publicKey: Address;
  supportedTransactionVersions: ReadonlySet<number | 'legacy'>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}
export async function verifySignatures(transaction: Transaction): Promise<void> {
  transaction = decodeTransaction(encodeTransaction(transaction));
  const message = transactionMessage(transaction);
  if (message.version !== 0) throw new Error('only v0 is supported');
  const required = message.staticAccounts.slice(0,message.header.numSignerAccounts);
  if (Object.keys(transaction.signatures).length !== required.length || required.some(key=>!(key in transaction.signatures))) throw new Error('incorrect signature count');
  const bytes = new Uint8Array(transaction.messageBytes);
  for (const signer of required) {
    const signature = transaction.signatures[signer];
    if (!signature || signature.length !== 64) throw new Error('missing or invalid wallet signature');
    const key = await crypto.subtle.importKey('raw', new Uint8Array(addressBytes(signer)), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), bytes)) throw new Error('missing or invalid wallet signature');
  }
}
/** Every wallet must explicitly advertise v0 and preserve the reviewed message and prior signatures. */
export async function signV0(transaction: Transaction, wallets: readonly V0Wallet[]): Promise<Transaction> {
  if (transactionMessage(transaction).version !== 0) throw new Error('only v0 is supported');
  const expected = new Uint8Array(transaction.messageBytes);
  let signed = decodeTransaction(encodeTransaction(transaction));
  const message = transactionMessage(signed);
  if(message.version !== 0) throw new Error('only v0 is supported');
  const required = message.staticAccounts.slice(0,message.header.numSignerAccounts);
  for (const wallet of [...wallets]) {
    if (!wallet.supportedTransactionVersions.has(0)) throw new Error('wallet does not advertise v0 signing');
    if (!required.some(key => (key === wallet.publicKey))) throw new Error('wallet is not a required signer');
    const previous = Object.fromEntries(Object.entries(signed.signatures).map(([key,signature])=>[key,signature ? new Uint8Array(signature) : null]));
    // Wallets retain the transaction passed to them. Detach their output before any
    // asynchronous signature checks so a retained reference cannot change our result.
    signed = decodeTransaction(encodeTransaction(await wallet.signTransaction(signed)));
    if (transactionMessage(signed).version !== 0 || !equal(signed.messageBytes, expected)) throw new Error('wallet changed transaction message');
    for (const signer of required) if (previous[signer]?.some(byte=>byte !== 0) && (!signed.signatures[signer] || !equal(previous[signer]!,signed.signatures[signer]!))) throw new Error('wallet changed an existing signature');
  }
  await verifySignatures(signed);
  if (encodeTransaction(signed).length > MAX_TRANSACTION_BYTES) throw new Error('transaction exceeds 1232-byte v0 limit');
  return signed;
}
export interface BufferState { address: Address; owner: Address; data: Uint8Array; slot: number; commitment: 'finalized' }
/** The account result and its finalized block are one anchored observation,
 * including when the account is absent. */
export interface FinalizedBufferObservation {
  address: string; account: BufferState | null; slot: number; blockHeight: number; blockhash: string; commitment: 'finalized';
}
/** Validate finalized account bytes against this exact upload, including PDA, allocation, nonce, prefix and digest. */
export async function readBuffer(plan: UploadPlan, account: BufferState): Promise<{ offset: number; sealed: boolean }> {
  const b = account.data;
  if (!(account.address === plan.buffer) || account.commitment !== 'finalized' || !Number.isSafeInteger(account.slot) || account.slot < plan.snapshot.slot || !(account.owner === plan.programId) || b.length !== 160 + plan.payload.length || !equal(b.slice(0, 8), await discriminator('PayloadBuffer', 'account')) || b[8] !== 2 || b[9] !== plan.bump) throw new Error('invalid buffer account');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const length = view.getUint32(43, true), offset = view.getUint32(79, true), sealed = b[83];
  if (!equal(b.slice(10, 42), addressBytes(plan.uploader)) || b[42] !== OPERATIONS[plan.operation].op || length !== plan.payload.length || !equal(b.slice(47, 79), plan.digest)
      || offset > length || sealed > 1 || view.getBigUint64(84, true) !== plan.expires || !equal(b.slice(92, 124), addressBytes(plan.rentPayer)) || view.getUint32(124, true) !== length
      || !equal(b.slice(128 + length), plan.nonce) || !equal(b.slice(128, 128 + offset), plan.payload.slice(0, offset)) || (sealed === 1 && offset !== length)) throw new Error('buffer differs from journal');
  if (sealed === 1 && !equal(await sha256(b.slice(128, 128 + length)), plan.digest)) throw new Error('sealed digest mismatch');
  return { offset, sealed: sealed === 1 };
}

/** Persist via an atomic, durable store before sending. The host supplies encrypted storage in I08. */
export interface PlanRecord {
  programId: string; pool: string; operation: Operation; payloadHex: string; nonceHex: string; expires: string;
  uploader: string; rentPayer: string; feePayer: string; snapshotSlot: number; snapshotSequence: string;
  expectedRoot: string; expectedNoteId: number; financial: Record<keyof FinancialAccounts, string>;
  priorityFeeMicroLamports?: string;
}
export interface SignedAttempt { schema: 1 | 2; kind: Step['kind']; signature: string; wireHex: string; blockhash: string; lastValidBlockHeight: number }
export interface Attempt extends SignedAttempt { schema: 1; kind: Exclude<Step['kind'], 'deposit_inline'>; planDigest: string; buffer: string; plan: PlanRecord; closer?: string }
export interface FinalizationPlan { programId: Address; pool: Address; noteId: number; feePayer: Address; financial: FinancialAccounts; snapshot: { slot: number; sequence: bigint } }
export interface FinalizationAttempt extends SignedAttempt { schema: 1; kind: 'finalize'; finalization: {
  programId: string; pool: string; noteId: number; feePayer: string; financial: Record<keyof FinancialAccounts, string>; snapshotSlot: number; snapshotSequence: string;
} }
function planRecord(plan: UploadPlan): PlanRecord {
  const treeStart = plan.payload.length - 608;
  const id = BigInt('0x' + hex(plan.payload.slice(treeStart + 96, treeStart + 128)));
  if (id > 0xffffffffn) throw new Error('tree note ID out of range');
  return { programId: plan.programId, pool: plan.pool, operation: plan.operation, payloadHex: hex(plan.payload), nonceHex: hex(plan.nonce), expires: plan.expires.toString(),
    uploader: plan.uploader, rentPayer: plan.rentPayer, feePayer: plan.feePayer, snapshotSlot: plan.snapshot.slot, snapshotSequence: plan.snapshot.sequence.toString(),
    expectedRoot: hex(plan.payload.slice(treeStart + 32, treeStart + 64)), expectedNoteId: Number(id),
    ...((plan.priorityFeeMicroLamports ?? 0n) > 0n ? { priorityFeeMicroLamports: plan.priorityFeeMicroLamports!.toString() } : {}),
    financial: Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(name => [name, plan.financial[name]])) as FinancialAccounts };
}
export { planRecord as snapshotPlan };
export async function restorePlan(record: PlanRecord): Promise<UploadPlan> {
  const restored = await buildUploadPlan({ programId: address(record.programId), pool: address(record.pool), operation: record.operation,
    payload: fromHex(record.payloadHex, OPERATIONS[record.operation].bytes), nonce: fromHex(record.nonceHex, 32), expires: BigInt(record.expires),
    uploader: address(record.uploader), rentPayer: address(record.rentPayer), feePayer: address(record.feePayer),
    snapshot: { slot: record.snapshotSlot, sequence: BigInt(record.snapshotSequence) }, priorityFeeMicroLamports: BigInt(record.priorityFeeMicroLamports ?? '0'),
    financial: Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(name => [name, address(record.financial[name])])) as FinancialAccounts });
  const expected = planRecord(restored);
  if (expected.expectedRoot !== record.expectedRoot || expected.expectedNoteId !== record.expectedNoteId || expected.priorityFeeMicroLamports !== record.priorityFeeMicroLamports) throw new Error('journal proof context mismatch');
  return restored;
}
export interface Journal<T = Attempt> { save(attempt: T): Promise<void> }
export interface SignatureStatus { slot: number; confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null; err: unknown | null }
export interface FinalizedReceipt { message: Uint8Array; signature: string; err: unknown | null; slot: number }
export interface TransportRpc {
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
  finalizedReceipt(signature: string): Promise<FinalizedReceipt | null>;
  finalizedBlockHeight(): Promise<number>;
  sendRawTransaction(bytes: Uint8Array): Promise<string>;
}
export type Recovery = { state: 'finalized'; slot: number } | { state: 'rejected'; slot: number; error: unknown; needsNewProof: boolean } | { state: 'pending' | 'unknown' | 'expired_reconcile_required' };
export async function prepareAttempt(plan: UploadPlan, step: Step, blockhash: { blockhash: string; lastValidBlockHeight: number }, wallets: readonly V0Wallet[], journal: Journal): Promise<Attempt> {
  if (!Number.isSafeInteger(blockhash.lastValidBlockHeight) || blockhash.lastValidBlockHeight < 0) throw new Error('invalid last valid block height');
  // Capture all caller-owned inputs before the first await. Wallet prompts may
  // outlive UI edits to the plan, instruction or current blockhash.
  if (step.kind === 'deposit_inline') throw new Error('inline deposit requires its own plan');
  const record = planRecord(plan), digest = hex(plan.digest), buffer = plan.buffer, kind = step.kind;
  const { blockhash: recentBlockhash, lastValidBlockHeight } = blockhash;
  const transaction = decodeTransaction(encodeTransaction(compileV0(step.instruction, plan.feePayer, recentBlockhash, plan.priorityFeeMicroLamports)));
  const closer = kind === 'close' ? step.instruction.accounts![2].address : undefined;
  const checked = await restorePlan(record);
  if (hex(checked.digest) !== digest || checked.buffer !== buffer) throw new Error('upload plan changed');
  await assertPlannedMessage(checked, kind, transaction, closer);
  const signed = await signV0(transaction, wallets);
  const attempt: Attempt = { schema: 1, kind, signature: transactionSignature(signed), wireHex: hex(encodeTransaction(signed)),
    blockhash: recentBlockhash, lastValidBlockHeight, planDigest: digest, buffer, plan: record, ...(closer ? { closer } : {}) };
  await journal.save(attempt); return attempt;
}
async function assertPlannedMessage(plan: UploadPlan, kind: Step['kind'], tx: Transaction, closer?: string): Promise<void> {
  if (closer && kind !== 'close') throw new Error('closer only allowed for close');
  const steps = [...plan.steps, await closePayload(plan, closer ? address(closer) : plan.uploader)];
  if (!steps.some(step => step.kind === kind && equal(compileV0(step.instruction, plan.feePayer, transactionBlockhash(tx), plan.priorityFeeMicroLamports).messageBytes, tx.messageBytes))) throw new Error('signed message does not match journal plan');
}
function staleProof(error: unknown): boolean {
  // Anchor 6006 StaleRoot, 6007 StaleNoteId, 6008 InvalidExpiry: preserve auth state, request new proof and fresh buffer.
  if (error === null || typeof error !== 'object') return false;
  const instruction = (error as { InstructionError?: unknown[] }).InstructionError;
  const detail = instruction?.[1];
  return typeof detail === 'object' && detail !== null && [6006, 6007, 6008].includes((detail as { Custom?: number }).Custom ?? -1);
}
async function readSignedAttempt(attempt: SignedAttempt): Promise<Transaction> {
  const wire = fromHex(attempt.wireHex, attempt.wireHex.length / 2), transaction = decodeTransaction(wire);
  if (![1, 2].includes(attempt.schema) || transactionMessage(transaction).version !== 0 || transactionBlockhash(transaction) !== attempt.blockhash || transactionSignature(transaction) !== attempt.signature || wire.length > MAX_TRANSACTION_BYTES
    || !Number.isSafeInteger(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight < 0) throw new Error('corrupt transaction journal');
  await verifySignatures(transaction); return transaction;
}
async function observeSignedAttempt(attempt: SignedAttempt, transaction: Transaction, rpc: TransportRpc, resendIdentical: boolean): Promise<Recovery> {
  // Always consult history before retrying. Confirmed errors can roll back; only a finalized receipt is terminal.
  try {
    const status = await rpc.signatureStatus(attempt.signature);
    const receipt = await rpc.finalizedReceipt(attempt.signature);
    if (receipt) {
      if (attempt.kind === 'deposit_inline' && status && (status.slot !== receipt.slot || JSON.stringify(status.err) !== JSON.stringify(receipt.err))) throw new Error('RPC signature status and receipt disagree');
      if (receipt.signature !== attempt.signature || !equal(receipt.message, transaction.messageBytes) || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0) throw new Error('RPC receipt does not match signed transaction');
      return receipt.err === null ? { state: 'finalized', slot: receipt.slot } : { state: 'rejected', slot: receipt.slot, error: receipt.err, needsNewProof: (attempt.kind === 'execute' || attempt.kind === 'deposit_inline') && staleProof(receipt.err) };
    }
    if (status) return { state: 'pending' };
    if (await rpc.finalizedBlockHeight() > attempt.lastValidBlockHeight) return { state: 'expired_reconcile_required' };
    if (resendIdentical) {
      const returnedSignature = await rpc.sendRawTransaction(fromHex(attempt.wireHex, attempt.wireHex.length / 2));
      if (returnedSignature !== attempt.signature) throw new Error('RPC returned another signature');
    }
    return { state: 'pending' };
  } catch { return { state: 'unknown' }; }
}
export async function recoverAttempt(attempt: Attempt, rpc: TransportRpc, resendIdentical = false): Promise<Recovery> {
  // RPC awaits must not allow a caller to substitute bytes after validation.
  attempt = structuredClone(attempt);
  if(attempt.schema!==1||!['create','append','seal','execute','close'].includes(attempt.kind))throw new Error('invalid buffer attempt variant');
  const transaction = await readSignedAttempt(attempt), restored = await restorePlan(attempt.plan);
  if (hex(restored.digest) !== attempt.planDigest || restored.buffer !== attempt.buffer) throw new Error('journal payload digest mismatch');
  await assertPlannedMessage(restored, attempt.kind, transaction, attempt.closer);
  return observeSignedAttempt(attempt, transaction, rpc, resendIdentical);
}
async function validateFinalization(plan: FinalizationPlan): Promise<void> {
  u32(plan.noteId); u64(plan.snapshot.sequence);
  const note = (await getProgramDerivedAddress({seeds: ['note', addressBytes(plan.pool), u32(plan.noteId)], programAddress: plan.programId}))[0];
  if (!Number.isSafeInteger(plan.snapshot.slot) || plan.snapshot.slot < 0 || !(plan.pool === plan.financial.pool) || !(note === plan.financial.note)) throw new Error('invalid finalization context');
}
function restoreFinalizationPlan(record: FinalizationAttempt['finalization']): FinalizationPlan {
  return { programId: address(record.programId), pool: address(record.pool), noteId: record.noteId, feePayer: address(record.feePayer),
    financial: Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(name => [name, address(record.financial[name])])) as FinancialAccounts,
    snapshot: { slot: record.snapshotSlot, sequence: BigInt(record.snapshotSequence) } };
}
export async function prepareFinalizationAttempt(plan: FinalizationPlan, blockhash: { blockhash: string; lastValidBlockHeight: number }, wallets: readonly V0Wallet[], journal: Journal<FinalizationAttempt>): Promise<FinalizationAttempt> {
  plan = {...plan,financial:{...plan.financial},snapshot:{...plan.snapshot}}; blockhash = {...blockhash};
  await validateFinalization(plan);
  if (!Number.isSafeInteger(blockhash.lastValidBlockHeight) || blockhash.lastValidBlockHeight < 0) throw new Error('invalid last valid block height');
  const record: FinalizationAttempt['finalization'] = { programId: plan.programId, pool: plan.pool, noteId: plan.noteId, feePayer: plan.feePayer,
    financial: Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(name => [name, plan.financial[name]])) as FinancialAccounts, snapshotSlot: plan.snapshot.slot, snapshotSequence: plan.snapshot.sequence.toString() };
  const { blockhash: recentBlockhash, lastValidBlockHeight } = blockhash;
  const checked = restoreFinalizationPlan(record);
  const step = await finalizeEscape(checked.programId, checked.financial, checked.noteId);
  const signed = await signV0(compileV0(step.instruction, checked.feePayer, recentBlockhash), wallets);
  const attempt: FinalizationAttempt = { schema: 1, kind: 'finalize', signature: transactionSignature(signed), wireHex: hex(encodeTransaction(signed)), blockhash: recentBlockhash,
    lastValidBlockHeight, finalization: record };
  await journal.save(attempt); return attempt;
}
export async function recoverFinalizationAttempt(attempt: FinalizationAttempt, rpc: TransportRpc, resendIdentical = false): Promise<Recovery> {
  attempt = structuredClone(attempt);
  const transaction = await readSignedAttempt(attempt), record = attempt.finalization;
  if (attempt.schema !== 1 || attempt.kind !== 'finalize') throw new Error('invalid finalization journal kind');
  const plan = restoreFinalizationPlan(record);
  await validateFinalization(plan);
  const step = await finalizeEscape(plan.programId, plan.financial, plan.noteId);
  if (!equal(compileV0(step.instruction, plan.feePayer, attempt.blockhash).messageBytes, transaction.messageBytes)) throw new Error('signed message does not match finalization journal');
  return observeSignedAttempt(attempt, transaction, rpc, resendIdentical);
}
/** Reconcile upload only. Execute/close and missing accounts require signature/history evidence, never infer success from absence. */
export async function nextUploadStep(plan: UploadPlan, account: BufferState | null): Promise<Step | null> {
  if (account === null) throw new Error('buffer absent: reconcile signatures and finalized history before creating or declaring success');
  const state = await readBuffer(plan, account);
  if (state.sealed) return plan.steps.find(step => step.kind === 'execute')!;
  if (state.offset === plan.payload.length) return plan.steps.find(step => step.kind === 'seal')!;
  const next = plan.steps.find(step => step.kind === 'append' && step.offset === state.offset);
  if (!next) throw new Error('unrecognized upload offset');
  return next;
}
/** After blockhash expiry, only monotonic uploads may be retried using a verified finalized account.
 * Execute/close need finalized transaction/history evidence. A missing account never authorizes a new attempt.
 */
export async function refreshExpiredUpload(attempt: Attempt, rpc: TransportRpc, account: BufferState | null,
  blockhash: { blockhash: string; lastValidBlockHeight: number }, wallets: readonly V0Wallet[], journal: Journal): Promise<Attempt | { next: Step }> {
  attempt = structuredClone(attempt);
  blockhash = { ...blockhash };
  if (attempt.kind === 'execute' || attempt.kind === 'close' || attempt.kind === 'finalize') throw new Error('financial or close attempt needs finalized history reconciliation');
  if ((await recoverAttempt(attempt, rpc)).state !== 'expired_reconcile_required') throw new Error('previous attempt is not finalized-expired');
  const plan = await restorePlan(attempt.plan);
  if (account === null) throw new Error('missing buffer: finalized history reconciliation required');
  const next = (await nextUploadStep(plan, account))!;
  const old = decodeTransaction(fromHex(attempt.wireHex, attempt.wireHex.length / 2));
  const retry = compileV0(next.instruction, plan.feePayer, attempt.blockhash, plan.priorityFeeMicroLamports);
  if (!equal(old.messageBytes, retry.messageBytes)) return { next };
  // A refreshed hash must be new and valid after the old finalized height.
  if (blockhash.blockhash === attempt.blockhash || blockhash.lastValidBlockHeight <= attempt.lastValidBlockHeight) throw new Error('fresh blockhash required');
  return prepareAttempt(plan, next, blockhash, wallets, journal);
}

export async function fetchFinalizedBuffer(connection: Rpc<SolanaRpcApi>, plan: UploadPlan, minimumSlot = plan.snapshot.slot): Promise<BufferState | null> {
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0) throw new Error('invalid minimum buffer slot');
  const minContextSlot = Math.max(plan.snapshot.slot, minimumSlot);
  const result = await connection.getAccountInfo(plan.buffer, { encoding:'base64', commitment: 'finalized', minContextSlot:BigInt(minContextSlot) }).send();
  const slot = safeRpcNumber(result.context.slot,'buffer slot');
  if (slot < minContextSlot) throw new Error('stale finalized buffer observation');
  const value = decodeRpcAccount(result.value);
  if (!value) return null;
  const account: BufferState = { address: plan.buffer, owner: value.owner, data: value.data, slot, commitment: 'finalized' };
  await readBuffer(plan, account); return account;
}

export async function fetchFinalizedBufferObservation(connection: Rpc<SolanaRpcApi>, plan: UploadPlan, minimumSlot = plan.snapshot.slot): Promise<FinalizedBufferObservation> {
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0) throw new Error('invalid minimum buffer slot');
  const minContextSlot = Math.max(plan.snapshot.slot, minimumSlot);
  const result = await connection.getAccountInfo(plan.buffer, { encoding:'base64', commitment: 'finalized', minContextSlot:BigInt(minContextSlot) }).send();
  const slot = safeRpcNumber(result.context.slot,'buffer slot');
  if (slot < minContextSlot) throw new Error('stale finalized buffer observation');
  const block = await connection.getBlock(BigInt(slot), { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 1 }).send();
  if (!block || typeof block.blockhash !== 'string' || asBlockhash(block.blockhash) !== block.blockhash) throw new Error('invalid finalized buffer block');
  const blockHeight = safeRpcNumber(block.blockHeight,'finalized buffer block height');
  const value = decodeRpcAccount(result.value);
  const account: BufferState | null = value ? { address: plan.buffer, owner: value.owner, data: value.data, slot, commitment: 'finalized' } : null;
  if (account) await readBuffer(plan, account);
  return { address: plan.buffer, account, slot, blockHeight, blockhash: block.blockhash, commitment: 'finalized' };
}

/** Transaction preparation may use a fresher confirmed bank. This never changes
 * proof/account commitments, financial finality, or saved-attempt expiry checks. */
export type TransactionPreparationCommitment = 'confirmed' | 'finalized';
export function resolvePreparationCommitment(value: unknown = undefined): TransactionPreparationCommitment {
  if (value === undefined) return 'finalized';
  if (value !== 'confirmed' && value !== 'finalized') throw new Error('invalid transaction preparation commitment');
  return value;
}

/** Adapter uses finalized receipts and explicit v0 reads. Match an opt-in
 * preparation commitment to blockhash and fee lookups at the call site. */
function journalRpcError(error: unknown): unknown {
  // Error indices and custom program codes are integer JSON metadata, not
  // financial quantities. Preserve the existing durable JSON error contract.
  if (typeof error === 'bigint') return safeRpcNumber(error,'transaction error integer');
  if (error === undefined || typeof error === 'number' && (!Number.isSafeInteger(error) || error < 0)) throw new Error('invalid transaction error metadata');
  if (Array.isArray(error)) return error.map(journalRpcError);
  if (error && typeof error === 'object') return Object.fromEntries(Object.entries(error).map(([key,value])=>[key,journalRpcError(value)]));
  return error;
}
export function connectionTransport(connection: Rpc<SolanaRpcApi>, options: {preparationCommitment?: TransactionPreparationCommitment} = {}): TransportRpc {
  const preparationCommitment = resolvePreparationCommitment(options.preparationCommitment);
  return {
    signatureStatus: async signature => {
      const value = (await connection.getSignatureStatuses([asSignature(signature)], { searchTransactionHistory: true }).send()).value[0];
      return value ? {err:journalRpcError(value.err),confirmationStatus:value.confirmationStatus,slot:safeRpcNumber(value.slot,'signature slot')} : null;
    },
    finalizedReceipt: async signature => {
      const receipt = await connection.getTransaction(asSignature(signature), { encoding:'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }).send();
      if (!receipt || !receipt.meta) return null;
      const tx = decodeTransaction(new Uint8Array(getBase64Encoder().encode(receipt.transaction[0])));
      if (transactionMessage(tx).version !== 0) throw new Error('only v0 receipts are supported');
      return { message: new Uint8Array(tx.messageBytes), signature: transactionSignature(tx), err: journalRpcError(receipt.meta.err), slot: safeRpcNumber(receipt.slot,'transaction slot') };
    },
    finalizedBlockHeight: async () => safeRpcNumber(await connection.getBlockHeight({commitment:'finalized'}).send(),'finalized block height'),
    sendRawTransaction: bytes => connection.sendTransaction(getBase64Decoder().decode(bytes) as Base64EncodedWireTransaction, { encoding:'base64', skipPreflight: false, maxRetries: 0n, preflightCommitment: preparationCommitment }).send(),
  };
}


export interface InlineDepositPlanInput {
  deploymentId: string; manifestHash: string; vaultBinding: string;
  programId: Address; pool: Address; feePayer: Address; payload: Uint8Array;
  financial: FinancialAccounts; snapshot: { slot: number; sequence: bigint }; priorityFeeMicroLamports?: bigint;
}
export interface InlineDepositPlan extends InlineDepositPlanInput {
  transport: 'v0_inline_deposit_v1'; compact: Uint8Array; canonicalPayloadDigest: Uint8Array;
  inlineInstructionDigest: Uint8Array; steps: [Step & {kind: 'deposit_inline'}];
}
export interface InlineDepositPlanRecord {
  transport: 'v0_inline_deposit_v1'; operation: 'deposit'; deploymentId: string; manifestHash: string;
  programId: string; pool: string; mint: string; vaultBinding: string; feePayer: string;
  financial: Record<keyof FinancialAccounts, string>; snapshotSlot: number; snapshotSequence: string;
  payloadHex: string; compactHex: string; discriminatorHex: string; canonicalPayloadDigest: string; inlineInstructionDigest: string;
  amount: string; expectedRoot: string; expectedNoteId: number; expiry: string; priorityFeeMicroLamports?: string;
}
export interface InlineDepositAttempt extends SignedAttempt {
  schema: 2; kind: 'deposit_inline'; transport: 'v0_inline_deposit_v1'; plan: InlineDepositPlanRecord;
}
export type FinancialAttempt = Attempt | FinalizationAttempt | InlineDepositAttempt;
export type FinancialPlanRecord = PlanRecord | InlineDepositPlanRecord;
const INLINE_DISCRIMINATOR = 'adee5c1edb1f80e9';
function exactKeys(value: object, allowed: readonly string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) throw new Error('invalid inline journal fields');
}
const inlinePlanKeys = ['transport','operation','deploymentId','manifestHash','programId','pool','mint','vaultBinding','feePayer','financial','snapshotSlot','snapshotSequence','payloadHex','compactHex','discriminatorHex','canonicalPayloadDigest','inlineInstructionDigest','amount','expectedRoot','expectedNoteId','expiry','priorityFeeMicroLamports'];
/** Structural, redundant-field and asynchronous PDA validation at encrypted CAS/read.
 * Recovery additionally recomputes hashes and verifies Ed25519 signatures. */
export async function validateInlineDepositPlanRecord(record: InlineDepositPlanRecord): Promise<void> {
  record = structuredClone(record);
  exactKeys(record, inlinePlanKeys, inlinePlanKeys.filter(k => k !== 'priorityFeeMicroLamports'));
  if (record.transport !== 'v0_inline_deposit_v1' || record.operation !== 'deposit' || typeof record.deploymentId !== 'string' || !record.deploymentId.length || !/^[0-9a-f]{64}$/.test(record.manifestHash)
    || !Number.isSafeInteger(record.snapshotSlot) || record.snapshotSlot < 0) throw new Error('invalid inline plan context');
  for (const v of [record.programId, record.pool, record.mint, record.feePayer]) if (address(v) !== v) throw new Error('noncanonical inline account');
  exactKeys(record.financial, FINANCIAL_ACCOUNT_ORDER);
  for (const v of Object.values(record.financial)) if (address(v) !== v) throw new Error('noncanonical inline account');
  for (const v of [record.snapshotSequence, record.amount, record.expiry, record.priorityFeeMicroLamports ?? '0']) {
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error('invalid inline integer'); u64(BigInt(v));
  }
  if (record.priorityFeeMicroLamports === '0') throw new Error('noncanonical inline fee');
  const payload = fromHex(record.payloadHex, 692), compact = fromHex(record.compactHex, 436), view = new DataView(compact.buffer, compact.byteOffset, compact.byteLength);
  if (!equal(compactDepositPayload(payload, record.vaultBinding), compact) || !equal(expandCompactDepositPayload(compact, record.vaultBinding), payload)
    || record.expectedNoteId !== view.getUint32(0, true) || record.expectedRoot !== hex(compact.slice(4, 36)) || record.expiry !== view.getBigUint64(36, true).toString()
    || record.amount !== view.getBigUint64(76, true).toString() || record.pool !== record.financial.pool || record.mint !== record.financial.mint
    || record.discriminatorHex !== INLINE_DISCRIMINATOR) throw new Error('inline journal payload mismatch');
  fromHex(record.canonicalPayloadDigest, 32); fromHex(record.inlineInstructionDigest, 32);
  const expected = await vaultAccounts({programId:address(record.programId),pool:address(record.pool),mint:address(record.mint),payer:address(record.financial.payer),tokenOwner:address(record.financial.tokenOwner),operation:'deposit',noteId:record.expectedNoteId});
  for (const key of FINANCIAL_ACCOUNT_ORDER) if (expected[key] !== record.financial[key]) throw new Error('invalid inline financial accounts');
}
export async function validateInlineDepositAttemptRecord(attempt: InlineDepositAttempt): Promise<void> {
  attempt = structuredClone(attempt);
  exactKeys(attempt, ['schema','kind','transport','signature','wireHex','blockhash','lastValidBlockHeight','plan']);
  if (attempt.schema !== 2 || attempt.kind !== 'deposit_inline' || attempt.transport !== 'v0_inline_deposit_v1' || !Number.isSafeInteger(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight < 0) throw new Error('invalid inline attempt');
  await validateInlineDepositPlanRecord(attempt.plan);
  const wire = fromHex(attempt.wireHex, attempt.wireHex.length / 2), tx = decodeTransaction(wire);
  if (wire.length > MAX_TRANSACTION_BYTES || transactionMessage(tx).version !== 0 || transactionBlockhash(tx) !== attempt.blockhash || transactionSignature(tx) !== attempt.signature || !equal(encodeTransaction(tx),wire)) throw new Error('invalid inline signed wire');
  const p = attempt.plan, instruction = {programAddress:address(p.programId),accounts:[...financialMetas(Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(k => [k,address(p.financial[k])])) as FinancialAccounts),meta(address(p.financial.tokenOwner),false,true)],data:concat(fromHex(p.discriminatorHex,8),fromHex(p.compactHex,436))};
  if (!equal(compileV0(instruction,address(p.feePayer),attempt.blockhash,BigInt(p.priorityFeeMicroLamports ?? '0')).messageBytes,tx.messageBytes)) throw new Error('inline signed message does not match plan');
}
export async function buildInlineDepositPlan(input: InlineDepositPlanInput): Promise<InlineDepositPlan> {
  // Detach all mutable bytes before hashing or prompting a wallet.
  input = {...input,payload:input.payload.slice(),financial:{...input.financial},snapshot:{...input.snapshot}};
  const compact = compactDepositPayload(input.payload,input.vaultBinding);
  const instruction = await ix(input.programId,'deposit_compact_v1',[...financialMetas(input.financial),meta(input.financial.tokenOwner,false,true)],compact);
  const plan: InlineDepositPlan = {...input,transport:'v0_inline_deposit_v1',compact,canonicalPayloadDigest:await sha256(input.payload),inlineInstructionDigest:await sha256(instruction.data),steps:[{kind:'deposit_inline',instruction}]};
  await validateInlineDepositPlanRecord(snapshotInlineDepositPlan(plan));
  compileV0(instruction,input.feePayer,SYSTEM_PROGRAM,input.priorityFeeMicroLamports);
  return plan;
}
export function snapshotInlineDepositPlan(plan: InlineDepositPlan): InlineDepositPlanRecord {
  const view = new DataView(plan.compact.buffer,plan.compact.byteOffset,plan.compact.byteLength);
  return {transport:'v0_inline_deposit_v1',operation:'deposit',deploymentId:plan.deploymentId,manifestHash:plan.manifestHash,vaultBinding:plan.vaultBinding,
    programId:plan.programId,pool:plan.pool,mint:plan.financial.mint,feePayer:plan.feePayer,
    financial:Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(k=>[k,plan.financial[k]])) as FinancialAccounts,snapshotSlot:plan.snapshot.slot,snapshotSequence:plan.snapshot.sequence.toString(),
    payloadHex:hex(plan.payload),compactHex:hex(plan.compact),discriminatorHex:hex(plan.steps[0].instruction.data.slice(0,8)),canonicalPayloadDigest:hex(plan.canonicalPayloadDigest),inlineInstructionDigest:hex(plan.inlineInstructionDigest),
    expectedNoteId:view.getUint32(0,true),expectedRoot:hex(plan.compact.slice(4,36)),amount:view.getBigUint64(76,true).toString(),expiry:view.getBigUint64(36,true).toString(),
    ...((plan.priorityFeeMicroLamports??0n)>0n?{priorityFeeMicroLamports:plan.priorityFeeMicroLamports!.toString()}:{})};
}
export async function restoreInlineDepositPlan(record: InlineDepositPlanRecord): Promise<InlineDepositPlan> {
  record = structuredClone(record); await validateInlineDepositPlanRecord(record);
  const plan = await buildInlineDepositPlan({deploymentId:record.deploymentId,manifestHash:record.manifestHash,vaultBinding:record.vaultBinding,programId:address(record.programId),pool:address(record.pool),feePayer:address(record.feePayer),payload:fromHex(record.payloadHex,692),
    financial:Object.fromEntries(FINANCIAL_ACCOUNT_ORDER.map(k=>[k,address(record.financial[k])])) as FinancialAccounts,snapshot:{slot:record.snapshotSlot,sequence:BigInt(record.snapshotSequence)},priorityFeeMicroLamports:BigInt(record.priorityFeeMicroLamports??'0')});
  if (hex(plan.canonicalPayloadDigest)!==record.canonicalPayloadDigest || hex(plan.inlineInstructionDigest)!==record.inlineInstructionDigest) throw new Error('inline journal digest mismatch');
  return plan;
}
export async function prepareInlineDepositAttempt(plan: InlineDepositPlan, blockhash: {blockhash:string;lastValidBlockHeight:number}, wallets:readonly V0Wallet[], journal:Journal<InlineDepositAttempt>): Promise<InlineDepositAttempt> {
  if(!Number.isSafeInteger(blockhash.lastValidBlockHeight)||blockhash.lastValidBlockHeight<0)throw new Error('invalid last valid block height');
  const record = snapshotInlineDepositPlan(plan), hash = {...blockhash};
  // Capture and verify the exact supplied instruction as well as reconstructed plan.
  const tx = decodeTransaction(encodeTransaction(compileV0(plan.steps[0].instruction,plan.feePayer,hash.blockhash,plan.priorityFeeMicroLamports)));
  const checked = await restoreInlineDepositPlan(record);
  if (!equal(tx.messageBytes,compileV0(checked.steps[0].instruction,checked.feePayer,hash.blockhash,checked.priorityFeeMicroLamports).messageBytes)) throw new Error('inline plan changed');
  const signed = await signV0(tx,wallets);
  const attempt:InlineDepositAttempt = {schema:2,kind:'deposit_inline',transport:'v0_inline_deposit_v1',signature:transactionSignature(signed),wireHex:hex(encodeTransaction(signed)),blockhash:hash.blockhash,lastValidBlockHeight:hash.lastValidBlockHeight,plan:record};
  await validateInlineDepositAttemptRecord(attempt); await journal.save(attempt); return attempt;
}
/** Defaults to observation only. The wallet enables sending exclusively for the
 * attempt just durably created by that invocation; reopened unknowns never send. */
export async function recoverInlineDepositAttempt(attempt: InlineDepositAttempt,rpc:TransportRpc,resendIdentical=false):Promise<Recovery> {
  attempt=structuredClone(attempt);await validateInlineDepositAttemptRecord(attempt);
  const tx=await readSignedAttempt(attempt);await restoreInlineDepositPlan(attempt.plan);
  const result=await observeSignedAttempt(attempt,tx,rpc,resendIdentical);
  if((result.state==='finalized'||result.state==='rejected')&&result.slot<attempt.plan.snapshotSlot)return {state:'unknown'};
  return result;
}
