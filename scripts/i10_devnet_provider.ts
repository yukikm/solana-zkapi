/** Devnet provider campaign coordinator. Wallet creation/withdrawal remain in
 * WalletClient and the caller; this module only reuses its imported note. */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, open, readFile, rename} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {address,type Rpc,type SolanaRpcApi} from '@solana/kit';
import {decodeRpcAccount,safeRpcNumber} from '../packages/sdk/src/solana-rpc.ts';
import {ControlClient, verifiedClientContext, type ClientOptions, type NoteJournal, type Tariff, type VerificationContext, type SessionVerifier} from '../packages/sdk/src/control.ts';
import {NativeSessionVerifier} from '../packages/sdk/src/control-node.ts';
import type {EncryptedJournal} from '../packages/sdk/src/journal.ts';
import type {NoteProver} from '../packages/sdk/src/prover.ts';
import {jcsBytes, parseStrictJson, type ArtifactBundle, type VerifiedManifest} from '../packages/sdk/src/trust.ts';
import type {WalletChain} from '../packages/sdk/src/wallet-chain.ts';
import {ProviderAcceptanceFailure, providerAcceptanceBody, runProviderAcceptanceCase,
  type ProviderAcceptanceCase} from './provider_acceptance_client.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b)));
function requireTrue(value: unknown): asserts value { if (!value) throw new ProviderAcceptanceFailure(); }
type CaseReport = Awaited<ReturnType<typeof runProviderAcceptanceCase>>;
interface Plan {schema: 1; campaign_id: string; budget_micro_usdc: string; models: {profile: unknown; tariff: Tariff; sources: unknown[]}[]; cases: ProviderAcceptanceCase[]}
interface BudgetStatus {identity: {schema: number; campaign_id: string; plan_sha256: string; budget_micro_usdc: string};
  reservations: {case_id: string; max_cost_micro_usdc: string; state: string}[]}

function object(value: unknown): Record<string, unknown> {
  requireTrue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exactFields(value: Record<string, unknown>, fields: string[]) {
  requireTrue(same(Object.keys(value).sort(), [...fields].sort()));
}
function credentialReference(value: unknown) {
  requireTrue(typeof value === 'string' && isAbsolute(value));
}
function publicHttps(value: unknown): string {
  requireTrue(typeof value === 'string');
  let url: URL; try { url = new URL(value); } catch { throw new ProviderAcceptanceFailure(); }
  requireTrue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  return value;
}
/** An immutable execution subset never changes the global parent plan/budget. */
export function validateProviderSelection(plan: Plan, value: unknown, profileName: string): Pick<Plan, 'models' | 'cases'> {
  const selection = object(value);
  exactFields(selection, ['schema', 'parent_plan_sha256', 'role', 'profile', 'case_ids']);
  requireTrue(selection.schema === 1 && selection.parent_plan_sha256 === sha(jcsBytes(plan))
    && selection.profile === profileName && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileName)
    && typeof selection.role === 'string' && ['openai', 'anthropic', 'openrouter', 'direct_oa', 'direct_openrouter'].includes(selection.role)
    && Array.isArray(selection.case_ids) && selection.case_ids.length > 0
    && selection.case_ids.every(id => typeof id === 'string') && new Set(selection.case_ids).size === selection.case_ids.length);
  const ids = selection.case_ids;
  const cases = plan.cases.filter(c => (c.mode === 'proxy' ? c.provider : c.mode) === selection.role && ids.includes(c.id));
  requireTrue(same(ids, cases.map(c => c.id)));
  const models = plan.models.filter(m => cases.some(c => m.tariff.provider === c.provider
    && m.tariff.model === (c.mode === 'proxy' ? c.model : '*')));
  requireTrue(models.length > 0);
  return {models, cases};
}
/** Pure check after Python has validated the plan and before RPC/AUTH/reserve.
 * Match prepare()'s selected-provider projection, including every model profile
 * for a selected provider. Array ordering is immaterial; duplicates are not.
 * Never let an edited runtime context/output/cache profile undercut the budget
 * calculated from the public plan. Native config validation still checks files.
 */
