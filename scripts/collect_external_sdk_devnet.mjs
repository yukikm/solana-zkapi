/** Independent read-only collection from PUBLIC result files and finalized RPC.
 * Never reads an encrypted journal, wallet, passphrase or private configuration. */
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {address, getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, getSignatureFromTransaction} from '@solana/kit';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const keyBytes = value => Buffer.from(getAddressEncoder().encode(value));
import bs58 from 'bs58';
import {verifySignatures, discriminator, vaultAccounts, TOKEN_PROGRAM} from '@zkapi/solana-sdk/transport';
import {parseStrictJson, manifestDigest} from '@zkapi/solana-sdk/trust';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const key = value => { assert.equal(typeof value, 'string'); const k = address(value); assert.equal(k, value); return k; };
const signature = value => { assert.equal(typeof value, 'string'); const bytes = bs58.decode(value); assert.equal(bytes.length, 64); assert.equal(bs58.encode(bytes), value); };
const signatureNames = ['deposit_compact_v1', 'create_payload', 'append_payload', 'seal_payload', 'execute_payload', 'close_payload', 'finalize_escape'];

async function publicBytes(path) {
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 1024 * 1024, 'bounded public regular input required');
  return new Uint8Array(await readFile(path));
}
async function boundedResponse(response) {
  assert.ok(response.ok && response.body); const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; assert.ok(size <= 4 * 1024 * 1024); chunks.push(next.value); } }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return parseStrictJson(new Uint8Array(Buffer.concat(chunks)), 4 * 1024 * 1024);
}
export function publicRpc(host, fetcher = fetch) {
  const url = new URL(host); assert.equal(url.origin, host); assert.equal(url.protocol, 'http:'); assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
  let id = 0;
  return async (method, params) => {
    assert.ok(['getGenesisHash', 'getTransaction', 'getSignatureStatuses', 'getMultipleAccounts', 'getBlock'].includes(method), 'collector is read-only');
    const requestId = ++id;
    const response = await fetcher(host + '/rpc', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: host},
      body: JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000)});
    const value = await boundedResponse(response); assert.equal(value.jsonrpc, '2.0'); assert.equal(value.id, requestId); assert.ok(!value.error, 'read-only RPC failed');
    return value.result;
  };
}

/** Reports are cumulative dispatch observations. Repeated rows across reports
 * are the same saved dispatch, never extra inference or transaction sends. */
export function validatePublicReports(reports) {
  assert.ok(reports.length > 0); const checked = [];
  for (const {name, value, sha256} of reports) {
    assert.match(name, /^[a-z0-9][a-z0-9-]*-result\.json$/); assert.match(sha256, /^[0-9a-f]{64}$/);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.ok(typeof value.command === 'string' && !Number.isNaN(Date.parse(value.completedAt)));
    assert.ok(value.status && typeof value.status.noteId === 'string' && Array.isArray(value.transactions));
    assert.ok(integer(value.authSends) && integer(value.inferenceSends));
    const seen = new Set();
    for (const row of value.transactions) {
      signature(row.signature); assert.ok(!seen.has(row.signature), 'duplicate saved dispatch'); seen.add(row.signature);
      assert.match(row.wireSha256, /^[0-9a-f]{64}$/); assert.ok(integer(row.bytes) && row.bytes > 0 && row.bytes <= 1232);
      assert.ok(!Number.isNaN(Date.parse(row.sendRecordedAt)));
    }
    checked.push({name, value: structuredClone(value), sha256});
  }
  checked.sort((a,b) => Date.parse(a.value.completedAt) - Date.parse(b.value.completedAt));
  const latest = checked.at(-1).value;
  assert.equal(latest.status.wallet, 'closed', 'collect only after completed withdrawal');
  assert.equal(latest.status.session, null); assert.equal(latest.status.walletOperation, null); assert.ok(!latest.failed);
  assert.ok(latest.transactions.length > 0 && Array.isArray(latest.finalized));
  const dispatch = new Map(latest.transactions.map(row => [row.signature, row]));
  assert.equal(latest.finalized.length, dispatch.size); const finalSeen = new Set();
  for (const row of latest.finalized) {
    signature(row.signature); assert.ok(dispatch.has(row.signature) && !finalSeen.has(row.signature)); finalSeen.add(row.signature);
    assert.ok(integer(row.slot) && row.slot > 0); assert.ok(['deposit','mutual_close'].includes(row.kind));
  }
  for (const report of checked) {
    assert.equal(report.value.status.noteId, latest.status.noteId); assert.equal(report.value.status.mode, latest.status.mode);
    assert.ok(report.value.authSends <= latest.authSends && report.value.inferenceSends <= latest.inferenceSends);
    for (const row of report.value.transactions) assert.deepEqual(row, dispatch.get(row.signature), 'saved dispatch changed across process reports');
  }
  return {reports: checked, latest, dispatch};
}

