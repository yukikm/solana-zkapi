//! Synthetic instruction-history boundaries; no proof or public-chain claim.
use super::*;
use crate::Transaction;
use zkapi_layout2::{integer, TreeUpdate};

const PROGRAM: Bytes32 = [7; 32];
const POOL: Bytes32 = [8; 32];
const DEST: Bytes32 = [11; 32];
const BUFFER: Bytes32 = [12; 32];
fn binding() -> Bytes32 {
    zkapi_layout2::framing::reduce(sha(&zkapi_layout2::framing::vault(
        &[3; 32], &PROGRAM, &POOL, &[10; 32], &[4; 32],
    )))
}
fn instruction(name: &str, args: &[u8], accounts: Vec<Bytes32>) -> Instruction {
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
fn block(slot: u64, time: u64, instruction: Instruction) -> FinalizedBlock {
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
            instructions: vec![instruction],
        }],
    }
}
fn initial() -> Indexer {
    let mut args = vec![0; 280];
    args[32..64].copy_from_slice(&[3; 32]);
    args[192..200].copy_from_slice(&86400u64.to_le_bytes());
    args[200..208].copy_from_slice(&60u64.to_le_bytes());
    let mut accounts = vec![[9; 32]; 11];
    accounts[0] = POOL;
    accounts[3] = [4; 32];
    accounts[8] = [10; 32];
    let mut index = Indexer::new(PROGRAM, POOL);
    index
        .apply_block(&block(
            1,
            10,
            instruction("initialize_pool", &args, accounts),
        ))
        .unwrap();
    index
}
fn note() -> Note {
    Note {
        id: 0,
        commitment: integer(17),
        deposit: 12345,
        expiry: 172800,
    }
}
fn financial() -> Vec<Bytes32> {
    let mut a = vec![[9; 32]; 18];
    a[0] = POOL;
    a[9] = DEST;
    a
}
fn payload(tree: &mut Tree, op: Operation, nullifier: u64) -> Vec<u8> {
    let n = note();
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
        integer(0),
        old_leaf,
        new_leaf,
        n.commitment,
        integer(n.deposit),
        integer(n.expiry),
        integer(op.tree_op()),
        [0; 32],
    ];
    public[10] = zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(
        &std::iter::once(zkapi_poseidon::domain(b"solana.zkapi.tree.v1"))
            .chain(
                public[..10]
                    .iter()
                    .map(|v| zkapi_poseidon::parse(v).unwrap()),
            )
            .collect::<Vec<_>>(),
    ));
    let mut bytes = Vec::new();
    match op {
        Operation::Deposit => {
            bytes.extend(n.id.to_le_bytes());
            bytes.extend(old_root);
            bytes.extend(n.expiry.to_le_bytes());
            bytes.extend(n.commitment);
            bytes.extend(n.deposit.to_le_bytes());
        }
        Operation::Escape => {
            let mut p = [[0; 32]; 14];
            p[0] = integer(2);
            p[1] = integer(zkapi_layout2::NAMESPACE);
            p[2] = binding();
            p[3] = old_root;
            p[8] = integer(0);
            p[9] = integer(100);
            p[10] =
                zkapi_layout2::framing::reduce(sha(&zkapi_layout2::framing::destination(&DEST)));
            p[11] = integer(nullifier);
            for f in p {
                bytes.extend(f);
            }
            bytes.extend([0; 256]);
        }
        Operation::Challenge => {
            bytes.extend(n.id.to_le_bytes());
            let mut p = [[0; 32]; 12];
            p[2] = binding();
            p[3] = integer(777);
            p[8] = integer(nullifier);
            for f in p {
                bytes.extend(f);
            }
            bytes.extend([0; 256]);
        }
        _ => unreachable!(),
    }
    let mut wire = [0; 608];
    TreeUpdate {
        public,
        proof: [0; 256],
    }
    .encode(&mut wire)
    .unwrap();
    bytes.extend(wire);
    bytes
}
fn restored(index: &Indexer) -> Indexer {
    let bytes = index.checkpoint_bytes().unwrap();
    let (slot, hash) = index.checkpoint.unwrap();
    let result =
        Indexer::restore_checkpoint(&bytes, sha(&bytes), PROGRAM, POOL, slot, hash).unwrap();
    assert!(!result.is_ready());
    result
}
fn buffer_fixture() -> (Indexer, Vec<FinalizedBlock>) {
    let mut index = initial();
    let bytes = payload(&mut Tree::new(), Operation::Deposit, 0);
    let digest = sha(&bytes);
    let mut create = vec![Operation::Deposit as u8];
    create.extend((bytes.len() as u32).to_le_bytes());
    create.extend(digest);
    create.extend([0; 32]);
    create.extend(1000u64.to_le_bytes());
    let buffer_accounts = vec![BUFFER, POOL, [9; 32], [9; 32]];
    let append = |offset: u32, part: &[u8]| {
        let mut args = offset.to_le_bytes().to_vec();
        args.extend((part.len() as u32).to_le_bytes());
        args.extend(part);
        instruction("append_payload", &args, buffer_accounts.clone())
    };
    index
        .apply_block(&block(
            2,
            20,
            instruction("create_payload", &create, buffer_accounts.clone()),
        ))
        .unwrap();
    index
        .apply_block(&block(3, 30, append(0, &bytes[..100])))
        .unwrap();
    let mut execute_accounts = vec![BUFFER, [9; 32], [9; 32]];
    execute_accounts.extend(financial());
    (
        index,
        vec![
            block(4, 40, append(100, &bytes[100..])),
            block(5, 50, instruction("seal_payload", &[], buffer_accounts)),
            block(
                6,
                60,
                instruction("execute_payload", &digest, execute_accounts),
            ),
        ],
    )
}

