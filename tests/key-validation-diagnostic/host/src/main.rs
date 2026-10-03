use litesvm::LiteSVM;
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_sdk::{instruction::Instruction, pubkey::Pubkey, signature::{Keypair,Signer,SeedDerivable}, transaction::Transaction, compute_budget::ComputeBudgetInstruction};
fn main() {
 let elf=std::fs::read(std::env::args().nth(1).expect("diagnostic ELF path")).unwrap();
 let fixture:serde_json::Value=serde_json::from_slice(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/layout2/a.json")).unwrap()).unwrap();
 let public=fixture["auth"]["escape"]["public_inputs"].as_array().unwrap();
 let fields:Vec<Vec<u8>>=(4..8).map(|i| hex::decode(public[i].as_str().unwrap().trim_start_matches("0x")).unwrap()).collect();
 for diagnostic in [true, false] {
 for n in [1,2] {
  let mut svm=LiteSVM::new().with_transaction_history(0);
  if diagnostic { svm=svm.with_compute_budget(ComputeBudget{compute_unit_limit:100_000_000,..ComputeBudget::default()}); }
  let id=Pubkey::new_from_array([42;32]);let payer=Keypair::from_seed(&[1; 32]).unwrap();
  svm.airdrop(&payer.pubkey(),1_000_000_000).unwrap();svm.add_program(id,&elf);
  let tx=Transaction::new_signed_with_payer(&[ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),Instruction{program_id:id,accounts:vec![],data:fields[..2*n].concat()}],Some(&payer.pubkey()),&[&payer],svm.latest_blockhash());
  match svm.send_transaction(tx) {Ok(m)=>println!("diagnostic={diagnostic}, {n} keys: {} CU, {:?}",m.compute_units_consumed,m.logs),Err(e)=>println!("diagnostic={diagnostic}, {n} keys failed: {:?}",e)};
 }
}
}
