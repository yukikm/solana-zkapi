//! Synthetic storage fixtures only; no proof, RPC, funded state, or live files.
use super::*;
use serde_json::json;
use zkapi_indexer::{Instruction, Transaction};

const POOL: Hash = [71; 32];
fn archive(journal: &Journal) -> Vec<FinalizedBlock> {
    let mut blocks = Vec::new();
    journal
        .replay_archive(|block| {
            blocks.push(block.clone());
            Ok(())
        })
        .unwrap();
    blocks
}
pub(super) fn block(slot: u64, bytes: usize) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: slot,
        transactions: vec![Transaction {
            signature: format!("synthetic-{slot}"),
            succeeded: true,
            instructions: vec![Instruction {
                program: [72; 32],
                accounts: vec![[73; 32]],
                data: vec![31; bytes],
                outer_index: 0,
                invocation_index: 0,
                stack_height: 1,
                succeeded: Some(true),
                events: vec![],
            }],
        }],
    }
}
fn seed(root: &Path, count: u64, bytes: usize) -> Vec<FinalizedBlock> {
    let mut journal = Journal::initialize(root, POOL).unwrap();
    let blocks: Vec<_> = (1..=count).map(|s| block(s, bytes)).collect();
    journal.append_archive_batch(blocks.clone()).unwrap();
    // Storage-valid synthetic signed-attempt/transport metadata. No claim that
    // these fixture signatures, proofs, or transaction bytes validate on chain.
    journal.update(|state| {
        let checkpoint = Checkpoint { position: Position { slot: 1, transaction_index: 0,
            signature: "synthetic-cut".into(), outer_instruction: 0, invocation_index: 0 },
            blockhash: block(1, 0).blockhash, tree_sequence: 1 };
        let identity = JobIdentity { pool: POOL, note_id: 0, nullifier: [74; 32], deadline: 100, generation: checkpoint.clone() };
        let transcript = b"synthetic storage evidence".to_vec();
        let evidence = Evidence { pool: POOL, request_id: uuid::Uuid::nil(), nullifier: identity.nullifier,
            transcript_digest: sha(&transcript), transcript };
        let payload = Payload { bytes: vec![1, 2], digest: sha(&[1, 2]), buffer: [75; 32], checkpoint: checkpoint.clone() };
        let attempt = Attempt { signature: "synthetic-unknown-send".into(), signed_bytes: vec![4, 5],
            stage: Stage::Execute, payload_digest: payload.digest, buffer: payload.buffer, outcome: Outcome::Unknown };
        state.transport.insert(attempt.signature.clone(), json!({"signature":attempt.signature,"wireHex":"0405",
            "planDigest":hex::encode(payload.digest),"buffer":zkapi_indexer::snapshot::key(payload.buffer),
            "kind":"execute","plan":{"operation":"challenge_escape"}}));
        state.jobs.insert(identity.id(), Job { identity, evidence, discovered_at: 1,
            payloads: vec![payload], attempts: vec![attempt], complete: false, first_execute_send_at: Some(2) });
        state.checkpoint = Some(checkpoint);
        state.proof_failure_total = 7;
        Ok(())
    }).unwrap();
    journal.enqueue_alerts(50).unwrap();
    blocks
}
fn read_head(root: &Path) -> (State, Head) {
    let (envelope, _, _) = read_source(root).unwrap();
    (envelope.state, envelope.segmented.unwrap())
}
pub(super) fn migrated(count: u64) -> (tempfile::TempDir, Vec<FinalizedBlock>) {
    let root = tempfile::tempdir().unwrap();
    let blocks = seed(root.path(), count, 128);
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    (root, blocks)
}
fn raw(root: &Path) -> Vec<u8> {
    fs::read(root.join("journal.json")).unwrap()
}
fn failure(point: &'static str) {
    FAILURE.with(|f| f.set(Some(point)));
}
fn chunk_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(root.join(ARCHIVE_DIR))
        .unwrap()
        .map(|p| {
            let p = p.unwrap().path();
            (
                p.file_name().unwrap().to_str().unwrap().to_owned(),
                fs::read(p).unwrap(),
            )
        })
        .collect()
}