function tokenRows(meta, names, mint) {
  const before = new Map(), after = new Map();
  for (const [rows, target] of [[meta.preTokenBalances, before], [meta.postTokenBalances, after]]) {
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok(integer(row.accountIndex) && row.accountIndex < names.length && !target.has(row.accountIndex));
      key(row.mint); key(row.owner); assert.ok(uint(row.uiTokenAmount?.amount));
      if (row.mint !== mint) continue;
      assert.equal(row.uiTokenAmount.decimals, 6);
      target.set(row.accountIndex, {amount: row.uiTokenAmount.amount, owner: row.owner});
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort((a,b)=>a-b).map(index => {
    const pre = before.get(index), post = after.get(index); if (pre && post) assert.equal(pre.owner, post.owner);
    return {address: names[index], owner: (pre ?? post).owner, mint, before_micro_usdc: pre?.amount ?? null, after_micro_usdc: post?.amount ?? null,
      delta_micro_usdc: pre && post ? (BigInt(post.amount)-BigInt(pre.amount)).toString() : null};
  });
}
export async function verifyTransactionRecord(chain, observed, receipt, manifest, expectedOwner) {
  assert.ok(chain && chain.meta && chain.meta.err === null); assert.equal(chain.slot, receipt.slot);
  assert.equal(chain.transaction?.[1], 'base64'); const encoded = chain.transaction[0]; assert.equal(typeof encoded, 'string');
  const wire = Buffer.from(encoded, 'base64'); assert.equal(wire.toString('base64'), encoded); assert.ok(wire.length <= 1232 && wire.length > 0);
  assert.equal(wire.length, observed.bytes); assert.equal(hash(wire), observed.wireSha256, 'recorded exact signed bytes differ from chain');
  const tx = getTransactionDecoder().decode(wire); const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes); assert.equal(message.version, 0); assert.equal((message.addressTableLookups?.length ?? 0), 0);
  assert.deepEqual(Buffer.from(getTransactionEncoder().encode(tx)), wire); await verifySignatures(tx);
  assert.equal(Object.keys(tx.signatures).length, 1); assert.equal(getSignatureFromTransaction(tx), observed.signature); assert.equal(receipt.signature, observed.signature);
  const names = message.staticAccounts; if (expectedOwner) assert.equal(names[0], expectedOwner);
  assert.ok(integer(chain.meta.fee) && chain.meta.fee > 0); assert.ok(integer(chain.meta.computeUnitsConsumed) && chain.meta.computeUnitsConsumed > 0 && chain.meta.computeUnitsConsumed <= 1_000_000);
  if (chain.meta.loadedAddresses) { assert.deepEqual(Object.keys(chain.meta.loadedAddresses).sort(), ['readonly','writable']); assert.deepEqual(chain.meta.loadedAddresses.readonly, []); assert.deepEqual(chain.meta.loadedAddresses.writable, []); }
  const instructions = message.instructions; assert.ok(instructions.length >= 2 && instructions.length <= 3);
  let computeLimit = null, computePrice = '0';
  for (const instruction of instructions.slice(0,-1)) {
    assert.equal(names[instruction.programAddressIndex], COMPUTE_BUDGET_PROGRAM); assert.equal((instruction.accountIndices?.length ?? 0), 0);
    const data = Buffer.from(instruction.data);
    if (data[0] === 2) { assert.equal(data.length, 5); assert.equal(computeLimit, null); computeLimit = data.readUInt32LE(1); assert.ok(computeLimit > 0 && computeLimit <= 1_000_000); }
    else { assert.equal(data[0], 3); assert.equal(data.length, 9); assert.equal(computePrice, '0'); computePrice = data.readBigUInt64LE(1).toString(); }
  }
  assert.ok(computeLimit !== null && chain.meta.computeUnitsConsumed <= computeLimit);
  const financial = instructions.at(-1); assert.equal(names[financial.programAddressIndex], manifest.program_id);
  const bytes = Buffer.from(financial.data); let instruction;
  for (const candidate of signatureNames) if (bytes.subarray(0,8).equals(Buffer.from(await discriminator(candidate)))) instruction = candidate;
  assert.ok(instruction, 'unknown Vault instruction');
  const poolIndex = instruction === 'deposit_compact_v1' || instruction === 'finalize_escape' ? 0 : instruction === 'execute_payload' ? 3 : 1;
  assert.equal(names[financial.accountIndices[poolIndex]], manifest.pool);
  if (receipt.kind === 'deposit') assert.equal(instruction, 'deposit_compact_v1');
  else assert.ok(['create_payload','append_payload','seal_payload','execute_payload'].includes(instruction));
  assert.ok(Array.isArray(chain.meta.preBalances) && Array.isArray(chain.meta.postBalances) && chain.meta.preBalances.length === names.length && chain.meta.postBalances.length === names.length);
  for (const amount of [...chain.meta.preBalances, ...chain.meta.postBalances]) assert.ok(integer(amount));
  const report = {signature: observed.signature, slot: chain.slot, kind: receipt.kind, instruction, fee_payer: names[0],
    block_time: chain.blockTime, wire_sha256: hash(wire), message_sha256: hash(tx.messageBytes), wire_bytes: wire.length,
    fee_lamports: chain.meta.fee, compute_units: chain.meta.computeUnitsConsumed, requested_compute_units: computeLimit,
    priority_fee_micro_lamports: computePrice, fee_payer_lamport_delta: String(chain.meta.postBalances[0] - chain.meta.preBalances[0]),
    token_balances: tokenRows(chain.meta,names,manifest.mint), exact_recorded_wire_matches: true, signatures_verified: true};
  Object.defineProperty(report, 'instructionDetail', {value: {data: bytes, accounts: financial.accountIndices.map(index=>names[index])}});
  return report;
}

