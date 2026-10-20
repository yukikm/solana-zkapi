//! Synthetic projection adversaries plus offline replay of the existing real
//! SDK/SBF history fixture. None of these tests contacts a provider or sends.
use super::*;
use crate::{Indexer, Instruction};
use zkapi_layout2::Operation;

const PROGRAM: Bytes32 = [7; 32];
const POOL: Bytes32 = [8; 32];
const BUFFER: Bytes32 = [12; 32];

fn ix(name: &str, args: &[u8], accounts: Vec<Bytes32>) -> Instruction {
    Instruction {
        program: PROGRAM,
        accounts,
        data: [discriminator("global", name).as_slice(), args].concat(),
        outer_index: 0,
        invocation_index: 0,
        stack_height: 1,
        succeeded: Some(true),
        events: vec![],
    }
}
fn init() -> Instruction {
    let mut args = vec![0; 280];
    args[32..64].copy_from_slice(&[3; 32]);
    args[192..200].copy_from_slice(&86400u64.to_le_bytes());
    args[200..208].copy_from_slice(&60u64.to_le_bytes());
    let mut keys = vec![[9; 32]; 11];
    keys[0] = POOL;
    keys[3] = [4; 32];
    keys[8] = [10; 32];
    ix("initialize_pool", &args, keys)
}
fn tx(signature: &str, mut instructions: Vec<Instruction>) -> Transaction {
    for (i, instruction) in instructions.iter_mut().enumerate() {
        instruction.outer_index = i as u32;
    }
    Transaction {
        signature: signature.into(),
        succeeded: true,
        instructions,
    }
}
fn foreign(signature: &str) -> Transaction {
    let mut instruction = ix("unrelated", &[42; 1000], vec![]);
    instruction.program = [99; 32];
    tx(signature, vec![instruction])
}
fn block(slot: u64, transactions: Vec<Transaction>) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: 10,
        transactions,
    }
}
fn compare(full: &mut Indexer, projected: &mut Indexer, source: &FinalizedBlock) -> ProjectedBlock {
    let record = full.validate_and_project(source).unwrap();
    record.verify_source(source).unwrap();
    let bytes = record.canonical_bytes().unwrap();
    let restored = ProjectedBlock::from_bytes(&bytes).unwrap();
    assert_eq!(record, restored);
    projected.apply_projected(&restored).unwrap();
    assert_eq!(
        full.semantic_digest().unwrap(),
        projected.semantic_digest().unwrap()
    );
    assert_eq!(
        full.replay_state().unwrap(),
        projected.replay_state().unwrap()
    );
    assert_eq!(full.block_transitions(), projected.block_transitions());
    record
}

#[test]
fn mixed_pool_transactions_keep_original_positions_and_whole_context() {
    let other = ix("pause", &[], vec![[55; 32]]);
    let mut failed = tx("failed", vec![init()]);
    failed.succeeded = false;
    // A rolled-back transaction's malformed logs/instructions are not replayed.
    failed.instructions[0].events.push(vec![255]);
    let source = block(
        1,
        vec![
            foreign("foreign-before"),
            tx("other-pool", vec![other.clone()]),
            tx(
                "mixed",
                vec![foreign("unused").instructions.remove(0), init(), other],
            ),
            failed,
            foreign("foreign-after"),
        ],
    );
    let mut full = Indexer::new(PROGRAM, POOL);
    let mut projected = full.clone();
    let record = compare(&mut full, &mut projected, &source);
    assert_eq!(record.original_transaction_count, 5);
    assert_eq!(record.transactions.len(), 1);
    assert_eq!(record.transactions[0].original_index, 2);
    assert_eq!(record.transactions[0].transaction, source.transactions[2]);
    assert_ne!(record.digest, record.source_block_digest);
    assert!(full.checkpoint_bytes().is_ok());
    assert!(projected.checkpoint_bytes().is_err());
    let quiet = compare(&mut full, &mut projected, &block(2, vec![foreign("quiet")]));
    assert!(quiet.transactions.is_empty());
    assert_eq!(quiet.original_transaction_count, 1);
    assert_eq!(quiet.parent_slot, 1);
}

