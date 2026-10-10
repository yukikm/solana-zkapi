//! Synthetic filesystem fixtures; no RPC, keys, jobs, or live archive access.
use super::*;
use zkapi_indexer::{Instruction, Transaction};
const POOL: Hash = [83; 32];

fn block(slot: u64) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: slot,
        transactions: vec![Transaction {
            signature: format!("fixture-{slot}"),
            succeeded: true,
            instructions: vec![Instruction {
                program: [84; 32],
                accounts: vec![],
                data: vec![17; 128],
                outer_index: 0,
                invocation_index: 0,
                stack_height: 1,
                succeeded: Some(true),
                events: vec![],
            }],
        }],
    }
}
fn fixture(count: u64) -> (tempfile::TempDir, Journal) {
    let root = tempfile::tempdir().unwrap();
    let mut writer = Journal::initialize(root.path(), POOL).unwrap();
    if count > 0 {
        writer
            .append_archive_batch((1..=count).map(block).collect())
            .unwrap();
    }
    drop(writer);
    Journal::migrate_v1_to_segmented(root.path(), POOL).unwrap();
    let writer = Journal::open(root.path(), POOL).unwrap();
    (root, writer)
}
fn files(root: &Path) -> BTreeMap<PathBuf, (Hash, FileStamp)> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(self::files(&path));
        } else {
            files.insert(
                path.clone(),
                (
                    sha(&fs::read(&path).unwrap()),
                    FileStamp::at(&path).unwrap(),
                ),
            );
        }
    }
    files
}
fn collect(reader: &ReadOnlyArchive, start: u64, end: u64) -> Vec<FinalizedBlock> {
    let mut blocks = vec![];
    reader
        .replay_range(start, end, |b| {
            blocks.push(b.clone());
            Ok(())
        })
        .unwrap();
    blocks
}
fn head(root: &Path) -> (State, Head) {
    let (envelope, _, _) = read_source(root).unwrap();
    (envelope.state, envelope.segmented.unwrap())
}
fn replace_head(root: &Path, state: &State, head: &Head) {
    // Test-only malicious/replacement head; production follower never writes.
    fs::write(
        root.join("replacement.next"),
        serde_json::to_vec(&Envelope {
            digest: digest(state, head).unwrap(),
            state: state.clone(),
            segmented: Some(head.clone()),
        })
        .unwrap(),
    )
    .unwrap();
    fs::rename(root.join("replacement.next"), root.join("journal.json")).unwrap();
}

#[test]
fn readonly_archive_head_open_accepts_concurrent_writer_commit() {
    let (root, mut writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    // Commit exactly between pathname inspection and open, without timing or
    // threads. The writer atomically replaces only the mutable journal head.
    BEFORE_REGULAR_OPEN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            writer.append_archive_batch(vec![block(4)]).unwrap();
        }));
    });
    assert!(reader.refresh().unwrap());
    assert_eq!(reader.archive_tail(), Some(ArchiveTail::from(&block(4))));
    assert_eq!(
        collect(&reader, 1, 4),
        (1..=4).map(block).collect::<Vec<_>>()
    );
}

#[test]
fn readonly_archive_immutable_open_still_rejects_concurrent_replacement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("immutable.json");
    fs::write(&path, b"original").unwrap();
    let replace = path.clone();
    BEFORE_REGULAR_OPEN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let next = replace.with_extension("next");
            fs::write(&next, b"original").unwrap();
            fs::rename(next, replace).unwrap();
        }));
    });
    assert!(matches!(
        regular(&path),
        Err(Error::Conflict("archive file changed during open"))
    ));
}

