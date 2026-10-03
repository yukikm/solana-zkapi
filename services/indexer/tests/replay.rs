//! Synthetic archive-boundary cases. No synthetic proof is counted as SVM or
//! cryptographic evidence; SDK/SBF integrated replay is exercised separately.
use ark_bn254::Fr;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zkapi_indexer::{
    discriminator,
    rpc::decode_finalized_block,
    snapshot::{field, key},
    tree::Tree,
    Bytes32, Error, FinalizedBlock, Indexer, Instruction, Note, Transaction,
};
use zkapi_layout2::{integer, Operation, TreeUpdate};
const PROGRAM: Bytes32 = [7; 32];
const POOL: Bytes32 = [8; 32];
const DESTINATION: Bytes32 = [11; 32];
fn hash(bytes: &[u8]) -> Bytes32 {
    Sha256::digest(bytes).into()
}
fn binding() -> Bytes32 {
    zkapi_layout2::framing::reduce(hash(&zkapi_layout2::framing::vault(
        &[3; 32], &PROGRAM, &POOL, &[10; 32], &[4; 32],
    )))
}
fn accounts() -> Vec<Bytes32> {
    let mut a = vec![[9; 32]; 18];
    a[0] = POOL;
    a[9] = DESTINATION;
    a
}
fn ix(name: &str, args: Vec<u8>, accounts: Vec<Bytes32>) -> Instruction {
    let mut data = discriminator("global", name).to_vec();
    data.extend(args);
    Instruction {
        program: PROGRAM,
        accounts,
        data,
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
    ix("initialize_pool", args, keys)
}
fn block(slot: u64, time: u64, mut instructions: Vec<Instruction>) -> FinalizedBlock {
    for (i, ix) in instructions.iter_mut().enumerate() {
        ix.outer_index = i as u32;
    }
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: [slot as u8; 32],
        previous_blockhash: [(slot - 1) as u8; 32],
        block_time: time,
        transactions: vec![Transaction {
            signature: bs58::encode([slot as u8; 64]).into_string(),
            succeeded: true,
            instructions,
        }],
    }
}
fn initial() -> Indexer {
    let mut index = Indexer::new(PROGRAM, POOL);
    index.apply_block(&block(1, 10, vec![init()])).unwrap();
    index
}
fn note(id: u32) -> Note {
    Note {
        id,
        commitment: integer(17 + u64::from(id)),
        deposit: 12345,
        expiry: 172800,
    }
}
fn payload(tree: &mut Tree, n: &Note, op: Operation, nullifier: u64) -> Vec<u8> {
    let old_root = tree.root();
    let old_leaf = tree.leaf(n.id);
    let new_leaf = if matches!(op, Operation::Deposit | Operation::Challenge) {
        n.leaf().unwrap()
    } else {
        [0; 32]
    };
    tree.update(n.id, new_leaf).unwrap();
    let mut public = [
        binding(),
        old_root,
        tree.root(),
        integer(n.id as u64),
        old_leaf,
        new_leaf,
        n.commitment,
        integer(n.deposit),
        integer(n.expiry),
        integer(op.tree_op()),
        [0; 32],
    ];
    let inputs = std::iter::once(zkapi_poseidon::domain(b"solana.zkapi.tree.v1"))
        .chain(
            public[..10]
                .iter()
                .map(|f| zkapi_poseidon::parse(f).unwrap()),
        )
        .collect::<Vec<_>>();
    public[10] = zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(&inputs));
    let mut out = Vec::new();
    match op {
        Operation::Deposit => {
            out.extend(n.id.to_le_bytes());
            out.extend(old_root);
            out.extend(n.expiry.to_le_bytes());
            out.extend(n.commitment);
            out.extend(n.deposit.to_le_bytes());
        }
        Operation::Close | Operation::Escape => {
            let mut wp = [[0; 32]; 14];
            wp[0] = integer(2);
            wp[1] = integer(zkapi_layout2::NAMESPACE);
            wp[2] = binding();
            wp[3] = old_root;
            wp[8] = integer(n.id as u64);
            wp[9] = integer(100);
            wp[10] = zkapi_layout2::framing::reduce(hash(&zkapi_layout2::framing::destination(
                &DESTINATION,
            )));
            wp[11] = integer(nullifier);
            wp[12] = integer(u64::from(op == Operation::Close));
            for f in wp {
                out.extend(f)
            }
            out.extend([0; 256]);
        }
        Operation::Challenge => {
            out.extend(n.id.to_le_bytes());
            let mut rp = [[0; 32]; 12];
            rp[2] = binding();
            rp[3] = integer(777);
            rp[8] = integer(nullifier);
            for f in rp {
                out.extend(f)
            }
            out.extend([0; 256]);
        }
        Operation::Expiry => out.extend(n.id.to_le_bytes()),
    }
    let mut wire = [0; 608];
    TreeUpdate {
        public,
        proof: [0; 256],
    }
    .encode(&mut wire)
    .unwrap();
    out.extend(wire);
    out
}
fn reconcile(index: &mut Indexer) {
    let state = index.replay_state().unwrap();
    index.reconcile(&state).unwrap();
}
fn event_bytes(index: &Indexer, n: &Note, op: u8, status: u8, old_root: Bytes32) -> Vec<u8> {
    let state = index.replay_state().unwrap();
    let mut out = discriminator("event", "VaultTransitionV1").to_vec();
    out.push(1);
    out.extend(POOL);
    out.extend(state.sequence.to_le_bytes());
    out.push(op);
    out.extend(n.id.to_le_bytes());
    out.push(status);
    out.extend(old_root);
    out.extend(state.root);
    out.extend(n.commitment);
    out.extend(n.deposit.to_le_bytes());
    out.extend(n.expiry.to_le_bytes());
    out.extend([0; 4]);
    out
}
#[test]
fn original_poseidon_path_replay_all_lifecycle_and_finalize_sequence() {
    let mut index = initial();
    let mut tree = Tree::new();
    let n = note(0);
    index
        .apply_block(&block(
            2,
            10,
            vec![ix(
                "deposit",
                payload(&mut tree, &n, Operation::Deposit, 0),
                accounts(),
            )],
        ))
        .unwrap();
    assert_eq!(index.path(0), Err(Error::Unavailable));
    reconcile(&mut index);
    let path = index.path(0).unwrap();
    let siblings = path.siblings.map(|f| {
        zkapi_poseidon::parse(&zkapi_indexer::snapshot::parse_field(&f).unwrap()).unwrap()
    });
    assert_eq!(
        field(zkapi_poseidon::bytes(zkapi_poseidon::root(
            0,
            zkapi_poseidon::parse(&n.leaf().unwrap()).unwrap(),
            &siblings
        ))),
        path.snapshot.root
    );
    index
        .apply_block(&block(
            3,
            11,
            vec![ix(
                "initiate_escape",
                payload(&mut tree, &n, Operation::Escape, 101),
                accounts(),
            )],
        ))
        .unwrap();
    reconcile(&mut index);
    assert!(index.path(0).is_err());
    assert_eq!(index.zero_path(0).unwrap().leaf, field([0; 32]));
    index
        .apply_block(&block(
            4,
            12,
            vec![ix(
                "challenge_escape",
                payload(&mut tree, &n, Operation::Challenge, 101),
                accounts(),
            )],
        ))
        .unwrap();
    reconcile(&mut index);
    assert!(index.path(0).is_ok());
    index
        .apply_block(&block(
            5,
            13,
            vec![ix(
                "initiate_escape",
                payload(&mut tree, &n, Operation::Escape, 102),
                accounts(),
            )],
        ))
        .unwrap();
    let before = index.replay_state().unwrap();
    index
        .apply_block(&block(
            6,
            73,
            vec![ix(
                "finalize_escape",
                0u32.to_le_bytes().to_vec(),
                accounts(),
            )],
        ))
        .unwrap();
    let after = index.replay_state().unwrap();
    assert_eq!(after.root, before.root);
    assert_eq!(after.sequence, before.sequence + 1);
    assert_eq!(after.outstanding_deposits, 0);
    assert!(after.pending.is_empty());
    reconcile(&mut index);
    assert!(index.zero_path(0).is_err());
}
#[test]
fn close_and_expiry_are_distinct_from_finalize_and_do_not_reuse_ids() {
    for (operation, name, time) in [
        (Operation::Close, "mutual_close", 11),
        (Operation::Expiry, "claim_expired", 172800),
    ] {
        let mut index = initial();
        let mut tree = Tree::new();
        let n = note(0);
        index
            .apply_block(&block(
                2,
                10,
                vec![ix(
                    "deposit",
                    payload(&mut tree, &n, Operation::Deposit, 0),
                    accounts(),
                )],
            ))
            .unwrap();
        index
            .apply_block(&block(
                3,
                time,
                vec![ix(name, payload(&mut tree, &n, operation, 51), accounts())],
            ))
            .unwrap();
        reconcile(&mut index);
        assert_eq!(index.root().unwrap().next_note_id, "1");
        assert!(index.zero_path(0).is_err());
        assert!(index.zero_path(1).is_ok());
        assert_eq!(index.replay_state().unwrap().outstanding_deposits, 0);
    }
}
#[test]
fn failed_transaction_logs_are_ignored_and_block_application_is_atomic() {
    let mut index = initial();
    let mut tree = Tree::new();
    let n = note(0);
    let deposit = ix(
        "deposit",
        payload(&mut tree, &n, Operation::Deposit, 0),
        accounts(),
    );
    let mut failed = block(2, 10, vec![deposit.clone()]);
    failed.transactions[0].succeeded = false;
    failed.transactions[0].instructions[0]
        .events
        .push(vec![255]);
    index.apply_block(&failed).unwrap();
    assert_eq!(index.replay_state().unwrap().sequence, 0);
    let state = index.replay_state().unwrap();
    let bad = ix("deposit", vec![], accounts());
    assert!(index
        .apply_block(&block(3, 10, vec![deposit, bad]))
        .is_err());
    assert_eq!(index.replay_state().unwrap(), state);
    assert!(index.root().is_err());
}
#[test]
fn identical_block_is_idempotent_conflicting_duplicate_and_gap_halt() {
    let mut index = initial();
    let init_block = block(1, 10, vec![init()]);
    reconcile(&mut index);
    index.apply_block(&init_block).unwrap();
    assert!(index.root().is_ok());
    let mut conflict = init_block;
    conflict.block_time += 1;
    assert_eq!(index.apply_block(&conflict), Err(Error::History));
    assert!(!index.is_ready());
    let mut index = initial();
    assert_eq!(
        index.apply_block(&block(3, 10, vec![])),
        Err(Error::History)
    );
}
#[test]
fn emitted_sequence_and_fields_must_equal_full_instruction_replay() {
    let mut index = initial();
    let mut tree = Tree::new();
    let n = note(0);
    let old_root = tree.root();
    let mut b = block(
        2,
        10,
        vec![ix(
            "deposit",
            payload(&mut tree, &n, Operation::Deposit, 0),
            accounts(),
        )],
    );
    let mut expected = index.clone();
    expected.apply_block(&b).unwrap();
    let bytes = event_bytes(&expected, &n, 0, 1, old_root);
    b.transactions[0].instructions[0].events.push(bytes.clone());
    index.apply_block(&b).unwrap();
    for offset in [8, 41, 49, 54, 55, 119, 151, 159] {
        let mut index = initial();
        let mut bad = b.clone();
        bad.transactions[0].instructions[0].events[0][offset] ^= 1;
        assert!(index.apply_block(&bad).is_err(), "event offset {offset}");
        assert_eq!(index.replay_state().unwrap().sequence, 0);
    }
}
fn create(buffer: Bytes32, data: &[u8], op: Operation) -> Instruction {
    let mut args = vec![op as u8];
    args.extend((data.len() as u32).to_le_bytes());
    args.extend(hash(data));
    args.extend([5; 32]);
    args.extend(3600u64.to_le_bytes());
    ix(
        "create_payload",
        args,
        vec![buffer, POOL, [12; 32], [13; 32], [0; 32]],
    )
}
fn append(buffer: Bytes32, offset: u32, bytes: &[u8]) -> Instruction {
    let mut args = offset.to_le_bytes().to_vec();
    args.extend((bytes.len() as u32).to_le_bytes());
    args.extend(bytes);
    ix("append_payload", args, vec![buffer, POOL, [12; 32]])
}
fn seal(buffer: Bytes32) -> Instruction {
    ix("seal_payload", vec![], vec![buffer, POOL, [12; 32]])
}
fn execute(buffer: Bytes32, data: &[u8]) -> Instruction {
    let mut keys = vec![buffer, [12; 32], [13; 32]];
    keys.extend(accounts());
    ix("execute_payload", hash(data).to_vec(), keys)
}
#[test]
fn missing_logs_rebuild_buffer_from_generation_chunks_digest_and_success_history() {
    let mut index = initial();
    let mut tree = Tree::new();
    let n = note(0);
    let data = payload(&mut tree, &n, Operation::Deposit, 0);
    let buffer = [15; 32];
    index
        .apply_block(&block(
            2,
            10,
            vec![
                create(buffer, &data, Operation::Deposit),
                append(buffer, 0, &data[..300]),
            ],
        ))
        .unwrap();
    let mut failed = block(3, 10, vec![append(buffer, 300, &data[300..])]);
    failed.transactions[0].succeeded = false;
    index.apply_block(&failed).unwrap();
    index
        .apply_block(&block(
            4,
            10,
            vec![
                append(buffer, 300, &data[300..]),
                seal(buffer),
                execute(buffer, &data),
            ],
        ))
        .unwrap();
    reconcile(&mut index);
    assert_eq!(index.path(0).unwrap().snapshot.sequence, "1");
    // Successful execution closes the buffer; absence is not itself proof of success.
    assert!(index
        .apply_block(&block(5, 10, vec![execute(buffer, &data)]))
        .is_err());
}
#[test]
fn buffer_reuse_cannot_reuse_old_digest_and_unknown_history_stops() {
    let mut tree = Tree::new();
    let data = payload(&mut tree, &note(0), Operation::Deposit, 0);
    let buffer = [15; 32];
    let mut new_data = data.clone();
    new_data[77] ^= 1;
    let mut index = initial();
    let close = ix(
        "close_payload",
        vec![],
        vec![buffer, POOL, [12; 32], [13; 32]],
    );
    index
        .apply_block(&block(
            2,
            10,
            vec![
                create(buffer, &data, Operation::Deposit),
                close,
                create(buffer, &new_data, Operation::Deposit),
                append(buffer, 0, &new_data),
                seal(buffer),
            ],
        ))
        .unwrap();
    assert_eq!(
        index.apply_block(&block(3, 10, vec![execute(buffer, &data)])),
        Err(Error::Buffer)
    );
    let mut index = initial();
    assert_eq!(
        index.apply_block(&block(2, 10, vec![execute(buffer, &data)])),
        Err(Error::Buffer)
    );
    for offset in [1, 900] {
        let mut index = initial();
        assert_eq!(
            index.apply_block(&block(
                2,
                10,
                vec![
                    create(buffer, &data, Operation::Deposit),
                    append(buffer, offset, &data)
                ]
            )),
            Err(Error::Buffer)
        );
    }
}
#[test]
fn snapshot_requires_jcs_hash_full_pending_and_independent_chain_anchor() {
    let mut index = initial();
    let mut tree = Tree::new();
    let n = note(0);
    index
        .apply_block(&block(
            2,
            10,
            vec![
                ix(
                    "deposit",
                    payload(&mut tree, &n, Operation::Deposit, 0),
                    accounts(),
                ),
                ix(
                    "initiate_escape",
                    payload(&mut tree, &n, Operation::Escape, 101),
                    accounts(),
                ),
            ],
        ))
        .unwrap();
    reconcile(&mut index);
    let bytes = index.snapshot_bytes().unwrap();
    let restored = Indexer::restore_snapshot(&bytes, hash(&bytes), &index).unwrap();
    assert_eq!(restored.snapshot_bytes().unwrap(), bytes);
    assert!(restored.zero_path(0).is_ok());
    for change in [
        "deadline",
        "nullifier",
        "old_root",
        "destination_owner",
        "balance_micro_usdc",
    ] {
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["pending_withdrawals"][0][change] = json!(match change {
            "nullifier" | "old_root" => field(integer(777)),
            "destination_owner" => key([88; 32]),
            _ => "999".into(),
        });
        let fake = serde_jcs::to_vec(&value).unwrap();
        assert!(
            Indexer::restore_snapshot(&fake, hash(&fake), &index).is_err(),
            "{change}"
        );
    }
    let mut corrupt = bytes.clone();
    corrupt.push(b'\n');
    assert!(Indexer::restore_snapshot(&corrupt, hash(&corrupt), &index).is_err());
    assert!(Indexer::restore_snapshot(&bytes, [0; 32], &index).is_err());
    let mut wrong_anchor = index.replay_state().unwrap();
    wrong_anchor.blockhash = [99; 32];
    assert!(index.reconcile(&wrong_anchor).is_err());
    assert!(index.snapshot_bytes().is_err());
}
fn rpc_value(ix: &Instruction) -> Value {
    let mut keys = ix.accounts.clone();
    keys.push(ix.program);
    json!({"blockhash":key([2;32]),"previousBlockhash":key([1;32]),"parentSlot":1,"blockTime":10,"transactions":[{"version":0,"transaction":{"signatures":[bs58::encode([2;64]).into_string()],"message":{"accountKeys":keys.iter().map(|k|key(*k)).collect::<Vec<_>>(),"instructions":[{"programIdIndex":keys.len()-1,"accounts":(0..ix.accounts.len()).collect::<Vec<_>>(),"data":bs58::encode(&ix.data).into_string()}]}},"meta":{"err":null,"loadedAddresses":{"writable":[],"readonly":[]},"innerInstructions":[],"logMessages":null}}]})
}
#[test]
fn rpc_null_logs_recover_outer_but_cpi_needs_positive_success_and_ancestry() {
    let mut index = initial();
    let mut tree = Tree::new();
    let deposit = ix(
        "deposit",
        payload(&mut tree, &note(0), Operation::Deposit, 0),
        accounts(),
    );
    let value = rpc_value(&deposit);
    index
        .apply_block(&decode_finalized_block(2, &value).unwrap())
        .unwrap();
    let mut cpi = value.clone();
    let message = &mut cpi["transactions"][0]["transaction"]["message"];
    let inner = message["instructions"][0].clone();
    message["accountKeys"]
        .as_array_mut()
        .unwrap()
        .push(json!(key([99; 32])));
    let outer_program = message["accountKeys"].as_array().unwrap().len() - 1;
    message["instructions"] = json!([{"programIdIndex":outer_program,"accounts":[],"data":""}]);
    let mut inner = inner;
    inner["stackHeight"] = json!(2);
    cpi["transactions"][0]["meta"]["innerInstructions"] =
        json!([{"index":0,"instructions":[inner]}]);
    let mut index = initial();
    assert_eq!(
        index.apply_block(&decode_finalized_block(2, &cpi).unwrap()),
        Err(Error::Invocation)
    );
    cpi["transactions"][0]["meta"]["logMessages"] = json!([
        format!("Program {} invoke [1]", key([99; 32])),
        format!("Program {} invoke [2]", key(PROGRAM)),
        format!("Program {} success", key(PROGRAM)),
        format!("Program {} success", key([99; 32]))
    ]);
    let mut index = initial();
    index
        .apply_block(&decode_finalized_block(2, &cpi).unwrap())
        .unwrap();
    assert_eq!(index.replay_state().unwrap().sequence, 1);
    cpi["transactions"][0]["meta"]["logMessages"][2] =
        json!(format!("Program {} failed: custom error", key(PROGRAM)));
    let mut index = initial();
    index
        .apply_block(&decode_finalized_block(2, &cpi).unwrap())
        .unwrap();
    assert_eq!(index.replay_state().unwrap().sequence, 0);
}
#[test]
fn foreign_program_data_cannot_impersonate_vault_event() {
    let mut ix = init();
    ix.program = [99; 32];
    ix.events = vec![discriminator("event", "VaultTransitionV1").to_vec()];
    let mut index = Indexer::new(PROGRAM, POOL);
    index.apply_block(&block(1, 10, vec![ix])).unwrap();
    assert!(index.reconcile(&index.replay_state().unwrap()).is_err());
}
#[test]
fn unknown_finality_or_reordered_execution_stops_public_paths() {
    let mut index = initial();
    let mut b = block(2, 10, vec![]);
    b.finalized = false;
    assert_eq!(index.apply_block(&b), Err(Error::Unfinalized));
    let mut index = initial();
    let mut b = block(
        2,
        10,
        vec![
            ix("pause", vec![], vec![POOL]),
            ix("unpause", vec![], vec![POOL]),
        ],
    );
    b.transactions[0].instructions[1].outer_index = 0;
    assert_eq!(index.apply_block(&b), Err(Error::History));
}
#[test]
fn tree_supports_maximum_u32_id_without_dense_allocation() {
    let mut tree = Tree::new();
    let empty = tree.root();
    let n = note(u32::MAX);
    tree.update(n.id, n.leaf().unwrap()).unwrap();
    let siblings = tree.path(n.id).map(|f| zkapi_poseidon::parse(&f).unwrap());
    assert_eq!(
        tree.root(),
        zkapi_poseidon::bytes(zkapi_poseidon::root(
            n.id,
            zkapi_poseidon::parse(&n.leaf().unwrap()).unwrap(),
            &siblings
        ))
    );
    tree.update(n.id, zkapi_poseidon::bytes(Fr::from(0)))
        .unwrap();
    assert_eq!(tree.root(), empty);
}