#[test]
fn segmented_migration_retains_exact_v1_and_all_jobs_attempts_transport_alerts() {
    let root = tempfile::tempdir().unwrap();
    let blocks = seed(root.path(), 514, 128);
    // Old readable v1 files may contain outer whitespace and reordered keys.
    let old: serde_json::Value = serde_json::from_slice(&raw(root.path())).unwrap();
    let old_bytes = format!(
        "  {{\n\"state\":{},\n\"digest\":{}\n}} \n",
        old["state"], old["digest"]
    )
    .into_bytes();
    fs::write(root.path().join("journal.json"), &old_bytes).unwrap();
    let original = Journal::open(root.path(), POOL).unwrap();
    let mut expected = original.state.clone();
    drop(original);
    let report = Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    assert_eq!(report.format_version, 2);
    assert_eq!(report.archive_blocks, 514);
    assert_eq!(report.archive_chunks, 3);
    assert_eq!(report.legacy_sha256, sha(&old_bytes));
    assert_eq!(report.legacy_bytes, old_bytes.len() as u64);
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), old_bytes);
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    expected.version = 2;
    expected.archive.clear();
    assert_eq!(journal.state, expected);
    assert_eq!(archive(&journal), blocks);
    assert_eq!(journal.segmented.as_ref().unwrap().references.len(), 3);
    let committed_tail = journal.archive_tail();
    let files = chunk_files(root.path());
    journal.record_proof_failure().unwrap();
    assert_eq!(journal.archive_tail(), committed_tail);
    assert!(journal.state.archive.is_empty());
    assert_eq!(chunk_files(root.path()), files);
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), old_bytes);
    assert!(raw(root.path()).len() < 10_000);
    journal
        .append_archive_batch(vec![block(514, 128), block(515, 128)])
        .unwrap();
    assert_eq!(journal.archive_len(), 515);
    assert_eq!(
        journal.archive_tail(),
        Some(ArchiveTail::from(&block(515, 128)))
    );
    for (name, bytes) in files {
        assert_eq!(
            fs::read(root.path().join(ARCHIVE_DIR).join(name)).unwrap(),
            bytes
        );
    }
    drop(journal);
    let journal = Journal::open(root.path(), POOL).unwrap();
    assert_eq!(journal.archive_len(), 515);
    assert_eq!(journal.proof_failure_total(), 8);
    assert_eq!(
        journal.jobs().next().unwrap().1.attempts[0].outcome,
        Outcome::Unknown
    );
    assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
}

#[test]
fn segmented_old_reader_rejects_v2_and_legacy_default_bytes_stay_legacy() {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OldEnvelope {
        #[allow(dead_code)]
        digest: Hash,
        #[allow(dead_code)]
        state: State,
    }
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::initialize(root.path(), POOL).unwrap();
    let original = raw(root.path());
    assert!(serde_json::from_slice::<OldEnvelope>(&original).is_ok());
    drop(journal);
    assert_eq!(Journal::open(root.path(), POOL).unwrap().state.version, 1);
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    assert!(serde_json::from_slice::<OldEnvelope>(&raw(root.path())).is_err());
    assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), original);
    assert!(Journal::open(root.path(), POOL).unwrap().archive_is_empty());
}

#[test]
fn segmented_batch_duplicate_fork_gap_and_failed_middle_are_atomic() {
    let (root, blocks) = migrated(3);
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    let initial = raw(root.path());
    let chunks = chunk_files(root.path());
    for fault in ["fork", "gap", "unfinalized", "rollback"] {
        let mut bad = block(5, 128);
        match fault {
            "fork" => bad.previous_blockhash = [0; 32],
            "gap" => bad.parent_slot = 3,
            "unfinalized" => bad.finalized = false,
            _ => bad = block(2, 129),
        }
        assert!(journal
            .append_archive_batch(vec![block(4, 128), bad])
            .is_err());
        assert_eq!(archive(&journal), blocks);
        assert_eq!(raw(root.path()), initial);
        assert_eq!(chunk_files(root.path()), chunks);
    }
    journal
        .append_archive_batch(vec![
            block(1, 128),
            block(4, 128),
            block(2, 128),
            block(4, 128),
            block(5, 128),
        ])
        .unwrap();
    assert_eq!(
        archive(&journal),
        (1..=5).map(|s| block(s, 128)).collect::<Vec<_>>()
    );
    let committed = raw(root.path());
    journal
        .append_archive_batch(vec![block(2, 128), block(5, 128)])
        .unwrap();
    assert_eq!(raw(root.path()), committed);
}

