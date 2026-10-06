/** Wallet proving facade. This code creates witnesses/proofs, never sends requests or commits state. */
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { parseField, parseMicroUsdc } from './encoding.ts';
import { verifyArtifactBundle, type ArtifactBundle, type VerifiedManifest } from './trust.ts';
import type { PrivateState, Quote, Tariff, PreparedSession, StateSignature, createCredentials } from './control.ts';
import type { PublicProof } from './layout2.ts';
import type { ClientProver } from './prover-runtime.ts';
import type { SnapshotNote, SnapshotPath } from './session-snapshot.ts';
export type { ClientProver } from './prover-runtime.ts';
export interface NoteWitness { secret: string; note_id: number; deposit_micro_usdc: string; expiry: string }
export interface DepositCandidate { witness: NoteWitness; state: PrivateState; registration_commitment: string }
export interface ProverContext { vault_binding: string; state_key: [string,string]; clearance_key: [string,string] }
export interface PublicNote { note_id: number; registration_commitment: string; deposit_micro_usdc: string; expiry: string }
function proof(value: unknown, count: number): PublicProof {
  const p = value as PublicProof;
  if (!p || !Array.isArray(p.public_inputs) || p.public_inputs.length !== count || !/^[0-9a-f]{512}$/.test(p.proof_wire_hex)) throw new Error('invalid prover response');
  p.public_inputs.forEach(parseField); return p;
}
export function validateWitness(value: unknown): asserts value is NoteWitness {
  const w = value as NoteWitness;
  if (!w || !Number.isInteger(w.note_id) || w.note_id < 0 || w.note_id > 0xffffffff || typeof w.expiry !== 'string' || !/^(0|[1-9][0-9]*)$/.test(w.expiry) || BigInt(w.expiry) > 0xffffffffffffffffn) throw new Error('invalid note witness');
  parseField(w.secret); if (BigInt(w.secret) === 0n || parseMicroUsdc(w.deposit_micro_usdc) === 0n) throw new Error('empty note witness');
}
export class NoteProver {
  readonly context: ProverContext;
  private readonly engine: ClientProver;
  private readonly keys: Record<'request'|'withdrawal'|'tree', {bytes_base64:string;pk_sha256:string;vk_sha256:string}>;
  private constructor(manifest: VerifiedManifest, artifacts: ArtifactBundle, engine: ClientProver) {
    this.engine = engine;
    this.context = { vault_binding:manifest.vault_binding, state_key:[manifest.state_key.x,manifest.state_key.y], clearance_key:[manifest.clearance_key.x,manifest.clearance_key.y] };
    this.keys = {
      request:{bytes_base64:Buffer.from(artifacts.requestPk).toString('base64'),pk_sha256:manifest.request_pk_hash,vk_sha256:manifest.request_vk_hash},
      withdrawal:{bytes_base64:Buffer.from(artifacts.withdrawalPk).toString('base64'),pk_sha256:manifest.withdrawal_pk_hash,vk_sha256:manifest.withdrawal_vk_hash},
      tree:{bytes_base64:Buffer.from(artifacts.treePk).toString('base64'),pk_sha256:manifest.tree_proof_artifacts.pk_hash,vk_sha256:manifest.tree_proof_artifacts.vk_hash},
    };
  }
  static async create(manifest: VerifiedManifest, artifacts: ArtifactBundle, engine: ClientProver): Promise<NoteProver> {
    return new NoteProver(manifest, await verifyArtifactBundle(manifest, artifacts), engine);
  }
  private run(command: object): Promise<unknown> { return this.engine.run(structuredClone(command)); }
  /** Reconstruct the original sparse tree locally; never send the selected ID. */
  async snapshotPath(root:string,nextNoteId:string,notes:readonly SnapshotNote[],noteId:number):Promise<SnapshotPath> {
    const result=await this.run({kind:'snapshot_path',root,next_note_id:nextNoteId,active_notes:notes,note_id:noteId}) as SnapshotPath;
    if(!result||result.root!==root||result.note_id!==noteId||!Array.isArray(result.siblings)||result.siblings.length!==32)throw Error('invalid local snapshot path');
    result.siblings.forEach(parseField);return result;
  }
  async deposit(noteId: number, amount: string, expiry: string): Promise<DepositCandidate> {
    const result = await this.run({kind:'deposit',note_id:noteId,amount,expiry}) as DepositCandidate;
    validateWitness(result.witness); return result;
  }
  async rebaseDeposit(witness: NoteWitness, noteId: number, expiry: string): Promise<DepositCandidate> {
    const result = await this.run({kind:'rebase_deposit',witness,note_id:noteId,expiry}) as DepositCandidate;
    validateWitness(result.witness); return result;
  }
  async inspect(witness: NoteWitness, state: PrivateState): Promise<{nullifier:string;registration_commitment:string}> {
    return await this.run({kind:'inspect',context:this.context,witness,state}) as {nullifier:string;registration_commitment:string};
  }
  async prepareSession(witness: NoteWitness, state: PrivateState, root: string, siblings: string[], quote: Quote, tariff: Tariff,
    credentials: Awaited<ReturnType<typeof createCredentials>>): Promise<PreparedSession> {
    const q = structuredClone(quote), t = structuredClone(tariff), c = structuredClone(credentials);
    const authorization = {version:'1' as const,deployment_id:q.body.deployment_id,pool:q.body.pool,request_id:c.requestId,quote_hash:q.quote_hash,
      mode:q.body.mode,control_secret_hash:c.controlHash,proxy_secret_hash:c.proxyHash};
    const result = await this.run({kind:'request',context:this.context,witness,state,root,siblings,authorization,request_time:q.body.issued_at,cap:q.body.cap_micro_usdc,key:this.keys.request}) as {auth:unknown;rerandomization:string};
    const auth = proof(result.auth,12);
    return {request:{authorization,quote:q,public_inputs:[...auth.public_inputs],proof:{backend:'groth16_bn254',proof:Buffer.from(auth.proof_wire_hex,'hex').toString('base64')}},
      control_token:c.controlToken,proxy_token:c.proxyToken,tariff:t,rerandomization:result.rerandomization};
  }
  async verifyClearance(nullifier: string, signature: StateSignature): Promise<void> {
    const result = await this.run({kind:'clearance',context:this.context,nullifier,signature}) as {verified?:boolean};
    if (result.verified !== true) throw new Error('invalid clearance');
  }
  async withdrawal(witness: NoteWitness, state: PrivateState, root: string, siblings: string[], destination: PublicKey, clearance: StateSignature | null): Promise<PublicProof> {
    return proof(await this.run({kind:'withdrawal',context:this.context,witness,state,root,siblings,destination_owner_hex:Buffer.from(destination.toBytes()).toString('hex'),clearance,mutual:clearance !== null,key:this.keys.withdrawal}),14);
  }
  async tree(note: PublicNote, root: string, siblings: string[], op: 0|1|2): Promise<PublicProof> {
    return proof(await this.run({kind:'tree',context:this.context,note,root,siblings,op,key:this.keys.tree}),11);
  }
}
