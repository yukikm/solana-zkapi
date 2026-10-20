//! Optional owner-controlled restart cache. Checksums detect damage, not a
//! privileged forgery. Cached immutable files use the same Unix metadata trust
//! model as an already-open follower. Financial journal state is never cached.
use super::*;
use readonly::{DirectoryStamp, FileStamp, Observations};
use std::borrow::Borrow;

const NAME: &str = "archive-runtime-checkpoint-v1";
const MAGIC: &[u8] = b"ZKAPI-ARCHIVE-CHECKPOINT-V1\n";
// References and file stamps grow with retained chunks. Keep a finite bound
// without making a complete, authenticated archive lose restart caching at
// the former 64 MiB limit. This changes no v1 bytes or trust requirements.
const META_LIMIT: u64 = 256 * 1024 * 1024;
const STATE_LIMIT: u64 = 512 * 1024 * 1024;

pub struct ArchiveCheckpointState {
    pub bytes: Vec<u8>,
    pub sha256: Hash,
    pub tail: Option<ArchiveTail>,
    pub blocks: u64,
}
#[derive(Clone)]
pub(super) struct VerifiedFiles {
    pub(super) observations: Observations,
    root_identity: DirectoryStamp,
    archive_identity: DirectoryStamp,
}
impl VerifiedFiles {
    pub(super) fn capture(root: &Path, observations: Observations) -> Result<Self> {
        let value = Self {
            observations,
            root_identity: DirectoryStamp::at(root)?,
            archive_identity: DirectoryStamp::at(&root.join(ARCHIVE_DIR))?,
        };
        value.verify(root)?;
        Ok(value)
    }
    fn borrowed(&self) -> VerifiedFilesView<'_> {
        VerifiedFilesView {
            observations: &self.observations,
            root_identity: &self.root_identity,
            archive_identity: &self.archive_identity,
        }
    }
    pub(super) fn verify(&self, root: &Path) -> Result<()> {
        self.borrowed().verify(root)
    }
}
#[derive(Clone, Copy)]
struct VerifiedFilesView<'a> {
    observations: &'a Observations,
    root_identity: &'a DirectoryStamp,
    archive_identity: &'a DirectoryStamp,
}
impl VerifiedFilesView<'_> {
    fn verify(&self, root: &Path) -> Result<()> {
        if DirectoryStamp::at(root)? != *self.root_identity
            || DirectoryStamp::at(&root.join(ARCHIVE_DIR))? != *self.archive_identity
        {
            return Err(Error::Conflict("checkpoint archive directory changed"));
        }
        for (path, stamp) in self.observations {
            if FileStamp::at(path)? != *stamp {
                return Err(Error::Conflict("checkpoint archive file changed"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata<R = Vec<ChunkRef>, S = FileStamp> {
    version: u32,
    binding: Hash,
    head: Head,
    references: R,
    archive_tail: ArchiveTail,
    first: (u64, u64),
    anchor: ArchiveTail,
    anchor_blocks: u64,
    state_sha256: Hash,
    root_identity: DirectoryStamp,
    archive_identity: DirectoryStamp,
    legacy_stamp: FileStamp,
    chunk_stamps: Vec<S>,
}
fn private_parent(path: &Path) -> Result<&Path> {
    let parent = path.parent().ok_or(Error::Conflict("checkpoint parent"))?;
    directory(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::symlink_metadata(parent)?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
            return Err(Error::Conflict("checkpoint parent custody"));
        }
    }
    Ok(parent)
}
fn private_file(path: &Path) -> Result<File> {
    private_parent(path)?;
    let file = regular(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = file.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o600 || m.nlink() != 1 {
            return Err(Error::Conflict("checkpoint file custody"));
        }
    }
    Ok(file)
}
fn read_part(reader: &mut impl Read, hash: &mut Sha256, count: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0; count];
    reader.read_exact(&mut bytes)?;
    hash.update(&bytes);
    Ok(bytes)
}
fn read_count(reader: &mut impl Read, hash: &mut Sha256, limit: u64) -> Result<usize> {
    let bytes = read_part(reader, hash, 8)?;
    let count = u64::from_be_bytes(bytes.try_into().expect("eight bytes"));
    if count == 0 || count > limit {
        return Err(Error::Conflict("checkpoint byte bound"));
    }
    Ok(count as usize)
}
fn read_cache(path: &Path) -> Result<(Metadata, Vec<u8>)> {
    let file = private_file(path)?;
    let before = FileStamp::of(&file.metadata()?)?;
    if file.metadata()?.len() > META_LIMIT + STATE_LIMIT + MAGIC.len() as u64 + 48 {
        return Err(Error::Conflict("checkpoint byte bound"));
    }
    let probe = file.try_clone()?;
    let mut reader = BufReader::new(file);
    let mut hash = Sha256::new();
    if read_part(&mut reader, &mut hash, MAGIC.len())? != MAGIC {
        return Err(Error::Conflict("checkpoint format"));
    }
    let count = read_count(&mut reader, &mut hash, META_LIMIT)?;
    let metadata: Metadata = serde_json::from_slice(&read_part(&mut reader, &mut hash, count)?)?;
    let count = read_count(&mut reader, &mut hash, STATE_LIMIT)?;
    let bytes = read_part(&mut reader, &mut hash, count)?;
    let mut expected = [0; 32];
    reader.read_exact(&mut expected)?;
    let mut extra = [0; 1];
    if Hash::from(hash.finalize()) != expected
        || reader.read(&mut extra)? != 0
        || sha(&bytes) != metadata.state_sha256
        || before != FileStamp::of(&probe.metadata()?)?
        || before != FileStamp::at(path)?
    {
        return Err(Error::Conflict("checkpoint checksum/identity"));
    }
    Ok((metadata, bytes))
}
fn write_cache<R: Serialize, S: Serialize>(
    path: &Path,
    metadata: &Metadata<R, S>,
    bytes: &[u8],
) -> Result<()> {
    let parent = private_parent(path)?;
    if fs::symlink_metadata(path).is_ok() {
        private_file(path)?;
    }
    let encoded = serde_json::to_vec(metadata)?;
    if encoded.len() as u64 > META_LIMIT || bytes.is_empty() || bytes.len() as u64 > STATE_LIMIT {
        return Err(Error::Conflict("checkpoint byte bound"));
    }
    let temporary = parent.join(format!(".archive-checkpoint-{}.next", hex::encode(nonce())));
    let mut file = create(&temporary)?;
    {
        let mut writer = BufWriter::new(&mut file);
        let mut hash = Sha256::new();
        for part in [
            MAGIC,
            &(encoded.len() as u64).to_be_bytes(),
            &encoded,
            &(bytes.len() as u64).to_be_bytes(),
            bytes,
        ] {
            writer.write_all(part)?;
            hash.update(part);
        }
        writer.write_all(&hash.finalize())?;
        writer.flush()?;
    }
    file.sync_all()?;
    // Any previous cache remains intact until this single activation boundary.
    fs::rename(&temporary, path)?;
    sync_directory(parent)
}
// The same shape/order/count checks feed both restore's owned observation map
// and save's comparison with an already authenticated map. Save only borrows
// retained references/stamps; it does not build a second path/stamp map.
fn visit_observations<R: AsRef<[ChunkRef]>, S: Borrow<FileStamp>>(
    root: &Path,
    metadata: &Metadata<R, S>,
    mut visit: impl FnMut(PathBuf, &FileStamp, Option<Hash>) -> Result<()>,
) -> Result<()> {
    let references = metadata.references.as_ref();
    let head = &metadata.head;
    if metadata.version != 1
        || head.version != 2
        || head.chunks == 0
        || head.chunks != references.len() as u64
        || metadata.chunk_stamps.len() != references.len()
        || head.tail.as_ref() != references.last()
        || metadata.legacy_stamp.fields[2] != head.legacy.bytes
    {
        return Err(Error::Conflict("checkpoint archive shape"));
    }
    visit(root.join(BACKUP), &metadata.legacy_stamp, None)?;
    let mut count = 0u64;
    let mut last_slot = None;
    for (index, (reference, stamp)) in references.iter().zip(&metadata.chunk_stamps).enumerate() {
        let stamp = stamp.borrow();
        if reference.sequence != index as u64 + 1
            || reference.blocks == 0
            || reference.blocks > CHUNK_BLOCKS as u64
            || reference.first_slot > reference.last_slot
            || last_slot.is_some_and(|slot| reference.first_slot <= slot)
            // A gzip chunk's stored length differs from its authenticated JSON
            // length. The complete stamp is still captured after checksum
            // verification, and unchanged-file continuity remains mandatory.
            || stamp.fields[2] == 0
        {
            return Err(Error::Conflict("checkpoint archive references"));
        }
        count = count
            .checked_add(reference.blocks)
            .ok_or(Error::Conflict("checkpoint block count"))?;
        last_slot = Some(reference.last_slot);
        visit(
            chunk_path(&root.join(ARCHIVE_DIR), reference),
            stamp,
            Some(reference.sha256),
        )?;
    }
    let first = &references[0];
    let last = references.last().expect("nonempty refs");
    if count != head.blocks
        || metadata.anchor_blocks == 0
        || metadata.anchor_blocks > count
        || metadata.first.0 != first.first_slot
        || metadata.first.1 >= metadata.first.0
        || metadata.archive_tail.slot != last.last_slot
        || metadata.archive_tail.blockhash != last.last_blockhash
        || metadata.anchor.slot < metadata.first.0
        || metadata.anchor.slot > last.last_slot
    {
        return Err(Error::Conflict("checkpoint archive anchor/count"));
    }
    Ok(())
}
fn observations(root: &Path, metadata: &Metadata) -> Result<Observations> {
    let mut result = Observations::new();
    visit_observations(root, metadata, |path, stamp, _| {
        if result.insert(path, stamp.clone()).is_some() {
            return Err(Error::Conflict("checkpoint duplicate file"));
        }
        Ok(())
    })?;
    Ok(result)
}
fn observations_match<R: AsRef<[ChunkRef]>, S: Borrow<FileStamp>>(
    root: &Path,
    metadata: &Metadata<R, S>,
    expected: &Observations,
) -> Result<()> {
    // Equal map length plus unique derived paths and equality at every path is
    // exact map equality. Hash keys avoid copying every full archive pathname.
    // Legacy and chunk paths have disjoint fixed directory/name construction.
    let mut seen = std::collections::BTreeSet::new();
    visit_observations(root, metadata, |path, stamp, chunk_hash| {
        if chunk_hash.is_some_and(|hash| !seen.insert(hash)) {
            return Err(Error::Conflict("checkpoint duplicate file"));
        }
        if expected.get(&path) != Some(stamp) {
            return Err(Error::Conflict("checkpoint observation set"));
        }
        Ok(())
    })?;
    if expected.len() != metadata.references.as_ref().len() + 1 {
        return Err(Error::Conflict("checkpoint observation set"));
    }
    Ok(())
}
fn anchor_blocks(archive: &Archive, root: &Path, anchor: ArchiveTail) -> Result<u64> {
    let index = archive
        .chunk_index(anchor.slot)
        .ok_or(Error::Conflict("checkpoint anchor absent"))?;
    let chunk = archive.read_indexed(&archive_directory(root)?, index)?;
    let position = chunk
        .blocks
        .binary_search_by_key(&anchor.slot, |b| b.slot)
        .map_err(|_| Error::Conflict("checkpoint anchor absent"))?;
    if ArchiveTail::from(&chunk.blocks[position]) != anchor {
        return Err(Error::Conflict("checkpoint anchor mismatch"));
    }
    Ok(archive.references[..index]
        .iter()
        .map(|r| r.blocks)
        .sum::<u64>()
        + position as u64
        + 1)
}
fn load_reader(
    root: &Path,
    pool: Hash,
    head: Head,
    binding: Hash,
    path: &Path,
) -> Result<(ReadOnlyArchive, ArchiveCheckpointState)> {
    let (metadata, bytes) = read_cache(path)?;
    if metadata.binding != binding || metadata.head.pool != pool {
        return Err(Error::Conflict("checkpoint binding/pool"));
    }
    let observed = observations(root, &metadata)?;
    let mut reader = ReadOnlyArchive {
        directory: root.to_owned(),
        pool,
        archive: Archive {
            references: metadata.references,
            tail: Some(metadata.archive_tail),
            head: metadata.head,
            verified: None,
        },
        first: Some(metadata.first),
        observations: observed,
        root_identity: metadata.root_identity,
        archive_identity: metadata.archive_identity,
    };
    reader.verify_files()?;
    if anchor_blocks(&reader.archive, root, metadata.anchor)? != metadata.anchor_blocks {
        return Err(Error::Conflict("checkpoint anchor count"));
    }
    // Existing refresh authenticates every new chunk and exact previous-head link.
    reader.refresh_head(head)?;
    let state = ArchiveCheckpointState {
        bytes,
        sha256: metadata.state_sha256,
        tail: Some(metadata.anchor),
        blocks: metadata.anchor_blocks,
    };
    Ok((reader, state))
}
pub(in crate::journal) fn load_checkpoint(
    root: &Path,
    pool: Hash,
    head: Head,
    binding: Hash,
) -> Result<(Archive, ArchiveCheckpointState)> {
    let (reader, state) = load_reader(root, pool, head, binding, &root.join(NAME))?;
    let mut archive = reader.archive;
    archive.verified = Some(VerifiedFiles {
        observations: reader.observations,
        root_identity: reader.root_identity,
        archive_identity: reader.archive_identity,
    });
    Ok((archive, state))
}
// Shared writer/follower serialization keeps its explicit archive and custody inputs.
#[allow(clippy::too_many_arguments)]
fn save(
    root: &Path,
    path: &Path,
    archive: &Archive,
    verified: VerifiedFilesView<'_>,
    first: (u64, u64),
    binding: Hash,
    bytes: &[u8],
    anchor: ArchiveTail,
) -> Result<()> {
    verified.verify(root)?;
    let anchor_blocks = anchor_blocks(archive, root, anchor)?;
    let metadata = Metadata {
        version: 1,
        binding,
        head: archive.head.clone(),
        references: archive.references.as_slice(),
        archive_tail: archive
            .tail
            .ok_or(Error::Conflict("checkpoint archive empty"))?,
        first,
        anchor,
        anchor_blocks,
        state_sha256: sha(bytes),
        root_identity: (*verified.root_identity).clone(),
        archive_identity: (*verified.archive_identity).clone(),
        legacy_stamp: verified
            .observations
            .get(&root.join(BACKUP))
            .ok_or(Error::Conflict("checkpoint legacy observation"))?
            .clone(),
        chunk_stamps: archive
            .references
            .iter()
            .map(|r| {
                verified
                    .observations
                    .get(&chunk_path(&root.join(ARCHIVE_DIR), r))
                    .ok_or(Error::Conflict("checkpoint chunk observation"))
            })
            .collect::<Result<_>>()?,
    };
    observations_match(root, &metadata, verified.observations)?;
    verified.verify(root)?;
    write_cache(path, &metadata, bytes)
}
impl Journal {
    /// Save disposable runtime state, never jobs, signed attempts or transport.
    /// A runtime must bind its codec/config and revalidate fresh chain readiness.
    pub fn save_checkpoint(
        &self,
        binding: Hash,
        bytes: &[u8],
        anchor: ArchiveTail,
    ) -> Result<bool> {
        self.ensure_writable()?;
        let Some(archive) = &self.segmented else {
            return Ok(false);
        };
        let verified = archive
            .verified
            .as_ref()
            .ok_or(Error::Conflict("checkpoint observations unavailable"))?;
        let first = ReadOnlyArchive::first(archive, &self.directory)?
            .ok_or(Error::Conflict("checkpoint archive empty"))?;
        save(
            &self.directory,
            &self.directory.join(NAME),
            archive,
            verified.borrowed(),
            first,
            binding,
            bytes,
            anchor,
        )?;
        Ok(true)
    }
}
impl ReadOnlyArchive {
    /// Invalid/missing local cache is only a performance miss. The original
    /// complete authentication path remains the fallback and error authority.
    pub fn open_with_checkpoint(
        directory: &Path,
        pool: Hash,
        binding: Hash,
        checkpoint_path: &Path,
    ) -> Result<(Self, Option<ArchiveCheckpointState>)> {
        let head = Self::read_head(directory, pool)?;
        if let Ok((reader, state)) = load_reader(directory, pool, head, binding, checkpoint_path) {
            return Ok((reader, Some(state)));
        }
        Ok((Self::open(directory, pool)?, None))
    }
    pub fn save_checkpoint(
        &self,
        checkpoint_path: &Path,
        binding: Hash,
        bytes: &[u8],
        anchor: ArchiveTail,
    ) -> Result<()> {
        let verified = VerifiedFilesView {
            observations: &self.observations,
            root_identity: &self.root_identity,
            archive_identity: &self.archive_identity,
        };
        save(
            &self.directory,
            checkpoint_path,
            &self.archive,
            verified,
            self.first
                .ok_or(Error::Conflict("checkpoint archive empty"))?,
            binding,
            bytes,
            anchor,
        )
    }
}

#[cfg(test)]
#[path = "journal_checkpoint_tests.rs"]
mod tests;

#[cfg(test)]
mod allocation_tests {
    use super::super::tests::migrated;
    use super::*;
    const POOL: Hash = [71; 32];
    const BINDING: Hash = [91; 32];
    fn fixture() -> (tempfile::TempDir, Metadata, Vec<u8>, Observations) {
        let (root, _) = migrated(514);
        let journal = Journal::open(root.path(), POOL).unwrap();
        journal
            .save_checkpoint(
                BINDING,
                b"same private runtime",
                journal.archive_tail().unwrap(),
            )
            .unwrap();
        let (metadata, bytes) = read_cache(&root.path().join(NAME)).unwrap();
        let observed = observations(root.path(), &metadata).unwrap();
        (root, metadata, bytes, observed)
    }
    fn duplicate(metadata: &Metadata) -> Metadata {
        serde_json::from_slice(&serde_json::to_vec(metadata).unwrap()).unwrap()
    }
    #[test]
    fn borrowed_follower_save_preserves_complete_v1_bytes() {
        let (root, metadata, bytes, _) = fixture();
        let original = fs::read(root.path().join(NAME)).unwrap();
        let reader = ReadOnlyArchive::open(root.path(), POOL).unwrap();
        let path = root.path().join("borrowed-cache");
        reader
            .save_checkpoint(&path, BINDING, &bytes, metadata.anchor)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        let (restored, restored_bytes) = read_cache(&path).unwrap();
        assert_eq!(
            serde_json::to_vec(&restored).unwrap(),
            serde_json::to_vec(&metadata).unwrap()
        );
        assert_eq!(restored_bytes, bytes);
    }
    #[test]
    fn borrowed_observation_validation_rejects_every_legacy_shape_failure() {
        let (root, original, _, expected) = fixture();
        assert!(original.references.len() >= 3);
        observations_match(root.path(), &original, &expected).unwrap();
        for case in [
            "version",
            "head_version",
            "empty",
            "count",
            "stamps",
            "tail",
            "legacy_bytes",
            "sequence",
            "zero_blocks",
            "large_blocks",
            "range",
            "overlap",
            "zero_stamp",
            "block_count",
            "anchor_zero",
            "anchor_count",
            "first",
            "parent",
            "archive_slot",
            "archive_hash",
            "anchor_before",
            "anchor_after",
            "duplicate",
        ] {
            let mut metadata = duplicate(&original);
            match case {
                "version" => metadata.version += 1,
                "head_version" => metadata.head.version += 1,
                "empty" => metadata.head.chunks = 0,
                "count" => metadata.head.chunks += 1,
                "stamps" => {
                    metadata.chunk_stamps.pop();
                }
                "tail" => metadata.head.tail = None,
                "legacy_bytes" => metadata.legacy_stamp.fields[2] += 1,
                "sequence" => metadata.references[0].sequence += 1,
                "zero_blocks" => metadata.references[0].blocks = 0,
                "large_blocks" => metadata.references[0].blocks = CHUNK_BLOCKS as u64 + 1,
                "range" => metadata.references[0].first_slot = metadata.references[0].last_slot + 1,
                "overlap" => metadata.references[1].first_slot = metadata.references[0].last_slot,
                "zero_stamp" => metadata.chunk_stamps[0].fields[2] = 0,
                "block_count" => metadata.head.blocks += 1,
                "anchor_zero" => metadata.anchor_blocks = 0,
                "anchor_count" => metadata.anchor_blocks = metadata.head.blocks + 1,
                "first" => metadata.first.0 += 1,
                "parent" => metadata.first.1 = metadata.first.0,
                "archive_slot" => metadata.archive_tail.slot += 1,
                "archive_hash" => metadata.archive_tail.blockhash[0] ^= 1,
                "anchor_before" => metadata.anchor.slot = metadata.first.0 - 1,
                "anchor_after" => metadata.anchor.slot = metadata.archive_tail.slot + 1,
                "duplicate" => metadata.references[1].sha256 = metadata.references[0].sha256,
                _ => unreachable!(),
            }
            assert!(
                observations(root.path(), &metadata).is_err(),
                "legacy {case}"
            );
            assert!(
                observations_match(root.path(), &metadata, &expected).is_err(),
                "borrowed {case}"
            );
        }
    }
    #[test]
    fn borrowed_observation_equality_rejects_missing_extra_and_changed_stamps() {
        let (root, metadata, _, expected) = fixture();
        for case in ["missing", "extra", "changed", "substituted"] {
            let mut changed = expected.clone();
            let path = chunk_path(&root.path().join(ARCHIVE_DIR), &metadata.references[0]);
            match case {
                "missing" => {
                    changed.remove(&path);
                }
                "extra" => {
                    changed.insert(root.path().join("extra"), metadata.legacy_stamp.clone());
                }
                "changed" => changed.get_mut(&path).unwrap().fields[1] ^= 1,
                "substituted" => {
                    let stamp = changed.remove(&path).unwrap();
                    changed.insert(root.path().join("replacement"), stamp);
                }
                _ => unreachable!(),
            }
            assert!(
                observations(root.path(), &metadata).unwrap() != changed,
                "legacy {case}"
            );
            assert!(
                observations_match(root.path(), &metadata, &changed).is_err(),
                "borrowed {case}"
            );
        }
        // Matching repeated paths plus an unrelated compensating map entry
        // must not exploit the length check to bypass exact map equality.
        let mut duplicate = duplicate(&metadata);
        duplicate.references[1].sha256 = duplicate.references[0].sha256;
        duplicate.chunk_stamps[1] = duplicate.chunk_stamps[0].clone();
        assert!(observations_match(root.path(), &duplicate, &expected).is_err());
    }
}