#[test]
fn segmented_every_append_failure_preserves_memory_poisons_and_never_adopts_orphans() {
    for point in [
        "chunk_before_flush",
        "chunk_after_sync",
        "chunk_after_publish",
        "head_before_flush",
        "head_after_sync",
        "head_before_rename",
        "head_after_rename",
        "head_after_dirsync",
    ] {
        let (root, blocks) = migrated(2);
        let mut journal = Journal::open(root.path(), POOL).unwrap();
        failure(point);
        assert!(journal.append_archive(block(3, 128)).is_err(), "{point}");
        assert_eq!(archive(&journal), blocks, "{point}");
        assert!(journal.record_proof_failure().is_err());
        assert!(journal.append_archive_batch(vec![]).is_err());
        assert!(journal.enqueue_alerts(0).is_err());
        drop(journal);
        let mut reopened = Journal::open(root.path(), POOL).unwrap();
        let activated = ["head_after_rename", "head_after_dirsync"].contains(&point);
        assert_eq!(
            reopened.archive_len(),
            if activated { 3 } else { 2 },
            "{point}"
        );
        let retained = chunk_files(root.path());
        reopened.append_archive(block(3, 128)).unwrap();
        assert_eq!(reopened.archive_len(), 3);
        // All incomplete/unused files are retained. No orphan is adopted or overwritten.
        for (name, bytes) in retained {
            assert_eq!(
                fs::read(root.path().join(ARCHIVE_DIR).join(name)).unwrap(),
                bytes
            );
        }
    }
}

#[test]
fn segmented_metadata_failure_poisons_without_cloning_history() {
    let (root, blocks) = migrated(2);
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    failure("head_before_flush");
    assert!(journal.record_proof_failure().is_err());
    assert_eq!(journal.proof_failure_total(), 7);
    assert_eq!(archive(&journal), blocks);
    assert!(journal.record_proof_failure().is_err());
    drop(journal);
    assert_eq!(
        Journal::open(root.path(), POOL)
            .unwrap()
            .proof_failure_total(),
        7
    );
}

#[test]
fn segmented_migration_failures_and_cancellation_leave_v1_before_activation() {
    for point in [
        "migration_after_backup",
        "chunk_before_flush",
        "chunk_after_publish",
        "migration_before_activation",
        "head_before_rename",
    ] {
        let root = tempfile::tempdir().unwrap();
        let blocks = seed(root.path(), 257, 16);
        let original = raw(root.path());
        failure(point);
        assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
        assert_eq!(raw(root.path()), original, "{point}");
        assert_eq!(archive(&Journal::open(root.path(), POOL).unwrap()), blocks);
        assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
    }
    for stop_at in [1, 2, 3, 4, 5, 6] {
        let root = tempfile::tempdir().unwrap();
        let blocks = seed(root.path(), 257, 16);
        let original = raw(root.path());
        let count = std::cell::Cell::new(0);
        assert!(
            Journal::migrate_v1_to_segmented_with_cancel(root.path(), POOL, || {
                count.set(count.get() + 1);
                count.get() >= stop_at
            })
            .is_err()
        );
        assert_eq!(raw(root.path()), original);
        assert_eq!(archive(&Journal::open(root.path(), POOL).unwrap()), blocks);
        if stop_at <= 2 {
            assert!(!root.path().join(ARCHIVE_DIR).exists());
        } else {
            assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
        }
    }
    for point in ["head_after_rename", "head_after_dirsync"] {
        let root = tempfile::tempdir().unwrap();
        seed(root.path(), 2, 16);
        let original = raw(root.path());
        failure(point);
        assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
        assert_ne!(raw(root.path()), original);
        assert_eq!(fs::read(root.path().join(BACKUP)).unwrap(), original);
        assert_eq!(Journal::open(root.path(), POOL).unwrap().state.version, 2);
        assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
    }
}

#[test]
fn segmented_migration_requires_original_lock_pool_and_unmodified_source() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), 2, 16);
    let original = raw(root.path());
    let held = Journal::open(root.path(), POOL).unwrap();
    assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
    drop(held);
    assert!(Journal::migrate_v1_to_segmented(root.path(), [0; 32]).is_err());
    assert_eq!(raw(root.path()), original);
    assert!(!root.path().join(ARCHIVE_DIR).exists());
    fs::write(root.path().join(BACKUP), b"partial backup").unwrap();
    assert!(Journal::migrate_v1_to_segmented(root.path(), POOL).is_err());
    assert_eq!(raw(root.path()), original);
}

