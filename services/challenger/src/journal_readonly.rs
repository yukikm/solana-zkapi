//! Read-only, fixed-head follower of the existing v2 archive format.
//!
//! Cold open authenticates the whole retained prefix. Incremental refresh trusts
//! the local filesystem's inode/size/mtime/ctime continuity for already checked
//! immutable files, and hashes every new or replayed payload chunk. This is not
//! protection against a privileged actor able to forge filesystem metadata.
use super::*;
use std::io::{Seek, SeekFrom};

// Resource gate only; the existing strict Envelope decoder below remains the
// authority. An accidental v1 source (or nonempty v2 inline archive) must not
// allocate the historical block Vec before this v2-only reader rejects it.
#[derive(Deserialize)]
struct HeadProbe {
    state: StateProbe,
}
#[derive(Deserialize)]
struct StateProbe {
    #[serde(deserialize_with = "version_two")]
    version: (),
    #[serde(default, deserialize_with = "empty_inline_archive")]
    archive: (),
}
fn version_two<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<(), D::Error> {
    if u32::deserialize(d)? == 2 {
        Ok(())
    } else {
        Err(serde::de::Error::custom("read-only archive requires v2"))
    }
}
fn empty_inline_archive<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<(), D::Error> {
    struct Empty;
    impl<'de> serde::de::Visitor<'de> for Empty {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("empty v2 inline archive")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<(), A::Error> {
            if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                Err(serde::de::Error::custom(
                    "read-only v2 inline archive is not empty",
                ))
            } else {
                Ok(())
            }
        }
    }
    d.deserialize_seq(Empty)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct FileStamp {
    pub(super) fields: [u64; 11],
}
impl FileStamp {
    pub(super) fn of(metadata: &fs::Metadata) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                fields: [
                    metadata.dev(),
                    metadata.ino(),
                    metadata.len(),
                    metadata.mode() as u64,
                    metadata.uid() as u64,
                    metadata.gid() as u64,
                    metadata.nlink(),
                    metadata.mtime() as u64,
                    metadata.mtime_nsec() as u64,
                    metadata.ctime() as u64,
                    metadata.ctime_nsec() as u64,
                ],
            })
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Err(Error::Conflict(
                "read-only archive requires Unix file identity",
            ))
        }
    }
    pub(super) fn at(path: &Path) -> Result<Self> {
        // Continuity checks inspect metadata only. Reopening every already
        // authenticated chunk adds several syscalls per file, per check, and
        // can exhaust the HTTP wait budget on a growing archive. lstat captures
        // the same complete stamp without following a final-component symlink.
        // Payload reads still use regular(), validate the opened descriptor,
        // and hash the bytes; this never grants trust to a new/replaced inode.
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() {
            return Err(Error::Conflict("archive file type"));
        }
        Self::of(&metadata)
    }
    fn same_captured_head(&self, after: &Self) -> bool {
        self == after
            || (
                // Replacing journal.json unlinks this still-open old inode. Link
                // count and ctime may change; its bytes, owner, mode and mtime must
                // not. Immutable chunk/legacy checks never allow this exception.
                self.fields[..6] == after.fields[..6]
                    && self.fields[6] == 1
                    && after.fields[6] == 0
                    && self.fields[7..9] == after.fields[7..9]
            )
    }
}
pub(super) type Observations = BTreeMap<PathBuf, FileStamp>;
#[cfg(test)]
thread_local! { pub(super) static READS: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) }; }

