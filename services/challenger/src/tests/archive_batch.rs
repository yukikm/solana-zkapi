//! Journal durability/format tests only. Archive envelopes and signed-attempt
//! bytes are synthetic; they do not establish chain/proof/transaction validity.
use super::*;
use serde::Serialize;
use std::{fs, path::Path, time::Instant};
use zkapi_indexer::{FinalizedBlock, Instruction, Transaction};

fn block(slot: u64, payload_bytes: usize) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: slot,
        transactions: vec![Transaction {
            signature: format!("archive-fixture-{slot}"),
            succeeded: true,
            instructions: vec![Instruction {
                program: [201; 32],
                accounts: vec![[202; 32]],
                data: vec![(slot % 251) as u8; payload_bytes],
                outer_index: 0,
                invocation_index: 0,
                stack_height: 1,
                succeeded: Some(true),
                events: vec![],
            }],
        }],
    }
}

fn saved(directory: &Path) -> Vec<u8> {
    fs::read(directory.join("journal.json")).unwrap()
}

fn seeded(directory: &Path) -> (Journal, Hash, String, Value) {
    let (trust, _) = trust_and_manifest();
    let evidence = evidence(&trust);
    let view = view(trust.clone(), &evidence);
    let prepared = PreparedChallenge::from_finalized(&view, 0, evidence.clone()).unwrap();
    let bytes = payload(&prepared, &trust);
    let id = prepared.job.id();
    let mut journal = Journal::initialize(directory, trust.pool()).unwrap();
    journal
        .enqueue_cut(checkpoint(3), vec![(prepared.job, evidence)], 10)
        .unwrap();
    let digest = sha(&bytes);
    let buffer = [9; 32];
    journal
        .save_payload(
            &id,
            Payload {
                bytes,
                digest,
                buffer,
                checkpoint: checkpoint(3),
            },
        )
        .unwrap();
    let attempt = Attempt {
        signature: "archive-unknown-fixture".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Execute,
        payload_digest: digest,
        buffer,
        outcome: Outcome::Unknown,
    };
    let transport = json!({"signature":attempt.signature,"wireHex":"010203",
        "planDigest":hex::encode(digest),"buffer":zkapi_indexer::snapshot::key(buffer),
        "kind":"execute","stepIndex":3,"plan":{"operation":"challenge_escape"}});
    journal
        .save_v0_attempt(&id, attempt, transport.clone())
        .unwrap();
    journal.record_execute_send(&id, 11).unwrap();
    journal.record_proof_failure().unwrap();
    journal.enqueue_alerts(400).unwrap();
    (journal, trust.pool(), id, transport)
}

// Frozen v1 writer shape for the populated fields below. Empty absent_buffers
// was omitted by the old writer. This verifies exact legacy serialization order
// and checksum, independently of the optimized persist implementation.
#[derive(Serialize)]
struct LegacyState<'a> {
    version: u32,
    pool: Hash,
    jobs: BTreeMap<String, &'a Job>,
    checkpoint: Option<&'a Checkpoint>,
    archive: &'a [FinalizedBlock],
    transport: BTreeMap<String, &'a Value>,
    alerts: Vec<&'a AlertEvent>,
    proof_failure_total: u64,
}
#[derive(Serialize)]
struct LegacyEnvelope<'a> {
    digest: Hash,
    state: LegacyState<'a>,
}

#[test]
fn archive_batch_matches_singletons_and_legacy_v1_with_unknown_transport() {
    let one = tempfile::tempdir().unwrap();
    let batch = tempfile::tempdir().unwrap();
    let (mut single, pool, id, transport) = seeded(one.path());
    let (mut many, _, _, _) = seeded(batch.path());
    let before_job = single.jobs().next().unwrap().1.clone();
    let blocks: Vec<_> = (1..=64).map(|s| block(s, 128)).collect();
    for b in &blocks {
        single.append_archive(b.clone()).unwrap();
    }
    many.append_archive_batch(blocks.clone()).unwrap();
    assert_eq!(saved(one.path()), saved(batch.path()));
    let legacy = LegacyState {
        version: 1,
        pool,
        jobs: single
            .jobs()
            .map(|(id, job)| (id.to_owned(), job))
            .collect(),
        checkpoint: single.checkpoint(),
        archive: single.archive(),
        transport: BTreeMap::from([("archive-unknown-fixture".into(), &transport)]),
        alerts: single.alerts().collect(),
        proof_failure_total: single.proof_failure_total(),
    };
    let digest = sha(&serde_json::to_vec(&legacy).unwrap());
    assert_eq!(
        saved(one.path()),
        serde_json::to_vec(&LegacyEnvelope {
            digest,
            state: legacy
        })
        .unwrap()
    );
    drop(single);
    drop(many);
    for directory in [one.path(), batch.path()] {
        let journal = Journal::open(directory, pool).unwrap();
        assert_eq!(journal.archive(), blocks);
        assert_eq!(journal.jobs().next(), Some((id.as_str(), &before_job)));
        assert_eq!(
            journal.transport("archive-unknown-fixture"),
            Some(&transport)
        );
        assert_eq!(journal.proof_failure_total(), 1);
        assert_eq!(
            journal.jobs().next().unwrap().1.first_execute_send_at,
            Some(11)
        );
    }
}