/** Reconstruct public instruction payloads independently of the SDK result labels. */
export function verifyLifecycleInstructions(transactions) {
  assert.equal(transactions[0]?.instruction, 'deposit_compact_v1');
  const deposit=transactions[0].instructionDetail, compact=deposit.data.subarray(8);
  assert.equal(compact.length,436);assert.equal(deposit.accounts.length,19);
  const noteId=compact.readUInt32LE(0),depositAmount=compact.readBigUInt64LE(76),expiry=compact.readBigUInt64LE(36);
  assert.ok(depositAmount>0n);
  const withdrawal=transactions.slice(1);assert.ok(withdrawal.length>=4);
  assert.equal(withdrawal[0].instruction,'create_payload');assert.equal(withdrawal.at(-2).instruction,'seal_payload');assert.equal(withdrawal.at(-1).instruction,'execute_payload');
  assert.ok(withdrawal.slice(1,-2).every(tx=>tx.instruction==='append_payload'));
  const create=withdrawal[0].instructionDetail;assert.equal(create.data.length,85);assert.equal(create.data[8],1,'buffer operation must be mutual_close');
  assert.equal(create.data.readUInt32LE(9),1312);const digest=create.data.subarray(13,45).toString('hex'),buffer=create.accounts[0];
  const chunks=[];let offset=0;
  for(const tx of withdrawal.slice(1,-2)){
    const part=tx.instructionDetail;assert.equal(part.accounts[0],buffer);assert.equal(part.data.readUInt32LE(8),offset);
    const size=part.data.readUInt32LE(12);assert.ok(size>0);assert.equal(part.data.length,16+size);chunks.push(part.data.subarray(16));offset+=size;
  }
  const payload=Buffer.concat(chunks);assert.equal(payload.length,1312);assert.equal(hash(payload),digest);
  const seal=withdrawal.at(-2).instructionDetail,execute=withdrawal.at(-1).instructionDetail;
  assert.equal(seal.accounts[0],buffer);assert.equal(seal.data.length,8);assert.equal(execute.accounts[0],buffer);assert.equal(execute.data.length,40);assert.equal(execute.data.subarray(8).toString('hex'),digest);
  assert.equal(execute.accounts.length,21);
  const field=index=>BigInt('0x'+payload.subarray(index*32,(index+1)*32).toString('hex'));
  assert.equal(field(8),BigInt(noteId));assert.equal(BigInt('0x'+payload.subarray(800,832).toString('hex')),BigInt(noteId));
  const returned=field(9);assert.ok(returned<=depositAmount);
  assert.equal(deposit.accounts[2],execute.accounts[5]);assert.equal(deposit.accounts[8],execute.accounts[11]);
  assert.equal(deposit.accounts[13],transactions[0].fee_payer);assert.equal(execute.accounts[12],transactions[0].fee_payer);
  return {note_id:noteId,note_account:deposit.accounts[2],source_token_account:deposit.accounts[7],vault_token_account:deposit.accounts[8],
    destination_owner:execute.accounts[12],destination_token_account:execute.accounts[13],treasury_owner:execute.accounts[14],treasury_token_account:execute.accounts[15],
    deposit_micro_usdc:depositAmount.toString(),withdrawal_payload_return_micro_usdc:returned.toString(),deposit_minus_return_micro_usdc:(depositAmount-returned).toString(),
    expiry:expiry.toString(),registration_commitment:compact.subarray(44,76).toString('hex'),withdrawal_buffer:buffer,withdrawal_payload_sha256:digest};
}