#[test]
fn open_buffer_close_reuse_and_full_prefix_cutover_preserve_semantics() {
    let bytes = vec![5; Operation::Deposit.payload_len()];
    let mut create = vec![Operation::Deposit as u8];
    create.extend((bytes.len() as u32).to_le_bytes());
    create.extend(sha(&bytes));
    create.extend([0; 32]);
    create.extend(1000u64.to_le_bytes());
    let accounts = vec![BUFFER, POOL, [9; 32], [9; 32]];
    let append = |offset: u32, data: &[u8]| {
        let mut args = offset.to_le_bytes().to_vec();
        args.extend((data.len() as u32).to_le_bytes());
        args.extend(data);
        ix("append_payload", &args, accounts.clone())
    };
    let history = vec![
        block(1, vec![tx("init", vec![init()])]),
        block(
            2,
            vec![
                foreign("f0"),
                foreign("f1"),
                tx(
                    "create",
                    vec![
                        ix("create_payload", &create, accounts.clone()),
                        append(0, &bytes[..100]),
                    ],
                ),
            ],
        ),
        block(
            3,
            vec![tx(
                "close",
                vec![ix("close_payload", &[], accounts.clone())],
            )],
        ),
        block(
            4,
            vec![
                foreign("f0"),
                foreign("f1"),
                foreign("f2"),
                foreign("f3"),
                tx(
                    "reuse",
                    vec![
                        ix("create_payload", &create, accounts.clone()),
                        append(0, &bytes),
                    ],
                ),
            ],
        ),
        block(
            5,
            vec![tx("seal", vec![ix("seal_payload", &[], accounts.clone())])],
        ),
        block(
            6,
            vec![tx("close-again", vec![ix("close_payload", &[], accounts)])],
        ),
    ];
    let mut full = Indexer::new(PROGRAM, POOL);
    let mut projected = full.clone();
    for source in &history {
        compare(&mut full, &mut projected, source);
    }
    for cut in 1..history.len() {
        let mut prefix = Indexer::new(PROGRAM, POOL);
        for source in &history[..cut] {
            prefix.apply_block(source).unwrap();
        }
        let checkpoint = prefix.checkpoint_bytes().unwrap();
        let at = &history[cut - 1];
        let mut shadow = Indexer::restore_checkpoint(
            &checkpoint,
            sha(&checkpoint),
            PROGRAM,
            POOL,
            at.slot,
            at.blockhash,
        )
        .unwrap();
        assert_eq!(
            shadow.semantic_digest().unwrap(),
            prefix.semantic_digest().unwrap()
        );
        for source in &history[cut..] {
            compare(&mut prefix, &mut shadow, source);
        }
    }
}

#[test]
fn full_validation_rejects_global_errors_before_any_projection() {
    let original = block(1, vec![foreign("a"), tx("target", vec![init()])]);
    let mut duplicate = original.clone();
    duplicate
        .transactions
        .push(duplicate.transactions[0].clone());
    let mut bad_order = original.clone();
    let repeated_instruction = bad_order.transactions[0].instructions[0].clone();
    bad_order.transactions[0]
        .instructions
        .push(repeated_instruction);
    let mut unknown_cpi = original.clone();
    let mut unrelated_pool = ix("pause", &[], vec![[66; 32]]);
    unrelated_pool.succeeded = None;
    unrelated_pool.stack_height = 2;
    unrelated_pool.invocation_index = 1;
    unknown_cpi
        .transactions
        .push(tx("unknown-cpi-other-pool", vec![unrelated_pool]));
    let mut malformed_other_pool = original.clone();
    malformed_other_pool
        .transactions
        .push(tx("missing-pool", vec![ix("append_payload", &[], vec![])]));
    for source in [duplicate, bad_order, unknown_cpi, malformed_other_pool] {
        let mut ordinary = Indexer::new(PROGRAM, POOL);
        let mut full = ordinary.clone();
        let error = ordinary.apply_block(&source).unwrap_err();
        assert_eq!(full.validate_and_project(&source), Err(error));
        assert_eq!(
            full.semantic_digest().unwrap(),
            ordinary.semantic_digest().unwrap()
        );
        assert_eq!(
            full.validate_and_project(&original),
            Err(Error::Unavailable)
        );
    }
}