export function validatePreparedProviderConfig(plan: Pick<Plan, 'models' | 'cases'>, prepared: unknown):
  Pick<ClientOptions, 'directProviderBases' | 'oaVerifier'> {
  const providers = object(prepared); exactFields(providers, ['direct', 'proxy']);
  requireTrue(Array.isArray(providers.proxy) && Array.isArray(providers.direct));
  const proxyNames = new Set(plan.cases.filter(c => c.mode === 'proxy').map(c => c.provider));
  const directNames = new Set(plan.cases.filter(c => c.mode !== 'proxy').map(c => c.provider));
  requireTrue(providers.proxy.length === proxyNames.size && providers.direct.length === directNames.size);
  const canonicalProfiles = (profiles: unknown[]) => profiles.map(p => Buffer.from(jcsBytes(p)).toString('utf8')).sort();
  for (const value of providers.proxy) {
    const config = object(value); exactFields(config, ['provider', 'credential_file', 'local_test_base', 'models']);
    requireTrue(typeof config.provider === 'string' && ['openai', 'anthropic', 'openrouter'].includes(config.provider)
      && proxyNames.delete(config.provider as ProviderAcceptanceCase['provider']) && config.local_test_base === null
      && Array.isArray(config.models));
    credentialReference(config.credential_file);
    const expected = plan.models.filter(m => m.profile !== null && object(m.profile).provider === config.provider).map(m => m.profile);
    requireTrue(expected.length > 0 && same(canonicalProfiles(config.models), canonicalProfiles(expected)));
  }
  const bases: Partial<Record<'direct_oa' | 'direct_openrouter', string>> = {};
  let oaVerifier: ClientOptions['oaVerifier'];
  for (const value of providers.direct) {
    const config = object(value);
    requireTrue((config.provider === 'oa' || config.provider === 'openrouter') && directNames.delete(config.provider));
    credentialReference(config.credential_file);
    if (config.provider === 'openrouter') {
      exactFields(config, ['provider', 'api_base', 'inference_base', 'credential_file', 'settlement_grace_seconds']);
      requireTrue(config.api_base === 'https://openrouter.ai/api/v1' && config.inference_base === config.api_base
        && config.settlement_grace_seconds === 60);
      bases.direct_openrouter = config.inference_base as string;
    } else {
      exactFields(config, ['provider', 'issuer_base', 'verifier_base', 'inference_base', 'station_id', 'credential_file']);
      publicHttps(config.issuer_base);
      requireTrue(typeof config.station_id === 'string' && /^[\x20-\x7e]{1,128}$/.test(config.station_id));
      bases.direct_oa = publicHttps(config.inference_base);
      const base = publicHttps(config.verifier_base);
      requireTrue(new URL(base).href.replace(/\/$/, '') === base && !base.includes('?') && !base.includes('#'));
      oaVerifier = {base, stationId: config.station_id};
    }
  }
  requireTrue(proxyNames.size === 0 && directNames.size === 0);
  // This is the independently installed provider profile, never key-response
  // metadata. Preserve the verifier and station pins in both SDK instances.
  return {directProviderBases: bases, ...(oaVerifier ? {oaVerifier} : {})};
}
export interface DevnetProviderContext {
  manifest: VerifiedManifest;
  artifacts: ArtifactBundle;
  prover: NoteProver;
  journal: EncryptedJournal<NoteJournal>;
  chain: WalletChain;
  connection: Rpc<SolanaRpcApi>;
  pinnedFetch: typeof fetch;
  verifier: {path: string; sha256: string};
  planPath: string;
  stateDir: string;
  /** Optional immutable stateDir/configurations/<profile>; budget stays stateDir. */
  configurationDir?: string;
  runDirectory: string;
  noteId?: string;
}

