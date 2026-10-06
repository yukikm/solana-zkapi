import type { ReviewedChatProfile } from './load-deployment.ts';

/** Install reviewed public configuration here and rebuild. Keep trust/WASM pins
 * independent of downloaded assets. Never put provider or private RPC keys here.
 * Empty deliberately: this repository does not imply a current hosted deployment.
 * Use one entry per explicit privacy mode, with the matching model tariffs. */
export const reviewedProfiles: readonly ReviewedChatProfile[] = [];