#[test]
fn segmented_corrupt_missing_trailing_and_substituted_chunks_or_backup_fail_closed() {
    for fault in [
        "missing",
        "tampered",
        "trailing",
        "truncated",
        "backup",
        "substitution",
    ] {
        let (root, _) = migrated(257);
        let (_, head) = read_head(root.path());
        let path = chunk_path(&root.path().join(ARCHIVE_DIR), head.tail.as_ref().unwrap());
        match fault {
            "missing" => fs::remove_file(path).unwrap(),
            "tampered" => {
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] = b'[';
                fs::write(path, bytes).unwrap();
            }
            "trailing" => {
                let mut bytes = fs::read(&path).unwrap();
                bytes.extend_from_slice(b"{}");
                fs::write(path, bytes).unwrap();
            }
            "truncated" => {
                let mut bytes = fs::read(&path).unwrap();
                bytes.pop();
                fs::write(path, bytes).unwrap();
            }
            "backup" => fs::write(root.path().join(BACKUP), b"changed").unwrap(),
            _ => {
                let other = migrated(257).0;
                let (_, other_head) = read_head(other.path());
                fs::copy(
                    chunk_path(
                        &other.path().join(ARCHIVE_DIR),
                        other_head.tail.as_ref().unwrap(),
                    ),
                    path,
                )
                .unwrap();
            }
        }
        assert!(Journal::open(root.path(), POOL).is_err(), "{fault}");
    }
}

#[test]
fn segmented_authenticated_but_invalid_counts_identity_and_chain_fail_closed() {
    for fault in [
        "count",
        "chunks",
        "pool",
        "tail_count",
        "tail_slot",
        "tail_sequence",
        "version",
        "embedded_archive",
    ] {
        let (root, _) = migrated(257);
        let (mut state, mut head) = read_head(root.path());
        match fault {
            "count" => head.blocks += 1,
            "chunks" => head.chunks += 1,
            "pool" => head.pool = [0; 32],
            "tail_count" => head.tail.as_mut().unwrap().blocks += 1,
            "tail_slot" => head.tail.as_mut().unwrap().first_slot += 1,
            "tail_sequence" => head.tail.as_mut().unwrap().sequence += 1,
            "version" => head.version = 1,
            _ => state.archive.push(block(1, 16)),
        }
        persist_head(root.path(), &state, &head).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err(), "{fault}");
    }
    let (root, _) = migrated(1);
    for tail in [b"{}".as_slice(), b" false", b" invalid"] {
        let mut bytes = raw(root.path());
        bytes.extend_from_slice(tail);
        fs::write(root.path().join("journal.json"), bytes).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err());
    }
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), 0, 0);
    let mut v: serde_json::Value = serde_json::from_slice(&raw(root.path())).unwrap();
    v["segmented"] = serde_json::Value::Null;
    fs::write(
        root.path().join("journal.json"),
        serde_json::to_vec(&v).unwrap(),
    )
    .unwrap();
    assert!(Journal::open(root.path(), POOL).is_err());
}

#[cfg(unix)]
#[test]
fn segmented_symlink_and_path_fields_are_rejected_and_orphans_ignored() {
    use std::os::unix::fs::symlink;
    for target in ["chunk", "backup", "directory", "primary"] {
        let (root, _) = migrated(1);
        let (_, head) = read_head(root.path());
        let path = match target {
            "chunk" => chunk_path(&root.path().join(ARCHIVE_DIR), head.tail.as_ref().unwrap()),
            "backup" => root.path().join(BACKUP),
            "directory" => root.path().join(ARCHIVE_DIR),
            _ => root.path().join("journal.json"),
        };
        let moved = root.path().join("synthetic-link-target");
        fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err(), "{target}");
    }
    let (root, blocks) = migrated(1);
    fs::write(
        root.path().join(ARCHIVE_DIR).join("orphan.json"),
        b"not a block",
    )
    .unwrap();
    symlink(
        "/never-open-this",
        root.path().join(ARCHIVE_DIR).join("orphan-link"),
    )
    .unwrap();
    assert_eq!(archive(&Journal::open(root.path(), POOL).unwrap()), blocks);
    let mut v: serde_json::Value = serde_json::from_slice(&raw(root.path())).unwrap();
    v["segmented"]["tail"]["path"] = json!("../legacy-v1.json");
    fs::write(
        root.path().join("journal.json"),
        serde_json::to_vec(&v).unwrap(),
    )
    .unwrap();
    assert!(Journal::open(root.path(), POOL).is_err());
}

