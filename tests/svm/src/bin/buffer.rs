//! I04 real SBF lifecycle tests: every buffer is created through the program.
#![allow(dead_code, clippy::result_large_err)]
#[path = "../vault_support.rs"]
mod support;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account, clock::Clock, instruction::AccountMeta, pubkey::Pubkey, signature::Signer,
};
use std::{fs, path::Path};
use support::*;
use zkapi_layout2::Operation;
use zkapi_vault::PayloadBuffer;

struct Upload {
    key: Pubkey,
    nonce: [u8; 32],
    digest: [u8; 32],
    body: Vec<u8>,
    op: Operation,
    uploader: Pubkey,
    rent_payer: Pubkey,
    expires: u64,
}
impl Upload {
    fn new(w: &World, fixture: &Value, op: Operation, nonce: u8) -> Self {
        let body = payload(fixture, op);
        let uploader = w.attacker.pubkey();
        let rent_payer = w.attacker.pubkey();
        let nonce = [nonce; 32];
        let key = Pubkey::find_program_address(
            &[b"payload", w.pool.as_ref(), uploader.as_ref(), &nonce],
            &w.id,
        )
        .0;
        let digest = Sha256::digest(&body).into();
        Self {
            key,
            nonce,
            digest,
            body,
            op,
            uploader,
            rent_payer,
            expires: w.svm.get_sysvar::<Clock>().unix_timestamp as u64 + 3600,
        }
    }
    fn create_accounts(&self, w: &World) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new_readonly(self.uploader, true),
            AccountMeta::new(self.rent_payer, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ]
    }
    fn upload_accounts(&self, w: &World) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new_readonly(self.uploader, true),
        ]
    }
    fn close_accounts(&self, w: &World, closer: Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new_readonly(closer, true),
            AccountMeta::new(self.rent_payer, false),
        ]
    }
    fn create_data(&self) -> Vec<u8> {
        let mut args = vec![self.op as u8];
        args.extend((self.body.len() as u32).to_le_bytes());
        args.extend(self.digest);
        args.extend(self.nonce);
        args.extend(self.expires.to_le_bytes());
        data("create_payload", &args)
    }
    fn create(&self, w: &mut World, name: &str) {
        let state_before = w.svm.get_account(&w.tree);
        let vault_before = w.svm.get_account(&w.vault);
        w.run(
            name,
            self.create_accounts(w),
            self.create_data(),
            Expect::Ok,
        )
        .unwrap();
        let b: PayloadBuffer = w.state(self.key);
        assert_eq!(b.payload, vec![0; self.body.len()]);
        assert_eq!(b.next_offset, 0);
        assert_eq!(b.rent_payer, self.rent_payer);
        assert!(!b.sealed);
        assert_eq!(
            w.svm.get_account(&self.key).unwrap().data.len(),
            160 + self.body.len()
        );
        assert_eq!(w.svm.get_account(&w.tree), state_before);
        assert_eq!(w.svm.get_account(&w.vault), vault_before);
    }
    fn append_data(offset: u32, bytes: &[u8]) -> Vec<u8> {
        let mut args = offset.to_le_bytes().to_vec();
        args.extend((bytes.len() as u32).to_le_bytes());
        args.extend(bytes);
        data("append_payload", &args)
    }
    fn upload(&self, w: &mut World, name: &str) {
        self.create(w, &format!("{name}/create"));
        self.finish(w, name);
    }
    fn finish(&self, w: &mut World, name: &str) {
        let offset = w.state::<PayloadBuffer>(self.key).next_offset as usize;
        for (chunk, part) in self.body[offset..].chunks(700).enumerate() {
            let start = offset + chunk * 700;
            w.run(
                &format!("{name}/append/{start}"),
                self.upload_accounts(w),
                Self::append_data(start as u32, part),
                Expect::Ok,
            )
            .unwrap();
            let b: PayloadBuffer = w.state(self.key);
            assert_eq!(b.next_offset as usize, start + part.len());
            assert_eq!(
                &b.payload[..start + part.len()],
                &self.body[..start + part.len()]
            );
        }
        w.run(
            &format!("{name}/seal"),
            self.upload_accounts(w),
            data("seal_payload", &[]),
            Expect::Ok,
        )
        .unwrap();
        assert!(w.state::<PayloadBuffer>(self.key).sealed);
    }
    fn execute_accounts(&self, w: &World, fixture: &Value) -> Vec<AccountMeta> {
        let n = matches!(self.op, Operation::Close | Operation::Escape)
            .then(|| field(&fixture["auth"]["withdrawal"]["public_inputs"][11]));
        let mut result = vec![
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(self.uploader, true),
            AccountMeta::new(self.rent_payer, false),
        ];
        result.extend(w.financial(fixture["id"].as_u64().unwrap() as u32, n, Some(self.op)));
        result
    }
    fn execute(&self, w: &mut World, fixture: &Value, name: &str, expected: Expect) {
        let before = w.svm.get_account(&self.rent_payer).unwrap().lamports;
        let rent = w.svm.get_account(&self.key).unwrap().lamports;
        let result = w.run(
            name,
            self.execute_accounts(w, fixture),
            data("execute_payload", &self.digest),
            expected,
        );
        if matches!(expected, Expect::Ok) {
            result.unwrap();
            assert!(w.svm.get_account(&self.key).is_none_or(|a| a.lamports == 0));
            assert_eq!(
                w.svm.get_account(&self.rent_payer).unwrap().lamports,
                before + rent
            );
        } else {
            result.unwrap_err();
        }
    }
    fn close(&self, w: &mut World, closer: Pubkey, name: &str, expected: Expect) {
        let before = w.svm.get_account(&self.rent_payer).unwrap().lamports;
        let rent = w.svm.get_account(&self.key).unwrap().lamports;
        let result = w.run(
            name,
            self.close_accounts(w, closer),
            data("close_payload", &[]),
            expected,
        );
        if matches!(expected, Expect::Ok) {
            result.unwrap();
            assert!(w.svm.get_account(&self.key).is_none_or(|a| a.lamports == 0));
            assert_eq!(
                w.svm.get_account(&self.rent_payer).unwrap().lamports,
                before + rent
            );
        } else {
            result.unwrap_err();
        }
    }
}
fn fresh(elf: &[u8], fixture: &Value) -> World {
    let mut w = World::new(elf);
    w.initialize(fixture);
    w
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let elf =
        fs::read(root.join("target/i04-sbf/zkapi_vault.so")).expect("build I04 SBF ELF first");
    let a = read(root.join("tests/fixtures/vault/a.json"));
    let mut rows = vec![];
    // Full successful operations use only real create/append/seal/execute instructions.
    for terminal in [Operation::Close, Operation::Escape, Operation::Expiry] {
        let mut w = fresh(&elf, &a);
        let d = Upload::new(&w, &a, Operation::Deposit, 1);
        d.upload(&mut w, "lifecycle/deposit");
        d.execute(&mut w, &a, "lifecycle/deposit/execute", Expect::Ok);
        if terminal == Operation::Expiry {
            w.clock(a["expiry"].as_u64().unwrap() as i64);
        }
        let u = Upload::new(&w, &a, terminal, 2);
        u.upload(&mut w, &format!("lifecycle/{terminal:?}"));
        u.execute(
            &mut w,
            &a,
            &format!("lifecycle/{terminal:?}/execute"),
            Expect::Ok,
        );
        if terminal == Operation::Escape {
            let c = Upload::new(&w, &a, Operation::Challenge, 3);
            c.upload(&mut w, "lifecycle/challenge");
            c.execute(&mut w, &a, "lifecycle/challenge/execute", Expect::Ok);
        }
        rows.extend(w.rows);
    }
    // Interrupted uploads resume from persisted offset; replays fail without changes.
    {
        let mut w = fresh(&elf, &a);
        let u = Upload::new(&w, &a, Operation::Deposit, 4);
        u.create(&mut w, "resume/create");
        w.run(
            "resume/create-replay",
            u.create_accounts(&w),
            u.create_data(),
            Expect::Reject,
        )
        .unwrap_err();
        w.run(
            "resume/seal-incomplete",
            u.upload_accounts(&w),
            data("seal_payload", &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        u.execute(&mut w, &a, "resume/execute-unsealed", Expect::Error(6017));
        w.run(
            "resume/first-prefix",
            u.upload_accounts(&w),
            Upload::append_data(0, &u.body[..101]),
            Expect::Ok,
        )
        .unwrap();
        for offset in [0, 100, 102, u32::MAX] {
            w.run(
                &format!("resume/wrong-offset/{offset}"),
                u.upload_accounts(&w),
                Upload::append_data(offset, &[1]),
                Expect::Error(6017),
            )
            .unwrap_err();
        }
        let mut wrong = u.upload_accounts(&w);
        wrong[2] = AccountMeta::new_readonly(w.payer.pubkey(), true);
        w.run(
            "resume/wrong-uploader",
            wrong,
            Upload::append_data(101, &[1]),
            Expect::Error(6017),
        )
        .unwrap_err();
        let mut unsigned = u.upload_accounts(&w);
        unsigned[2].is_signer = false;
        w.run(
            "resume/unsigned-uploader",
            unsigned,
            Upload::append_data(101, &[1]),
            Expect::Reject,
        )
        .unwrap_err();
        u.finish(&mut w, "resume/restarted-client");
        w.run(
            "resume/sealed-append",
            u.upload_accounts(&w),
            Upload::append_data(u.body.len() as u32, &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        w.run(
            "resume/repeated-seal",
            u.upload_accounts(&w),
            data("seal_payload", &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        let mut wrong = u.execute_accounts(&w, &a);
        wrong[1] = AccountMeta::new_readonly(w.payer.pubkey(), true);
        w.run(
            "resume/third-party-execute",
            wrong,
            data("execute_payload", &u.digest),
            Expect::Error(6017),
        )
        .unwrap_err();
        let mut digest = u.digest;
        digest[0] ^= 1;
        w.run(
            "resume/wrong-digest",
            u.execute_accounts(&w, &a),
            data("execute_payload", &digest),
            Expect::Error(6017),
        )
        .unwrap_err();
        u.execute(&mut w, &a, "resume/final-execute", Expect::Ok);
        w.run(
            "resume/execute-replay",
            u.execute_accounts(&w, &a),
            data("execute_payload", &u.digest),
            Expect::Error(6017),
        )
        .unwrap_err();
        rows.extend(w.rows);
    }
    // Creation limits, canonical account identity and exact argument lengths.
    {
        let mut w = fresh(&elf, &a);
        let u = Upload::new(&w, &a, Operation::Deposit, 5);
        for (name, start, bytes) in [
            ("unknown-op", 8, vec![5]),
            ("wrong-length", 9, 691u32.to_le_bytes().to_vec()),
            ("zero-length", 9, 0u32.to_le_bytes().to_vec()),
            ("over-limit", 9, 4097u32.to_le_bytes().to_vec()),
            ("expired-equal", 77, NOW.to_le_bytes().to_vec()),
            ("too-future", 77, (NOW + 3601).to_le_bytes().to_vec()),
        ] {
            let mut args = u.create_data();
            args[start..start + bytes.len()].copy_from_slice(&bytes);
            w.run(
                &format!("create/{name}"),
                u.create_accounts(&w),
                args,
                Expect::Error(6017),
            )
            .unwrap_err();
        }
        for (name, slot, key) in [("wrong-pda", 0, w.tree), ("wrong-pool", 1, w.tree)] {
            let mut accounts = u.create_accounts(&w);
            accounts[slot].pubkey = key;
            w.run(
                &format!("create/{name}"),
                accounts,
                u.create_data(),
                Expect::Reject,
            )
            .unwrap_err();
        }
        for slot in [2, 3] {
            let mut accounts = u.create_accounts(&w);
            // Uploader and payer alias here; remove both signer flags to test unsigned identity.
            accounts[2].is_signer = false;
            accounts[3].is_signer = false;
            w.run(
                &format!("create/unsigned/{slot}"),
                accounts,
                u.create_data(),
                Expect::Reject,
            )
            .unwrap_err();
        }
        for cut in [8, 84] {
            w.run(
                &format!("create/truncated/{cut}"),
                u.create_accounts(&w),
                u.create_data()[..cut].to_vec(),
                Expect::Error(6017),
            )
            .unwrap_err();
        }
        let mut trailing = u.create_data();
        trailing.push(0);
        w.run(
            "create/trailing",
            u.create_accounts(&w),
            trailing,
            Expect::Error(6017),
        )
        .unwrap_err();
        w.clock(-1);
        w.run(
            "create/negative-clock",
            u.create_accounts(&w),
            u.create_data(),
            Expect::Error(6018),
        )
        .unwrap_err();
        w.clock(NOW as i64);
        // A third party may pre-fund the PDA; allocation must remain usable.
        w.svm
            .set_account(
                u.key,
                Account {
                    lamports: 1,
                    data: vec![],
                    owner: solana_sdk::system_program::id(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        u.create(&mut w, "create/prefunded-pda");
        for (name, mut args) in [
            ("truncated", Upload::append_data(0, &[1])),
            ("trailing", Upload::append_data(0, &[1])),
            ("huge-prefix", Upload::append_data(0, &[1])),
        ] {
            match name {
                "truncated" => {
                    args.pop();
                }
                "trailing" => args.push(0),
                _ => args[12..16].copy_from_slice(&u32::MAX.to_le_bytes()),
            }
            w.run(
                &format!("append/{name}"),
                u.upload_accounts(&w),
                args,
                Expect::Error(6017),
            )
            .unwrap_err();
        }
        w.run(
            "append/out-of-range",
            u.upload_accounts(&w),
            Upload::append_data(0, &vec![1; u.body.len() + 1]),
            Expect::Error(6017),
        )
        .unwrap_err();
        w.run(
            "append/wrong-hash-body",
            u.upload_accounts(&w),
            Upload::append_data(0, &vec![1; u.body.len()]),
            Expect::Ok,
        )
        .unwrap();
        w.run(
            "seal/digest-mismatch",
            u.upload_accounts(&w),
            data("seal_payload", &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        u.close(&mut w, u.uploader, "close/bad-payload-abort", Expect::Ok);
        rows.extend(w.rows);
    }
    // Expiry boundary, independent refund, and same-PDA different-digest generation.
    {
        let mut w = fresh(&elf, &a);
        let u = Upload::new(&w, &a, Operation::Deposit, 6);
        u.upload(&mut w, "close/sealed");
        let stranger = w.payer.pubkey();
        u.close(
            &mut w,
            stranger,
            "close/stranger-before-expiry",
            Expect::Error(6017),
        );
        let mut wrong_refund = u.close_accounts(&w, u.uploader);
        wrong_refund[3].pubkey = stranger;
        w.run(
            "close/wrong-refund",
            wrong_refund,
            data("close_payload", &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        let mut trailing = data("seal_payload", &[]);
        trailing.push(0);
        w.run(
            "seal/trailing",
            u.upload_accounts(&w),
            trailing,
            Expect::Error(6017),
        )
        .unwrap_err();
        let mut trailing = data("close_payload", &[]);
        trailing.push(0);
        w.run(
            "close/trailing",
            u.close_accounts(&w, u.uploader),
            trailing,
            Expect::Error(6017),
        )
        .unwrap_err();
        w.clock(u.expires as i64);
        u.execute(&mut w, &a, "execute/expiry-equal", Expect::Error(6017));
        u.close(&mut w, stranger, "close/stranger-expiry-equal", Expect::Ok);
        w.clock(NOW as i64);
        let mut replacement = Upload::new(&w, &a, Operation::Deposit, 6);
        replacement.body[0] ^= 1;
        replacement.digest = Sha256::digest(&replacement.body).into();
        replacement.upload(&mut w, "generation/recreated");
        assert_eq!(replacement.key, u.key);
        w.run(
            "generation/old-signed-digest",
            u.execute_accounts(&w, &a),
            data("execute_payload", &u.digest),
            Expect::Error(6017),
        )
        .unwrap_err();
        replacement.close(&mut w, replacement.uploader, "generation/abort", Expect::Ok);
        // Aborting before upload and expiry of an unsealed account also work.
        let empty = Upload::new(&w, &a, Operation::Deposit, 7);
        empty.create(&mut w, "abort/created");
        empty.close(&mut w, empty.uploader, "abort/immediate", Expect::Ok);
        let expired = Upload::new(&w, &a, Operation::Deposit, 8);
        expired.create(&mut w, "expiry/unsealed-create");
        w.clock(expired.expires as i64);
        w.run(
            "expiry/append-at-equality",
            expired.upload_accounts(&w),
            Upload::append_data(0, &[1]),
            Expect::Error(6017),
        )
        .unwrap_err();
        w.run(
            "expiry/seal-at-equality",
            expired.upload_accounts(&w),
            data("seal_payload", &[]),
            Expect::Error(6017),
        )
        .unwrap_err();
        expired.close(
            &mut w,
            stranger,
            "expiry/unsealed-third-party-close",
            Expect::Ok,
        );
        rows.extend(w.rows);
    }
    // An uploader may be different from the refund payer; only the saved payer receives rent.
    {
        let mut w = fresh(&elf, &a);
        let mut u = Upload::new(&w, &a, Operation::Deposit, 10);
        u.uploader = w.payer.pubkey();
        u.key = Pubkey::find_program_address(
            &[b"payload", w.pool.as_ref(), u.uploader.as_ref(), &u.nonce],
            &w.id,
        )
        .0;
        u.upload(&mut w, "separate-rent-payer");
        u.close(&mut w, u.uploader, "separate-rent-payer/refund", Expect::Ok);
        rows.extend(w.rows);
    }
    // A second uploaded operation can become stale; its buffer remains abortable.
    {
        let mut w = fresh(&elf, &a);
        let first = Upload::new(&w, &a, Operation::Deposit, 11);
        let racing = Upload::new(&w, &a, Operation::Deposit, 12);
        first.upload(&mut w, "race/first");
        racing.upload(&mut w, "race/second");
        first.execute(&mut w, &a, "race/winner", Expect::Ok);
        racing.execute(&mut w, &a, "race/loser-stale-id", Expect::Error(6007));
        assert!(w.state::<PayloadBuffer>(racing.key).sealed);
        racing.close(&mut w, racing.uploader, "race/abort-loser", Expect::Ok);
        // Two valid close proofs for different current roots must not be silently retried.
        let stale = Upload::new(&w, &a, Operation::Close, 13);
        stale.upload(&mut w, "race/old-root-close");
        let ba = read(root.join("tests/fixtures/vault/b-with-a.json"));
        let other = Upload::new(&w, &ba, Operation::Deposit, 14);
        other.upload(&mut w, "race/new-deposit");
        other.execute(&mut w, &ba, "race/root-advanced", Expect::Ok);
        stale.execute(&mut w, &a, "race/close-stale-root", Expect::Error(6006));
        stale.close(&mut w, stale.uploader, "race/abort-old-root", Expect::Ok);
        rows.extend(w.rows);
    }
    // Upload is committed separately, but both token transfers and execute consumption roll back.
    {
        let mut w = fresh(&elf, &a);
        let d = Upload::new(&w, &a, Operation::Deposit, 15);
        d.upload(&mut w, "rollback/deposit");
        d.execute(&mut w, &a, "rollback/deposit-execute", Expect::Ok);
        w.token(w.treasury, w.treasury_owner, 0);
        w.edit_token(w.treasury, |t| {
            t.state = spl_token::state::AccountState::Frozen
        });
        let close = Upload::new(&w, &a, Operation::Close, 16);
        close.upload(&mut w, "rollback/close");
        assert!(w.svm.get_account(&w.destination).is_none());
        close.execute(
            &mut w,
            &a,
            "rollback/second-transfer-frozen",
            Expect::Error(17),
        );
        assert!(w.state::<PayloadBuffer>(close.key).sealed);
        assert!(w.svm.get_account(&w.destination).is_none());
        let logs = w.rows.last().unwrap()["logs"].as_array().unwrap();
        let transfers: Vec<_> = logs
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                l.as_str()
                    .unwrap()
                    .contains("Instruction: TransferChecked")
                    .then_some(i)
            })
            .collect();
        assert_eq!(transfers.len(), 2);
        assert!(logs[transfers[0] + 1..transfers[1]]
            .iter()
            .any(|l| l.as_str().unwrap().contains("success")));
        w.edit_token(w.treasury, |t| {
            t.state = spl_token::state::AccountState::Initialized
        });
        close.execute(
            &mut w,
            &a,
            "rollback/retry-same-buffer-after-chain-failure",
            Expect::Ok,
        );
        rows.extend(w.rows);
    }
    // Corrupted account fixtures exercise owner/layout/seed/pool binding fail-closed.
    for field_name in [
        "layout", "bump", "nonce", "uploader", "len", "offset", "owner", "pool", "space",
    ] {
        let mut w = fresh(&elf, &a);
        let u = Upload::new(&w, &a, Operation::Deposit, 9);
        u.create(&mut w, "identity/create");
        match field_name {
            "owner" => w.edit(u.key, |a| a.owner = solana_sdk::system_program::id()),
            "space" => w.edit(u.key, |a| a.data.push(0)),
            "pool" => {}
            _ => w.edit_state::<PayloadBuffer>(u.key, |b| match field_name {
                "layout" => b.layout_version = 1,
                "bump" => b.bump ^= 1,
                "nonce" => b.nonce[0] ^= 1,
                "uploader" => b.uploader = Pubkey::new_unique(),
                "len" => b.payload_len -= 1,
                "offset" => b.next_offset = b.payload_len + 1,
                _ => unreachable!(),
            }),
        }
        let mut accounts = u.upload_accounts(&w);
        if field_name == "pool" {
            accounts[1].pubkey = w.tree;
        }
        w.run(
            &format!("identity/{field_name}"),
            accounts,
            Upload::append_data(0, &[1]),
            Expect::Reject,
        )
        .unwrap_err();
        rows.extend(w.rows);
    }
    let successes = rows.iter().filter(|r| r["ok"] == true).count();
    let max_cu = rows
        .iter()
        .map(|r| r["cu"].as_u64().unwrap())
        .max()
        .unwrap();
    let max_bytes = rows
        .iter()
        .map(|r| r["transaction_bytes"].as_u64().unwrap())
        .max()
        .unwrap();
    let report = json!({"scope":"I04 real Vault SBF buffer lifecycle; no pre-seeded successful buffer; real tree/auth proofs and token CPI; local test mint/setup only",
        "elf_sha256":hex::encode(Sha256::digest(&elf)),"cases":rows.len(),"successful_transactions":successes,"rejected_transactions":rows.len()-successes,
        "max_cu":max_cu,"max_transaction_bytes":max_bytes,"transport":"v0, no ALT, 1M CU","rows":rows});
    fs::create_dir_all(root.join("docs/evidence")).unwrap();
    fs::write(
        root.join("docs/evidence/I04-buffer-svm-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "I04 buffer PASS: {} transactions, {} rejected, max {max_cu} CU, {max_bytes} bytes",
        rows.len(),
        rows.len() - successes
    );
}
