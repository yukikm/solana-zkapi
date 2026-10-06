//! Real ELF Vault execution. The only seeded program account is a sealed I04
//! PayloadBuffer fixture; all Pool/Tree/Note/Exit/Pending/ATA creation is executed.
// Preserve LiteSVM's native result type, including the complete failure logs.
#![allow(clippy::result_large_err)]
use anchor_lang::{AccountDeserialize, AccountSerialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use litesvm::{types::TransactionResult, LiteSVM};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::{v0, VersionedMessage},
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, SeedDerivable, Signer},
    transaction::{TransactionError, VersionedTransaction},
};
use std::{collections::BTreeSet, fs, path::Path, str::FromStr};
use zkapi_layout2::{Field, Operation};
use zkapi_vault::{ExitNullifier, Note, PendingWithdrawal, TreeState};

pub const NOW: u64 = 3_000_000_000;
pub const DEPOSIT: u64 = 5_000_000;
pub const BALANCE: u64 = 4_900_000;
pub const CHALLENGE: u64 = 86_400;

pub fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
pub fn bytes(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap().trim_start_matches("0x")).unwrap()
}
pub fn field(value: &Value) -> Field {
    bytes(value).try_into().unwrap()
}
pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(name.as_bytes())[..8].try_into().unwrap()
}
pub fn proof(value: &Value) -> Vec<u8> {
    let mut result = vec![];
    for field in value["public_inputs"].as_array().unwrap() {
        result.extend(bytes(field));
    }
    result.extend(bytes(&value["proof_wire_hex"]));
    result
}
pub fn payload(fixture: &Value, op: Operation) -> Vec<u8> {
    let mut result = vec![];
    let id = fixture["id"].as_u64().unwrap() as u32;
    match op {
        Operation::Deposit => {
            result.extend(id.to_le_bytes());
            result.extend(bytes(&fixture["trees"][0]["public_inputs"][1]));
            result.extend(fixture["expiry"].as_u64().unwrap().to_le_bytes());
            result.extend(bytes(&fixture["commitment"]));
            result.extend(fixture["deposit"].as_u64().unwrap().to_le_bytes());
        }
        Operation::Close => result.extend(proof(&fixture["auth"]["withdrawal"])),
        Operation::Escape => result.extend(proof(&fixture["auth"]["escape"])),
        Operation::Challenge => {
            result.extend(id.to_le_bytes());
            result.extend(proof(&fixture["auth"]["request"]));
        }
        Operation::Expiry => result.extend(id.to_le_bytes()),
    }
    result.extend(proof(&fixture["trees"][op.tree_op() as usize]));
    assert_eq!(result.len(), op.payload_len());
    result
}
pub fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), spl_token::id().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}
pub fn ata_program() -> Pubkey {
    Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}
pub fn data(name: &str, args: &[u8]) -> Vec<u8> {
    let mut result = disc(&format!("global:{name}")).to_vec();
    result.extend(args);
    result
}