#[test]
fn archive_batch_rejects_bad_middle_atomically_and_preserves_old_duplicates() {
    let directory = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(directory.path(), [8; 32]).unwrap();
    journal.append_archive(block(1, 128)).unwrap();
    let baseline = saved(directory.path());
    for fault in ["unfinalized", "parent", "hash", "old_duplicate", "order"] {
        let mut candidate = vec![block(2, 128), block(3, 128), block(4, 128)];
        match fault {
            "unfinalized" => candidate[1].finalized = false,
            "parent" => candidate[1].parent_slot = 1,
            "hash" => candidate[1].previous_blockhash[0] ^= 1,
            "old_duplicate" => {
                candidate[1] = block(1, 128);
                candidate[1].transactions[0].instructions[0].data[0] ^= 1;
            }
            "order" => candidate.swap(0, 1),
            _ => unreachable!(),
        }
        assert!(journal.append_archive_batch(candidate).is_err(), "{fault}");
        assert_eq!(saved(directory.path()), baseline, "{fault}");
        assert_eq!(journal.archive(), &[block(1, 128)], "{fault}");
    }
    journal
        .append_archive_batch(vec![
            block(1, 128),
            block(2, 128),
            block(2, 128),
            block(3, 128),
        ])
        .unwrap();
    let accepted = saved(directory.path());
    journal
        .append_archive_batch(vec![block(1, 128), block(3, 128)])
        .unwrap();
    assert_eq!(saved(directory.path()), accepted);
    drop(journal);
    let journal = Journal::open(directory.path(), [8; 32]).unwrap();
    assert_eq!(
        journal.archive(),
        (1..=3).map(|s| block(s, 128)).collect::<Vec<_>>()
    );
}

#[test]
fn archive_batch_failed_persistence_poisons_writes_and_original_reopens() {
    for failure in ["temporary_open", "rename"] {
        let directory = tempfile::tempdir().unwrap();
        let mut journal = Journal::initialize(directory.path(), [8; 32]).unwrap();
        journal.append_archive(block(1, 16)).unwrap();
        let baseline = saved(directory.path());
        let target = directory.path().join("journal.json");
        let temporary = directory.path().join("journal.next");
        if failure == "temporary_open" {
            fs::create_dir(&temporary).unwrap();
        } else {
            fs::rename(&target, directory.path().join("original.json")).unwrap();
            fs::create_dir(&target).unwrap();
        }
        assert!(journal
            .append_archive_batch(vec![block(2, 16), block(3, 16)])
            .is_err());
        assert_eq!(journal.archive(), &[block(1, 16)]);
        if failure == "temporary_open" {
            assert_eq!(saved(directory.path()), baseline);
            fs::remove_dir(&temporary).unwrap();
        } else {
            fs::remove_dir(&target).unwrap();
            fs::rename(directory.path().join("original.json"), &target).unwrap();
        }
        assert!(journal.append_archive(block(2, 16)).is_err());
        assert!(journal.record_proof_failure().is_err());
        assert_eq!(saved(directory.path()), baseline);
        drop(journal);
        let mut reopened = Journal::open(directory.path(), [8; 32]).unwrap();
        assert_eq!(reopened.archive(), &[block(1, 16)]);
        assert_eq!(reopened.proof_failure_total(), 0);
        reopened
            .append_archive_batch(vec![block(2, 16), block(3, 16)])
            .unwrap();
        assert_eq!(reopened.archive().len(), 3);
    }
}

#[test]
fn archive_batch_restart_retains_committed_prefix_and_refetches_unsaved_suffix() {
    let directory = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(directory.path(), [8; 32]).unwrap();
    let prefix: Vec<_> = (1..=64).map(|s| block(s, 64)).collect();
    journal.append_archive_batch(prefix.clone()).unwrap();
    let durable = saved(directory.path());
    // The runtime may have fetched this suffix; no journal commit has occurred.
    let suffix: Vec<_> = (65..=71).map(|s| block(s, 64)).collect();
    drop(journal);
    let mut journal = Journal::open(directory.path(), [8; 32]).unwrap();
    assert_eq!(journal.archive(), prefix);
    assert_eq!(saved(directory.path()), durable);
    journal.append_archive_batch(suffix.clone()).unwrap();
    drop(journal);
    let mut journal = Journal::open(directory.path(), [8; 32]).unwrap();
    let complete: Vec<_> = prefix.into_iter().chain(suffix).collect();
    assert_eq!(journal.archive(), complete);
    let durable = saved(directory.path());
    journal.append_archive_batch(complete).unwrap();
    assert_eq!(saved(directory.path()), durable);
}

#[test]
#[ignore = "manual local journal fsync microbenchmark; no RPC, proof or public SLO"]
fn archive_batch_measure_local_singleton_and_batch_persistence() {
    let blocks: Vec<_> = (1..=64).map(|s| block(s, 4096)).collect();
    let one = tempfile::tempdir().unwrap();
    let batch = tempfile::tempdir().unwrap();
    let mut single = Journal::initialize(one.path(), [8; 32]).unwrap();
    let mut many = Journal::initialize(batch.path(), [8; 32]).unwrap();
    let start = Instant::now();
    for b in &blocks {
        single.append_archive(b.clone()).unwrap();
    }
    let singleton_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    many.append_archive_batch(blocks).unwrap();
    let batch_seconds = start.elapsed().as_secs_f64();
    let bytes = saved(one.path());
    assert_eq!(bytes, saved(batch.path()));
    println!(
        "{}",
        json!({"schema":1,"passed":true,
        "scope":"local temporary-filesystem synthetic64-block journal persistence,4096-byte foreign instruction per block; excludes RPC/replay/proof and does not establish public latency/SLO",
        "blocks":64,"singleton_commits":64,"batch_commits":1,"journal_bytes":bytes.len(),
        "singleton_seconds":singleton_seconds,"batch_seconds":batch_seconds,
        "exact_legacy_journal_bytes_equal":true})
    );
}
