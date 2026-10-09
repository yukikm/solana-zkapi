/** Local, detached guidance. These reports never authorize migration or a send. */
import type { Mode } from './control.ts';

export function privacyProfile(mode: Mode, keyReuseSeconds = 0) {
  if (!['proxy', 'direct_oa', 'direct_openrouter'].includes(mode)
    || !Number.isInteger(keyReuseSeconds) || keyReuseSeconds < 0 || keyReuseSeconds > 300) throw new Error('invalid privacy context');
  return {
    schema: 1 as const, mode,
    contentRecipients: mode === 'proxy' ? ['proxy_operator', 'selected_provider']
      : mode === 'direct_openrouter' ? ['openrouter', 'selected_provider'] : ['selected_provider'],
    routingPolicy: { zeroDataRetentionRequired: mode === 'direct_openrouter',
      dataCollectionDenied: mode === 'direct_openrouter', automaticPolicyDowngrade: false as const },
    network: { sourceIpProtection: 'transport_dependent' as const, anonymityGuaranteed: false as const,
      notice: 'Direct HTTPS exposes the connecting IP to contacted services. Tor depends on the installed transport; this report does not attest it.' },
    providerDeletionVerified: false as const,
    session: { keyReuseSeconds, requestsWithinLeaseMayBeLinked: mode !== 'proxy' && keyReuseSeconds > 0 },
    localRetention: { directBodyPersisted: false as const, proxyBodyUntilDispatch: mode === 'proxy',
      sentBodyFingerprintRetained: true as const, settledPurgeAvailable: true as const,
      legacyBodiesMayRemain: true as const, externalBackupsErased: false as const },
  };
}
export type PrivacyProfile = ReturnType<typeof privacyProfile>;

export interface UpgradePlan {
  schema: 1;
  assessment: 'needs_attention' | 'ready_for_separate_installation' | 'unknown';
  basis: 'local_status_only';
  inPlaceMigrationSupported: false;
  automaticActions: false;
  blockers: string[];
  nextActions: string[];
  message: string;
}
/** Accepts a saved SDK status or native /admin/status (including older versions).
 * Missing/ambiguous fields never become permission to replace custody. */
export function planClientUpgrade(status: unknown): UpgradePlan {
  const result: UpgradePlan = { schema: 1, assessment: 'unknown', basis: 'local_status_only',
    inPlaceMigrationSupported: false, automaticActions: false, blockers: [],
    nextActions: ['keep_original_runtime_profile_journal_and_keys'],
    message: 'Keep the original installation. Obtain a fresh status using its original runtime before preparing a separate installation.' };
  const unknown = () => { result.blockers.push('status_incomplete'); return result; };
  if (!status || typeof status !== 'object' || Array.isArray(status)) return unknown();
  const s = status as Record<string, unknown>;
  const native = Object.hasOwn(s, 'wallet_status');
  const wallet = native ? s.wallet_status : s.wallet;
  const balance = native ? s.balance_micro_usdc : s.settledBalanceMicroUsdc;
  const operation = native ? s.wallet_operation : s.walletOperation;
  const escape = native ? s.wallet_emergency_escape : s.emergencyEscape;
  if (!['empty', 'unfunded', 'active', 'pending_escape', 'closed'].includes(String(wallet))
    || typeof balance !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(balance)
    || !Object.hasOwn(s, native ? 'wallet_operation' : 'walletOperation')
    || !Object.hasOwn(s, native ? 'wallet_emergency_escape' : 'emergencyEscape')
    || native && (typeof s.recovery_required !== 'boolean' || !Number.isSafeInteger(s.in_flight) || Number(s.in_flight) < 0
      || typeof s.phase !== 'string' || !Array.isArray(s.unresolved_operations))
    || !native && (typeof s.busy !== 'boolean' || !Object.hasOwn(s, 'session'))) return unknown();
  const active = native ? Number(s.in_flight) > 0 : s.busy;
  if (active) { result.blockers.push('response_in_progress'); result.nextActions.push('finish_or_cancel_current_response'); }
  if (operation !== null) { result.blockers.push('wallet_operation_pending'); result.nextActions.push('recover_wallet_operation_with_original_runtime'); }
  if (escape !== null && (typeof escape !== 'object' || (escape as { phase?: unknown }).phase !== 'settled') || wallet === 'pending_escape') {
    result.blockers.push('emergency_recovery_pending'); result.nextActions.push('finish_emergency_recovery_with_original_runtime');
  }
  const session = native ? !['ready', 'unfunded', 'closed'].includes(s.phase as string)
    || s.recovery_required || (s.unresolved_operations as unknown[]).length > 0 : s.session !== null;
  if (session) { result.blockers.push('session_recovery_pending'); result.nextActions.push('inspect_and_settle_saved_session_with_original_runtime'); }
  // An active zero-balance note still requires its original withdrawal/closure.
  if (wallet === 'active' || wallet === 'pending_escape' || wallet !== 'closed' && BigInt(balance) > 0n) {
    result.blockers.push('existing_note_not_closed'); result.nextActions.push('close_or_withdraw_existing_note_with_original_runtime');
  }
  result.assessment = result.blockers.length ? 'needs_attention' : 'ready_for_separate_installation';
  if (!result.blockers.length) result.nextActions.push('verify_new_release_and_profile', 'install_in_new_directory_with_new_custody');
  result.message = result.blockers.length
    ? 'Finish the listed operations using the original installation. Never replay an uncertain inference or replace its journal/profile.'
    : 'The supplied local status has no pending funds or operations. Verify the new release and profile and use a new directory; keep the original recovery material.';
  return result;
}