export function decodeTokenAccount(account, mint, owner) {
  assert.ok(account && account.executable === false && account.owner === TOKEN_PROGRAM && account.data?.[1] === 'base64');
  const raw = Buffer.from(account.data[0], 'base64'); assert.equal(raw.toString('base64'), account.data[0]); assert.equal(raw.length, 165);
  assert.deepEqual(raw.subarray(0,32), keyBytes(key(mint))); assert.deepEqual(raw.subarray(32,64), keyBytes(key(owner))); assert.equal(raw[108], 1);
  return raw.readBigUInt64LE(64).toString();
}
/** Match RPC token deltas to the decoded financial instruction amounts. When
 * destination and treasury are the same ATA, their two transfers are combined. */
export function verifyTokenMovements(transactions,lifecycle) {
  const amount=BigInt(lifecycle.deposit_micro_usdc),returned=BigInt(lifecycle.withdrawal_payload_return_micro_usdc);
  const expectedDeposit=new Map([[lifecycle.source_token_account,-amount],[lifecycle.vault_token_account,amount]]);
  const expectedWithdrawal=new Map([[lifecycle.vault_token_account,-amount]]);
  for(const[address,value]of [[lifecycle.destination_token_account,returned],[lifecycle.treasury_token_account,amount-returned]])expectedWithdrawal.set(address,(expectedWithdrawal.get(address)??0n)+value);
  for(const[index,tx]of transactions.entries()){
    const expected=index===0?expectedDeposit:index===transactions.length-1?expectedWithdrawal:new Map();
    const actual=new Map(tx.token_balances.map(row=>[row.address,row]));
    assert.equal(actual.size,tx.token_balances.length);
    for(const[address,want]of expected){const row=actual.get(address);assert.ok(row&&row.delta_micro_usdc!==null,'financial token delta must be present');assert.equal(BigInt(row.delta_micro_usdc),want);}
    for(const row of actual.values())assert.equal(BigInt(row.delta_micro_usdc??'0'),expected.get(row.address)??0n,'unexpected token movement');
  }
  const initial=transactions[0].token_balances.find(row=>row.address===lifecycle.source_token_account),final=transactions.at(-1).token_balances.find(row=>row.address===lifecycle.destination_token_account);
  assert.ok(initial?.before_micro_usdc!==null&&final?.after_micro_usdc!==null);
  return {instruction_amounts_match_token_deltas:true,wallet_before_deposit_micro_usdc:initial.before_micro_usdc,wallet_after_withdrawal_micro_usdc:final.after_micro_usdc,
    combined_destination_and_treasury:lifecycle.destination_token_account===lifecycle.treasury_token_account};
}
export async function collectExternalSdkDevnet({reports, manifestBytes, expectedManifestHash, read}) {
  assert.match(expectedManifestHash, /^[0-9a-f]{64}$/);
  const manifest = parseStrictJson(manifestBytes); assert.equal(await manifestDigest(manifest), expectedManifestHash); assert.equal(manifest.manifest_hash, expectedManifestHash);
  assert.equal(manifest.deployment_environment, 'devnet'); assert.equal(manifest.genesis_hash, GENESIS); assert.equal(manifest.token_program, TOKEN_PROGRAM); assert.equal(manifest.decimals, 6);
  for (const name of ['program_id','pool','mint']) key(manifest[name]);
  const {reports: checked, latest, dispatch} = validatePublicReports(reports);
  assert.equal(await read('getGenesisHash',[]), GENESIS);
  const status = await read('getSignatureStatuses',[[...dispatch.keys()],{searchTransactionHistory:true}]);
  assert.ok(integer(status.context?.slot) && Array.isArray(status.value) && status.value.length === dispatch.size);
  const receipts = new Map(latest.finalized.map(row => [row.signature,row]));
  for (const [index, row] of status.value.entries()) { assert.ok(row && row.err === null && row.confirmationStatus === 'finalized'); assert.equal(row.slot,receipts.get([...dispatch.keys()][index]).slot); }
  const transactions = []; let owner;
  for (const row of latest.transactions) {
    const chain = await read('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);
    const verified = await verifyTransactionRecord(chain,row,receipts.get(row.signature),manifest,owner); owner ??= verified.fee_payer; transactions.push(verified);
  }
  const lifecycle=verifyLifecycleInstructions(transactions);
  const tokenMovement=verifyTokenMovements(transactions,lifecycle);
  const addresses = await vaultAccounts({programId:key(manifest.program_id),pool:key(manifest.pool),mint:key(manifest.mint),noteId:lifecycle.note_id,payer:key(owner),tokenOwner:key(owner),operation:'deposit'});
  assert.equal(lifecycle.note_account,addresses.note);assert.equal(lifecycle.source_token_account,addresses.source);assert.equal(lifecycle.destination_token_account,addresses.source);assert.equal(lifecycle.vault_token_account,addresses.vault);
  const lastSlot = Math.max(...transactions.map(tx=>tx.slot));
  const cut = await read('getMultipleAccounts',[[addresses.source,addresses.vault,manifest.pool,addresses.note],{encoding:'base64',commitment:'finalized',minContextSlot:lastSlot}]);
  assert.ok(integer(cut.context?.slot) && cut.context.slot >= lastSlot && Array.isArray(cut.value) && cut.value.length === 4);
  const wallet = decodeTokenAccount(cut.value[0],manifest.mint,owner), vault = decodeTokenAccount(cut.value[1],manifest.mint,addresses.vaultAuthority);
  assert.equal(vault,'0','closed lifecycle must leave this dedicated Vault empty');
  const pool = cut.value[2]; assert.ok(pool && !pool.executable && pool.owner===manifest.program_id && pool.data?.[1]==='base64');
  const poolBytes=Buffer.from(pool.data[0],'base64'); assert.equal(poolBytes.toString('base64'),pool.data[0]); assert.equal(poolBytes.length,422); assert.equal(poolBytes[8],2);
  assert.deepEqual(poolBytes.subarray(0,8),Buffer.from(await discriminator('PoolConfig','account')));
  assert.deepEqual(poolBytes.subarray(10,42),keyBytes(key(GENESIS))); assert.deepEqual(poolBytes.subarray(42,74),keyBytes(key(manifest.mint))); assert.deepEqual(poolBytes.subarray(74,106),keyBytes(TOKEN_PROGRAM)); assert.equal(poolBytes[106],6);
  const treasuryOwner=getAddressDecoder().decode(poolBytes.subarray(171,203));assert.equal(lifecycle.treasury_owner,treasuryOwner);
  const note=cut.value[3];assert.ok(note&&!note.executable&&note.owner===manifest.program_id&&note.data?.[1]==='base64');
  const noteBytes=Buffer.from(note.data[0],'base64');assert.equal(noteBytes.toString('base64'),note.data[0]);assert.equal(noteBytes.length,63);assert.equal(noteBytes[8],2);
  assert.deepEqual(noteBytes.subarray(0,8),Buffer.from(await discriminator('Note','account')));assert.equal(noteBytes.readUInt32LE(10),lifecycle.note_id);assert.equal(noteBytes[62],3);
  assert.equal(noteBytes.subarray(14,46).toString('hex'),lifecycle.registration_commitment);assert.equal(noteBytes.readBigUInt64LE(46).toString(),lifecycle.deposit_micro_usdc);assert.equal(noteBytes.readBigUInt64LE(54).toString(),lifecycle.expiry);
  const block=await read('getBlock',[cut.context.slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:1}]);
  assert.ok(block&&integer(block.blockHeight)); key(block.blockhash);
  return {schema:1,passed:true,observed_at_utc:new Date().toISOString(),scope:'Independent read-only finalized transaction and token balance verification; not provider billing verification',
    source_reports:checked.map(({name,sha256,value})=>({name,sha256,command:value.command,completed_at:value.completedAt,failed:value.failed===true})),
    manifest_sha256:hash(manifestBytes),manifest_hash:expectedManifestHash,program:manifest.program_id,pool:manifest.pool,mint:manifest.mint,note_id:latest.status.noteId,
    lifecycle,token_movement:tokenMovement,transactions,finalized_count:transactions.length,max_compute_units:Math.max(...transactions.map(tx=>tx.compute_units)),max_wire_bytes:Math.max(...transactions.map(tx=>tx.wire_bytes)),
    finalized_fee_lamports:transactions.reduce((sum,tx)=>sum+tx.fee_lamports,0),recorded_unique_transaction_dispatches:dispatch.size,
    sdk_reported_auth_sends:latest.authSends,sdk_reported_inference_sends:latest.inferenceSends,sdk_reported_inference_replays:latest.inferenceReplays??null,
    sdk_reported_automatic_transaction_resends:latest.automaticTransactionResends??null,network_send_counts_independently_observable:false,
    finalized_balance_cut:{slot:cut.context.slot,blockhash:block.blockhash,block_height:block.blockHeight,wallet_owner:owner,wallet_token_account:addresses.source,
      vault_token_account:addresses.vault,vault_authority:addresses.vaultAuthority,treasury_owner:treasuryOwner,note_account:addresses.note,note_status:'closed',wallet_micro_usdc:wallet,vault_micro_usdc:vault,wallet_owner_is_treasury_owner:owner===treasuryOwner},
    balance_note:'When wallet owner also owns treasury, its token balance includes returned principal and treasury transfers. This does not erase the separately SDK-verified provider charge.',
    provider_packets_verified:false,provider_charge_signature_reverified:false,proof_reverified_off_chain:false,phantom_verified:false,full_i10:false,release_gates_passed:[]};
}