#[derive(Clone, Copy, Debug)]
pub enum Expect {
    Ok,
    Error(u32),
    Reject,
}
pub struct World {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub attacker: Keypair,
    pub id: Pubkey,
    pub pool: Pubkey,
    pub tree: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub source: Pubkey,
    pub destination_owner: Pubkey,
    pub destination: Pubkey,
    pub treasury_owner: Pubkey,
    pub treasury: Pubkey,
    pub rows: Vec<Value>,
    pub traces: Vec<Value>,
    nonce: u64,
}
impl World {
    pub fn new(elf: &[u8]) -> Self {
        let id = zkapi_vault::ID;
        assert_eq!(id.to_bytes(), [43; 32]);
        Self::new_for(elf, id, Pubkey::new_from_array([4; 32]))
    }
    /// Explicit alternate test deployment; transaction signatures remain enabled.
    pub fn new_for(elf: &[u8], id: Pubkey, mint: Pubkey) -> Self {
        let payer = Keypair::from_seed(&[1; 32]).unwrap();
        let attacker = Keypair::from_seed(&[10; 32]).unwrap();
        let mut svm = LiteSVM::new().with_transaction_history(0);
        svm.airdrop(&payer.pubkey(), 20_000_000_000).unwrap();
        svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
        svm.add_program(id, elf).expect("load SBF fixture");
        let pool = Pubkey::find_program_address(&[b"pool", &[2; 32]], &id).0;
        let tree = Pubkey::find_program_address(&[b"tree", pool.as_ref()], &id).0;
        let authority = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &id).0;
        let destination_owner = Pubkey::new_from_array([7; 32]);
        let treasury_owner = Pubkey::new_from_array([8; 32]);
        let mut world = Self {
            svm,
            source: ata(payer.pubkey(), mint),
            payer,
            attacker,
            id,
            pool,
            tree,
            authority,
            mint,
            vault: ata(authority, mint),
            destination_owner,
            destination: ata(destination_owner, mint),
            treasury_owner,
            treasury: ata(treasury_owner, mint),
            rows: vec![],
            traces: vec![],
            nonce: 0,
        };
        let mint_state = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 100_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::Some(world.payer.pubkey()),
        };
        let mut raw = vec![0; spl_token::state::Mint::LEN];
        spl_token::state::Mint::pack(mint_state, &mut raw).unwrap();
        world.account(mint, spl_token::id(), raw);
        world.token(world.source, world.payer.pubkey(), 100_000_000);
        world.clock(NOW as i64);
        world
    }
    pub fn account(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        self.svm
            .set_account(
                key,
                Account {
                    lamports: 100_000_000,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    pub fn edit(&mut self, key: Pubkey, edit: impl FnOnce(&mut Account)) {
        let mut account = self.svm.get_account(&key).unwrap();
        edit(&mut account);
        self.svm.set_account(key, account).unwrap();
    }
    pub fn state<T: AccountDeserialize>(&self, key: Pubkey) -> T {
        T::try_deserialize(&mut self.svm.get_account(&key).unwrap().data.as_slice()).unwrap()
    }
    pub fn edit_state<T: AccountDeserialize + AccountSerialize>(
        &mut self,
        key: Pubkey,
        edit: impl FnOnce(&mut T),
    ) {
        let mut state = self.state::<T>(key);
        edit(&mut state);
        self.edit(key, |a| {
            let mut out = Vec::new();
            state.try_serialize(&mut out).unwrap();
            out.resize(a.data.len(), 0);
            a.data = out;
        });
    }
    pub fn token(&mut self, key: Pubkey, owner: Pubkey, amount: u64) {
        let state = spl_token::state::Account {
            mint: self.mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut raw = vec![0; spl_token::state::Account::LEN];
        spl_token::state::Account::pack(state, &mut raw).unwrap();
        self.account(key, spl_token::id(), raw);
    }
    pub fn edit_token(&mut self, key: Pubkey, edit: impl FnOnce(&mut spl_token::state::Account)) {
        self.edit(key, |a| {
            let mut state = spl_token::state::Account::unpack_unchecked(&a.data).unwrap();
            edit(&mut state);
            spl_token::state::Account::pack(state, &mut a.data).unwrap();
        });
    }
    pub fn amount(&self, key: Pubkey) -> u64 {
        self.svm
            .get_account(&key)
            .filter(|a| !a.data.is_empty())
            .map(|a| {
                spl_token::state::Account::unpack_unchecked(&a.data)
                    .unwrap()
                    .amount
            })
            .unwrap_or(0)
    }
    pub fn clock(&mut self, time: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = time;
        self.svm.set_sysvar(&clock);
    }
    pub fn note(&self, id: u32) -> Pubkey {
        Pubkey::find_program_address(&[b"note", self.pool.as_ref(), &id.to_le_bytes()], &self.id).0
    }
    pub fn pending(&self, id: u32) -> Pubkey {
        Pubkey::find_program_address(
            &[b"pending", self.pool.as_ref(), &id.to_le_bytes()],
            &self.id,
        )
        .0
    }
    pub fn exit(&self, n: &Field) -> Pubkey {
        Pubkey::find_program_address(&[b"exit", self.pool.as_ref(), n], &self.id).0
    }
    pub fn init_accounts(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.tree, false),
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(ata_program(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ]
    }
    pub fn init_data(&self, fixture: &Value) -> Vec<u8> {
        assert_eq!(self.pool.to_bytes(), field(&fixture["pool"]));
        let w = &fixture["auth"]["withdrawal"]["public_inputs"];
        let mut args = vec![];
        args.extend([2; 32]);
        args.extend([0; 32]);
        for key in [4, 5, 6, 7] {
            args.extend(bytes(&w[key]));
        }
        args.extend(2_592_000u64.to_le_bytes());
        args.extend(CHALLENGE.to_le_bytes());
        args.extend(1_000_000u64.to_le_bytes());
        args.extend(self.payer.pubkey().to_bytes());
        args.extend(self.treasury_owner.to_bytes());
        data("initialize_pool", &args)
    }
    pub fn initialize(&mut self, fixture: &Value) {
        assert!(self.svm.get_account(&self.pool).is_none());
        assert!(self.svm.get_account(&self.tree).is_none());
        assert!(self.svm.get_account(&self.vault).is_none());
        self.run(
            "initialize_pool/real-pda-and-ata-cpi",
            self.init_accounts(),
            self.init_data(fixture),
            Expect::Ok,
        )
        .unwrap();
        assert_eq!(self.state::<TreeState>(self.tree).sequence, 0);
        assert_eq!(self.amount(self.vault), 0);
    }
    pub fn financial(&self, id: u32, n: Option<Field>, op: Option<Operation>) -> Vec<AccountMeta> {
        let deposit = op == Some(Operation::Deposit);
        let pending =
            op == Some(Operation::Escape) || op == Some(Operation::Challenge) || op.is_none();
        let outgoing =
            op == Some(Operation::Close) || op == Some(Operation::Expiry) || op.is_none();
        let destination = outgoing && op != Some(Operation::Expiry);
        // Anchor's shared context marks optional slots mutable. A payer alias
        // keeps those slots writable without adding extraneous transaction keys.
        let placeholder = AccountMeta::new(self.payer.pubkey(), false);
        vec![
            AccountMeta::new_readonly(self.pool, false),
            AccountMeta::new(self.tree, false),
            AccountMeta::new(self.note(id), false),
            if pending {
                AccountMeta::new(self.pending(id), false)
            } else {
                placeholder.clone()
            },
            n.map(|n| AccountMeta::new(self.exit(&n), false))
                .unwrap_or(placeholder.clone()),
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(self.mint, false),
            if deposit {
                AccountMeta::new(self.source, false)
            } else {
                placeholder.clone()
            },
            AccountMeta::new(self.vault, false),
            if destination || op == Some(Operation::Escape) {
                AccountMeta::new_readonly(self.destination_owner, false)
            } else {
                placeholder.clone()
            },
            if destination {
                AccountMeta::new(self.destination, false)
            } else {
                placeholder.clone()
            },
            if outgoing {
                AccountMeta::new_readonly(self.treasury_owner, false)
            } else {
                placeholder.clone()
            },
            if outgoing {
                AccountMeta::new(self.treasury, false)
            } else {
                placeholder.clone()
            },
            if deposit {
                AccountMeta::new_readonly(self.payer.pubkey(), true)
            } else {
                placeholder
            },
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(ata_program(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ]
    }
    pub fn buffer(&mut self, op: Operation, body: &[u8]) -> (Pubkey, [u8; 32]) {
        self.nonce += 1;
        let nonce: [u8; 32] = Sha256::digest(self.nonce.to_le_bytes()).into();
        let (key, bump) = Pubkey::find_program_address(
            &[
                b"payload",
                self.pool.as_ref(),
                self.payer.pubkey().as_ref(),
                &nonce,
            ],
            &self.id,
        );
        let digest: [u8; 32] = Sha256::digest(body).into();
        let mut raw = disc("account:PayloadBuffer").to_vec();
        raw.extend([2, bump]);
        raw.extend(self.payer.pubkey().to_bytes());
        raw.push(op as u8);
        raw.extend((body.len() as u32).to_le_bytes());
        raw.extend(digest);
        raw.extend((body.len() as u32).to_le_bytes());
        raw.push(1);
        let now = self.svm.get_sysvar::<Clock>().unix_timestamp.max(0) as u64;
        raw.extend((now.saturating_add(3600)).to_le_bytes());
        raw.extend(self.payer.pubkey().to_bytes());
        raw.extend((body.len() as u32).to_le_bytes());
        raw.extend(body);
        raw.extend(nonce);
        self.account(key, self.id, raw);
        (key, digest)
    }
    pub fn execution(
        &mut self,
        fixture: &Value,
        op: Operation,
        body: &[u8],
    ) -> (Vec<AccountMeta>, Vec<u8>, Pubkey) {
        let (buffer, digest) = self.buffer(op, body);
        let id = fixture["id"].as_u64().unwrap() as u32;
        let n = matches!(op, Operation::Close | Operation::Escape)
            .then(|| field(&fixture["auth"]["withdrawal"]["public_inputs"][11]));
        let mut accounts = vec![
            AccountMeta::new(buffer, false),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
            AccountMeta::new(self.payer.pubkey(), false),
        ];
        accounts.extend(self.financial(id, n, Some(op)));
        (accounts, data("execute_payload", &digest), buffer)
    }
    pub fn execute(
        &mut self,
        name: &str,
        fixture: &Value,
        op: Operation,
        expected: Expect,
    ) -> TransactionResult {
        let body = payload(fixture, op);
        self.execute_body(name, fixture, op, &body, expected)
    }
    pub fn execute_body(
        &mut self,
        name: &str,
        fixture: &Value,
        op: Operation,
        body: &[u8],
        expected: Expect,
    ) -> TransactionResult {
        let before = self.state::<TreeState>(self.tree);
        let (accounts, args, buffer) = self.execution(fixture, op, body);
        let result = self.run(name, accounts, args, expected);
        if matches!(expected, Expect::Ok) {
            assert!(
                self.svm
                    .get_account(&buffer)
                    .is_none_or(|a| a.lamports == 0),
                "execute must return buffer rent"
            );
            self.assert_event(
                &before,
                match op {
                    Operation::Deposit => 0,
                    Operation::Close => 1,
                    Operation::Escape => 2,
                    Operation::Challenge => 3,
                    Operation::Expiry => 5,
                },
            );
            if matches!(
                op,
                Operation::Close | Operation::Escape | Operation::Challenge
            ) {
                let e = &self.rows.last().unwrap()["events"][0];
                assert_eq!(
                    e["exit_nullifier"],
                    hex::encode(field(&fixture["auth"]["withdrawal"]["public_inputs"][11]))
                );
                assert_eq!(e["final_balance"], fixture["balance"]);
                assert_eq!(
                    e["destination_owner"],
                    hex::encode(self.destination_owner.to_bytes())
                );
                if op != Operation::Close {
                    assert_eq!(
                        e["deadline"],
                        self.state::<PendingWithdrawal>(
                            self.pending(fixture["id"].as_u64().unwrap() as u32)
                        )
                        .deadline
                    );
                }
            }
        }
        result
    }
    pub fn finalize(&mut self, name: &str, id: u32, expected: Expect) -> TransactionResult {
        let before = self.state::<TreeState>(self.tree);
        let result = self.run(
            name,
            self.financial(id, None, None),
            data("finalize_escape", &id.to_le_bytes()),
            expected,
        );
        if matches!(expected, Expect::Ok) {
            self.assert_event(&before, 4);
            let p = self.state::<PendingWithdrawal>(self.pending(id));
            let e = &self.rows.last().unwrap()["events"][0];
            assert_eq!(e["exit_nullifier"], hex::encode(p.nullifier));
            assert_eq!(e["final_balance"], p.balance);
            assert_eq!(
                e["destination_owner"],
                hex::encode(p.destination_owner.to_bytes())
            );
            assert_eq!(e["deadline"], p.deadline);
        }
        result
    }
    pub fn admin(&mut self, name: &str, args: &[u8], expected: Expect) -> TransactionResult {
        self.run(
            name,
            vec![
                AccountMeta::new(self.pool, false),
                AccountMeta::new_readonly(self.payer.pubkey(), true),
            ],
            data(name, args),
            expected,
        )
    }
    pub(crate) fn assert_event(&self, before: &TreeState, op: u8) {
        let events = self.rows.last().unwrap()["events"].as_array().unwrap();
        assert_eq!(events.len(), 1, "one transition event");
        let e = &events[0];
        let tree = self.state::<TreeState>(self.tree);
        let n = self.state::<Note>(self.note(e["note_id"].as_u64().unwrap() as u32));
        assert_eq!(e["pool"], hex::encode(self.pool.to_bytes()));
        assert_eq!(e["sequence"], before.sequence + 1);
        assert_eq!(tree.sequence, before.sequence + 1);
        assert_eq!(e["op"], op);
        assert_eq!(e["old_root"], hex::encode(before.root));
        assert_eq!(e["new_root"], hex::encode(tree.root));
        assert_eq!(e["status"], n.status);
        assert_eq!(e["commitment"], hex::encode(n.commitment));
        assert_eq!(e["deposit"], n.deposit);
        assert_eq!(e["expiry"], n.expiry);
        for key in ["exit_nullifier", "final_balance", "destination_owner"] {
            assert_eq!(e[key].is_null(), matches!(op, 0 | 5));
        }
        assert_eq!(e["deadline"].is_null(), matches!(op, 0 | 1 | 5));
        assert!(self.amount(self.vault) >= tree.outstanding_deposits);
        if op == 4 {
            assert_eq!(tree.root, before.root);
        }
    }
    #[allow(clippy::result_large_err)]
    pub fn run(
        &mut self,
        name: &str,
        accounts: Vec<AccountMeta>,
        args: Vec<u8>,
        expected: Expect,
    ) -> TransactionResult {
        let mut seen = BTreeSet::new();
        let before: Vec<_> = accounts
            .iter()
            .filter(|a| a.is_writable && a.pubkey != self.payer.pubkey() && seen.insert(a.pubkey))
            .map(|a| (a.pubkey, self.svm.get_account(&a.pubkey)))
            .collect();
        let message = v0::Message::try_compile(
            &self.payer.pubkey(),
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
                Instruction {
                    program_id: self.id,
                    accounts: accounts.clone(),
                    data: args,
                },
            ],
            &[],
            self.svm.latest_blockhash(),
        )
        .unwrap();
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        if accounts
            .iter()
            .any(|a| a.pubkey == self.attacker.pubkey() && a.is_signer)
        {
            signers.push(&self.attacker);
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::V0(message), &signers).unwrap();
        let size = bincode::serialize(&tx).unwrap().len();
        assert!(size <= 1232, "{name}: v0 {size} bytes");
        let result = self.svm.send_transaction(tx);
        let (ok, meta, error) = match &result {
            Ok(m) => (true, m, None),
            Err(e) => (false, &e.meta, Some(format!("{:?}", e.err))),
        };
        match (expected, &result) {
            (Expect::Ok, Ok(_)) => {}
            (Expect::Error(code), Err(e)) => assert_eq!(
                e.err,
                TransactionError::InstructionError(1, InstructionError::Custom(code)),
                "{name}: {e:?}"
            ),
            (Expect::Reject, Err(e)) => assert!(
                matches!(
                    e.err,
                    TransactionError::InstructionError(
                        1,
                        InstructionError::Custom(_)
                            | InstructionError::InvalidAccountData
                            | InstructionError::InvalidInstructionData
                            | InstructionError::InvalidArgument
                            | InstructionError::MissingRequiredSignature
                            | InstructionError::IncorrectProgramId
                            | InstructionError::AccountAlreadyInitialized
                            | InstructionError::UninitializedAccount
                    )
                ),
                "{name}: abnormal execution failure {e:?}"
            ),
            _ => panic!("{name}: expected {expected:?}; {result:?}"),
        }
        assert!(meta.compute_units_consumed <= 1_000_000, "{name}");
        if !ok {
            for (key, old) in before {
                assert_eq!(self.svm.get_account(&key), old, "{name}: rollback {key}");
            }
        }
        let events: Vec<_> = meta
            .logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .filter_map(|b64| {
                let raw = STANDARD.decode(b64).ok()?;
                (raw.starts_with(&disc("event:VaultTransitionV1"))).then(|| parse_event(&raw))
            })
            .collect();
        self.rows.push(json!({"case":name,"ok":ok,"expected":format!("{expected:?}"),"cu":meta.compute_units_consumed,"transaction_bytes":size,
            "error":error,"inner_instruction_count":meta.inner_instructions.iter().map(|i|i.len()).sum::<usize>(),"events":events,"logs":meta.logs}));
        result
    }
    pub fn snapshot(&mut self, label: &str, fixture: &Value) {
        let tree = self.state::<TreeState>(self.tree);
        let mut statuses = vec![];
        let mut exists = vec![];
        let mut balances = vec![];
        let mut deadlines = vec![];
        let mut nullifiers = vec![];
        for id in 0..2 {
            statuses.push(
                self.svm
                    .get_account(&self.note(id))
                    .filter(|a| !a.data.is_empty())
                    .map(|_| self.state::<Note>(self.note(id)).status)
                    .unwrap_or(0),
            );
            let p = self
                .svm
                .get_account(&self.pending(id))
                .filter(|a| !a.data.is_empty())
                .map(|_| self.state::<PendingWithdrawal>(self.pending(id)));
            let present = p.as_ref().is_some_and(|p| p.exists);
            exists.push(present);
            balances.push(
                p.as_ref()
                    .filter(|_| present)
                    .map(|p| p.balance)
                    .unwrap_or(0),
            );
            deadlines.push(
                p.as_ref()
                    .filter(|_| present)
                    .map(|p| p.deadline)
                    .unwrap_or(0),
            );
            nullifiers.push(format!(
                "0x{}",
                hex::encode(
                    p.as_ref()
                        .filter(|_| present)
                        .map(|p| p.nullifier)
                        .unwrap_or([0; 32])
                )
            ));
        }
        let n = field(&fixture["auth"]["withdrawal"]["public_inputs"][11]);
        let used = self
            .svm
            .get_account(&self.exit(&n))
            .filter(|a| !a.data.is_empty())
            .is_some_and(|_| self.state::<ExitNullifier>(self.exit(&n)).consumed);
        let leaves: Vec<_> = (0..2)
            .map(|i| {
                format!(
                    "0x{}",
                    hex::encode(if statuses[i] == 1 {
                        let note = self.state::<Note>(self.note(i as u32));
                        zkapi_poseidon::bytes(zkapi_poseidon::leaf(
                            note.note_id,
                            zkapi_poseidon::parse(&note.commitment).unwrap(),
                            note.deposit,
                            note.expiry,
                        ))
                    } else {
                        [0; 32]
                    })
                )
            })
            .collect();
        self.traces.push(json!({"label":label,"root":format!("0x{}",hex::encode(tree.root)),"next_id":tree.next_note_id,
            "statuses":statuses,"pending_exists":exists,"pending_balance":balances,"pending_deadline":deadlines,"nullifier_used":used,
            "active_leaves":leaves,"pending_nullifier":nullifiers,
            "user_delta":self.amount(self.destination) as i64+(self.amount(self.source) as i64-100_000_000),"treasury_delta":self.amount(self.treasury),
            "vault_units":self.amount(self.vault),"time":self.svm.get_sysvar::<Clock>().unix_timestamp}));
    }
}

fn parse_event(raw: &[u8]) -> Value {
    struct Cursor<'a>(&'a [u8]);
    impl Cursor<'_> {
        fn take(&mut self, n: usize) -> &[u8] {
            let (head, tail) = self.0.split_at(n);
            self.0 = tail;
            head
        }
        fn u8(&mut self) -> u8 {
            self.take(1)[0]
        }
        fn u32(&mut self) -> u32 {
            u32::from_le_bytes(self.take(4).try_into().unwrap())
        }
        fn u64(&mut self) -> u64 {
            u64::from_le_bytes(self.take(8).try_into().unwrap())
        }
        fn f(&mut self) -> String {
            hex::encode(self.take(32))
        }
        fn opt(&mut self, n: usize) -> Value {
            match self.u8() {
                0 => Value::Null,
                1 => {
                    if n == 8 {
                        json!(self.u64())
                    } else {
                        json!(self.f())
                    }
                }
                _ => panic!("noncanonical event option"),
            }
        }
    }
    let mut r = Cursor(&raw[8..]);
    let v = json!({"event_version":r.u8(),"pool":r.f(),"sequence":r.u64(),"op":r.u8(),"note_id":r.u32(),"status":r.u8(),
        "old_root":r.f(),"new_root":r.f(),"commitment":r.f(),"deposit":r.u64(),"expiry":r.u64(),
        "exit_nullifier":r.opt(32),"final_balance":r.opt(8),"destination_owner":r.opt(32),"deadline":r.opt(8)});
    assert!(r.0.is_empty(), "event trailing bytes");
    assert_eq!(v["event_version"], 1);
    v
}
