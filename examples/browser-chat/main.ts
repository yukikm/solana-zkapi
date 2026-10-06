// Reuse the already pinned Wallet Standard package installed by the UI lockfile.
import { getWallets } from '../../scripts/i10-wallet-ui/node_modules/@wallet-standard/app/src/index.ts';
import { mountChat, type BrowserWallet } from './app.ts';
import { connectChat } from './integration.ts';
import { reviewedProfiles } from './reviewed-profiles.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('App root required');
// Wallet Standard types expose a readonly publicKey view; the SDK copies it and
// never mutates the wallet account. Preserve the actual selected account object.
mountChat(root, { profiles: reviewedProfiles, wallets: () => getWallets().get() as unknown as readonly BrowserWallet[], connect: connectChat });
