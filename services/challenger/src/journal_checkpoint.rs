//! Optional owner-controlled restart cache. Checksums detect damage, not a
//! privileged forgery. Cached immutable files use the same Unix metadata trust
//! model as an already-open follower. Financial journal state is never cached.
use super::*;
use readonly::{DirectoryStamp, FileStamp, Observations};

const NAME: &str = "archive-runtime-checkpoint-v1";
const MAGIC: &[u8] = b"ZKAPI-ARCHIVE-CHECKPOINT-V1\n";
const META_LIMIT: u64 = 64 * 1024 * 1024;
const STATE_LIMIT: u64 = 256 * 1024 * 1024;

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
    pub(super) fn verify(&self, root: &Path) -> Result<()> {
        if DirectoryStamp::at(root)? != self.root_identity
            || DirectoryStamp::at(&root.join(ARCHIVE_DIR))? != self.archive_identity
        {
            return Err(Error::Conflict("checkpoint archive directory changed"));
        }
        for (path, stamp) in &self.observations {
            if FileStamp::at(path)? != *stamp {
                return Err(Error::Conflict("checkpoint archive file changed"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    binding: Hash,
    head: Head,
    references: Vec<ChunkRef>,
    archive_tail: ArchiveTail,
    first: (u64, u64),
    anchor: ArchiveTail,
    anchor_blocks: u64,
    state_sha256: Hash,
    root_identity: DirectoryStamp,
    archive_identity: DirectoryStamp,
    legacy_stamp: FileStamp,
    chunk_stamps: Vec<FileStamp>,
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
fn write_cache(path: &Path, metadata: &Metadata, bytes: &[u8]) -> Result<()> {
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
fn observations(root: &Path, metadata: &Metadata) -> Result<Observations> {
    let head = &metadata.head;
    if metadata.version != 1
        || head.version != 2
        || head.chunks == 0
        || head.chunks != metadata.references.len() as u64
        || metadata.chunk_stamps.len() != metadata.references.len()
        || head.tail.as_ref() != metadata.references.last()
        || metadata.legacy_stamp.fields[2] != head.legacy.bytes
    {
        return Err(Error::Conflict("checkpoint archive shape"));
    }
    let mut result = Observations::new();
    result.insert(root.join(BACKUP), metadata.legacy_stamp.clone());
    let mut count = 0u64;
    let mut last_slot = None;
    for (index, (reference, stamp)) in metadata
        .references
        .iter()
        .zip(&metadata.chunk_stamps)
        .enumerate()
    {
        if reference.sequence != index as u64 + 1
            || reference.blocks == 0
            || reference.blocks > CHUNK_BLOCKS as u64
            || reference.first_slot > reference.last_slot
            || last_slot.is_some_and(|slot| reference.first_slot <= slot)
            || stamp.fields[2] != reference.bytes
        {
            return Err(Error::Conflict("checkpoint archive references"));
        }
        count = count
            .checked_add(reference.blocks)
            .ok_or(Error::Conflict("checkpoint block count"))?;
        last_slot = Some(reference.last_slot);
        if result
            .insert(
                chunk_path(&root.join(ARCHIVE_DIR), reference),
                stamp.clone(),
            )
            .is_some()
        {
            return Err(Error::Conflict("checkpoint duplicate file"));
        }
    }
    let first = &metadata.references[0];
    let last = metadata.references.last().expect("nonempty refs");
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
    Ok(result)
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
    verified: &VerifiedFiles,
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
        references: archive.references.clone(),
        archive_tail: archive
            .tail
            .ok_or(Error::Conflict("checkpoint archive empty"))?,
        first,
        anchor,
        anchor_blocks,
        state_sha256: sha(bytes),
        root_identity: verified.root_identity.clone(),
        archive_identity: verified.archive_identity.clone(),
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
                    .cloned()
                    .ok_or(Error::Conflict("checkpoint chunk observation"))
            })
            .collect::<Result<_>>()?,
    };
    if observations(root, &metadata)? != verified.observations {
        return Err(Error::Conflict("checkpoint observation set"));
    }
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
            verified,
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
        let verified = VerifiedFiles {
            observations: self.observations.clone(),
            root_identity: self.root_identity.clone(),
            archive_identity: self.archive_identity.clone(),
        };
        save(
            &self.directory,
            checkpoint_path,
            &self.archive,
            &verified,
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
