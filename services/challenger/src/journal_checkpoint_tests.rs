//! Synthetic archive caches only. No RPC, signatures, funded journal or runtime.
use super::super::tests::{block, migrated};
use super::*;
const POOL: Hash = [71; 32];
const BINDING: Hash = [91; 32];
fn saved(count: u64) -> (tempfile::TempDir, Vec<FinalizedBlock>) {
    let (root, blocks) = migrated(count);
    let journal = Journal::open(root.path(), POOL).unwrap();
    journal
        .save_checkpoint(
            BINDING,
            b"runtime codec bytes",
            *journal.archive_tail().as_ref().unwrap(),
        )
        .unwrap();
    (root, blocks)
}
fn clear_reads() {
    readonly::READS.with(|r| r.borrow_mut().clear());
    PAYLOAD_READS.with(|r| r.borrow_mut().clear());
}
#[test]
fn checkpoint_restart_reads_anchor_only_and_preserves_current_unknown_jobs() {
    let (root, _) = saved(514);
    let original = fs::read(root.path().join("journal.json")).unwrap();
    // Financial state changes after the cache, without any archive change.
    let mut journal = Journal::open(root.path(), POOL).unwrap();
    journal.record_proof_failure().unwrap();
    let expected = serde_json::to_vec(&journal.state).unwrap();
    drop(journal);
    clear_reads();
    let (journal, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    let state = state.unwrap();
    assert_eq!(state.bytes, b"runtime codec bytes");
    assert_eq!(state.sha256, sha(&state.bytes));
    assert_eq!(state.blocks, 514);
    assert_eq!(state.tail, journal.archive_tail());
    assert_eq!(serde_json::to_vec(&journal.state).unwrap(), expected);
    assert_eq!(journal.proof_failure_total(), 8);
    assert_eq!(
        journal.jobs().next().unwrap().1.attempts[0].outcome,
        Outcome::Unknown
    );
    assert!(journal.transport("synthetic-unknown-send").is_some());
    assert_ne!(
        fs::read(root.path().join("journal.json")).unwrap(),
        original
    );
    readonly::READS.with(|r| assert!(r.borrow().is_empty(), "legacy/prefix not parsed"));
    PAYLOAD_READS.with(|r| assert_eq!(r.borrow().len(), 1, "one anchor chunk only"));
    journal
        .replay_archive_after(514, |_| panic!("no old payload replay"))
        .unwrap();
    PAYLOAD_READS.with(|r| assert_eq!(r.borrow().len(), 1));
}
#[test]
fn checkpoint_suffix_is_authenticated_and_replayed_in_order() {
    let (root, _) = saved(514);
    let mut writer = Journal::open(root.path(), POOL).unwrap();
    writer
        .append_archive_batch((515..=520).map(|s| block(s, 8)).collect())
        .unwrap();
    drop(writer);
    clear_reads();
    let (journal, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    assert_eq!(state.unwrap().tail.unwrap().slot, 514);
    assert_eq!(journal.archive_len(), 520);
    readonly::READS.with(|r| {
        assert_eq!(r.borrow().len(), 1, "only one new chunk");
        assert!(!r.borrow()[0].ends_with(BACKUP));
    });
    let mut slots = vec![];
    journal
        .replay_archive_after(514, |b| {
            slots.push(b.slot);
            Ok(())
        })
        .unwrap();
    assert_eq!(slots, (515..=520).collect::<Vec<_>>());
}
#[test]
fn checkpoint_follower_anchor_may_be_inside_older_chunk() {
    let (root, blocks) = migrated(514);
    let output = tempfile::tempdir().unwrap();
    let path = output.path().join("cache");
    let reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
    reader
        .save_checkpoint(
            &path,
            BINDING,
            b"older state",
            ArchiveTail::from(&blocks[299]),
        )
        .unwrap();
    clear_reads();
    let (reader, state) =
        ReadOnlyArchive::open_with_checkpoint(root.path(), POOL, BINDING, &path).unwrap();
    let state = state.unwrap();
    assert_eq!(state.blocks, 300);
    assert_eq!(state.tail.unwrap().slot, 300);
    assert_eq!(reader.archive_len(), 514);
    readonly::READS.with(|r| assert!(r.borrow().is_empty()));
    PAYLOAD_READS.with(|r| assert_eq!(r.borrow().len(), 1));
    let mut slots = vec![];
    reader
        .replay_range(301, 514, |b| {
            slots.push(b.slot);
            Ok(())
        })
        .unwrap();
    assert_eq!(slots, (301..=514).collect::<Vec<_>>());
}
#[test]
fn checkpoint_missing_corrupt_wrong_binding_fall_back_without_journal_mutation() {
    let (root, _) = saved(4);
    let before = fs::read(root.path().join("journal.json")).unwrap();
    let cache = fs::read(root.path().join(NAME)).unwrap();
    for bytes in [vec![], cache[..cache.len() - 1].to_vec(), {
        let mut c = cache.clone();
        c[12] ^= 1;
        c
    }] {
        fs::write(root.path().join(NAME), bytes).unwrap();
        let (journal, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
        assert!(state.is_none());
        assert_eq!(journal.archive_len(), 4);
    }
    fs::write(root.path().join(NAME), &cache).unwrap();
    let (_, state) = Journal::open_with_checkpoint(root.path(), POOL, [92; 32]).unwrap();
    assert!(state.is_none());
    fs::remove_file(root.path().join(NAME)).unwrap();
    let (_, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    assert!(state.is_none());
    assert_eq!(fs::read(root.path().join("journal.json")).unwrap(), before);
}
#[test]
fn checkpoint_changed_immutable_metadata_falls_back_and_corruption_still_fails() {
    let (root, _) = saved(4);
    let legacy = root.path().join(BACKUP);
    let bytes = fs::read(&legacy).unwrap();
    fs::write(&legacy, &bytes).unwrap(); // identical content, new ctime/mtime
    let (_, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    assert!(state.is_none());
    fs::write(&legacy, b"corrupt").unwrap();
    assert!(Journal::open_with_checkpoint(root.path(), POOL, BINDING).is_err());
}
#[test]
fn checkpoint_shape_and_exact_anchor_reject_rechecksummed_bad_metadata() {
    let (root, _) = saved(4);
    let (mut metadata, bytes) = read_cache(&root.path().join(NAME)).unwrap();
    metadata.references[0].sequence = 2;
    write_cache(&root.path().join(NAME), &metadata, &bytes).unwrap();
    assert!(Journal::open_with_checkpoint(root.path(), POOL, BINDING)
        .unwrap()
        .1
        .is_none());
    metadata.references[0].sequence = 1;
    metadata.anchor.blockhash[0] ^= 1;
    write_cache(&root.path().join(NAME), &metadata, &bytes).unwrap();
    assert!(Journal::open_with_checkpoint(root.path(), POOL, BINDING)
        .unwrap()
        .1
        .is_none());
}
#[test]
fn checkpoint_wrong_anchor_save_preserves_previous_cache_and_orphan_is_ignored() {
    let (root, _) = saved(4);
    let before = fs::read(root.path().join(NAME)).unwrap();
    let journal = Journal::open(root.path(), POOL).unwrap();
    let mut anchor = journal.archive_tail().unwrap();
    anchor.block_time += 1;
    assert!(journal.save_checkpoint(BINDING, b"new", anchor).is_err());
    assert_eq!(fs::read(root.path().join(NAME)).unwrap(), before);
    fs::write(
        root.path().join(".archive-checkpoint-orphan.next"),
        b"partial",
    )
    .unwrap();
    drop(journal);
    assert!(Journal::open_with_checkpoint(root.path(), POOL, BINDING)
        .unwrap()
        .1
        .is_some());
}
#[cfg(unix)]
#[test]
fn checkpoint_nonprivate_or_symlink_cache_is_never_trusted_or_replaced() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (root, _) = saved(4);
    let path = root.path().join(NAME);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let (journal, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    assert!(state.is_none());
    assert!(journal
        .save_checkpoint(BINDING, b"new", journal.archive_tail().unwrap())
        .is_err());
    drop(journal);
    fs::remove_file(&path).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"untouched").unwrap();
    symlink(outside.path(), &path).unwrap();
    let (journal, state) = Journal::open_with_checkpoint(root.path(), POOL, BINDING).unwrap();
    assert!(state.is_none());
    assert!(journal
        .save_checkpoint(BINDING, b"new", journal.archive_tail().unwrap())
        .is_err());
    assert_eq!(fs::read(outside.path()).unwrap(), b"untouched");
}