#[test]
fn segmented_chunks_preserve_oversized_singletons_and_apply_byte_threshold() {
    // Byte threshold is tested with a counting-only view first, avoiding a
    // multi-GB fixture. Encoded u8 arrays make this >32MiB per large block.
    let large = block(1, 12 * 1024 * 1024);
    let second = block(2, 12 * 1024 * 1024);
    assert_eq!(chunk_end(&[large.clone(), second], 0).unwrap(), 1);
    let root = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(root.path(), POOL).unwrap();
    journal.append_archive(large.clone()).unwrap();
    drop(journal);
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    let reopened = Journal::open(root.path(), POOL).unwrap();
    assert_eq!(archive(&reopened), [large]);
    assert_eq!(reopened.segmented.as_ref().unwrap().head.chunks, 1);
}

#[test]
fn segmented_rehashed_chunk_semantic_corruption_is_rejected() {
    for fault in [
        "parent",
        "previous_hash",
        "sequence",
        "previous_sequence",
        "previous_count",
        "pool",
        "unfinalized",
        "version",
        "legacy_digest",
    ] {
        let (root, _) = migrated(257);
        let (state, mut head) = read_head(root.path());
        if fault == "legacy_digest" {
            head.legacy.state_digest = [0; 32];
        } else {
            let mut reference = head.tail.clone().unwrap();
            let path = root.path().join(ARCHIVE_DIR);
            let (mut chunk, _, _): (Chunk<Vec<FinalizedBlock>>, _, _) = read_chunk_json(
                regular(&chunk_path(&path, &reference)).unwrap(),
                reference.bytes,
            )
            .unwrap();
            match fault {
                "parent" => chunk.blocks[0].parent_slot -= 1,
                "previous_hash" => chunk.blocks[0].previous_blockhash = [0; 32],
                "sequence" => chunk.sequence -= 1,
                "previous_sequence" => chunk.previous.as_mut().unwrap().sequence += 1,
                "previous_count" => chunk.previous.as_mut().unwrap().blocks -= 1,
                "pool" => chunk.pool = [0; 32],
                "unfinalized" => chunk.blocks[0].finalized = false,
                "version" => chunk.version = 1,
                _ => unreachable!(),
            }
            let bytes = serde_json::to_vec(&chunk).unwrap();
            reference.sha256 = sha(&bytes);
            reference.bytes = bytes.len() as u64;
            fs::write(chunk_path(&path, &reference), bytes).unwrap();
            head.tail = Some(reference);
        }
        // Recompute both file and head checksums. Semantic invariants, rather
        // than a stale byte hash, must reject each incompatible journal.
        persist_head(root.path(), &state, &head).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err(), "{fault}");
    }
}

#[test]
fn segmented_cold_reopen_child() {
    let Some(path) = std::env::var_os("ZKAPI_SEGMENTED_SYNTHETIC_REOPEN") else {
        return;
    };
    let journal = Journal::open(Path::new(&path), POOL).unwrap();
    assert_eq!(
        archive(&journal),
        (1..=257).map(|s| block(s, 128)).collect::<Vec<_>>()
    );
    assert_eq!(journal.proof_failure_total(), 7);
    assert_eq!(
        journal.jobs().next().unwrap().1.attempts[0].outcome,
        Outcome::Unknown
    );
}