#[test]
fn projection_rejects_tampering_indices_duplicates_bindings_and_noncanonical_wire() {
    let source = block(
        1,
        vec![
            foreign("a"),
            tx("init", vec![init()]),
            foreign("b"),
            tx("pause", vec![ix("pause", &[], vec![POOL])]),
        ],
    );
    let record = Indexer::new(PROGRAM, POOL)
        .validate_and_project(&source)
        .unwrap();
    let mut bad = record.clone();
    bad.block_time += 1;
    assert!(bad.validate().is_err());
    for change in [
        |b: &mut ProjectedBlock| b.transactions[0].original_index = b.original_transaction_count,
        |b: &mut ProjectedBlock| b.transactions.swap(0, 1),
        |b: &mut ProjectedBlock| {
            b.transactions[1].original_index = b.transactions[0].original_index
        },
        |b: &mut ProjectedBlock| {
            b.transactions[1].transaction.signature =
                b.transactions[0].transaction.signature.clone()
        },
        |b: &mut ProjectedBlock| b.rules_version += 1,
    ] {
        let mut bad = record.clone();
        change(&mut bad);
        bad.digest = bad.compute_digest().unwrap();
        assert!(bad.validate().is_err());
    }
    let mut omitted = record.clone();
    omitted.transactions.pop();
    omitted.digest = omitted.compute_digest().unwrap();
    // Hash integrity alone cannot prove complete selection. Source binding does.
    omitted.validate().unwrap();
    assert_eq!(omitted.verify_source(&source), Err(Error::History));
    let mut wrong_source = record.clone();
    wrong_source.source_block_digest[0] ^= 1;
    wrong_source.digest = wrong_source.compute_digest().unwrap();
    assert_eq!(wrong_source.verify_source(&source), Err(Error::History));
    let mut shadow = Indexer::new(PROGRAM, POOL);
    shadow.apply_projected(&record).unwrap();
    shadow.apply_projected(&record).unwrap();
    assert_eq!(shadow.apply_projected(&wrong_source), Err(Error::History));
    assert_eq!(
        Indexer::new([9; 32], POOL).apply_projected(&record),
        Err(Error::History)
    );
    let bytes = record.canonical_bytes().unwrap();
    let mut trailing = bytes.clone();
    trailing.push(b'\n');
    assert!(ProjectedBlock::from_bytes(&trailing).is_err());
    let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    unknown["transactions"][0]["transaction"]["extra"] = true.into();
    assert!(ProjectedBlock::from_bytes(&serde_json::to_vec(&unknown).unwrap()).is_err());
    let mut full = Indexer::new(PROGRAM, POOL);
    full.apply_block(&source).unwrap();
    assert_eq!(full.apply_projected(&record), Err(Error::History));
}