#[test]
fn checkpoint_mid_payload_resumes_append_seal_execute_and_preserves_fork_detection() {
    let (mut uninterrupted, suffix) = buffer_fixture();
    let mut resumed = restored(&uninterrupted);
    assert_eq!(resumed.buffers[&BUFFER].generation.slot, 2);
    for next in &suffix {
        uninterrupted.apply_block(next).unwrap();
        resumed.apply_block(next).unwrap();
        // Includes a restart after sealing, before execute consumes the buffer.
        resumed = restored(&resumed);
    }
    assert_eq!(
        uninterrupted.checkpoint_bytes().unwrap(),
        resumed.checkpoint_bytes().unwrap()
    );
    assert_eq!(resumed.active[&0], note());
    assert!(resumed.buffers.is_empty());
    assert!(!resumed.is_ready());
    resumed
        .reconcile(&uninterrupted.replay_state().unwrap())
        .unwrap();
    assert!(resumed.is_ready());
    let before = resumed.checkpoint_bytes().unwrap();
    resumed.apply_block(&suffix[0]).unwrap();
    assert_eq!(resumed.checkpoint_bytes().unwrap(), before);
    let mut fork = suffix[0].clone();
    fork.block_time += 1;
    assert_eq!(resumed.apply_block(&fork), Err(Error::History));
    assert!(resumed.checkpoint_bytes().is_err());
}

