//! I09's newly generated payload executed by the real Vault through v0 buffers.
//! Local test keys/mint only; this is not the daemon/broadcaster recovery gate.
#![allow(dead_code, deprecated, clippy::result_large_err)]
#[path = "../vault_support.rs"]
mod support;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{clock::Clock, instruction::AccountMeta, pubkey::Pubkey, signature::Signer};
use std::{fs, path::Path};
use support::*;
use zkapi_layout2::Operation;
use zkapi_vault::{ExitNullifier, Note, PendingWithdrawal, TreeState};

fn upload_execute(
    w: &mut World,
    fixture: &Value,
    op: Operation,
    body: &[u8],
    nonce: u8,
    name: &str,
    expected: Expect,
) {
    let nonce = [nonce; 32];
    let uploader = w.attacker.pubkey();
    let buffer = Pubkey::find_program_address(
        &[b"payload", w.pool.as_ref(), uploader.as_ref(), &nonce],
        &w.id,
    )
    .0;
    let digest: [u8; 32] = Sha256::digest(body).into();
    let mut args = vec![op as u8];
    args.extend((body.len() as u32).to_le_bytes());
    args.extend(digest);
    args.extend(nonce);
    args.extend((w.svm.get_sysvar::<Clock>().unix_timestamp as u64 + 3600).to_le_bytes());
    w.run(
        &format!("{name}/create"),
        vec![
            AccountMeta::new(buffer, false),
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new_readonly(uploader, true),
            AccountMeta::new(uploader, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data("create_payload", &args),
        Expect::Ok,
    )
    .unwrap();
    let upload_accounts = vec![
        AccountMeta::new(buffer, false),
        AccountMeta::new_readonly(w.pool, false),
        AccountMeta::new_readonly(uploader, true),
    ];
    for (i, part) in body.chunks(700).enumerate() {
        let mut args = ((i * 700) as u32).to_le_bytes().to_vec();
        args.extend((part.len() as u32).to_le_bytes());
        args.extend(part);
        w.run(
            &format!("{name}/append/{i}"),
            upload_accounts.clone(),
            data("append_payload", &args),
            Expect::Ok,
        )
        .unwrap();
    }
    w.run(
        &format!("{name}/seal"),
        upload_accounts,
        data("seal_payload", &[]),
        Expect::Ok,
    )
    .unwrap();
    let mut accounts = vec![
        AccountMeta::new(buffer, false),
        AccountMeta::new_readonly(uploader, true),
        AccountMeta::new(uploader, false),
    ];
    let n = matches!(op, Operation::Close | Operation::Escape)
        .then(|| field(&fixture["auth"]["withdrawal"]["public_inputs"][11]));
    accounts.extend(w.financial(fixture["id"].as_u64().unwrap() as u32, n, Some(op)));
    let before = w.state::<TreeState>(w.tree);
    let result = w.run(
        &format!("{name}/execute"),
        accounts,
        data("execute_payload", &digest),
        expected,
    );
    if matches!(expected, Expect::Ok) {
        result.unwrap();
        w.assert_event(&before, op as u8);
        assert!(w.svm.get_account(&buffer).is_none_or(|a| a.lamports == 0));
    } else {
        result.unwrap_err();
        assert!(w.svm.get_account(&buffer).is_some_and(|a| a.lamports > 0));
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = root.join("target/i09-challenger");
    let elf =
        fs::read(root.join("target/i04-sbf/zkapi_vault.so")).expect("build I04 Vault ELF first");
    let generated =
        fs::read(out.join("generated-challenge.bin")).expect("run I09 proof generation first");
    let proof_report = read(out.join("proof-generation.json"));
    assert_eq!(
        hex::encode(Sha256::digest(&generated)),
        proof_report["payload_sha256"]
    );
    assert_eq!(generated.len(), 1252);
    let a = read(root.join("tests/fixtures/vault/a.json"));
    let b = read(root.join("tests/fixtures/vault/b-with-a.json"));
    let ab = read(root.join("tests/fixtures/vault/a-with-b.json"));
    let mut rows = Vec::new();
    for scenario in ["historical", "paused", "deadline"] {
        let mut w = World::new(&elf);
        w.initialize(&a);
        for (fixture, op, nonce, name) in [
            (&a, Operation::Deposit, 81, "deposit-a"),
            (&b, Operation::Deposit, 82, "deposit-b"),
        ] {
            upload_execute(
                &mut w,
                fixture,
                op,
                &payload(fixture, op),
                nonce,
                name,
                Expect::Ok,
            );
        }
        let restored_root = w.state::<TreeState>(w.tree).root;
        upload_execute(
            &mut w,
            &ab,
            Operation::Escape,
            &payload(&ab, Operation::Escape),
            83,
            "escape-a",
            Expect::Ok,
        );
        let pending = w.state::<PendingWithdrawal>(w.pending(0));
        let n = field(&a["auth"]["request"]["public_inputs"][8]);
        assert_eq!(n, pending.nullifier);
        assert_ne!(
            field(&a["auth"]["request"]["public_inputs"][3]),
            pending.old_root
        );
        assert_ne!(
            field(&a["auth"]["request"]["public_inputs"][3]),
            w.state::<TreeState>(w.tree).root
        );
        if scenario == "paused" {
            w.admin("pause", &[], Expect::Ok).unwrap();
        }
        w.clock((pending.deadline - u64::from(scenario != "deadline")) as i64);
        upload_execute(
            &mut w,
            &ab,
            Operation::Challenge,
            &generated,
            84,
            "new-challenger-payload",
            if scenario == "deadline" {
                Expect::Error(6014)
            } else {
                Expect::Ok
            },
        );
        if scenario == "deadline" {
            assert!(w.state::<PendingWithdrawal>(w.pending(0)).exists);
            assert_eq!(w.state::<Note>(w.note(0)).status, 2);
        } else {
            assert!(!w.state::<PendingWithdrawal>(w.pending(0)).exists);
            assert_eq!(w.state::<Note>(w.note(0)).status, 1);
            assert_eq!(w.state::<TreeState>(w.tree).root, restored_root);
            assert_eq!(w.state::<TreeState>(w.tree).sequence, 4);
            if scenario == "paused" {
                w.admin("unpause", &[], Expect::Ok).unwrap();
            }
            upload_execute(
                &mut w,
                &ab,
                Operation::Challenge,
                &generated,
                85,
                "repeated-challenge",
                Expect::Error(6013),
            );
            upload_execute(
                &mut w,
                &ab,
                Operation::Escape,
                &payload(&ab, Operation::Escape),
                86,
                "escape-consumed-nullifier",
                Expect::Error(6011),
            );
        }
        assert!(w.state::<ExitNullifier>(w.exit(&n)).consumed);
        assert_eq!(w.amount(w.vault), DEPOSIT * 2);
        assert_eq!(w.amount(w.destination), 0);
        assert_eq!(w.amount(w.treasury), 0);
        assert_eq!(
            w.state::<TreeState>(w.tree).outstanding_deposits,
            DEPOSIT * 2
        );
        for mut row in w.rows {
            row["scenario"] = scenario.into();
            rows.push(row);
        }
    }
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
    let rejected = rows.iter().filter(|r| r["ok"] == false).count();
    let report = json!({"scope":"I09 newly generated native payload, real Vault SBF/v0 buffer lifecycle, historical RP/current tree, pause/deadline/tombstone; no daemon, SDK broadcaster, live RPC or recovery claim", "passed":true, "elf_sha256":hex::encode(Sha256::digest(&elf)), "payload_sha256":hex::encode(Sha256::digest(&generated)), "transactions":rows.len(), "expected_rejections":rejected, "max_cu":max_cu, "max_transaction_bytes":max_bytes, "cases":rows, "release_gates_passed":[]});
    fs::write(
        out.join("svm-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("PASS I09 new challenger payload: {} actual SBF transactions, {rejected} expected rejections, max {max_cu} CU / {max_bytes} bytes", rows.len());
}
