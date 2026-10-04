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
    for scenario in ["historical", "paused", "deadline", "sdk-signed"] {
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
        if scenario == "sdk-signed" {
            let generated_txs = std::process::Command::new("node")
                .arg(root.join("packages/sdk/test/challenger-sbf.ts"))
                .arg(w.svm.latest_blockhash().to_string())
                .arg(w.svm.get_sysvar::<Clock>().unix_timestamp.to_string())
                .output()
                .expect("challenger SDK bridge");
            assert!(
                generated_txs.status.success(),
                "{}",
                String::from_utf8_lossy(&generated_txs.stderr)
            );
            let signed: Value = serde_json::from_slice(&generated_txs.stdout).unwrap();
            let mut kinds = Vec::new();
            for attempt in signed["transactions"].as_array().unwrap() {
                let raw = hex::decode(attempt["wireHex"].as_str().unwrap()).unwrap();
                let tx: solana_sdk::transaction::VersionedTransaction =
                    bincode::deserialize(&raw).unwrap();
                assert_eq!(
                    tx.signatures[0].to_string(),
                    attempt["signature"].as_str().unwrap()
                );
                assert!(raw.len() <= 1232);
                let before = w.state::<TreeState>(w.tree);
                let meta = w
                    .svm
                    .send_transaction(tx)
                    .expect("SDK challenger signed v0 transaction");
                assert!(meta.compute_units_consumed <= 1_000_000);
                if attempt["kind"] == "execute" {
                    assert_eq!(w.state::<TreeState>(w.tree).sequence, before.sequence + 1);
                }
                kinds.push(attempt["kind"].as_str().unwrap().to_owned());
                w.rows.push(json!({"case":format!("sdk-challenger/{}",attempt["kind"].as_str().unwrap()),"ok":true,"expected":"Ok","cu":meta.compute_units_consumed,"transaction_bytes":raw.len(),"logs":meta.logs}));
            }
            assert_eq!(kinds.first().unwrap(), "create");
            assert_eq!(kinds.last().unwrap(), "execute");
            assert_eq!(kinds.iter().filter(|k| *k == "seal").count(), 1);
            assert!(kinds.iter().filter(|k| *k == "append").count() >= 2);
        } else {
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
        }
        if scenario == "sdk-signed" {
            let output = std::process::Command::new("node")
                .arg(root.join("packages/sdk/test/challenger-sbf.ts"))
                .arg(w.svm.latest_blockhash().to_string())
                .arg(w.svm.get_sysvar::<Clock>().unix_timestamp.to_string())
                .arg("cleanup")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let cleanup: Value = serde_json::from_slice(&output.stdout).unwrap();
            let buffer = cleanup["buffer"]
                .as_str()
                .unwrap()
                .parse::<Pubkey>()
                .unwrap();
            for attempt in cleanup["transactions"].as_array().unwrap() {
                let bytes = hex::decode(attempt["wireHex"].as_str().unwrap()).unwrap();
                let tx: solana_sdk::transaction::VersionedTransaction =
                    bincode::deserialize(&bytes).unwrap();
                let before = w.svm.get_account(&w.attacker.pubkey()).unwrap().lamports;
                let result = w.svm.send_transaction(tx);
                let expected_failure = attempt["kind"] == "execute";
                let (ok, meta) = match result {
                    Ok(meta) => {
                        assert!(!expected_failure);
                        (true, meta)
                    }
                    Err(failure) => {
                        assert!(expected_failure);
                        assert!(matches!(
                            failure.err,
                            solana_sdk::transaction::TransactionError::InstructionError(
                                _,
                                solana_sdk::instruction::InstructionError::Custom(6013)
                            )
                        ));
                        (false, failure.meta)
                    }
                };
                assert!(bytes.len() <= 1232 && meta.compute_units_consumed <= 1_000_000);
                if attempt["kind"] == "close" {
                    assert!(w.svm.get_account(&buffer).is_none_or(|a| a.lamports == 0));
                    assert!(w.svm.get_account(&w.attacker.pubkey()).unwrap().lamports > before);
                }
                w.rows.push(json!({"case":format!("sdk-failed-buffer/{}",attempt["kind"].as_str().unwrap()),"ok":ok,"expected":if expected_failure {"NotPending"} else {"Ok"},"cu":meta.compute_units_consumed,"transaction_bytes":bytes.len(),"logs":meta.logs}));
            }
        }
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
    let report = json!({"scope":"I09 newly generated native payload, real Vault SBF/v0 buffer lifecycle, historical RP/current tree, pause/deadline/tombstone; SDK challenger bridge signed v0 bytes; no live RPC or full daemon-to-SBF claim", "passed":true, "elf_sha256":hex::encode(Sha256::digest(&elf)), "payload_sha256":hex::encode(Sha256::digest(&generated)), "transactions":rows.len(), "expected_rejections":rejected, "max_cu":max_cu, "max_transaction_bytes":max_bytes, "cases":rows, "release_gates_passed":[]});
    fs::write(
        out.join("svm-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("PASS I09 new challenger payload: {} actual SBF transactions, {rejected} expected rejections, max {max_cu} CU / {max_bytes} bytes", rows.len());
}
