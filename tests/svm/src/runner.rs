//! Shared real-SBF transaction and token-account harness.
use litesvm::{types::TransactionResult, LiteSVM};
use serde_json::{json, Value};
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction, InstructionError},
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};
pub(crate) struct Runner {
    pub(crate) svm: LiteSVM,
    pub(crate) payer: Keypair,
    pub(crate) id: Pubkey,
    pub(crate) rows: Vec<Value>,
}
impl Runner {
    pub(crate) fn new(elf: &[u8], limit: u64) -> Self {
        let mut svm = LiteSVM::new()
            .with_transaction_history(0)
            .with_compute_budget(ComputeBudget {
                compute_unit_limit: limit,
                ..ComputeBudget::default()
            });
        let payer = Keypair::new();
        let id = Pubkey::new_from_array([42; 32]);
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        svm.add_program(id, elf).expect("load SBF fixture");
        Self {
            svm,
            payer,
            id,
            rows: vec![],
        }
    }
    pub(crate) fn accounts(&mut self, state: Vec<u8>) -> Vec<AccountMeta> {
        let state_id = Pubkey::new_unique();
        let mint_id = Pubkey::new_unique();
        let source = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        self.svm
            .set_account(
                state_id,
                Account {
                    lamports: 100_000_000,
                    data: state,
                    owner: self.id,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let mint = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 5_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0; spl_token::state::Mint::LEN];
        spl_token::state::Mint::pack(mint, &mut data).unwrap();
        self.svm
            .set_account(
                mint_id,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: spl_token::id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        for (key, amount) in [(source, 5_000_000), (dest, 0), (treasury, 0)] {
            let token = spl_token::state::Account {
                mint: mint_id,
                owner: self.payer.pubkey(),
                amount,
                delegate: COption::None,
                state: spl_token::state::AccountState::Initialized,
                is_native: COption::None,
                delegated_amount: 0,
                close_authority: COption::None,
            };
            let mut data = vec![0; spl_token::state::Account::LEN];
            spl_token::state::Account::pack(token, &mut data).unwrap();
            self.svm
                .set_account(
                    key,
                    Account {
                        lamports: 10_000_000,
                        data,
                        owner: spl_token::id(),
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
        }
        vec![
            AccountMeta::new(state_id, false),
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint_id, false),
            AccountMeta::new(dest, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
        ]
    }
    pub(crate) fn token_amount(&self, key: &Pubkey) -> u64 {
        spl_token::state::Account::unpack(&self.svm.get_account(key).unwrap().data)
            .unwrap()
            .amount
    }
    pub(crate) fn check_transfers(&self, accounts: &[AccountMeta], op: u8) {
        let expected = match op {
            3 | 6 => [0, 5_000_000, 0],
            4 | 7 => [0, 4_900_000, 100_000],
            5 | 8 => [5_000_000, 0, 0],
            _ => panic!(),
        };
        assert_eq!(
            [
                self.token_amount(&accounts[1].pubkey),
                self.token_amount(&accounts[3].pubkey),
                self.token_amount(&accounts[4].pubkey)
            ],
            expected
        );
    }
    #[allow(clippy::result_large_err)] // Preserve LiteSVM metadata in this measurement harness.
    pub(crate) fn run(
        &mut self,
        name: &str,
        data: Vec<u8>,
        accounts: Vec<AccountMeta>,
        expected: Option<bool>,
    ) -> TransactionResult {
        let tx = Transaction::new_signed_with_payer(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
                Instruction {
                    program_id: self.id,
                    accounts,
                    data,
                },
            ],
            Some(&self.payer.pubkey()),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        let size = bincode::serialize(&tx).unwrap().len();
        assert!(size <= 1232, "measurement transport exceeds packet: {size}");
        let result = self.svm.send_transaction(tx);
        let (ok, meta, err) = match &result {
            Ok(m) => (true, m, None),
            Err(e) => (false, &e.meta, Some(format!("{:?}", e.err))),
        };
        if let Some(expected) = expected {
            assert_eq!(ok, expected, "{name}: {result:?}");
        }
        if let Err(e) = &result {
            if name.contains("/release-budget") || name.starts_with("poseidon-") {
                assert!(
                    e.meta.logs.iter().any(|l| l.contains("exceeded CUs")),
                    "expected CU exhaustion: {name}: {e:?}"
                );
            } else if name != "fallback/second-CPI-failure-rollback" {
                assert!(
                    matches!(
                        e.err,
                        TransactionError::InstructionError(
                            _,
                            InstructionError::Custom(1 | 2)
                                | InstructionError::InvalidInstructionData
                        )
                    ),
                    "expected cryptographic rejection: {name}: {e:?}"
                );
            }
        }
        self.rows.push(json!({"case":name,"ok":ok,"cu":meta.compute_units_consumed,"transaction_bytes":size,"error":err,"logs":meta.logs,"inner_instruction_count":meta.inner_instructions.iter().map(|v|v.len()).sum::<usize>()}));
        result
    }
}
