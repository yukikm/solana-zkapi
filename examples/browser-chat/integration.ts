/** Framework-neutral integration, called only from explicit application actions. */
import { Buffer } from 'buffer';
import { createBrowserClient, walletStandardAdapter, type StandardWallet, type StandardAccount } from '@zkapi/solana-sdk/browser';
import { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';
import type { ChatRequest, ZkApiClient } from '@zkapi/solana-sdk';
import { loadDeployment, type ReviewedBrowserProfile } from './load-deployment.ts';

export async function connectChat(options: {
  profile: ReviewedBrowserProfile;
  wallet: StandardWallet;
  account: StandardAccount;
  chain: string;
  storageName: string;
  noteId: string;
  initializeStorage?: boolean;
}) {
  // Browser web3 consumers need the same pinned Buffer polyfill as the SDK.
  Object.assign(globalThis, { Buffer });
  const deployment = await loadDeployment(options.profile);
  return createBrowserClient({ ...deployment, wallet: walletStandardAdapter(options.wallet, options.account, options.chain),
    storageName: options.storageName, noteId: options.noteId, initializeStorage: options.initializeStorage,
    mode: 'proxy', // show the proxy privacy notice before the user chooses this integration
    createWorker: () => new Worker('/zkapi/worker.js', { type: 'module' }), priorityFeeMicroLamports: 1n });
}

/** Call once for a user-created operation ID. There is intentionally no retry loop. */
export async function sendText(client: ZkApiClient, request: ChatRequest) {
  const response = await client.chat({ ...request, stream: false });
  const text = await readChatText(response);
  return { text, status: await client.status() };
}
export async function sendStreamingText(client: ZkApiClient, request: ChatRequest, append: (text: string) => void) {
  const response = await client.chat({ ...request, stream: true });
  for await (const delta of readChatDeltas(response)) append(delta);
  return client.status();
}