// No second parser: these hooks wrap the writer's existing JSON/checksum/chain
// validation, recording file identity around the same open file descriptor.
pub(super) fn read_json_observed<T: DeserializeOwned>(
    path: &Path,
    observations: Option<&mut Observations>,
) -> Result<(T, Hash, u64)> {
    let file = regular(path)?;
    let Some(observations) = observations else {
        return read_json(file);
    };
    #[cfg(test)]
    READS.with(|reads| reads.borrow_mut().push(path.to_owned()));
    let probe = file.try_clone()?;
    let before = FileStamp::of(&probe.metadata()?)?;
    if observations.get(path).is_some_and(|old| old != &before) {
        return Err(Error::Conflict("verified archive file changed"));
    }
    let value = read_json(file)?;
    if before != FileStamp::of(&probe.metadata()?)? || before != FileStamp::at(path)? {
        return Err(Error::Conflict("verified archive file changed"));
    }
    observations.insert(path.to_owned(), before);
    Ok(value)
}
pub(super) fn read_chunk_observed(
    path: &Path,
    reference: &ChunkRef,
    pool: Hash,
    observations: Option<&mut Observations>,
) -> Result<Chunk<Vec<FinalizedBlock>>> {
    let Some(observations) = observations else {
        return read_chunk(path, reference, pool);
    };
    if reference.sequence == 0 || reference.blocks == 0 || reference.blocks > CHUNK_BLOCKS as u64 {
        return Err(Error::Conflict("archive chunk sequence/count"));
    }
    let file_path = chunk_path(path, reference);
    if regular(&file_path)?.metadata()?.len() != reference.bytes {
        return Err(Error::Conflict("archive chunk byte count"));
    }
    let (chunk, hash, bytes) = read_json_observed(&file_path, Some(observations))?;
    validate_chunk(chunk, hash, bytes, reference, pool)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct DirectoryStamp([u64; 5]);
impl DirectoryStamp {
    pub(super) fn at(path: &Path) -> Result<Self> {
        directory(path)?;
        let metadata = fs::symlink_metadata(path)?;
        let stamp = FileStamp::of(&metadata)?;
        // The immutable files' directory naturally changes mtime on append.
        Ok(Self([
            stamp.fields[0],
            stamp.fields[1],
            stamp.fields[3],
            stamp.fields[4],
            stamp.fields[5],
        ]))
    }
}

/// Authenticated read-only v2 snapshot. It never takes or creates `owner.lock`,
/// writes a health file, migrates, adopts orphan chunks, or accesses RPC.
///
/// Only the stored `FinalizedBlock` projection is exposed; it is not an original
/// RPC response or a cryptographic proof of finality. A consumer must still run
/// its original replay validation and current finalized account reconciliation.
pub struct ReadOnlyArchive {
    pub(super) directory: PathBuf,
    pub(super) pool: Hash,
    pub(super) archive: Archive,
    pub(super) first: Option<(u64, u64)>,
    pub(super) observations: Observations,
    pub(super) root_identity: DirectoryStamp,
    pub(super) archive_identity: DirectoryStamp,
}
impl ReadOnlyArchive {
    pub fn open(directory: &Path, pool: Hash) -> Result<Self> {
        let root_identity = DirectoryStamp::at(directory)?;
        let archive_identity = DirectoryStamp::at(&directory.join(ARCHIVE_DIR))?;
        let head = Self::read_head(directory, pool)?;
        let mut observations = Observations::new();
        let archive = load_observed(directory, pool, head, Some(&mut observations))?;
        let first = Self::first(&archive, directory)?;
        let reader = Self {
            directory: directory.to_owned(),
            pool,
            archive,
            first,
            observations,
            root_identity,
            archive_identity,
        };
        reader.verify_files()?;
        Ok(reader)
    }
    pub(super) fn read_head(directory: &Path, pool: Hash) -> Result<Head> {
        // Both the bounded probe and the existing strict decoder read one open
        // inode. An atomic newer head cannot be mixed into this captured cut.
        // Unlike immutable chunks, the head is atomically replaced by the live
        // writer. Capture whichever regular inode open() observes; comparing it
        // with an earlier pathname stat mistakes a normal commit for corruption.
        // The descriptor stamps, checksum and authenticated prefix checks below
        // still reject in-place mutation, invalid heads and rollback/rewrite.
        let mut file = open_regular(&directory.join("journal.json"))?;
        let before = FileStamp::of(&file.metadata()?)?;
        let HeadProbe {
            state:
                StateProbe {
                    version: (),
                    archive: (),
                },
        } = serde_json::from_reader(BufReader::with_capacity(JOURNAL_IO_BUFFER_BYTES, &mut file))?;
        file.seek(SeekFrom::Start(0))?;
        let (envelope, _, _): (Envelope, _, _) = read_json(file.try_clone()?)?;
        if !before.same_captured_head(&FileStamp::of(&file.metadata()?)?) {
            return Err(Error::Conflict(
                "read-only archive head changed during read",
            ));
        }
        let Some(head) = envelope.segmented else {
            return Err(Error::Conflict("read-only archive requires v2"));
        };
        if envelope.state.version != 2
            || envelope.state.pool != pool
            || head.pool != pool
            || !envelope.state.archive.is_empty()
            || envelope.digest != digest(&envelope.state, &head)?
        {
            return Err(Error::Conflict("read-only archive checksum/version/pool"));
        }
        envelope.state.validate_job_identities()?;
        Ok(head)
    }
    pub(super) fn first(archive: &Archive, directory: &Path) -> Result<Option<(u64, u64)>> {
        if archive.references.is_empty() {
            return Ok(None);
        }
        let chunk = archive.read_indexed(&archive_directory(directory)?, 0)?;
        Ok(chunk
            .blocks
            .first()
            .map(|block| (block.slot, block.parent_slot)))
    }
    pub(super) fn verify_files(&self) -> Result<()> {
        if DirectoryStamp::at(&self.directory)? != self.root_identity
            || DirectoryStamp::at(&self.directory.join(ARCHIVE_DIR))? != self.archive_identity
        {
            return Err(Error::Conflict("verified archive directory changed"));
        }
        for (path, before) in &self.observations {
            if &FileStamp::at(path)? != before {
                return Err(Error::Conflict("verified archive file changed"));
            }
        }
        Ok(())
    }
    pub fn archive_len(&self) -> u64 {
        self.archive.len()
    }
    pub fn archive_tail(&self) -> Option<ArchiveTail> {
        self.archive.tail()
    }
    /// First retained slot and its actual parent slot (which may precede a gap).
    pub fn archive_first(&self) -> Option<(u64, u64)> {
        self.first
    }

    /// Adopt only a fully authenticated extension of the last observed head.
    /// On failure the old snapshot remains intact; callers must fail closed.
    /// Unchanged prefixes use trusted Unix metadata continuity, not a fresh
    /// whole-archive rehash. Every new/replayed chunk is always rehashed.
    pub fn refresh(&mut self) -> Result<bool> {
        let head = Self::read_head(&self.directory, self.pool)?;
        self.refresh_head(head)
    }
    pub(super) fn refresh_head(&mut self, head: Head) -> Result<bool> {
        self.verify_files()?;
        if head == self.archive.head {
            return Ok(false);
        }
        let old = &self.archive.head;
        if head.version != 2
            || head.pool != old.pool
            || head.legacy != old.legacy
            || head.chunks <= old.chunks
            || head.blocks <= old.blocks
            || head.chunks > head.blocks
            || head.tail.is_none()
        {
            return Err(Error::Conflict("read-only archive rollback/rewrite"));
        }
        let path = archive_directory(&self.directory)?;
        let mut observations = self.observations.clone();
        let mut reference = head.tail.clone();
        let mut sequence = head.chunks;
        let mut count = 0u64;
        let mut reversed = Vec::new();
        let mut tail = None;
        while sequence > old.chunks {
            let current = reference.ok_or(Error::Conflict("read-only archive prefix absent"))?;
            if current.sequence != sequence {
                return Err(Error::Conflict("archive chunk sequence/count"));
            }
            let chunk = read_chunk_observed(&path, &current, self.pool, Some(&mut observations))?;
            if tail.is_none() {
                tail = chunk.blocks.last().map(ArchiveTail::from);
            }
            count = count
                .checked_add(current.blocks)
                .ok_or(Error::Conflict("archive count overflow"))?;
            if count > head.blocks - old.blocks {
                return Err(Error::Conflict("archive block count"));
            }
            sequence -= 1;
            reference = chunk.previous;
            reversed
                .try_reserve(1)
                .map_err(|_| Error::Conflict("archive capacity"))?;
            reversed.push(current);
        }
        if reference != old.tail || count != head.blocks - old.blocks {
            return Err(Error::Conflict("read-only archive prefix changed"));
        }
        reversed.reverse();
        let mut references = self.archive.references.clone();
        references.extend(reversed);
        let archive = Archive {
            references,
            tail,
            head,
            verified: None,
        };
        let first = match self.first {
            Some(first) => Some(first),
            None => Self::first(&archive, &self.directory)?,
        };
        // No partial installation, including when the writer atomically adds a
        // still newer head while this fixed extension is being validated.
        self.verify_files()?;
        for (path, stamp) in &observations {
            if &FileStamp::at(path)? != stamp {
                return Err(Error::Conflict("verified archive file changed"));
            }
        }
        self.archive = archive;
        self.first = first;
        self.observations = observations;
        Ok(true)
    }

    /// Inclusive range. Payload memory is bounded to one original chunk (the
    /// writer's legacy oversized-singleton exception is preserved). Callback
    /// errors/cancellation stop immediately. An atomic newer head is not mixed
    /// into this snapshot; the next refresh can adopt it.
    pub fn replay_range(
        &self,
        start: u64,
        end: u64,
        mut visit: impl FnMut(&FinalizedBlock) -> Result<()>,
    ) -> Result<()> {
        if start > end {
            return Err(Error::Conflict("read-only archive range"));
        }
        self.verify_files()?;
        let path = archive_directory(&self.directory)?;
        let first = self
            .archive
            .references
            .partition_point(|reference| reference.last_slot < start);
        for index in first..self.archive.references.len() {
            if self.archive.references[index].first_slot > end {
                break;
            }
            let chunk = self.archive.read_indexed(&path, index)?;
            for block in &chunk.blocks {
                if block.slot >= start && block.slot <= end {
                    visit(block)?;
                }
            }
        }
        self.verify_files()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "journal_readonly_tests.rs"]
mod tests;
