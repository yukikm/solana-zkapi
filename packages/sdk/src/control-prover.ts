/** Browser/native verification through the same Rust verifier used by clientd.
 * Worker failure may use an explicitly configured offline native bridge. */
import type { SessionVerifier, VerificationContext, PrivateState, PreparedSession, Settlement, Receipt } from './control.ts';
import type { ClientProver } from './prover-runtime.ts';
export class ProverSessionVerifier implements SessionVerifier {
  private readonly prover:ClientProver;
  constructor(prover:ClientProver){this.prover=prover;}
  async prepare(context:VerificationContext,state:PrivateState,prepared:PreparedSession,now:string,root:string):Promise<void>{
    const result=await this.prover.run({kind:'verify',command:{kind:'prepare',context,state,prepared,now,root}}) as {verified?:boolean};
    if(result?.verified!==true||Object.keys(result).join(',')!=='verified')throw Error('prepare verification rejected');
  }
  async settle(context:VerificationContext,state:PrivateState,prepared:PreparedSession,settlement:Settlement,receipts:Receipt[],operations:string[]):Promise<PrivateState>{
    return await this.prover.run({kind:'verify',command:{kind:'settle',context,state,prepared,settlement,receipts,operations}}) as PrivateState;
  }
}