#[test]
fn empty_append_and_sealing_malformed_payload_match_chain_lifecycle() {
    let mut index = initial();
    let malformed = vec![255; Operation::Deposit.payload_len()];
    let buffer = [15; 32];
    index
        .apply_block(&block(
            2,
            10,
            vec![
                create(buffer, &malformed, Operation::Deposit),
                append(buffer, 0, &[]),
                append(buffer, 0, &malformed),
                append(buffer, malformed.len() as u32, &[]),
                seal(buffer),
            ],
        ))
        .unwrap();
    assert_eq!(index.replay_state().unwrap().sequence, 0);
    let mut failed = block(3, 10, vec![execute(buffer, &malformed)]);
    failed.transactions[0].succeeded = false;
    index.apply_block(&failed).unwrap();
    index
        .apply_block(&block(
            4,
            10,
            vec![ix(
                "close_payload",
                vec![],
                vec![buffer, POOL, [12; 32], [13; 32]],
            )],
        ))
        .unwrap();
}

#[test]
fn successful_vault_cpi_is_rolled_back_when_its_ancestor_fails_and_parent_catches() {
    let mut tree = Tree::new();
    let deposit = ix(
        "deposit",
        payload(&mut tree, &note(0), Operation::Deposit, 0),
        accounts(),
    );
    let mut value = rpc_value(&deposit);
    let message = &mut value["transactions"][0]["transaction"]["message"];
    let mut vault = message["instructions"][0].clone();
    vault["stackHeight"] = json!(3);
    let keys = message["accountKeys"].as_array_mut().unwrap();
    keys.push(json!(key([90; 32])));
    let parent = keys.len() - 1;
    keys.push(json!(key([91; 32])));
    let wrapper = keys.len() - 1;
    message["instructions"] = json!([{"programIdIndex":parent,"accounts":[],"data":""}]);
    let meta = &mut value["transactions"][0]["meta"];
    meta["innerInstructions"] = json!([{"index":0,"instructions":[{"programIdIndex":wrapper,"accounts":[],"data":"","stackHeight":2},vault]}]);
    meta["logMessages"] = json!([
        format!("Program {} invoke [1]", key([90; 32])),
        format!("Program {} invoke [2]", key([91; 32])),
        "Program data: YQ== Yg==",
        format!("Program {} invoke [3]", key(PROGRAM)),
        format!("Program {} success", key(PROGRAM)),
        format!("Program {} failed: parent rollback", key([91; 32])),
        format!("Program {} success", key([90; 32]))
    ]);
    let decoded = decode_finalized_block(2, &value).unwrap();
    assert_eq!(
        decoded.transactions[0].instructions[2].succeeded,
        Some(false)
    );
    let mut index = initial();
    index.apply_block(&decoded).unwrap();
    assert_eq!(index.replay_state().unwrap().sequence, 0);
    // A successful nested invocation with an unknown ancestor outcome cannot
    // prove committed writes, even though the top-level transaction succeeded.
    value["transactions"][0]["meta"]["logMessages"]
        .as_array_mut()
        .unwrap()
        .truncate(5);
    let decoded = decode_finalized_block(2, &value).unwrap();
    let mut index = initial();
    assert_eq!(index.apply_block(&decoded), Err(Error::Invocation));
}