#[test]
fn segmented_fresh_process_reopens_committed_history_without_adopting_orphan_tail() {
    let (root, _) = migrated(257);
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    failure("head_before_rename");
    assert!(journal.append_archive(block(258, 128)).is_err());
    drop(journal);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "journal::segmented::tests::segmented_cold_reopen_child",
            "--nocapture",
        ])
        .env("ZKAPI_SEGMENTED_SYNTHETIC_REOPEN", root.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[test]
fn segmented_rechecksummed_empty_truncated_or_replaced_legacy_prefix_is_rejected() {
    for fault in ["empty", "truncated", "shifted", "changed_transactions"] {
        let (root, _) = migrated(2);
        let (state, mut head) = read_head(root.path());
        if fault == "empty" {
            head.blocks = 0;
            head.chunks = 0;
            head.tail = None;
        } else {
            let mut blocks = match fault {
                "truncated" => vec![block(1, 128)],
                "shifted" => vec![block(2, 128), block(3, 128)],
                _ => vec![block(1, 128), block(2, 128)],
            };
            if fault == "changed_transactions" {
                // Count, slots, blockhashes and parent joins remain identical;
                // only full archived instruction bytes expose substitution.
                blocks[0].transactions[0].instructions[0].data[0] ^= 1;
            }
            let reference =
                write_chunk(&root.path().join(ARCHIVE_DIR), POOL, None, &blocks).unwrap();
            head.blocks = reference.blocks;
            head.chunks = 1;
            head.tail = Some(reference);
        }
        persist_head(root.path(), &state, &head).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err(), "{fault}");
    }
}

#[test]
fn segmented_migration_rejects_rechecksummed_invalid_legacy_chain_before_staging() {
    for fault in ["parent", "previous_hash", "unfinalized", "slot_order"] {
        let root = tempfile::tempdir().unwrap();
        seed(root.path(), 2, 16);
        let (mut envelope, _, _) = read_source(root.path()).unwrap();
        match fault {
            "parent" => envelope.state.archive[1].parent_slot = 0,
            "previous_hash" => envelope.state.archive[1].previous_blockhash = [0; 32],
            "unfinalized" => envelope.state.archive[1].finalized = false,
            _ => envelope.state.archive[1].slot = 1,
        }
        // Test-only rechecksum makes semantic validation, rather than a stale
        // digest, responsible for refusing activation of unusable v2 storage.
        persist(root.path(), &envelope.state).unwrap();
        let original = raw(root.path());
        assert!(
            Journal::migrate_v1_to_segmented(root.path(), POOL).is_err(),
            "{fault}"
        );
        assert_eq!(raw(root.path()), original);
        assert!(!root.path().join(ARCHIVE_DIR).exists());
        assert!(!root.path().join(BACKUP).exists());
    }
}

#[test]
fn segmented_disk_cursor_preserves_skipped_slots_order_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    drop(Journal::initialize(root.path(), POOL).unwrap());
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    let mut blocks = vec![block(1, 16), block(3, 16), block(8, 16)];
    for index in 1..blocks.len() {
        blocks[index].parent_slot = blocks[index - 1].slot;
        blocks[index].previous_blockhash = blocks[index - 1].blockhash;
    }
    journal.append_archive_batch(blocks.clone()).unwrap();
    let primary = raw(root.path());
    assert_eq!(journal.archive_len(), 3);
    assert!(!journal.archive_is_empty());
    assert_eq!(journal.archive_tail(), blocks.last().map(ArchiveTail::from));
    assert_eq!(archive(&journal), blocks);
    for slot in [0, 2, 4, 7, 9] {
        assert_eq!(journal.archive_block_time(slot).unwrap(), None);
    }
    for slot in [1, 3, 8] {
        assert_eq!(journal.archive_block_time(slot).unwrap(), Some(slot));
    }
    let mut visited = Vec::new();
    assert!(journal
        .replay_archive(|block| {
            visited.push(block.slot);
            if block.slot == 3 {
                return Err(Error::Conflict("synthetic replay cancellation"));
            }
            Ok(())
        })
        .is_err());
    assert_eq!(visited, vec![1, 3]);
    assert_eq!(raw(root.path()), primary);
    // A skipped slot cannot be inserted into the already committed prefix.
    assert!(journal.append_archive(block(2, 16)).is_err());
    assert_eq!(raw(root.path()), primary);
    journal.append_archive_batch(blocks.clone()).unwrap();
    assert_eq!(raw(root.path()), primary);
    drop(journal);
    assert_eq!(archive(&Journal::open(root.path(), POOL).unwrap()), blocks);
}

#[test]
fn segmented_disk_duplicates_across_chunks_compare_full_payloads() {
    let (root, _) = migrated(514);
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    let primary = raw(root.path());
    for slot in [1, 256, 257, 512, 513, 514] {
        assert_eq!(journal.archive_block_time(slot).unwrap(), Some(slot));
        journal.append_archive(block(slot, 128)).unwrap();
        let mut changed = block(slot, 128);
        changed.transactions[0].instructions[0].data[0] ^= 1;
        assert!(journal.append_archive(changed).is_err());
        assert_eq!(raw(root.path()), primary);
    }
    journal
        .append_archive_batch(vec![
            block(256, 128),
            block(515, 128),
            block(257, 128),
            block(516, 128),
        ])
        .unwrap();
    assert_eq!(journal.archive_len(), 516);
    assert_eq!(journal.archive_tail().unwrap().slot, 516);
}

