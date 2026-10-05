/** Synthetic provider/proof backend, imported only by offline test entry points. */
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {ControlClient, type NoteJournal, type PrivateState, type VerificationContext, type Quote, type Tariff, type Settlement, type Receipt} from '../../packages/sdk/src/control.ts';
import {ProverSessionVerifier} from '../../packages/sdk/src/control-prover.ts';
import type {EncryptedJournal} from '../../packages/sdk/src/journal.ts';
import {jcsBytes, sha256Hex} from '../../packages/sdk/src/trust.ts';
import type {NoteProver} from '../../packages/sdk/src/prover.ts';
import type {UiProviderOptions, UiProviderConfiguration} from './provider.ts';
const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
export const fixtureState = (): PrivateState => ({balance_micro_usdc: '1000000', balance_blinding: field(3), note_leaf: field(4), commitment: {x: field(5), y: field(6)}, anchor: field(7), state_signature: null});
export async function providerFixture(journal: EncryptedJournal<NoteJournal>, noteId: string) {
  const counts = {quotes: 0, auth: 0, inference: 0, close: 0, verification: 0, snapshots: 0};
  const behavior = {loseAuth: false, loseResponse: false, rejectSettlement: false, absentOperation: false, htmlText: false};
  const authBodies: string[] = [];
  const tariffBody: Omit<Tariff, 'tariff_hash'> = {version: '1', provider: 'openai', model: 'fixture-openai', pricing_basis: 'fixed_usage_rates', valid_from: '90', valid_until: '1000', rates: [{unit: 'input_tokens', nano_usdc_numerator: '1', unit_denominator: '1'}, {unit: 'output_tokens', nano_usdc_numerator: '1', unit_denominator: '1'}], operator_fee_micro_usdc: '0'};
  const tariff: Tariff = {...tariffBody, tariff_hash: await sha256Hex(jcsBytes(tariffBody))};
  const configuration: UiProviderConfiguration = {testCase: {id: 'openai-chat-plain', mode: 'proxy', provider: 'openai', model: tariff.model, endpoint: 'chat_completions', stream: false, tools: false, max_output_tokens: 128, max_cost_micro_usdc: '19277', session_ttl_seconds: 300}, tariff, planSha256: 'a'.repeat(64)};
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const context: VerificationContext = {deployment_id: 'fixture', pool: 'fixture', vault_binding: field(1), state_key: [field(2), field(3)], cap_micro_usdc: '1000000', control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid', quote_public_key: bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))), receipt_public_key: '00'.repeat(32), request_vk_sha256: '00'.repeat(32), tariff_hashes: [tariff.tariff_hash]};
  const settlement = (): Settlement => ({charge_micro_usdc: behavior.absentOperation ? '0' : '1', next_commitment: {x: field(5), y: field(6)}, next_anchor: field(8), blind_delta_srv: field(12), next_state_signature: {r_x: field(9), r_y: field(10), s: field(11)}});
  let closed = false;
  const receipt = (id: string): Receipt => ({body: {receipt_id: '1', operation_id: id, billing_effect: 'metered'}, receipt_hash: 'b'.repeat(64), signature: 'fixture-only'});
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/quotes')) {
      if (counts.snapshots !== counts.quotes + 1) throw Error('fixture snapshot must precede quote'); counts.quotes++;
      const body: Quote['body'] = {quote_id: crypto.randomUUID(), deployment_id: context.deployment_id, pool: context.pool, mode: 'proxy', provider: 'openai', models: [tariff.model], tariff_hash: tariff.tariff_hash, cap_micro_usdc: context.cap_micro_usdc, issued_at: '100', expires_at: '220', session_ttl_seconds: '300', max_concurrency: '4', control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin};
      const quote_hash = await sha256Hex(jcsBytes(body));
      return Response.json({body, quote_hash, signature: Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(Buffer.from(quote_hash, 'hex')))).toString('base64')});
    }
    const p = (await journal.read(noteId))!.value.pending!;
    if (url.pathname.endsWith('/sessions')) {
      counts.auth++; authBodies.push(String(init?.body));
      if (p.phase !== 'send_unknown' || p.exactRequest !== init?.body) throw Error('fixture AUTH not durable');
      if (behavior.loseAuth) throw TypeError('fixture response lost');
    }
    if (url.origin === context.inference_api_origin) {
      counts.inference++;
      if (p.operations.length !== 1 || p.operations[0].phase !== 'send_unknown'
        || new Headers(init?.headers).get('idempotency-key') !== p.operations[0].id) throw Error('fixture inference not durable');
      if (behavior.loseResponse) throw TypeError('fixture inference response lost');
      return Response.json({choices: [{message: {role: 'assistant', content: behavior.htmlText ? '<img src=x onerror="window.fixtureXss=true">' : 'ok'}, finish_reason: 'stop'}]});
    }
    if (url.pathname.includes('/operations/')) return behavior.absentOperation ? Response.json({}, {status: 404}) : Response.json({request_id: p.prepared.request.authorization.request_id, operation_id: p.operations[0].id, response_replayable: false});
    if (url.pathname.endsWith('/receipts')) return Response.json({receipts: url.search || behavior.absentOperation || p.operations.length === 0 ? [] : [receipt(p.operations[0].id)], next_cursor: url.search || behavior.absentOperation || p.operations.length === 0 ? null : '1'});
    if (url.pathname.endsWith('/close')) { counts.close++; closed = true; }
    return Response.json({request_id: p.prepared.request.authorization.request_id, mode: 'proxy', cap_micro_usdc: context.cap_micro_usdc,
      state: closed || p.phase === 'closing' ? 'SETTLED' : 'ACTIVE', ...(closed || p.phase === 'closing' ? {settlement: settlement()} : {})});
  };
  const verifier = new ProverSessionVerifier({async run(input: any) {
    if (input.command.kind === 'prepare') return {verified: true};
    counts.verification++;
    if (behavior.rejectSettlement || input.command.operations.length !== input.command.receipts.length) throw Error('fixture successor or receipt verification rejected');
    const next = input.command.settlement as Settlement;
    return {...input.command.state, balance_micro_usdc: (BigInt(input.command.state.balance_micro_usdc) - BigInt(next.charge_micro_usdc)).toString(), anchor: next.next_anchor, state_signature: next.next_state_signature};
  }});
  const prover: Pick<NoteProver, 'prepareSession'> = {async prepareSession(_w, _s, _r, _path, quote, tariff, credentials) {
    return {request: {authorization: {version: '1', deployment_id: context.deployment_id, pool: context.pool, request_id: credentials.requestId, quote_hash: quote.quote_hash, mode: 'proxy', control_secret_hash: credentials.controlHash, proxy_secret_hash: credentials.proxyHash}, quote, public_inputs: Array(12).fill(field(1)), proof: {backend: 'groth16_bn254', proof: 'fixture-not-a-proof'}}, control_token: credentials.controlToken, proxy_token: credentials.proxyToken, tariff, rerandomization: field(13)};
  }};
  const options: UiProviderOptions = {configuration, journal, client: new ControlClient({context, journal, verifier, fetch: fetcher, now: () => 150n}), prover,
    chain: {async snapshot() { counts.snapshots++; return {root: field(14), siblings: Array(32).fill(field(0)), slot: 1, sequence: '0', nextNoteId: 1, clock: '100', paused: false, treasuryOwner: 'fixture'}; }}};
  return {options, counts, behavior, authBodies};
}
