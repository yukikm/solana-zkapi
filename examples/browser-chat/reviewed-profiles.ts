import type { ReviewedChatProfile } from './load-deployment.ts';

/** Replaced only by build.mjs after validating the explicitly pinned public JSON.
 * No runtime URL, downloaded config or query parameter can install trust pins. */
declare const __ZKAPI_INSTALLED_PROFILES__: readonly ReviewedChatProfile[];
/** The default build deliberately has no deployment or automatic network effects. */
export const reviewedProfiles: readonly ReviewedChatProfile[] =
  typeof __ZKAPI_INSTALLED_PROFILES__ === 'undefined' ? [] : __ZKAPI_INSTALLED_PROFILES__;