#[cfg(unix)]
#[test]
fn readonly_archive_metadata_checks_reject_nonfiles_and_changed_custody() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for change in ["symlink", "directory", "fifo", "permissions", "hardlink"] {
        let (root, _writer) = fixture(3);
        let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
        let path = chunk_path(
            &root.path().join(ARCHIVE_DIR),
            reader.archive.head.tail.as_ref().unwrap(),
        );
        let original = FileStamp::at(&path).unwrap();
        assert_eq!(
            original,
            FileStamp::of(&regular(&path).unwrap().metadata().unwrap()).unwrap()
        );
        let saved = root.path().join("saved.json");
        match change {
            "permissions" => fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap(),
            "hardlink" => fs::hard_link(&path, &saved).unwrap(),
            _ => {
                fs::rename(&path, &saved).unwrap();
                match change {
                    "symlink" => symlink(&saved, &path).unwrap(),
                    "directory" => fs::create_dir(&path).unwrap(),
                    "fifo" => {
                        use std::os::unix::ffi::OsStrExt;
                        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    }
                    _ => unreachable!(),
                }
                assert!(matches!(
                    FileStamp::at(&path),
                    Err(Error::Conflict("archive file type"))
                ));
            }
        }
        assert!(reader.refresh().is_err(), "{change}");
        let mut delivered = 0;
        assert!(
            reader
                .replay_range(1, 3, |_| {
                    delivered += 1;
                    Ok(())
                })
                .is_err(),
            "{change}"
        );
        assert_eq!(delivered, 0, "{change}");
        assert_eq!(reader.archive_len(), 3);
    }
}

#[cfg(unix)]
#[test]
fn readonly_archive_head_open_rejects_concurrent_symlink() {
    let (root, _writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    let path = root.path().join("journal.json");
    BEFORE_REGULAR_OPEN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let saved = path.with_extension("saved");
            fs::rename(&path, &saved).unwrap();
            std::os::unix::fs::symlink(saved, path).unwrap();
        }));
    });
    assert!(reader.refresh().is_err());
    assert_eq!(reader.archive_tail(), Some(ArchiveTail::from(&block(3))));
}

#[test]
fn readonly_archive_coexists_with_writer_and_streams_exact_bounded_ranges_without_writes() {
    let (root, mut writer) = fixture(514);
    let before = files(root.path());
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    assert_eq!(reader.archive_len(), 514);
    assert_eq!(reader.archive_first(), Some((1, 0)));
    assert_eq!(reader.archive_tail(), Some(ArchiveTail::from(&block(514))));
    assert_eq!(
        collect(&reader, 255, 258),
        (255..=258).map(block).collect::<Vec<_>>()
    );
    assert!(collect(&reader, 515, 600).is_empty());
    assert!(!reader.refresh().unwrap());
    assert_eq!(
        files(root.path()),
        before,
        "reader changed filesystem contents/identity/times"
    );
    assert!(
        Journal::open(root.path(), POOL).is_err(),
        "writer ownership must remain held"
    );
    writer.record_proof_failure().unwrap();
    assert!(
        !reader.refresh().unwrap(),
        "mutable job state is not a new archive prefix"
    );
    assert_eq!(reader.archive_len(), 514);
}

