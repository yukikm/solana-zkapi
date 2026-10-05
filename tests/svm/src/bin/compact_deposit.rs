//! ADR-0003: real Groth16 fixtures and the compiled Vault ELF in LiteSVM.
//! This is local SBF evidence, not public finality or a Phantom acceptance test.
#[path = "../vault_support.rs"]
#[allow(dead_code)]
mod support;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, SeedDerivable, Signer},
    transaction::{TransactionError, VersionedTransaction},
};
use std::{collections::BTreeSet, fs, path::Path, process::Command};
use support::*;
use zkapi_layout2::{
    compress_deposit_compact_v1, expand_deposit_compact_v1, Operation, FR_MODULUS, MAX_AMOUNT,
};
use zkapi_vault::{Note, PoolConfig, TreeState};

fn fresh(elf: &[u8], fixture: &Value) -> World {
    let mut w = World::new(elf);
    w.initialize(fixture);
    w
}
fn compact(fixture: &Value) -> Vec<u8> {
    let canonical = payload(fixture, Operation::Deposit);
    let binding = field(&fixture["trees"][0]["public_inputs"][0]);
    let small = compress_deposit_compact_v1(&canonical, &binding).unwrap();
    assert_eq!(
        expand_deposit_compact_v1(&small, &binding)
            .unwrap()
            .as_slice(),
        canonical
    );
    small.to_vec()
}
fn accounts(w: &World) -> Vec<AccountMeta> {
    let mut accounts = w.financial(0, None, Some(Operation::Deposit));
    accounts.push(AccountMeta::new_readonly(w.payer.pubkey(), true));
    accounts
}
fn transaction(
    w: &World,
    accounts: Vec<AccountMeta>,
    data: Vec<u8>,
    roles: u8,
) -> VersionedTransaction {
    let extra_fee_payer = Keypair::from_seed(&[12; 32]).unwrap();
    let fee_payer = match roles {
        0 => &w.payer,
        1 => &w.attacker,
        2 => &extra_fee_payer,
        _ => unreachable!(),
    };
    let message = v0::Message::try_compile(
        &fee_payer.pubkey(),
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
            ComputeBudgetInstruction::set_compute_unit_price(1),
            Instruction {
                program_id: w.id,
                accounts: accounts.clone(),
                data,
            },
        ],
        &[],
        w.svm.latest_blockhash(),
    )
    .unwrap();
    let mut signers: Vec<&Keypair> = vec![fee_payer];
    for signer in [&w.payer, &w.attacker] {
        if signer.pubkey() != fee_payer.pubkey()
            && accounts
                .iter()
                .any(|a| a.pubkey == signer.pubkey() && a.is_signer)
        {
            signers.push(signer);
        }
    }
    VersionedTransaction::try_new(VersionedMessage::V0(message), &signers).unwrap()
}
fn run(w: &mut World, name: &str, tx: VersionedTransaction, ok: bool, rows: &mut Vec<Value>) {
    let message = match &tx.message {
        VersionedMessage::V0(m) => m,
        _ => unreachable!(),
    };
    assert!(message.address_table_lookups.is_empty());
    assert_eq!(
        message.instructions.len(),
        3,
        "two CU settings plus one financial instruction"
    );
    let wire = bincode::serialize(&tx).unwrap();
    assert!(wire.len() <= 1232, "{name}: {} bytes", wire.len());
    let mut keys = BTreeSet::from([w.pool, w.tree, w.note(0), w.source, w.vault]);
    keys.extend(message.account_keys.iter().copied());
    // Fee payer lamports pay the network fee even when all financial writes roll back.
    let fee_payer = message.account_keys[0];
    let before: Vec<_> = keys
        .into_iter()
        .filter(|k| *k != fee_payer)
        .map(|k| (k, w.svm.get_account(&k)))
        .collect();
    let result = w.svm.send_transaction(tx.clone());
    let (actual_ok, meta, error) = match &result {
        Ok(m) => (true, m, None),
        Err(e) => (false, &e.meta, Some(format!("{:?}", e.err))),
    };
    assert_eq!(actual_ok, ok, "{name}: {result:?}");
    assert!(meta.compute_units_consumed <= 1_000_000, "{name}");
    if !ok {
        let error = &result.as_ref().unwrap_err().err;
        assert!(
            matches!(
                error,
                TransactionError::InstructionError(
                    2,
                    InstructionError::Custom(_)
                        | InstructionError::InvalidInstructionData
                        | InstructionError::InvalidAccountData
                        | InstructionError::InvalidArgument
                        | InstructionError::IncorrectProgramId
                        | InstructionError::MissingRequiredSignature
                        | InstructionError::AccountAlreadyInitialized
                        | InstructionError::UninitializedAccount
                )
            ),
            "{name}: must be a deliberate rejection, not a VM/compute failure: {error:?}"
        );
        for (key, old) in before {
            assert_eq!(w.svm.get_account(&key), old, "{name}: rollback {key}");
        }
    } else {
        assert_eq!(w.amount(w.source), 100_000_000 - DEPOSIT);
        assert_eq!(w.amount(w.vault), DEPOSIT);
        let tree = w.state::<TreeState>(w.tree);
        assert_eq!(tree.sequence, 1);
        assert_eq!(tree.next_note_id, 1);
        assert_eq!(tree.outstanding_deposits, DEPOSIT);
        let note = w.state::<Note>(w.note(0));
        assert_eq!(note.deposit, DEPOSIT);
        assert_eq!(note.status, 1);
    }
    let events: Vec<_> = meta
        .logs
        .iter()
        .filter_map(|s| s.strip_prefix("Program data: "))
        .filter_map(|s| STANDARD.decode(s).ok())
        .filter(|raw| raw.starts_with(&disc("event:VaultTransitionV1")))
        .collect();
    assert_eq!(events.len(), usize::from(ok), "{name}: event count");
    rows.push(json!({"case":name, "ok":actual_ok, "error":error,
        "cu":meta.compute_units_consumed,"transaction_bytes":wire.len(),
        "signature_count":tx.signatures.len(),"financial_instruction_count":1,
        "priority_fee_micro_lamports":1,"rollback_checked":!ok,
        "events_base64":events.iter().map(|v| STANDARD.encode(v)).collect::<Vec<_>>(),
        "logs":meta.logs}));
}
fn submit(
    w: &mut World,
    name: &str,
    accounts: Vec<AccountMeta>,
    body: &[u8],
    ok: bool,
    rows: &mut Vec<Value>,
) {
    let tx = transaction(w, accounts, data("deposit_compact_v1", body), 0);
    run(w, name, tx, ok, rows);
}
fn rpc_transaction(
    tx: &VersionedTransaction,
    meta: &litesvm::types::TransactionMetadata,
    error: Option<String>,
) -> Value {
    let VersionedMessage::V0(msg) = &tx.message else {
        unreachable!()
    };
    let instructions: Vec<_> = msg.instructions.iter().map(|ix| json!({
        "programIdIndex":ix.program_id_index,"accounts":ix.accounts,"data":bs58::encode(&ix.data).into_string()
    })).collect();
    let inner: Vec<_> = meta
        .inner_instructions
        .iter()
        .enumerate()
        .filter(|(_, list)| !list.is_empty())
        .map(|(index, list)| {
            let items: Vec<_> = list.iter().map(|ix| json!({
            "programIdIndex":ix.instruction.program_id_index,"accounts":ix.instruction.accounts,
            "data":bs58::encode(&ix.instruction.data).into_string(),"stackHeight":ix.stack_height
        })).collect();
            json!({"index":index,"instructions":items})
        })
        .collect();
    json!({"version":0,"transaction":{"signatures":tx.signatures.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "message":{"header":{"numRequiredSignatures":msg.header.num_required_signatures,
        "numReadonlySignedAccounts":msg.header.num_readonly_signed_accounts,"numReadonlyUnsignedAccounts":msg.header.num_readonly_unsigned_accounts},
        "accountKeys":msg.account_keys.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "recentBlockhash":msg.recent_blockhash.to_string(),"instructions":instructions,"addressTableLookups":[]}},
        "meta":{"err":error,"logMessages":meta.logs,"innerInstructions":inner,
        "loadedAddresses":{"writable":[],"readonly":[]},"computeUnitsConsumed":meta.compute_units_consumed}})
}
fn history_block(slot: u64, transaction: Value) -> Value {
    json!({"slot":slot,"block":{"blockhash":bs58::encode([slot as u8;32]).into_string(),
        "previousBlockhash":bs58::encode([(slot-1) as u8;32]).into_string(),
        "parentSlot":slot-1,"blockHeight":slot,"blockTime":NOW,"transactions":[transaction]}})
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 2, "usage: compact_deposit ELF OUTPUT_JSON");
    let elf_path = root.join(&args[0]);
    let output = root.join(&args[1]);
    let elf = fs::read(&elf_path).expect("build the new compact Vault ELF first");
    let a = read(root.join("tests/fixtures/vault/a.json"));
    let b = read(root.join("tests/fixtures/vault/b-with-a.json"));
    let small = compact(&a);
    assert_eq!(small.len(), 436);
    let mut rows = Vec::new();
    for roles in 0..=2 {
        let mut w = fresh(&elf, &a);
        let extra_fee_payer = Keypair::from_seed(&[12; 32]).unwrap();
        w.svm
            .airdrop(&extra_fee_payer.pubkey(), 1_000_000_000)
            .unwrap();
        let mut metas = accounts(&w);
        if roles > 0 {
            metas[14] = AccountMeta::new(w.attacker.pubkey(), true);
            for i in [3, 4, 9, 10, 11, 12] {
                metas[i] = AccountMeta::new(w.attacker.pubkey(), false);
            }
        }
        let tx = transaction(&w, metas, data("deposit_compact_v1", &small), roles);
        assert_eq!(tx.signatures.len(), roles as usize + 1);
        assert_eq!(
            bincode::serialize(&tx).unwrap().len(),
            [1007, 1103, 1199][roles as usize]
        );
        run(
            &mut w,
            &format!("success/{}-signatures", roles + 1),
            tx.clone(),
            true,
            &mut rows,
        );
        assert_eq!(
            w.state::<TreeState>(w.tree).root,
            field(&a["trees"][0]["public_inputs"][2])
        );
        assert_eq!(
            w.state::<Note>(w.note(0)).commitment,
            field(&a["commitment"])
        );
        assert_eq!(
            w.state::<Note>(w.note(0)).expiry,
            a["expiry"].as_u64().unwrap()
        );
        if roles == 0 {
            // Transaction history is intentionally disabled so the program's own
            // ID/root/PDA guards are exercised even for identical signed bytes.
            run(&mut w, "replay/exact-signed-bytes", tx, false, &mut rows);
            w.svm.expire_blockhash();
            let next = transaction(&w, accounts(&w), data("deposit_compact_v1", &small), 0);
            run(
                &mut w,
                "replay/same-payload-new-blockhash",
                next,
                false,
                &mut rows,
            );
            assert_eq!(w.amount(w.source), 100_000_000 - DEPOSIT);
            assert_eq!(w.amount(w.vault), DEPOSIT);
        }
    }
    // Independently mutate each compact semantic field and all eight proof coordinates.
    for (name, offset) in [
        ("expected-id", 0),
        ("expected-root", 35),
        ("expiry", 36),
        ("commitment", 75),
        ("amount", 76),
        ("new-root", 115),
        ("new-leaf", 147),
        ("tag", 179),
    ] {
        let mut w = fresh(&elf, &a);
        let mut body = small.clone();
        body[offset] ^= 1;
        let metas = accounts(&w);
        submit(
            &mut w,
            &format!("tamper/{name}"),
            metas,
            &body,
            false,
            &mut rows,
        );
    }
    for coord in 0..8 {
        let mut w = fresh(&elf, &a);
        let mut body = small.clone();
        body[180 + 32 * coord + 31] ^= 1;
        let metas = accounts(&w);
        submit(
            &mut w,
            &format!("tamper/proof-coordinate-{coord}"),
            metas,
            &body,
            false,
            &mut rows,
        );
    }
    for offset in [4, 44, 84, 116, 148] {
        let mut w = fresh(&elf, &a);
        let mut body = small.clone();
        body[offset..offset + 32].copy_from_slice(&FR_MODULUS);
        let metas = accounts(&w);
        submit(
            &mut w,
            &format!("encoding/noncanonical-field-{offset}"),
            metas,
            &body,
            false,
            &mut rows,
        );
    }
    for case in 0..8 {
        let mut w = fresh(&elf, &a);
        let mut body = small.clone();
        let name = match case {
            0 => {
                body.pop();
                "truncated"
            }
            1 => {
                body.push(0);
                "trailing"
            }
            2 => {
                body[180..].copy_from_slice(&compact(&b)[180..]);
                "mixed-valid-proof"
            }
            3 => {
                body[44..76].fill(0);
                "zero-commitment"
            }
            4 => {
                body[76..84].fill(0);
                "zero-amount"
            }
            5 => {
                body[76..84].copy_from_slice(&(MAX_AMOUNT + 1).to_le_bytes());
                "amount-range"
            }
            6 => {
                w.clock(NOW as i64 + 86400);
                "day-boundary-expiry"
            }
            _ => {
                w.edit_state::<TreeState>(w.tree, |s| s.next_note_id = 1);
                "stale-id"
            }
        };
        let metas = accounts(&w);
        submit(
            &mut w,
            &format!("reject/{name}"),
            metas,
            &body,
            false,
            &mut rows,
        );
    }
    // Oversized canonical wire can still test strict dispatch using no account
    // metas: the wire guard must reject before account parsing or financial work.
    for (name, body) in [
        ("deposit_compact_v1", payload(&a, Operation::Deposit)),
        ("deposit", small.clone()),
    ] {
        let mut w = fresh(&elf, &a);
        let tx = transaction(&w, vec![], data(name, &body), 0);
        run(
            &mut w,
            &format!("encoding/wrong-wire-for-{name}"),
            tx,
            false,
            &mut rows,
        );
    }
    for case in 0..24 {
        let mut w = fresh(&elf, &a);
        let mut metas = accounts(&w);
        let name = match case {
            0 => {
                w.edit_token(w.source, |t| t.amount = DEPOSIT - 1);
                "insufficient-usdc"
            }
            1 => {
                w.edit_token(w.source, |t| {
                    t.state = spl_token::state::AccountState::Frozen
                });
                "frozen-usdc"
            }
            2 => {
                w.edit_token(w.source, |t| t.owner = Pubkey::new_unique());
                "source-owner"
            }
            3 => {
                w.edit_token(w.source, |t| t.mint = Pubkey::new_unique());
                "source-mint"
            }
            4 => {
                w.edit_token(w.vault, |t| t.owner = Pubkey::new_unique());
                "vault-authority"
            }
            5 => {
                metas[15] = AccountMeta::new_readonly(solana_sdk::system_program::id(), false);
                "token-program"
            }
            6 => {
                metas[6] = AccountMeta::new_readonly(w.source, false);
                "mint-account"
            }
            7 => {
                metas[7] = AccountMeta::new(w.vault, false);
                "source-account"
            }
            8 => {
                metas[2] = AccountMeta::new(w.note(1), false);
                "note-pda"
            }
            9 => {
                metas[13] = AccountMeta::new_readonly(w.attacker.pubkey(), true);
                "owner-signer-mismatch"
            }
            10 => {
                metas[18] = AccountMeta::new_readonly(w.attacker.pubkey(), true);
                "extra-signer-mismatch"
            }
            11 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.paused = true);
                "paused"
            }
            12 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.vault_binding[31] ^= 1);
                "pool-binding"
            }
            13 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.layout_version = 1);
                "pool-layout"
            }
            14 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.circuit_profile_hash[0] ^= 1);
                "pool-profile"
            }
            15 => {
                w.edit(w.pool, |p| p.owner = Pubkey::new_unique());
                "pool-owner"
            }
            16 => {
                w.edit_state::<TreeState>(w.tree, |t| t.sequence = u64::MAX);
                "sequence-overflow"
            }
            17 => {
                w.edit_state::<TreeState>(w.tree, |t| t.outstanding_deposits = u64::MAX);
                w.edit_token(w.vault, |t| t.amount = u64::MAX);
                "liability-overflow"
            }
            18 => {
                w.edit_token(w.vault, |t| t.amount = u64::MAX);
                "vault-token-overflow"
            }
            19 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.ttl = u64::MAX);
                "ttl-overflow"
            }
            20 => {
                w.edit_state::<TreeState>(w.tree, |t| {
                    t.root = field(&a["trees"][0]["public_inputs"][2])
                });
                "stale-root"
            }
            21 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.bump ^= 1);
                "pool-pda"
            }
            22 => {
                metas[13] = AccountMeta::new_readonly(w.attacker.pubkey(), false);
                metas[18] = AccountMeta::new_readonly(w.attacker.pubkey(), false);
                "missing-owner-signature"
            }
            _ => {
                w.edit(w.tree, |a| a.owner = Pubkey::new_unique());
                "tree-owner"
            }
        };
        submit(
            &mut w,
            &format!("rollback/{name}"),
            metas,
            &small,
            false,
            &mut rows,
        );
    }
    // Compact entrypoint must also preserve legacy buffer withdrawal semantics.
    let mut w = fresh(&elf, &a);
    let metas = accounts(&w);
    submit(
        &mut w,
        "compat/compact-deposit",
        metas,
        &small,
        true,
        &mut rows,
    );
    w.execute(
        "compat/buffer-mutual-close",
        &a,
        Operation::Close,
        Expect::Ok,
    )
    .unwrap();
    assert_eq!(w.state::<TreeState>(w.tree).outstanding_deposits, 0);
    assert_eq!(w.amount(w.destination), BALANCE);

    // Build and sign via the public SDK, then execute exactly the saved wire.
    // The archive uses synthetic finalized slots around actual SBF metadata.
    let mut sdk = World::new(&elf);
    let init = transaction(&sdk, sdk.init_accounts(), sdk.init_data(&a), 0);
    let init_meta = sdk.svm.send_transaction(init.clone()).unwrap();
    let mut blocks = vec![history_block(1, rpc_transaction(&init, &init_meta, None))];
    let generated = Command::new(std::env::var("ZKAPI_NODE").unwrap_or_else(|_| "node".into()))
        .current_dir(&root)
        .arg("tests/svm/compact-deposit.ts")
        .arg(sdk.svm.latest_blockhash().to_string())
        .output()
        .expect("SDK fixture generator");
    assert!(
        generated.status.success(),
        "SDK fixture: {}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let generated: Value = serde_json::from_slice(&generated.stdout).unwrap();
    assert_eq!(generated["signRequests"], 1);
    assert_eq!(generated["durableSaves"], 1);
    let wire = hex::decode(generated["attempt"]["wireHex"].as_str().unwrap()).unwrap();
    let sdk_tx: VersionedTransaction = bincode::deserialize(&wire).unwrap();
    sdk_tx.verify_and_hash_message().unwrap();
    // Preserve the metadata before the run helper deliberately tests replay.
    let executed = sdk.svm.send_transaction(sdk_tx.clone()).unwrap();
    assert_eq!(sdk.amount(sdk.source), 100_000_000 - DEPOSIT);
    assert_eq!(sdk.amount(sdk.vault), DEPOSIT);
    assert_eq!(wire.len(), 1007);
    assert_eq!(sdk_tx.signatures.len(), 1);
    assert!(executed.compute_units_consumed <= 1_000_000);
    blocks.push(history_block(2, rpc_transaction(&sdk_tx, &executed, None)));
    let failed = sdk.svm.send_transaction(sdk_tx.clone()).unwrap_err();
    blocks.push(history_block(
        3,
        rpc_transaction(&sdk_tx, &failed.meta, Some(format!("{:?}", failed.err))),
    ));
    let tree = sdk.state::<TreeState>(sdk.tree);
    assert_eq!(tree.sequence, 1);
    assert_eq!(tree.next_note_id, 1);
    assert_eq!(tree.outstanding_deposits, DEPOSIT);
    assert_eq!(sdk.amount(sdk.source), 100_000_000 - DEPOSIT);
    let sdk_history = json!({"scope":"actual SDK signed compact wire + real SBF logs; synthetic finalized archive slots",
        "blocks":blocks,"expected":{"root":format!("0x{}",hex::encode(tree.root)),"sequence":1,"next_note_id":1,"outstanding_deposits":DEPOSIT},
        "sign_requests":generated["signRequests"],"durable_saves":generated["durableSaves"],
        "wire_sha256":hex::encode(Sha256::digest(&wire)),"transaction_bytes":wire.len(),"cu":executed.compute_units_consumed});
    fs::create_dir_all(output.parent().unwrap()).unwrap();
    let sdk_history_path = output.parent().unwrap().join("sdk-history.json");
    fs::write(
        &sdk_history_path,
        serde_json::to_vec_pretty(&sdk_history).unwrap(),
    )
    .unwrap();
    let compact_max_cu = rows
        .iter()
        .map(|r| r["cu"].as_u64().unwrap())
        .max()
        .unwrap();
    let report = json!({"status":"pass", "scope":"local real-proof LiteSVM SBF; no public deployment/finality or Phantom",
        "elf":args[0],"elf_sha256":hex::encode(Sha256::digest(&elf)),
        "fixture":"tests/fixtures/vault/a.json", "fixture_sha256":hex::encode(Sha256::digest(fs::read(root.join("tests/fixtures/vault/a.json")).unwrap())),
        "compact_args_bytes":436,"compact_instruction_bytes":444,"max_cu":compact_max_cu,
        "cases":rows,"legacy_buffer_close":w.rows.last().unwrap(),"sdk":sdk_history});
    fs::create_dir_all(output.parent().unwrap()).unwrap();
    fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!(
        "compact deposit: {} real SBF cases passed; max {} CU; report {}",
        report["cases"].as_array().unwrap().len(),
        compact_max_cu,
        output.display()
    );
}