async function privatePath(path: string, directory = false) {
  const info = await lstat(path);
  requireTrue((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
    && info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
}
async function readJson(path: string, privateFile = true): Promise<unknown> {
  if (privateFile) await privatePath(path);
  const data = await readFile(path); requireTrue(data.length <= 1_048_576);
  return parseStrictJson(data);
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;
  }
}
async function durable(path: string, value: unknown) {
  if (await exists(path)) { requireTrue(same(await readJson(path), value)); return; }
  const file = await open(path + '.pending', 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(path + '.pending', path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
/** Optional typed rows are explicit new demo operations, never acceptance-case
 * passes. Legacy reservation rows retain their exact three-field shape. */
export function demoBudgetTemplate(value: Record<string, unknown>): string | null {
  if (value.kind === undefined) {
    exactFields(value, ['case_id', 'max_cost_micro_usdc', 'state']);
    return null;
  }
  exactFields(value, ['case_id', 'kind', 'template_case_id', 'request_id', 'operation_id', 'max_cost_micro_usdc', 'state']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  requireTrue(value.kind === 'explicit_demo' && value.template_case_id === 'openai-chat-plain'
    && typeof value.request_id === 'string' && uuid.test(value.request_id)
    && typeof value.operation_id === 'string' && uuid.test(value.operation_id)
    && value.case_id === 'demo-' + value.operation_id);
  return value.template_case_id;
}
function validateBudgetSnapshot(value: unknown) {
  const budget = object(value);
  exactFields(budget, ['identity', 'reserved_micro_usdc', 'remaining_micro_usdc', 'reservations', 'refunds_supported', 'inference_replays_supported']);
  const identity = object(budget.identity);
  exactFields(identity, ['schema', 'campaign_id', 'plan_sha256', 'budget_micro_usdc', 'max_requests']);
  const units = (value: unknown) => {
    requireTrue(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,7})$/.test(value) && BigInt(value) <= 10_000_000n);
    return BigInt(value);
  };
  const cap = units(identity.budget_micro_usdc);
  requireTrue(identity.schema === 1 && typeof identity.campaign_id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.campaign_id)
    && typeof identity.plan_sha256 === 'string' && /^[0-9a-f]{64}$/.test(identity.plan_sha256) && cap > 0n
    && Number.isSafeInteger(identity.max_requests) && Number(identity.max_requests) > 0 && Number(identity.max_requests) <= 1000
    && budget.refunds_supported === false && budget.inference_replays_supported === false && Array.isArray(budget.reservations)
    && budget.reservations.length <= Number(identity.max_requests));
  const seen = new Set<string>(), demoSessions = new Set<string>(); let total = 0n;
  const reservations = budget.reservations.map(value => {
    const entry = object(value), template = demoBudgetTemplate(entry);
    if (template) { requireTrue(!demoSessions.has(entry.request_id as string)); demoSessions.add(entry.request_id as string); }
    const amount = units(entry.max_cost_micro_usdc);
    requireTrue(typeof entry.case_id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.case_id)
      && !seen.has(entry.case_id) && entry.state === 'reserved_no_automatic_replay' && amount > 0n);
    seen.add(entry.case_id); total += amount;
    return entry;
  });
  requireTrue(total <= cap && units(budget.reserved_micro_usdc) === total && units(budget.remaining_micro_usdc) === cap - total);
  return {identity, reservations};
}

/** A completed profile records the global budget at completion. Later profiles
 * may append reservations; preserve the original report's exact bytes and
 * snapshot after revalidating all case histories above. No refund or replay. */
export async function retainCompletedProviderReport<T extends {budget: unknown; cases: {case_id: string; reserved_micro_usdc: string}[]}>(path: string, current: T): Promise<T> {
  const latest = validateBudgetSnapshot(current.budget);
  const previous = await exists(path) ? object(await readJson(path)) : undefined;
  const saved = previous ? validateBudgetSnapshot(previous.budget) : latest;
  if (previous) {
    const {budget: _oldBudget, ...oldFields} = previous;
    const {budget: _newBudget, ...newFields} = current;
    requireTrue(same(oldFields, newFields) && same(saved.identity, latest.identity)
      && saved.reservations.length <= latest.reservations.length
      && same(saved.reservations, latest.reservations.slice(0, saved.reservations.length)));
  }
  for (const report of current.cases) requireTrue(saved.reservations.some(entry => entry.case_id === report.case_id
    && entry.kind === undefined && entry.max_cost_micro_usdc === report.reserved_micro_usdc));
  if (previous) return previous as T;
  await durable(path, current); return current;
}
/** Static diagnostic only, never an exception string, provider body or token.
 * This checkpoint is evidence of failure, not authority to replay/refund. */
export async function saveProviderFailureDiagnostic(path: string, caseId: string, planHash: string, error: ProviderAcceptanceFailure) {
  requireTrue(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(caseId) && /^[0-9a-f]{64}$/.test(planHash) && error.diagnostic);
  const d = object(error.diagnostic);
  exactFields(d, ['schema', 'stage', 'elapsed_ms', 'control_http_status', 'inference', 'settlement', 'inference_replays']);
  const elapsed = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
  const status = (value: unknown) => value === null || Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
  requireTrue(d.schema === 1 && d.inference_replays === 0 && elapsed(d.elapsed_ms) && status(d.control_http_status)
    && typeof d.stage === 'string' && ['preflight', 'snapshot', 'quote', 'proof', 'reserve', 'authorize', 'inference', 'close', 'settlement', 'acceptance'].includes(d.stage)
    && typeof d.settlement === 'string' && ['not_started', 'unresolved', 'completed'].includes(d.settlement));
  if (d.inference !== null) {
    const i = object(d.inference);
    exactFields(i, ['stage', 'elapsed_ms', 'http_status', 'service_error_code', 'response_bytes', 'sdk_send_invoked']);
    requireTrue(typeof i.stage === 'string' && ['prepare', 'send', 'response_status', 'response_read', 'response_limit', 'response_decode', 'response_validate', 'complete'].includes(i.stage)
      && elapsed(i.elapsed_ms) && status(i.http_status) && typeof i.sdk_send_invoked === 'boolean'
      && Number.isSafeInteger(i.response_bytes) && Number(i.response_bytes) >= 0 && Number(i.response_bytes) <= 8 * 1024 * 1024
      && (i.service_error_code === null || typeof i.service_error_code === 'string' && ['provider_unavailable', 'operation_unavailable', 'operation_in_progress', 'response_not_replayable',
        'idempotency_conflict', 'rate_limited', 'invalid_request', 'invalid_credential', 'adapter_unavailable', 'other'].includes(i.service_error_code)));
  }
  await durable(path, {schema: 1, passed: false, scope: 'sanitized SDK provider-case failure checkpoint; no replay or refund authority',
    case_id: caseId, plan_sha256: planHash, diagnostic: d, full_g3_passed: false});
}
async function coordinator(command: 'budget-status' | 'reserve', plan: string, state: string, caseId?: string): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
  // No .env loading, key values, URLs, wallet keys, Node/preload/proxy flags, or
  // Python import-path override are passed to the budget-only subprocess.
  const args = [join(ROOT, 'scripts/provider_acceptance.py'), command, '--plan', plan, '--state-dir', state];
  if (caseId) args.push('--case', caseId);
  try {
    const result = await execute('python3', args, {cwd: ROOT, env, timeout: 30_000, maxBuffer: 1_048_576});
    return parseStrictJson(Buffer.from(result.stdout));
  } catch { throw new ProviderAcceptanceFailure(); }
}