#[test]
fn readonly_archive_incremental_refresh_reads_only_new_chunks_and_never_adopts_orphans() {
    let (root, mut writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    fs::write(
        root.path().join(ARCHIVE_DIR).join("orphan.next"),
        b"incomplete garbage",
    )
    .unwrap();
    READS.with(|reads| reads.borrow_mut().clear());
    assert!(!reader.refresh().unwrap());
    assert!(READS.with(|reads| reads.borrow().is_empty()));
    writer
        .append_archive_batch(vec![block(4), block(5)])
        .unwrap();
    assert!(reader.refresh().unwrap());
    let reads = READS.with(|reads| reads.borrow().clone());
    assert_eq!(
        reads.len(),
        1,
        "refresh reread legacy or an already verified payload"
    );
    assert_ne!(reads[0].file_name().unwrap(), BACKUP);
    assert_eq!(
        collect(&reader, 1, 9),
        (1..=5).map(block).collect::<Vec<_>>()
    );
    assert_eq!(
        fs::read(root.path().join(ARCHIVE_DIR).join("orphan.next")).unwrap(),
        b"incomplete garbage"
    );
}

#[test]
fn readonly_archive_rejects_rollback_rewritten_prefix_and_changed_legacy_identity() {
    let (root, mut writer) = fixture(3);
    let (initial_state, initial_head) = head(root.path());
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    writer.append_archive_batch(vec![block(4)]).unwrap();
    assert!(reader.refresh().unwrap());
    replace_head(root.path(), &initial_state, &initial_head);
    assert!(reader.refresh().is_err());
    assert_eq!(reader.archive_len(), 4);
    let mut forged = reader.archive.head.clone();
    forged.legacy.sha256[0] ^= 1;
    replace_head(root.path(), &initial_state, &forged);
    assert!(reader.refresh().is_err());
    // Well-formed new chunk, but its claimed old prefix differs despite keeping
    // the old slot/hash/count. The exact immutable reference must join.
    let mut old = reader.archive.head.tail.clone().unwrap();
    old.sha256[0] ^= 1;
    let new = write_chunk(&root.path().join(ARCHIVE_DIR), POOL, Some(old), &[block(5)]).unwrap();
    let mut forged = reader.archive.head.clone();
    forged.chunks += 1;
    forged.blocks += 1;
    forged.tail = Some(new);
    replace_head(root.path(), &initial_state, &forged);
    assert!(reader.refresh().is_err());
    assert_eq!(reader.archive_len(), 4);
}

#[test]
fn readonly_archive_fixed_cut_survives_atomic_newer_head_and_callback_cancellation() {
    let (root, mut writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    let mut slots = vec![];
    reader
        .replay_range(1, 10, |b| {
            slots.push(b.slot);
            if b.slot == 1 {
                writer.append_archive_batch(vec![block(4)]).unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        slots,
        vec![1, 2, 3],
        "newer writer head leaked into fixed snapshot"
    );
    assert!(reader.refresh().unwrap());
    let before = files(root.path());
    let mut calls = 0;
    assert!(matches!(
        reader.replay_range(1, 4, |_| {
            calls += 1;
            Err(Error::Interrupted)
        }),
        Err(Error::Interrupted)
    ));
    assert_eq!(calls, 1);
    assert_eq!(files(root.path()), before);
    assert_eq!(
        collect(&reader, 1, 4),
        (1..=4).map(block).collect::<Vec<_>>()
    );
}

#[test]
fn readonly_archive_rejects_deleted_or_corrupt_verified_files_and_changed_chunk_on_replay() {
    for legacy in [true, false] {
        let (root, _writer) = fixture(3);
        let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
        let path = if legacy {
            root.path().join(BACKUP)
        } else {
            chunk_path(
                &root.path().join(ARCHIVE_DIR),
                reader.archive.head.tail.as_ref().unwrap(),
            )
        };
        let bytes = fs::read(&path).unwrap();
        let mut corrupt = bytes.clone();
        corrupt[0] ^= 1;
        fs::write(&path, &corrupt).unwrap();
        assert!(reader.refresh().is_err());
        assert!(reader.replay_range(1, 3, |_| Ok(())).is_err());
        fs::remove_file(&path).unwrap();
        assert!(reader.refresh().is_err());
    }
}

#[test]
fn readonly_archive_bad_suffix_is_not_installed_and_empty_prefix_can_extend() {
    let (root, mut writer) = fixture(0);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    assert_eq!(reader.archive_first(), None);
    writer
        .append_archive_batch(vec![block(1), block(2)])
        .unwrap();
    let (_, new_head) = head(root.path());
    let path = chunk_path(
        &root.path().join(ARCHIVE_DIR),
        new_head.tail.as_ref().unwrap(),
    );
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, b"bad chunk").unwrap();
    assert!(reader.refresh().is_err());
    assert_eq!(reader.archive_len(), 0);
    fs::write(&path, bytes).unwrap();
    assert!(reader.refresh().unwrap());
    assert_eq!(reader.archive_first(), Some((1, 0)));
    assert_eq!(reader.archive_len(), 2);
}

#[test]
fn readonly_archive_cold_rejects_wrong_pool_v1_checksum_and_truncated_original_prefix() {
    let (root, _writer) = fixture(3);
    assert!(ReadOnlyArchive::open(root.path(), [0; 32]).is_err());
    let (state, original) = head(root.path());
    let mut truncated = original.clone();
    truncated.blocks = 0;
    truncated.chunks = 0;
    truncated.tail = None;
    replace_head(root.path(), &state, &truncated);
    assert!(ReadOnlyArchive::open(root.path(), POOL).is_err());
    fs::write(
        root.path().join("journal.json"),
        fs::read(root.path().join(BACKUP)).unwrap(),
    )
    .unwrap();
    assert!(ReadOnlyArchive::open(root.path(), POOL).is_err());
    replace_head(root.path(), &state, &original);
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("journal.json")).unwrap()).unwrap();
    value["digest"][0] = serde_json::json!(value["digest"][0].as_u64().unwrap() ^ 1);
    fs::write(
        root.path().join("journal.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    assert!(ReadOnlyArchive::open(root.path(), POOL).is_err());
}

#[cfg(unix)]
#[test]
fn readonly_archive_rejects_symlinked_head_chunk_and_replaced_same_byte_prefix() {
    use std::os::unix::fs::symlink;
    let (root, _writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    let path = chunk_path(
        &root.path().join(ARCHIVE_DIR),
        reader.archive.head.tail.as_ref().unwrap(),
    );
    let original = fs::read(&path).unwrap();
    let alternate = root.path().join("alternate.json");
    fs::write(&alternate, &original).unwrap();
    fs::rename(&alternate, &path).unwrap();
    assert!(
        reader.refresh().is_err(),
        "inode replacement must not inherit old authentication"
    );
    fs::rename(&path, &alternate).unwrap();
    symlink(&alternate, &path).unwrap();
    assert!(ReadOnlyArchive::open(root.path(), POOL).is_err());
    let head = root.path().join("journal.json");
    fs::rename(&head, root.path().join("old-head.json")).unwrap();
    symlink(root.path().join("old-head.json"), &head).unwrap();
    assert!(ReadOnlyArchive::open(root.path(), POOL).is_err());
}

#[test]
fn readonly_archive_replay_hashes_payload_even_if_metadata_observation_is_replaced() {
    let (root, _writer) = fixture(3);
    let mut reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    let path = chunk_path(
        &root.path().join(ARCHIVE_DIR),
        reader.archive.head.tail.as_ref().unwrap(),
    );
    let mut chunk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    chunk["blocks"][0]["transactions"][0]["instructions"][0]["data"][0] = serde_json::json!(18);
    fs::write(&path, serde_json::to_vec(&chunk).unwrap()).unwrap();
    // Test-only bypass of the fast metadata guard: actual replay must still
    // reject byte corruption against the already authenticated chunk hash.
    reader
        .observations
        .insert(path.clone(), FileStamp::at(&path).unwrap());
    let mut callbacks = 0;
    assert!(reader
        .replay_range(1, 3, |_| {
            callbacks += 1;
            Ok(())
        })
        .is_err());
    assert_eq!(callbacks, 0);
}

#[test]
fn readonly_archive_retains_real_skipped_slot_coverage_and_range_boundaries() {
    let (root, mut writer) = fixture(0);
    let mut first = block(8);
    first.parent_slot = 3;
    first.previous_blockhash = block(3).blockhash;
    let mut next = block(12);
    next.parent_slot = 8;
    next.previous_blockhash = first.blockhash;
    writer
        .append_archive_batch(vec![first.clone(), next.clone()])
        .unwrap();
    let reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    assert_eq!(reader.archive_first(), Some((8, 3)));
    assert!(collect(&reader, 9, 11).is_empty());
    assert_eq!(collect(&reader, 4, 8), vec![first]);
    assert_eq!(collect(&reader, 9, 12), vec![next]);
    assert!(reader.replay_range(12, 11, |_| Ok(())).is_err());
}

#[test]
fn readonly_archive_captured_head_inode_remains_valid_when_writer_replaces_path() {
    let (root, mut writer) = fixture(3);
    let file = regular(&root.path().join("journal.json")).unwrap();
    let stamp = FileStamp::of(&file.metadata().unwrap()).unwrap();
    writer.append_archive_batch(vec![block(4)]).unwrap();
    let after = FileStamp::of(&file.metadata().unwrap()).unwrap();
    assert!(stamp.same_captured_head(&after));
    let (envelope, _, _): (Envelope, _, _) = read_json(file).unwrap();
    assert_eq!(envelope.segmented.as_ref().unwrap().blocks, 3);
    assert_eq!(head(root.path()).1.blocks, 4);
    assert_eq!(
        envelope.digest,
        digest(&envelope.state, envelope.segmented.as_ref().unwrap()).unwrap()
    );
    let mut changed = after.clone();
    changed.fields[7] += 1;
    assert!(
        !stamp.same_captured_head(&changed),
        "in-place content modification is not atomic replacement"
    );
}