#[test]
fn segmented_disk_reads_reject_post_open_chunk_substitution_before_callback_or_commit() {
    for operation in ["replay", "time", "duplicate"] {
        let (root, _) = migrated(2);
        let mut journal = Journal::open(root.path(), POOL).unwrap();
        let before = raw(root.path());
        let (_, head) = read_head(root.path());
        let path = chunk_path(&root.path().join(ARCHIVE_DIR), head.tail.as_ref().unwrap());
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(regular(&path).unwrap())
            .read_to_end(&mut bytes)
            .unwrap();
        // Same byte length and valid JSON, but a different archived payload.
        let needle = b"\"data\":[31,";
        let position = bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .unwrap()
            + 8;
        bytes[position] = b'2';
        fs::write(&path, bytes).unwrap();
        let mut visits = 0;
        let rejected = match operation {
            "replay" => journal
                .replay_archive(|_| {
                    visits += 1;
                    Ok(())
                })
                .is_err(),
            "time" => journal.archive_block_time(1).is_err(),
            _ => journal.append_archive(block(1, 128)).is_err(),
        };
        assert!(rejected, "{operation}");
        assert_eq!(visits, 0);
        assert_eq!(raw(root.path()), before);
        assert_eq!(journal.archive_len(), 2);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn segmented_disk_memory_child() {
    let Some(root) = std::env::var_os("ZKAPI_DISK_ARCHIVE_SYNTHETIC_CHILD") else {
        return;
    };
    let expected: u64 = std::env::var("ZKAPI_DISK_ARCHIVE_SYNTHETIC_COUNT")
        .unwrap()
        .parse()
        .unwrap();
    let journal = Journal::open(Path::new(&root), POOL).unwrap();
    assert_eq!(journal.archive_len(), expected);
    let mut count = 0;
    journal
        .replay_archive(|block| {
            count += 1;
            assert_eq!(block.slot, count);
            assert_eq!(block.transactions[0].instructions[0].data.len(), 524_288);
            Ok(())
        })
        .unwrap();
    assert_eq!(count, expected);
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let usage = unsafe { usage.assume_init() };
    let peak = usage.ru_maxrss as u64;
    #[cfg(target_os = "linux")]
    let peak = peak * 1024;
    fs::write(
        Path::new(&root).join(format!("memory-{expected}.json")),
        serde_json::to_vec(&json!({
            "blocks":count,"chunks":journal.segmented.as_ref().unwrap().references.len(),
            "instruction_payload_bytes":count * 524_288,"process_peak_rss_bytes":peak
        }))
        .unwrap(),
    )
    .unwrap();
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn segmented_disk_cold_replay_memory_does_not_retain_growing_payload_history() {
    let root = tempfile::tempdir().unwrap();
    drop(Journal::initialize(root.path(), POOL).unwrap());
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    let mut previous_count = 0;
    let mut reports = Vec::new();
    for count in [16u64, 128] {
        let mut journal = Journal::open(root.path(), POOL).unwrap();
        // Generate only a small append batch at once, never the whole fixture.
        while previous_count < count {
            journal
                .append_archive_batch(
                    (previous_count + 1..=previous_count + 16)
                        .map(|slot| block(slot, 524_288))
                        .collect(),
                )
                .unwrap();
            previous_count += 16;
        }
        drop(journal);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "journal::segmented::tests::segmented_disk_memory_child",
                "--nocapture",
            ])
            .env("ZKAPI_DISK_ARCHIVE_SYNTHETIC_CHILD", root.path())
            .env("ZKAPI_DISK_ARCHIVE_SYNTHETIC_COUNT", count.to_string())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(
            &fs::read(root.path().join(format!("memory-{count}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(report["blocks"], count);
        reports.push(report);
    }
    let small = reports[0]["process_peak_rss_bytes"].as_u64().unwrap();
    let large = reports[1]["process_peak_rss_bytes"].as_u64().unwrap();
    // Seven additional chunks contain 56MiB of payload. Retaining that payload
    // would exceed this 28MiB growth allowance; metadata and one chunk do not.
    assert!(large <= small + 28 * 1024 * 1024, "{reports:?}");
    println!(
        "{}",
        json!({"scope":"synthetic disk archive cold-open and ordered replay; not full-stack capacity", "measurements":reports})
    );
}

#[test]
fn bounded_archive_json_matches_streaming_value_hash_and_byte_count() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("chunk.json");
    let value = Chunk {
        version: 2,
        pool: POOL,
        sequence: 1,
        nonce: [8; 32],
        previous: None,
        blocks: vec![block(1, 1024), block(2, 2048)],
    };
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.extend_from_slice(b" \n\t");
    fs::write(&path, &bytes).unwrap();
    let fast: (serde_json::Value, _, _) = read_json(regular(&path).unwrap()).unwrap();
    let streaming: (serde_json::Value, _, _) = read_json_stream(regular(&path).unwrap()).unwrap();
    assert_eq!(fast, streaming);
    assert_eq!(fast.1, sha(&bytes));
    assert_eq!(fast.2, bytes.len() as u64);
}
#[test]
fn bounded_archive_json_keeps_strict_eof_and_malformed_rejection() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("chunk.json");
    for bytes in [b"{}{}".as_slice(), b"{} trailing", b"{", b"[1,]", b"{}\0"] {
        fs::write(&path, bytes).unwrap();
        assert!(read_json::<serde_json::Value>(regular(&path).unwrap()).is_err());
        assert!(read_json_stream::<serde_json::Value>(regular(&path).unwrap()).is_err());
    }
}
#[test]
fn oversized_archive_json_retains_streaming_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("legacy.json");
    let mut file = create(&path).unwrap();
    file.write_all(b"{\"retained\":true}").unwrap();
    let padding = [b' '; 65536];
    for _ in 0..CHUNK_BYTES / padding.len() as u64 {
        file.write_all(&padding).unwrap();
    }
    file.sync_all().unwrap();
    let expected_bytes = file.metadata().unwrap().len();
    assert!(expected_bytes > CHUNK_BYTES);
    drop(file);
    let result: (serde_json::Value, _, _) = read_json(regular(&path).unwrap()).unwrap();
    assert_eq!(result.0, serde_json::json!({"retained":true}));
    assert_eq!(
        (result.1, result.2),
        fingerprint(regular(&path).unwrap()).unwrap()
    );
    assert_eq!(result.2, expected_bytes);
}

#[test]
fn compressed_chunks_keep_original_hashes_and_support_mixed_history() {
    let (root, blocks) = migrated(257);
    let before = raw(root.path());
    let (_, head) = read_head(root.path());
    let tail = head.tail.unwrap();
    let path = chunk_path(&root.path().join(ARCHIVE_DIR), &tail);
    let compressed = fs::read(&path).unwrap();
    assert_eq!(&compressed[..2], &[0x1f, 0x8b]);
    let mut original = Vec::new();
    flate2::read::GzDecoder::new(compressed.as_slice())
        .read_to_end(&mut original)
        .unwrap();
    assert_eq!(sha(&original), tail.sha256);
    assert_eq!(original.len() as u64, tail.bytes);
    assert!(compressed.len() < original.len());
    fs::write(&path, &original).unwrap();
    assert_eq!(archive(&Journal::open(root.path(), POOL).unwrap()), blocks);
    assert_eq!(raw(root.path()), before);
    for bytes in [
        compressed[..compressed.len() - 1].to_vec(),
        {
            let mut v = compressed.clone();
            v.extend_from_slice(b"trailing");
            v
        },
        {
            let mut v = compressed.clone();
            v.extend_from_slice(&compressed);
            v
        },
        {
            let mut v = compressed.clone();
            let n = v.len();
            v[n - 8] ^= 1;
            v
        },
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(Journal::open(root.path(), POOL).is_err());
    }
    fs::write(&path, &compressed).unwrap();
    assert!(read_chunk_json::<serde_json::Value>(regular(&path).unwrap(), tail.bytes - 1).is_err());
    assert!(read_chunk_json::<serde_json::Value>(regular(&path).unwrap(), tail.bytes + 1).is_err());
    assert!(require_archive_headroom(2 * 1024 * 1024 * 1024).is_err());
    assert!(require_archive_headroom(2 * 1024 * 1024 * 1024 + CHUNK_BYTES).is_ok());
}
