/** Offline browser fixture only. Never included in the real Phantom bundle. */
import {Buffer} from 'buffer';
import {getWallets} from '@wallet-standard/app';
import {Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import fixture from '../../tests/fixtures/vault/genesis-a.json' with {type: 'json'};
import {mountWalletUi} from './app.ts';
import type {VerifiedManifest} from '../../packages/sdk/src/trust.ts';
import type {NoteProver} from '../../packages/sdk/src/prover.ts';
import type {PrivateState} from '../../packages/sdk/src/control.ts';
import {WalletClient} from '../../packages/sdk/src/wallet.ts';
import {providerFixture, fixtureState} from './provider.fixture.ts';
import type {TransportRpc} from '../../packages/sdk/src/transport.ts';
Object.assign(globalThis, {Buffer});
const field = (value: number) => '0x' + value.toString(16).padStart(64, '0');
const key = (value: string) => new PublicKey(Buffer.from(value, 'hex')).toBase58();
// Public deterministic fixture seeds; there is no imported user key or extension.
const pairs = [Keypair.fromSeed(new Uint8Array(32).fill(51)), Keypair.fromSeed(new Uint8Array(32).fill(52))];
const accounts = pairs.map(pair => Object.freeze({address: pair.publicKey.toBase58(), publicKey: pair.publicKey.toBytes(), chains: ['solana:devnet'] as const, features: ['solana:signTransaction'] as const}));
let connected = false, rejectNext = true, requests = 0, sends = 0, persistedBeforeSend = false;
const wallet = {
  version: '1.0.0' as const, name: 'Fixture Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+' as const, chains: ['solana:devnet'] as const,
  get accounts() { return connected ? accounts : []; },
  features: {
    'standard:connect': {version: '1.0.0' as const, connect: async () => { connected = true; return {accounts}; }},
    'solana:signTransaction': {version: '1.0.0' as const, supportedTransactionVersions: [0], signTransaction: async (...inputs: any[]) => {
      requests++; if (rejectNext) { rejectNext = false; throw Error('fixture explicit signature rejection'); }
      return inputs.map(input => { const pair = pairs.find(p => p.publicKey.toBase58() === input.account.address); if (!pair) throw Error('fixture account mismatch'); const tx = VersionedTransaction.deserialize(input.transaction); tx.sign([pair]); return {signedTransaction: tx.serialize()}; });
    }},
  },
};
getWallets().register(wallet);
const manifest = {deployment_environment: 'devnet', setup_profile: 'test_only', genesis_hash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  deployment_id: 'i10-ui-offline-fixture', manifest_hash: 'f'.repeat(64), program_id: key(fixture.program_id), pool: key(fixture.pool),
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', note_ttl_seconds: String(fixture.ttl)} as VerifiedManifest;
const providerMode = location.hash === '#provider-fixture';
mountWalletUi({fixtureOnly: true, targetWallet: wallet.name, runId: providerMode ? 'fixture-provider' : 'fixture', manifest, fee: async () => 5000,
  initialize: async (journal, signer) => {
    const state: PrivateState = {balance_micro_usdc: '1000000', balance_blinding: field(3), note_leaf: field(4), commitment: {x: field(5), y: field(6)}, anchor: field(1), state_signature: null};
    const prover = {deposit: async (note_id: number, amount: string, expiry: string) => ({witness: {secret: field(12345), note_id, deposit_micro_usdc: amount, expiry}, state, registration_commitment: '0x' + fixture.commitment}),
      inspect: async () => ({nullifier: fixture.auth.escape.public_inputs[11], registration_commitment: '0x' + fixture.commitment}),
      tree: async () => fixture.trees[0]} as unknown as NoteProver;
    const rpc: TransportRpc = {signatureStatus: async () => null, finalizedReceipt: async () => null, finalizedBlockHeight: async () => 1,
      sendRawTransaction: async bytes => {
        const tx = VersionedTransaction.deserialize(bytes), signature = bs58.encode(tx.signatures[0]);
        const saved = (await journal.read('wallet-ui-acceptance'))!.value.wallet!.operation!;
        persistedBeforeSend = saved.current === signature && saved.attempts.some(a => a.signature === signature && a.wireHex === Buffer.from(bytes).toString('hex'));
        if (!persistedBeforeSend) throw Error('SDK attempt not durable before send'); sends++; return signature;
      }};
    Object.assign(globalThis, {fixtureObservation: () => ({requests, sends, persistedBeforeSend}), fixtureApprove: () => { rejectNext = false; }});
    const walletOptions = {manifest, prover, rpc, chain: {snapshot: async () => ({root: fixture.trees[0].public_inputs[1], siblings: Array(32).fill(field(0)), slot: 100, sequence: '0', nextNoteId: 0, clock: String(fixture.now), paused: false, treasuryOwner: signer.publicKey.toBase58(), note: {note_id: 0, registration_commitment: '0x' + fixture.commitment, deposit_micro_usdc: '1000000', expiry: '86400', status: 'active' as const}}),
      buffer: async () => null, blockhash: async () => ({blockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), lastValidBlockHeight: 1000})}};
    if (providerMode) {
      if (!await journal.read('wallet-ui-acceptance')) await new WalletClient({...walletOptions, journal, wallets: [signer]}).importFinalized('wallet-ui-acceptance', {secret: field(12345), note_id: 0, deposit_micro_usdc: '1000000', expiry: '86400'}, fixtureState());
      const p = await providerFixture(journal, 'wallet-ui-acceptance');
      Object.assign(globalThis, {fixtureProviderObservation: () => p.counts, fixtureProviderBehavior: p.behavior});
      return {...walletOptions, providerOptions: p.options};
    }
    return walletOptions;
  }});