#[test]
fn checkpoint_pending_resumes_deadline_finalize_and_keeps_spent_nullifiers() {
    let (mut index, suffix) = buffer_fixture();
    for b in suffix {
        index.apply_block(&b).unwrap();
    }
    let mut tree = index.tree.clone();
    let escape = payload(&mut tree, Operation::Escape, 99);
    index
        .apply_block(&block(
            7,
            100,
            instruction("initiate_escape", &escape, financial()),
        ))
        .unwrap();
    let mut resumed = restored(&index);
    assert!(resumed.exits.contains(&integer(99)));
    assert_eq!(resumed.pending, index.pending);
    let too_early = block(
        8,
        159,
        instruction("finalize_escape", &0u32.to_le_bytes(), financial()),
    );
    assert_eq!(resumed.clone().apply_block(&too_early), Err(Error::State));
    let final_block = block(
        8,
        160,
        instruction("finalize_escape", &0u32.to_le_bytes(), financial()),
    );
    index.apply_block(&final_block).unwrap();
    resumed.apply_block(&final_block).unwrap();
    assert_eq!(
        resumed.checkpoint_bytes().unwrap(),
        index.checkpoint_bytes().unwrap()
    );
    assert!(resumed.pending.is_empty());
    assert_eq!(resumed.outstanding, 0);
    // A challenged note returns to active, but its prior nullifier remains spent.
    let (mut challenged, suffix) = buffer_fixture();
    for b in suffix {
        challenged.apply_block(&b).unwrap();
    }
    challenged
        .apply_block(&block(
            7,
            100,
            instruction("initiate_escape", &escape, financial()),
        ))
        .unwrap();
    let mut challenged = restored(&challenged);
    let challenge = payload(&mut tree, Operation::Challenge, 99);
    challenged
        .apply_block(&block(
            8,
            120,
            instruction("challenge_escape", &challenge, financial()),
        ))
        .unwrap();
    let mut challenged = restored(&challenged);
    let repeated = payload(&mut tree, Operation::Escape, 99);
    assert_eq!(
        challenged.apply_block(&block(
            9,
            130,
            instruction("initiate_escape", &repeated, financial())
        )),
        Err(Error::State)
    );
}

#[test]
fn checkpoint_rejects_wrong_anchor_checksum_encoding_and_structural_corruption() {
    let (index, _) = buffer_fixture();
    let bytes = index.checkpoint_bytes().unwrap();
    let digest = sha(&bytes);
    for (program, pool, slot, hash, sum) in [
        ([0; 32], POOL, 3, [3; 32], digest),
        (PROGRAM, [0; 32], 3, [3; 32], digest),
        (PROGRAM, POOL, 4, [3; 32], digest),
        (PROGRAM, POOL, 3, [4; 32], digest),
        (PROGRAM, POOL, 3, [3; 32], [0; 32]),
    ] {
        assert!(Indexer::restore_checkpoint(&bytes, sum, program, pool, slot, hash).is_err());
    }
    let mut trailing = bytes.clone();
    trailing.push(b'\n');
    assert!(
        Indexer::restore_checkpoint(&trailing, sha(&trailing), PROGRAM, POOL, 3, [3; 32]).is_err()
    );
    let changes: [fn(&mut Saved); 8] = [
        |s| s.root = integer(999),
        |s| s.outstanding = 1,
        |s| s.buffers[0].generation.slot = 4,
        |s| s.buffers[0].sealed = true,
        |s| s.buffers[0].len += 1,
        |s| s.blocks.push(s.blocks[0].clone()),
        |s| s.blocks[0].1 = "0".into(),
        |s| s.config.as_mut().unwrap().ttl = 0,
    ];
    for change in changes {
        let mut saved: Saved = serde_json::from_slice(&bytes).unwrap();
        change(&mut saved);
        let bad = serde_json::to_vec(&saved).unwrap();
        assert!(Indexer::restore_checkpoint(&bad, sha(&bad), PROGRAM, POOL, 3, [3; 32]).is_err());
    }
}

#[test]
fn checkpoint_before_pool_initialization_resumes_and_never_restores_readiness() {
    let mut index = Indexer::new(PROGRAM, POOL);
    let mut quiet = block(1, 10, instruction("unrelated", &[], vec![]));
    quiet.transactions.clear();
    index.apply_block(&quiet).unwrap();
    let restored = restored(&index);
    assert_eq!(
        restored.checkpoint_bytes().unwrap(),
        index.checkpoint_bytes().unwrap()
    );
    assert!(!restored.is_ready());
    assert!(Indexer::new(PROGRAM, POOL).checkpoint_bytes().is_err());
}