#[test]
fn existing_sdk_sbf_scenarios_match_at_every_cut_with_transaction_padding() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let history: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("target/i04/sdk-svm-history.json"))
            .expect("run the SDK/SBF harness to generate the existing fixture"),
    )
    .unwrap();
    let fixture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("tests/fixtures/vault/a.json")).unwrap())
            .unwrap();
    let program: Bytes32 = hex::decode(fixture["program_id"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let pool: Bytes32 = hex::decode(fixture["pool"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    for scenario in history["scenarios"].as_array().unwrap() {
        let mut full = Indexer::new(program, pool);
        let mut projected = full.clone();
        let mut count = 0;
        for row in scenario["blocks"].as_array().unwrap() {
            let mut source =
                crate::rpc::decode_finalized_block(row["slot"].as_u64().unwrap(), &row["block"])
                    .unwrap();
            source.transactions.insert(0, foreign("unrelated-prefix-0"));
            source.transactions.insert(1, foreign("unrelated-prefix-1"));
            source.transactions.push(foreign("unrelated-suffix"));
            compare(&mut full, &mut projected, &source);
            count += 1;
        }
        assert!(count > 0);
    }
}

#[test]
fn canonical_empty_coverage_vector_and_offline_readiness_fence() {
    let source = block(1, vec![]);
    let record = Indexer::new(PROGRAM, POOL)
        .validate_and_project(&source)
        .unwrap();
    assert_eq!(
        hex::encode(record.source_block_digest),
        "6a54b3434d971003138e09b571767f1b263340512941a41fee704d57ffc82dd9"
    );
    assert_eq!(
        hex::encode(record.digest),
        "45eb2f12e480d39b379c97f19e93a771fdeb5b1c2adcbfeb924ca9576e2204ea"
    );
    let initialized = block(1, vec![tx("init", vec![init()])]);
    let record = Indexer::new(PROGRAM, POOL)
        .validate_and_project(&initialized)
        .unwrap();
    let mut shadow = Indexer::new(PROGRAM, POOL);
    shadow.apply_projected(&record).unwrap();
    assert_eq!(
        shadow.reconcile(&shadow.replay_state().unwrap()),
        Err(Error::State)
    );
    assert!(!shadow.is_ready());
}

#[test]
fn decoded_cpi_success_caught_failure_ancestor_rollback_and_truncation_match() {
    use serde_json::json;
    let instruction = init();
    let key = |k: Bytes32| bs58::encode(k).into_string();
    let mut keys = instruction.accounts.clone();
    keys.extend([PROGRAM, [91; 32], [90; 32]]);
    let vault = keys.len() - 3;
    let ancestor = keys.len() - 2;
    let outer = keys.len() - 1;
    let value = json!({
        "blockhash":key(sha(&1u64.to_le_bytes())),
        "previousBlockhash":key(sha(&0u64.to_le_bytes())),
        "parentSlot":0,"blockTime":10,
        "transactions":[{"version":0,
          "transaction":{"signatures":[bs58::encode([2;64]).into_string()],
            "message":{"accountKeys":keys.iter().map(|k|key(*k)).collect::<Vec<_>>(),
              "instructions":[{"programIdIndex":outer,"accounts":[],"data":""}]}},
          "meta":{"err":null,"loadedAddresses":{"writable":[],"readonly":[]},
            "innerInstructions":[{"index":0,"instructions":[
              {"programIdIndex":ancestor,"accounts":[],"data":"","stackHeight":2},
              {"programIdIndex":vault,"accounts":(0..instruction.accounts.len()).collect::<Vec<_>>(),"data":bs58::encode(&instruction.data).into_string(),"stackHeight":3}
            ]}],"logMessages":null}}
        ]
    });
    for (vault_success, ancestor_success, truncate, expected_selected) in [
        (true, true, false, 1),
        (false, true, false, 0),
        (true, false, false, 0),
        (true, true, true, 0),
    ] {
        let mut raw = value.clone();
        let mut logs = vec![
            format!("Program {} invoke [1]", key([90; 32])),
            format!("Program {} invoke [2]", key([91; 32])),
            format!("Program {} invoke [3]", key(PROGRAM)),
            format!(
                "Program {} {}",
                key(PROGRAM),
                if vault_success {
                    "success"
                } else {
                    "failed: caught"
                }
            ),
            format!(
                "Program {} {}",
                key([91; 32]),
                if ancestor_success {
                    "success"
                } else {
                    "failed: rollback"
                }
            ),
            format!("Program {} success", key([90; 32])),
        ];
        if truncate {
            logs.truncate(4);
            logs.push("Log truncated".into());
        }
        raw["transactions"][0]["meta"]["logMessages"] = json!(logs);
        let source = crate::rpc::decode_finalized_block(1, &raw).unwrap();
        let mut full = Indexer::new(PROGRAM, POOL);
        let mut shadow = full.clone();
        if truncate {
            assert_eq!(full.validate_and_project(&source), Err(Error::Invocation));
        } else {
            let projected = compare(&mut full, &mut shadow, &source);
            assert_eq!(projected.transactions.len(), expected_selected);
            if expected_selected == 1 {
                assert_eq!(projected.transactions[0].transaction.instructions.len(), 3);
                assert_eq!(
                    projected.transactions[0].transaction.instructions[2].stack_height,
                    3
                );
            }
        }
    }
}