/** A saved success is not sufficient by itself: bind exact plan/case/body,
 * immutable budget reservation, actual SDK history, receipt and successor. */
export async function validateCompletedProviderCase(report: CaseReport, testCase: ProviderAcceptanceCase,
  planHash: string, note: NoteJournal, budget: BudgetStatus, context: VerificationContext, verifier: SessionVerifier, tariff: Tariff) {
  requireTrue(report.schema === 1 && report.passed === true && report.case_id === testCase.id && report.plan_sha256 === planHash
    && report.mode === testCase.mode && report.provider === testCase.provider && report.model === testCase.model
    && report.stream === testCase.stream && report.tools === testCase.tools && report.inference_sends === 1
    && report.inference_replays === 0 && report.full_g3_passed === false
    && report.reserved_micro_usdc === testCase.max_cost_micro_usdc
    && budget.identity.plan_sha256 === planHash && report.tariff_hash === tariff.tariff_hash
    && BigInt(report.charged_micro_usdc) <= BigInt(testCase.max_cost_micro_usdc));
  requireTrue(budget.reservations.filter(r => r.case_id === testCase.id && r.max_cost_micro_usdc === testCase.max_cost_micro_usdc
    && r.state === 'reserved_no_automatic_replay').length === 1);
  const indexes = note.history.flatMap((history, index) => history.prepared.request.authorization.request_id === report.request_id ? [index] : []);
  requireTrue(indexes.length === 1);
  const index = indexes[0], h = note.history[index], authorization = h.prepared.request.authorization;
  requireTrue(authorization.mode === testCase.mode && h.prepared.tariff.provider === testCase.provider
    && h.prepared.tariff.model === (testCase.mode === 'proxy' ? testCase.model : '*') && same(h.prepared.tariff, tariff)
    && h.operations.length === 1 && h.operations[0].id === report.operation_id
    && h.operations[0].path === report.endpoint && report.endpoint === ({chat_completions: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages'}[testCase.endpoint])
    && h.operations[0].bodyBase64 === Buffer.from(providerAcceptanceBody(testCase)).toString('base64')
    && h.operations[0].phase === 'send_unknown'
    && h.receipts.length === 1 && h.receipts[0].body.receipt_id === report.receipt_id
    && h.receipts[0].receipt_hash === report.receipt_hash
    && h.receipts[0].body.evidence_kind === report.evidence_kind && h.receipts[0].body.reason === 'metered'
    && h.settlement.charge_micro_usdc === report.charged_micro_usdc);
  const next = await verifier.settle(context, h.previous, h.prepared, h.settlement, h.receipts,
    testCase.mode === 'proxy' ? [report.operation_id] : []);
  const savedNext = note.history[index + 1]?.previous ?? note.state;
  requireTrue(same(next, savedNext));
}

export async function runDevnetProviderAcceptance(options: DevnetProviderContext) {
  try {
    const o = {...options, planPath: resolve(options.planPath), stateDir: resolve(options.stateDir), runDirectory: resolve(options.runDirectory)};
    requireTrue(o.manifest.deployment_environment === 'devnet' && o.manifest.setup_profile === 'test_only'
      && o.manifest.genesis_hash === DEVNET && o.manifest.mint === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    await privatePath(o.stateDir, true);
    await mkdir(o.runDirectory, {recursive: true, mode: 0o700}); await privatePath(o.runDirectory, true);
    const plan = await readJson(o.planPath, false) as Plan;
    requireTrue(plan.schema === 1 && Array.isArray(plan.cases) && plan.cases.length > 0);
    const planHash = sha(jcsBytes(plan));
    let budget = await coordinator('budget-status', o.planPath, o.stateDir) as BudgetStatus;
    requireTrue(budget.identity.plan_sha256 === planHash && budget.identity.campaign_id === plan.campaign_id
      && budget.identity.budget_micro_usdc === plan.budget_micro_usdc);
    const configurationDir = resolve(o.configurationDir ?? o.stateDir);
    let selection: unknown = undefined, execution: Pick<Plan, 'models' | 'cases'> = plan;
    if (configurationDir !== o.stateDir) {
      requireTrue(dirname(configurationDir) === join(o.stateDir, 'configurations'));
      await privatePath(dirname(configurationDir), true); await privatePath(configurationDir, true);
      selection = await readJson(join(configurationDir, 'selection.json'));
      execution = validateProviderSelection(plan, selection, basename(configurationDir));
    }
    const providers = await readJson(join(configurationDir, 'providers.json'));
    const tariffs = await readJson(join(configurationDir, 'tariffs.json')) as Tariff[];
    requireTrue(same(tariffs, execution.models.map(x => x.tariff)));
    const providerOptions = validatePreparedProviderConfig(execution, providers);
    const genesis = await o.connection.getGenesisHash().send(); requireTrue(genesis === DEVNET);
    const observedPool=await o.connection.getAccountInfo(address(o.manifest.pool),{encoding:'base64',commitment:'finalized'}).send();
    const pool={context:{slot:safeRpcNumber(observedPool.context.slot)},value:decodeRpcAccount(observedPool.value)};requireTrue(pool.value);
    const context = await verifiedClientContext(o.manifest, genesis, {address: o.manifest.pool, owner: pool.value.owner,
      executable: pool.value.executable, lamports: BigInt(pool.value.lamports), data: pool.value.data,
      slot: BigInt(pool.context.slot), commitment: 'finalized'}, 0n, o.artifacts);
    const verifier = new NativeSessionVerifier(o.verifier.path, o.verifier.sha256);
    const client = new ControlClient({context, journal: o.journal, verifier, fetch: o.pinnedFetch, ...providerOptions});
    const noteId = o.noteId ?? 'note';
    const sourceHashes: Record<string, string> = {};
    for (const name of ['scripts/provider_acceptance.py', 'scripts/provider_acceptance_client.ts', 'scripts/i10_devnet_provider.ts']) {
      sourceHashes[name] = sha(await readFile(join(ROOT, name)));
    }
    const identityPath = join(o.runDirectory, 'provider-campaign.json');
    const identity = {schema: 1, plan_sha256: planHash, campaign_id: plan.campaign_id, manifest_hash: o.manifest.manifest_hash,
      deployment_id: o.manifest.deployment_id, pool: o.manifest.pool, note_id: noteId,
      provider_configuration_sha256: sha(await readFile(join(configurationDir, 'providers.json'))),
      ...(selection ? {selection} : {}), source_sha256: sourceHashes};
    await durable(identityPath, identity);
    const reports: CaseReport[] = [];
    for (const testCase of execution.cases) {
      providerAcceptanceBody(testCase);
      const path = join(o.runDirectory, `provider-case-${testCase.id}.json`);
      budget = await coordinator('budget-status', o.planPath, o.stateDir) as BudgetStatus;
      const note = (await o.journal.read(noteId))?.value; requireTrue(note);
      const tariff = tariffs.find(t => t.provider === testCase.provider && t.model === (testCase.mode === 'proxy' ? testCase.model : '*'));
      requireTrue(tariff);
      if (await exists(path)) {
        const report = await readJson(path) as CaseReport;
        await validateCompletedProviderCase(report, testCase, planHash, note, budget, context, verifier, tariff);
        reports.push(report); continue;
      }
      // Reserved but unreported is an uncertainty, even if the process exited
      // before AUTH. Never silently consume a new case or recreate its intent.
      requireTrue(!budget.reservations.some(r => r.case_id === testCase.id));
      let report: CaseReport;
      try { report = await runProviderAcceptanceCase({client, journal: o.journal, prover: o.prover, chain: o.chain,
        noteId, tariff, testCase, async reserve(c) {
          requireTrue(same(c, testCase));
          const result = await coordinator('reserve', o.planPath, o.stateDir, c.id) as {case_id: string; reserved_micro_usdc: string; plan_sha256: string; send_authorized_once: true};
          requireTrue(result.plan_sha256 === planHash); return result;
        }}); } catch (error) {
        if (error instanceof ProviderAcceptanceFailure && error.diagnostic) {
          await saveProviderFailureDiagnostic(join(o.runDirectory, `provider-case-${testCase.id}-failure.json`), testCase.id, planHash, error);
        }
        throw error;
      }
      await durable(path, report);
      reports.push(report);
    }
    const result = {schema: 1, passed: true, scope: 'selected real-provider cases using actual devnet SDK/control/ledger',
      plan_sha256: planHash, campaign_id: plan.campaign_id, pool: o.manifest.pool, cases: reports, ...(selection ? {selection} : {}),
      budget: await coordinator('budget-status', o.planPath, o.stateDir), source_sha256: sourceHashes,
      full_g3_passed: false, wallet_ui_verified: false};
    return await retainCompletedProviderReport(join(o.runDirectory, 'provider-acceptance-results.json'), result);
  } catch (error) { throw error instanceof ProviderAcceptanceFailure ? error : new ProviderAcceptanceFailure(); }
}