async function main() {
  const names=['--results-dir','--manifest','--manifest-hash','--host','--output']; const args=process.argv.slice(2), options=new Map();
  assert.equal(args.length,names.length*2);
  for(let i=0;i<args.length;i+=2){assert.ok(names.includes(args[i])&&!options.has(args[i])&&args[i+1]);options.set(args[i],args[i+1]);}
  const directory=resolve(options.get('--results-dir')),reports=[];
  // Intentionally one directory level: never enter journal/, configuration, custody or wallet files.
  for(const name of (await readdir(directory)).sort())if(/^[a-z0-9][a-z0-9-]*-result\.json$/.test(name)){
    const raw=await publicBytes(join(directory,name));reports.push({name,value:parseStrictJson(raw),sha256:hash(raw)});
  }
  const manifestBytes=await publicBytes(resolve(options.get('--manifest')));
  const result=await collectExternalSdkDevnet({reports,manifestBytes,expectedManifestHash:options.get('--manifest-hash'),read:publicRpc(options.get('--host'))});
  await writeFile(resolve(options.get('--output')),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o644});
  console.log(JSON.stringify({passed:result.passed,finalized_count:result.finalized_count,max_wire_bytes:result.max_wire_bytes,max_compute_units:result.max_compute_units,finalized_fee_lamports:result.finalized_fee_lamports,balance_cut:result.finalized_balance_cut}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Independent read-only collection did not complete; no success report written.');process.exitCode=1;});
