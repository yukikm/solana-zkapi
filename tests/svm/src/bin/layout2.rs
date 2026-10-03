//! Real v0 transactions, actual ELF execution, fixed test keys, no native verifier.
use ark_bn254::{Fq, Fq2, G2Affine};
use ark_ff::{BigInteger, Field as ArkField, PrimeField};
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
    signature::{Keypair, Signer},
    transaction::{TransactionError, VersionedTransaction},
};
use std::{fs, path::Path};
use zkapi_layout2::{Field, Operation, FR_MODULUS};
#[path = "../../../../programs/i02-layout2/src/profile.rs"]
mod profile;
#[path = "../../../../programs/i02-layout2/src/state.rs"]
mod state;
fn read(p: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}
fn f(v: &Value) -> Field {
    bytes(v).try_into().unwrap()
}
fn proof(v: &Value) -> Vec<u8> {
    let mut b = vec![];
    for p in v["public_inputs"].as_array().unwrap() {
        b.extend(bytes(p));
    }
    b.extend(bytes(&v["proof_wire_hex"]));
    b
}
fn disc(s: &str) -> [u8; 8] {
    Sha256::digest(s.as_bytes())[..8].try_into().unwrap()
}
fn hash(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
fn payload(v: &Value, op: Operation) -> Vec<u8> {
    let mut b = vec![];
    let id = v["id"].as_u64().unwrap() as u32;
    match op {
        Operation::Deposit => {
            b.extend(id.to_le_bytes());
            b.extend(bytes(&v["trees"][0]["public_inputs"][1]));
            b.extend(v["expiry"].as_u64().unwrap().to_le_bytes());
            b.extend(bytes(&v["commitment"]));
            b.extend(v["deposit"].as_u64().unwrap().to_le_bytes());
        }
        Operation::Close => b.extend(proof(&v["auth"]["withdrawal"])),
        Operation::Escape => b.extend(proof(&v["auth"]["escape"])),
        Operation::Challenge => {
            b.extend(id.to_le_bytes());
            b.extend(proof(&v["auth"]["request"]));
        }
        Operation::Expiry => b.extend(id.to_le_bytes()),
    }
    b.extend(proof(&v["trees"][op.tree_op() as usize]));
    assert_eq!(b.len(), op.payload_len());
    b
}
#[derive(Clone)]
struct Job {
    op: Operation,
    pool: Pubkey,
    state: state::State,
    payload: Vec<u8>,
    now: u64,
}
impl Job {
    fn new(v: &Value, op: Operation) -> Self {
        let id = v["id"].as_u64().unwrap() as u32;
        let w = &v["auth"]["withdrawal"]["public_inputs"];
        let challenge = op == Operation::Challenge;
        Self {
            op,
            pool: Pubkey::new_from_array(f(&v["pool"])),
            payload: payload(v, op),
            now: if op == Operation::Expiry {
                v["expiry"].as_u64().unwrap()
            } else {
                v["now"].as_u64().unwrap()
            },
            state: state::State {
                layout: 2,
                backend: 1,
                policy: 1,
                paused: 0,
                profile: profile::PROFILE,
                genesis: f(&v["genesis"]),
                mint: f(&v["mint"]),
                treasury: [6; 32],
                root: f(&v["trees"][op.tree_op() as usize]["public_inputs"][1]),
                keys: [f(&w[4]), f(&w[5]), f(&w[6]), f(&w[7])],
                next_id: if op == Operation::Deposit {
                    u64::from(id)
                } else {
                    u64::from(id) + 1
                },
                sequence: 7,
                ttl: v["ttl"].as_u64().unwrap(),
                status: if op == Operation::Deposit {
                    0
                } else if challenge {
                    2
                } else {
                    1
                },
                id,
                commitment: f(&v["commitment"]),
                deposit: v["deposit"].as_u64().unwrap(),
                expiry: v["expiry"].as_u64().unwrap(),
                pending: u8::from(challenge),
                pending_n: f(&v["auth"]["request"]["public_inputs"][8]),
                deadline: v["now"].as_u64().unwrap() + 86400,
                old_root: f(&w[3]),
                consumed: u8::from(challenge),
                exit_n: f(&w[11]),
                balance: 4_900_000,
                destination: [7; 32],
            },
        }
    }
}
struct Runner {
    svm: LiteSVM,
    payer: Keypair,
    id: Pubkey,
    rows: Vec<Value>,
    sizes: Vec<Value>,
}
#[derive(Clone, Copy, Debug)]
enum Expect {
    Ok,
    Custom(u32),
    Crypto,
    Frozen,
}
impl Runner {
    fn new(elf: &[u8]) -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        let id = Pubkey::new_from_array([42; 32]);
        svm.add_program(id, elf);
        Self {
            svm,
            payer,
            id,
            rows: vec![],
            sizes: vec![],
        }
    }
    fn account(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
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
    fn edit(&mut self, key: Pubkey, edit: impl FnOnce(&mut Account)) {
        let mut a = self.svm.get_account(&key).unwrap();
        edit(&mut a);
        self.svm.set_account(key, a).unwrap();
    }
    fn token(&mut self, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let t = spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut d = vec![0; spl_token::state::Account::LEN];
        spl_token::state::Account::pack(t, &mut d).unwrap();
        self.account(key, spl_token::id(), d);
    }
    fn setup(&mut self, j: &Job) -> (Vec<AccountMeta>, Vec<u8>) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = j.now as i64;
        self.svm.set_sysvar(&clock);
        self.account(j.pool, self.id, j.state.encode().to_vec());
        let mint = Pubkey::new_from_array(j.state.mint);
        let source = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let treasury = Pubkey::new_from_array(j.state.treasury);
        let buffer = Pubkey::new_unique();
        let (authority, _) =
            Pubkey::find_program_address(&[b"i02-vault", j.pool.as_ref()], &self.id);
        self.account(authority, solana_sdk::system_program::id(), vec![]);
        let m = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 20_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut d = vec![0; spl_token::state::Mint::LEN];
        spl_token::state::Mint::pack(m, &mut d).unwrap();
        self.account(mint, spl_token::id(), d);
        self.token(
            source,
            mint,
            if j.op == Operation::Deposit {
                self.payer.pubkey()
            } else {
                authority
            },
            j.state.deposit,
        );
        self.token(
            dest,
            mint,
            if j.op == Operation::Deposit {
                authority
            } else {
                Pubkey::new_from_array([7; 32])
            },
            0,
        );
        self.token(treasury, mint, Pubkey::new_from_array([8; 32]), 0);
        let digest = Sha256::digest(&j.payload);
        let mut d = b"I02BPAYL".to_vec();
        d.extend([2, j.op as u8, 1]);
        d.extend(j.pool.to_bytes());
        d.extend(self.payer.pubkey().to_bytes());
        d.extend((j.now + 3600).to_le_bytes());
        d.extend(digest);
        d.extend(&j.payload);
        self.account(buffer, self.id, d);
        let mut data = disc("global:execute_payload").to_vec();
        data.extend(digest);
        (
            vec![
                AccountMeta::new(j.pool, false),
                AccountMeta::new(source, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(dest, false),
                AccountMeta::new(treasury, false),
                AccountMeta::new_readonly(self.payer.pubkey(), true),
                AccountMeta::new_readonly(spl_token::id(), false),
                AccountMeta::new(buffer, false),
                AccountMeta::new_readonly(authority, false),
            ],
            data,
        )
    }
    fn tx(&self, accounts: Vec<AccountMeta>, data: Vec<u8>) -> VersionedTransaction {
        VersionedTransaction::try_new(
            VersionedMessage::V0(
                v0::Message::try_compile(
                    &self.payer.pubkey(),
                    &[
                        ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
                        Instruction {
                            program_id: self.id,
                            accounts,
                            data,
                        },
                    ],
                    &[],
                    self.svm.latest_blockhash(),
                )
                .unwrap(),
            ),
            &[&self.payer],
        )
        .unwrap()
    }
    #[allow(clippy::result_large_err)]
    fn run(
        &mut self,
        name: &str,
        accounts: Vec<AccountMeta>,
        data: Vec<u8>,
        expected: Expect,
    ) -> TransactionResult {
        let before: Vec<_> = accounts
            .iter()
            .filter(|a| a.is_writable && a.pubkey != self.payer.pubkey())
            .map(|a| (a.pubkey, self.svm.get_account(&a.pubkey).unwrap()))
            .collect();
        let tx = self.tx(accounts, data);
        let size = bincode::serialize(&tx).unwrap().len();
        assert!(size <= 1232);
        let result = self.svm.send_transaction(tx);
        let (ok, meta, error) = match &result {
            Ok(m) => (true, m, None),
            Err(e) => (false, &e.meta, Some(format!("{:?}", e.err))),
        };
        match (expected, &result) {
            (Expect::Ok, Ok(_)) => {}
            (Expect::Custom(code), Err(e)) => assert_eq!(
                e.err,
                TransactionError::InstructionError(1, InstructionError::Custom(code)),
                "{name}: {e:?}"
            ),
            (Expect::Crypto, Err(e)) => assert!(
                matches!(
                    e.err,
                    TransactionError::InstructionError(
                        1,
                        InstructionError::Custom(1) | InstructionError::InvalidInstructionData
                    )
                ),
                "{name}: {e:?}"
            ),
            (Expect::Frozen, Err(e)) => assert_eq!(
                e.err,
                TransactionError::InstructionError(1, InstructionError::Custom(17)),
                "{name}: {e:?}"
            ),
            _ => panic!("{name} expected {expected:?}: {result:?}"),
        }
        assert!(meta.compute_units_consumed < 1_000_000, "{name}");
        if !ok {
            for (key, old) in before {
                assert_eq!(
                    self.svm.get_account(&key).unwrap(),
                    old,
                    "rollback {name}: {key}"
                );
            }
        }
        self.rows.push(json!({"case":name,"ok":ok,"expected":format!("{expected:?}"),"cu":meta.compute_units_consumed,"transaction_bytes":size,"error":error,"inner_instruction_count":meta.inner_instructions.iter().map(|x|x.len()).sum::<usize>(),"logs":meta.logs}));
        result
    }
    fn amount(&self, a: &AccountMeta) -> u64 {
        spl_token::state::Account::unpack(&self.svm.get_account(&a.pubkey).unwrap().data)
            .unwrap()
            .amount
    }
    fn job(&mut self, name: &str, j: &Job, expected: Expect) {
        let (a, d) = self.setup(j);
        let result = self.run(name, a.clone(), d, expected);
        if matches!(expected, Expect::Ok) {
            result.unwrap();
            let got = state::State::decode(&self.svm.get_account(&j.pool).unwrap().data).unwrap();
            let root: &[u8] = &j.payload[j.payload.len() - 608 + 64..j.payload.len() - 608 + 96];
            assert_eq!(got.root, root);
            assert_eq!(got.sequence, j.state.sequence + 1);
            assert_eq!(
                got.status,
                match j.op {
                    Operation::Deposit | Operation::Challenge => 1,
                    Operation::Escape => 2,
                    _ => 3,
                }
            );
            assert_eq!(
                got.next_id,
                j.state.next_id + u64::from(j.op == Operation::Deposit)
            );
            let expected = match j.op {
                Operation::Deposit => [0, j.state.deposit, 0],
                Operation::Close => [0, 4_900_000, j.state.deposit - 4_900_000],
                Operation::Expiry => [0, 0, j.state.deposit],
                _ => [j.state.deposit, 0, 0],
            };
            assert_eq!(
                [self.amount(&a[1]), self.amount(&a[3]), self.amount(&a[4])],
                expected
            );
            if matches!(
                j.op,
                Operation::Close | Operation::Escape | Operation::Challenge
            ) {
                assert_eq!(got.consumed, 1);
            }
            if j.op == Operation::Escape {
                assert_eq!(got.balance, 4_900_000);
                assert_eq!(got.destination, [7; 32]);
                assert_eq!(got.pending_n, got.exit_n);
                assert_eq!(got.old_root, j.state.root);
            }
            assert_eq!(self.svm.get_account(&a[7].pubkey).unwrap().data[10], 0);
            let mut inline = disc("global:i02_inline_size_only").to_vec();
            inline.extend(&j.payload);
            let size = bincode::serialize(&self.tx(a, inline)).unwrap().len();
            self.sizes.push(json!({"case":name,"payload_bytes":j.payload.len(),"inline_transaction_bytes_same_measurement_accounts":size,"inline_fits":size<=1232}));
        }
    }
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixtures = root.join("tests/fixtures/layout2");
    let elf = fs::read(root.join("target/i02b/sbf/zkapi_i02_layout2.so")).unwrap();
    let mut r = Runner::new(&elf);
    let all: Vec<_> = ["a", "a-with-b", "b-with-a", "other-vault", "max-id"]
        .map(|n| read(fixtures.join(format!("{n}.json"))))
        .to_vec();
    let a = &all[0];
    let ab = &all[1];
    let ba = &all[2];
    let other = &all[3];
    assert_eq!(f(&a["trees"][0]["public_inputs"][1]), profile::EMPTY_ROOT);
    // The CLI used OsRng, pinned PK/VK/profile and normative public-first output.
    let cli = fs::read(root.join("target/i02b/cli-tree-update.bin")).unwrap();
    assert_eq!(cli.len(), 608);
    let mut cli_data = disc("global:i02_verify_tree").to_vec();
    cli_data.extend(cli);
    r.run("native-cli/real-proof", vec![], cli_data, Expect::Ok)
        .unwrap();
    // All 30 proofs accepted independently by this SAME SBF verifier.
    for v in &all {
        let name = v["name"].as_str().unwrap();
        for kind in ["request", "withdrawal", "escape"] {
            let mut d = disc(if kind == "request" {
                "global:i02_verify_request"
            } else {
                "global:i02_verify_withdrawal"
            })
            .to_vec();
            d.extend(proof(&v["auth"][kind]));
            r.run(&format!("independent/{name}/{kind}"), vec![], d, Expect::Ok)
                .unwrap();
        }
        for op in 0..3 {
            let mut d = disc("global:i02_verify_tree").to_vec();
            d.extend(proof(&v["trees"][op]));
            r.run(
                &format!("independent/{name}/tree-{op}"),
                vec![],
                d,
                Expect::Ok,
            )
            .unwrap();
        }
    }
    for v in &all {
        for op in [
            Operation::Deposit,
            Operation::Close,
            Operation::Escape,
            Operation::Challenge,
            Operation::Expiry,
        ] {
            if op == Operation::Deposit
                && ["a-with-b", "b-with-a"].contains(&v["name"].as_str().unwrap())
            {
                continue;
            }
            r.job(
                &format!("normal/{}/{op:?}", v["name"].as_str().unwrap()),
                &Job::new(v, op),
                Expect::Ok,
            );
        }
    }
    // Both sides are valid, not byte-corrupted proofs.
    for (name, tree, auth) in [
        ("different-note-same-vault-root", ab, ba),
        ("different-root-same-note-vault", ab, a),
        ("different-vault-same-note-root", a, other),
    ] {
        let mut j = Job::new(tree, Operation::Close);
        j.payload[..704].copy_from_slice(&proof(&auth["auth"]["withdrawal"]));
        r.job(&format!("mixed-valid/{name}"), &j, Expect::Custom(22));
    }
    for (name, auth, err) in [
        ("request-other-pending", ba, 27),
        ("request-other-vault", other, 22),
    ] {
        let mut j = Job::new(ab, Operation::Challenge);
        j.payload[4..644].copy_from_slice(&proof(&auth["auth"]["request"]));
        r.job(&format!("mixed-valid/{name}"), &j, Expect::Custom(err));
    }
    // Valid historical RP root differs from both current and saved Pending root.
    let mut j = Job::new(ab, Operation::Challenge);
    j.payload[4..644].copy_from_slice(&proof(&a["auth"]["request"]));
    assert_ne!(f(&a["auth"]["request"]["public_inputs"][3]), j.state.root);
    assert_ne!(
        f(&a["auth"]["request"]["public_inputs"][3]),
        j.state.old_root
    );
    j.state.paused = 1;
    j.now += 3600; // Historical RP must survive quote/session freshness windows.
    r.job("historical-request/pause-challenge", &j, Expect::Ok);
    // Every public input and proof coordinate is constrained by the fixed VK.
    for (kind, n, v) in [
        ("tree", 11, &a["trees"][1]),
        ("request", 12, &a["auth"]["request"]),
        ("withdrawal", 14, &a["auth"]["withdrawal"]),
    ] {
        let mut raw = disc(&format!("global:i02_verify_{kind}")).to_vec();
        raw.extend(proof(v));
        for i in 0..n {
            let mut d = raw.clone();
            d[8 + i * 32 + 31] ^= 1;
            let _ = r.run(
                &format!("public-mutation/{kind}/{i}"),
                vec![],
                d,
                Expect::Crypto,
            );
        }
        for i in 0..n {
            let mut d = raw.clone();
            d[8 + i * 32..8 + (i + 1) * 32].copy_from_slice(&FR_MODULUS);
            let _ = r.run(
                &format!("noncanonical/{kind}/{i}"),
                vec![],
                d,
                Expect::Custom(21),
            );
        }
        for i in 0..8 {
            let mut d = raw.clone();
            d[8 + n * 32 + i * 32 + 31] ^= 1;
            let _ = r.run(
                &format!("proof-mutation/{kind}/{i}"),
                vec![],
                d,
                Expect::Crypto,
            );
            let mut d = raw.clone();
            let start = 8 + n * 32 + i * 32;
            let mut coordinate = Fq::from_be_bytes_mod_order(&d[start..start + 32]).into_bigint();
            assert!(!coordinate.add_with_carry(&Fq::MODULUS));
            d[start..start + 32].copy_from_slice(&coordinate.to_bytes_be());
            let _ = r.run(
                &format!("noncanonical-coordinate/{kind}/{i}"),
                vec![],
                d,
                Expect::Crypto,
            );
        }
        let start = 8 + n * 32;
        let mut d = raw.clone();
        d[start + 32..start + 64].copy_from_slice(
            &(-Fq::from_be_bytes_mod_order(&raw[start + 32..start + 64]))
                .into_bigint()
                .to_bytes_be(),
        );
        let _ = r.run(&format!("A-sign/{kind}"), vec![], d, Expect::Crypto);
        let mut d = raw.clone();
        for offset in [start + 64, start + 128] {
            d[offset..offset + 32].copy_from_slice(&raw[offset + 32..offset + 64]);
            d[offset + 32..offset + 64].copy_from_slice(&raw[offset..offset + 32]);
        }
        let _ = r.run(&format!("G2-order/{kind}"), vec![], d, Expect::Crypto);
        let b = (0..100u64)
            .filter_map(|i| {
                G2Affine::get_point_from_x_unchecked(Fq2::new(Fq::from(i), Fq::ONE), false)
            })
            .find(|p| !p.is_in_correct_subgroup_assuming_on_curve())
            .unwrap();
        assert!(b.is_on_curve());
        let mut d = raw.clone();
        for (out, coordinate) in d[start + 64..start + 192]
            .chunks_exact_mut(32)
            .zip([b.x.c0, b.x.c1, b.y.c0, b.y.c1])
        {
            out.copy_from_slice(&coordinate.into_bigint().to_bytes_be());
        }
        let _ = r.run(
            &format!("non-subgroup-G2/{kind}"),
            vec![],
            d,
            Expect::Crypto,
        );
        for (name, start, len) in [
            ("infinity-a", 0, 64),
            ("infinity-b", 64, 128),
            ("infinity-c", 192, 64),
        ] {
            let mut d = raw.clone();
            d[8 + n * 32 + start..8 + n * 32 + start + len].fill(0);
            let _ = r.run(&format!("{name}/{kind}"), vec![], d, Expect::Crypto);
        }
    }
    for (name, edit, err) in [
        ("root", 0, 22),
        ("id", 1, 22),
        ("commitment", 2, 22),
        ("deposit", 3, 22),
        ("expiry", 4, 22),
        ("state-key", 5, 22),
        ("clearance-key", 6, 22),
        ("paused", 7, 24),
        ("closed", 8, 24),
        ("nullifier", 9, 27),
        ("profile", 10, 32),
        ("layout", 11, 32),
        ("backend", 12, 32),
        ("policy", 13, 32),
        ("genesis", 14, 22),
    ] {
        let mut j = Job::new(a, Operation::Close);
        match edit {
            0 => j.state.root[31] ^= 1,
            1 => j.state.id += 1,
            2 => j.state.commitment[31] ^= 1,
            3 => j.state.deposit += 1,
            4 => j.state.expiry += 1,
            5 => j.state.keys[0][31] ^= 1,
            6 => j.state.keys[2][31] ^= 1,
            7 => j.state.paused = 1,
            8 => j.state.status = 3,
            9 => j.state.consumed = 1,
            10 => j.state.profile[0] ^= 1,
            11 => j.state.layout = 1,
            12 => j.state.backend = 0,
            13 => j.state.policy = 0,
            14 => j.state.genesis[0] = 1,
            _ => unreachable!(),
        };
        r.job(&format!("state/{name}"), &j, Expect::Custom(err));
    }
    let mut j = Job::new(a, Operation::Escape);
    j.payload[..704].copy_from_slice(&proof(&a["auth"]["withdrawal"]));
    r.job("clearance/close-proof-in-escape", &j, Expect::Custom(22));
    let mut j = Job::new(a, Operation::Close);
    j.payload[..704].copy_from_slice(&proof(&a["auth"]["escape"]));
    r.job("clearance/escape-proof-in-close", &j, Expect::Custom(22));
    for op in [
        Operation::Deposit,
        Operation::Close,
        Operation::Escape,
        Operation::Challenge,
        Operation::Expiry,
    ] {
        for mode in 0..3 {
            let mut j = Job::new(a, op);
            let expected = match mode {
                0 => {
                    j.payload.pop();
                    20
                }
                1 => {
                    j.payload.push(0);
                    20
                }
                _ => {
                    let start = j.payload.len() - 608;
                    let t = proof(&a["trees"][op.tree_op() as usize]);
                    j.payload[start..start + 256].copy_from_slice(&t[352..]);
                    j.payload[start + 256..].copy_from_slice(&t[..352]);
                    22
                }
            };
            r.job(&format!("wire/{op:?}/{mode}"), &j, Expect::Custom(expected));
        }
    }
    let mut j = Job::new(&all[4], Operation::Deposit);
    j.state.next_id = 1u64 << 32;
    r.job("boundary/tree-full", &j, Expect::Custom(26));
    for amount in [0, zkapi_layout2::MAX_AMOUNT + 1] {
        let mut j = Job::new(a, Operation::Deposit);
        j.payload[76..84].copy_from_slice(&amount.to_le_bytes());
        r.job(
            &format!("boundary/deposit-amount-{amount}"),
            &j,
            Expect::Custom(23),
        );
    }
    let mut j = Job::new(a, Operation::Deposit);
    j.payload[44..76].fill(0);
    r.job("boundary/zero-commitment", &j, Expect::Custom(23));
    // A valid proof for another operation is not authority for this entrypoint.
    for (op, wrong_tree) in [(Operation::Close, 2), (Operation::Challenge, 0)] {
        let mut j = Job::new(a, op);
        let start = j.payload.len() - 608;
        j.payload[start..].copy_from_slice(&proof(&a["trees"][wrong_tree]));
        r.job(
            &format!("mixed-valid/wrong-tree-op-{op:?}"),
            &j,
            Expect::Custom(22),
        );
    }
    let mut j = Job::new(a, Operation::Deposit);
    j.now += 86400;
    r.job("boundary/deposit-day-rollover", &j, Expect::Custom(25));
    let mut j = Job::new(a, Operation::Expiry);
    j.now -= 1;
    r.job("boundary/expiry-too-early", &j, Expect::Custom(25));
    j.now += 1;
    j.state.paused = 1;
    r.job("boundary/expiry-at-deadline-paused", &j, Expect::Ok);
    let mut j = Job::new(a, Operation::Challenge);
    j.now = j.state.deadline;
    r.job("boundary/challenge-at-deadline", &j, Expect::Custom(25));
    // Changing the signed expected digest cannot select a different payload.
    for mode in 0..8 {
        let j = Job::new(a, Operation::Close);
        let (ac, mut data) = r.setup(&j);
        let code = match mode {
            0 => {
                data[8] ^= 1;
                33
            }
            1 => {
                r.edit(ac[7].pubkey, |x| x.data[10] = 0);
                33
            }
            2 => {
                r.edit(ac[7].pubkey, |x| x.data[11] ^= 1);
                33
            }
            3 => {
                r.edit(ac[7].pubkey, |x| x.data[43] ^= 1);
                33
            }
            4 => {
                r.edit(ac[7].pubkey, |x| x.owner = solana_sdk::system_program::id());
                30
            }
            5 => {
                r.edit(ac[0].pubkey, |x| x.owner = solana_sdk::system_program::id());
                30
            }
            6 => {
                r.edit(ac[3].pubkey, |x| {
                    let mut t = spl_token::state::Account::unpack(&x.data).unwrap();
                    t.owner = Pubkey::new_from_array([8; 32]);
                    spl_token::state::Account::pack(t, &mut x.data).unwrap();
                });
                22
            }
            _ => {
                r.edit(ac[7].pubkey, |x| {
                    x.data[75..83].copy_from_slice(&j.now.to_le_bytes())
                });
                33
            }
        };
        let _ = r.run(
            &format!("accounts-buffer/{mode}"),
            ac,
            data,
            Expect::Custom(code),
        );
    }
    // Real first CPI succeeds, second fails; all mutable account bytes roll back.
    let j = Job::new(a, Operation::Close);
    let (ac, d) = r.setup(&j);
    r.edit(ac[4].pubkey, |x| {
        let mut t = spl_token::state::Account::unpack(&x.data).unwrap();
        t.state = spl_token::state::AccountState::Frozen;
        spl_token::state::Account::pack(t, &mut x.data).unwrap();
    });
    let e = r
        .run("rollback/second-token-CPI", ac, d, Expect::Frozen)
        .unwrap_err();
    assert_eq!(
        e.meta
            .inner_instructions
            .iter()
            .map(|x| x.len())
            .sum::<usize>(),
        2
    );
    assert!(e
        .meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {} success", spl_token::id())));
    // One coherent escape -> historical challenge -> same-N replay sequence.
    let j = Job::new(a, Operation::Escape);
    let (ac, d) = r.setup(&j);
    r.run("sequence/escape", ac.clone(), d, Expect::Ok).unwrap();
    let escaped = state::State::decode(&r.svm.get_account(&j.pool).unwrap().data).unwrap();
    let mut challenge = Job::new(a, Operation::Challenge);
    challenge.state = escaped;
    let (ac, d) = r.setup(&challenge);
    r.run("sequence/challenge", ac, d, Expect::Ok).unwrap();
    let restored = state::State::decode(&r.svm.get_account(&j.pool).unwrap().data).unwrap();
    let mut replay = Job::new(a, Operation::Escape);
    replay.state = restored;
    r.job(
        "sequence/consumed-N-after-challenge",
        &replay,
        Expect::Custom(27),
    );
    let wrong_elf = fs::read(root.join("target/i02b/sbf-wrong/zkapi_i02_layout2.so")).unwrap();
    let mut wrong = Runner::new(&wrong_elf);
    for (kind, v) in [
        ("tree", &a["trees"][1]),
        ("request", &a["auth"]["request"]),
        ("withdrawal", &a["auth"]["withdrawal"]),
    ] {
        let mut d = disc(&format!("global:i02_verify_{kind}")).to_vec();
        d.extend(proof(v));
        let _ = wrong.run(
            &format!("wrong-compiled-VK/{kind}"),
            vec![],
            d,
            Expect::Crypto,
        );
    }
    r.rows.extend(wrong.rows);
    let result = json!({"scope":"I02-B; actual SBF v0 and v0 transactions; measurement snapshots, prefilled sealed buffers and existing token accounts; no Vault/PDA/ATA creation or upload lifecycle claim","compute_budget":1_000_000,"packet_limit":1232,"svm":"LiteSVM 0.6.1 / Agave 2.2.0","sbf_arch":"v0","elf_sha256":hash(&elf),"wrong_elf_sha256":hash(&wrong_elf),"profile_hash":hex::encode(profile::PROFILE),"production_eligible":false,"cases":r.rows,"sizes":r.sizes});
    fs::write(
        root.join("docs/evidence/I02B-svm-results.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!(
        "PASS: {} real SBF cases",
        result["cases"].as_array().unwrap().len()
    );
}
