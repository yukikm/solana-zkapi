//! Opt-in v2 storage. Every full block remains retained; only persistence and
//! mutable-state ownership change. V2 keeps only a chunk index and tail in
//! memory; full block payloads are read one authenticated chunk at a time.
use super::*;
use rand::{rngs::OsRng, RngCore};
use serde::de::DeserializeOwned;
use std::io::{Read, Result as IoResult};
use zkapi_indexer::FinalizedBlock;

const ARCHIVE_DIR: &str = "archive-v2";
const BACKUP: &str = "legacy-v1.json";
const CHUNK_BLOCKS: usize = 256;
const CHUNK_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Legacy {
    sha256: Hash,
    bytes: u64,
    state_digest: Hash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct ChunkRef {
    sha256: Hash,
    bytes: u64,
    sequence: u64,
    blocks: u64,
    first_slot: u64,
    last_slot: u64,
    last_blockhash: Hash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Head {
    version: u32,
    pool: Hash,
    legacy: Legacy,
    chunks: u64,
    blocks: u64,
    tail: Option<ChunkRef>,
}
pub(super) struct Archive {
    references: Vec<ChunkRef>,
    tail: Option<ArchiveTail>,
    pub(super) head: Head,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk<B> {
    version: u32,
    pool: Hash,
    sequence: u64,
    // A fresh nonce makes a retried, uncommitted suffix a fresh immutable file.
    // Reopening never scans, adopts, overwrites, or removes orphan chunks.
    nonce: Hash,
    previous: Option<ChunkRef>,
    blocks: B,
}
#[derive(Debug, Serialize)]
pub struct MigrationReport {
    pub format_version: u32,
    pub legacy_sha256: Hash,
    pub legacy_bytes: u64,
    pub legacy_state_digest: Hash,
    pub archive_blocks: u64,
    pub archive_chunks: u64,
    pub head_digest: Hash,
}

pub(super) fn deserialize_head<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Head>, D::Error> {
    Head::deserialize(deserializer).map(Some)
}

// These checks protect fixed local paths. No filename or path is deserialized
// from the head: chunk names are derived solely from 32-byte hashes.
fn directory(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(Error::Conflict("archive directory type"));
    }
    Ok(())
}
fn regular(path: &Path) -> Result<File> {
    let before = fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Err(Error::Conflict("archive file type"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let after = file.metadata()?;
    if !after.is_file() {
        return Err(Error::Conflict("archive file type"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(Error::Conflict("archive file changed during open"));
        }
    }
    Ok(file)
}
fn create(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn create_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn nonce() -> Hash {
    let mut nonce = [0; 32];
    OsRng.fill_bytes(&mut nonce);
    nonce
}
fn sync_directory(path: &Path) -> Result<()> {
    directory(path)?;
    File::open(path)?.sync_all()?;
    Ok(())
}
struct HashedReader<R> {
    source: R,
    hash: Sha256,
    bytes: u64,
}
impl<R: Read> Read for HashedReader<R> {
    fn read(&mut self, out: &mut [u8]) -> IoResult<usize> {
        let count = self.source.read(out)?;
        self.hash.update(&out[..count]);
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("archive byte count overflow"))?;
        Ok(count)
    }
}
fn read_json<T: DeserializeOwned>(file: File) -> Result<(T, Hash, u64)> {
    // serde_json's reader adapter requests individual bytes. Hash beneath the
    // buffer so the digest sees bounded file reads, not one update per byte.
    let mut reader = BufReader::with_capacity(
        JOURNAL_IO_BUFFER_BYTES,
        HashedReader {
            source: file,
            hash: Sha256::new(),
            bytes: 0,
        },
    );
    // from_reader requires EOF, rejecting trailing JSON and malformed suffixes.
    let value = serde_json::from_reader(&mut reader)?;
    let reader = reader.into_inner();
    Ok((value, reader.hash.finalize().into(), reader.bytes))
}
pub(super) fn read_source(path: &Path) -> Result<(Envelope, Hash, u64)> {
    read_json(regular(&path.join("journal.json"))?)
}
fn fingerprint(mut file: File) -> Result<(Hash, u64)> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; JOURNAL_IO_BUFFER_BYTES];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or(Error::Conflict("archive byte count overflow"))?;
    }
    Ok((hash.finalize().into(), bytes))
}
#[derive(Serialize)]
struct Committed<'a> {
    domain: &'static str,
    state: &'a State,
    segmented: &'a Head,
}
pub(super) fn digest(state: &State, head: &Head) -> Result<Hash> {
    let mut writer = BufWriter::with_capacity(JOURNAL_IO_BUFFER_BYTES, HashWriter(Sha256::new()));
    serde_json::to_writer(
        &mut writer,
        &Committed {
            domain: "zkapi-challenger-journal-v2",
            state,
            segmented: head,
        },
    )?;
    Ok(writer
        .into_inner()
        .map_err(|e| e.into_error())?
        .0
        .finalize()
        .into())
}
fn archive_directory(root: &Path) -> Result<PathBuf> {
    directory(root)?;
    let path = root.join(ARCHIVE_DIR);
    directory(&path)?;
    Ok(path)
}
fn chunk_path(root: &Path, reference: &ChunkRef) -> PathBuf {
    root.join(format!("{}.json", hex::encode(reference.sha256)))
}
fn read_chunk(path: &Path, current: &ChunkRef, pool: Hash) -> Result<Chunk<Vec<FinalizedBlock>>> {
    if current.sequence == 0 || current.blocks == 0 || current.blocks > CHUNK_BLOCKS as u64 {
        return Err(Error::Conflict("archive chunk sequence/count"));
    }
    let file = regular(&chunk_path(path, current))?;
    if file.metadata()?.len() != current.bytes {
        return Err(Error::Conflict("archive chunk byte count"));
    }
    let (chunk, hash, bytes): (Chunk<Vec<FinalizedBlock>>, _, _) = read_json(file)?;
    if hash != current.sha256
        || bytes != current.bytes
        || chunk.version != 2
        || chunk.pool != pool
        || chunk.sequence != current.sequence
        || chunk.blocks.len() as u64 != current.blocks
        || chunk.blocks.first().map(|b| b.slot) != Some(current.first_slot)
        || chunk.blocks.last().map(|b| (b.slot, b.blockhash))
            != Some((current.last_slot, current.last_blockhash))
        || (current.sequence == 1) != chunk.previous.is_none()
    {
        return Err(Error::Conflict("archive chunk checksum/identity"));
    }
    valid_chain(&chunk.blocks, None)?;
    if let Some(previous) = &chunk.previous {
        let first = &chunk.blocks[0];
        if previous.sequence.checked_add(1) != Some(current.sequence)
            || first.slot <= previous.last_slot
            || first.parent_slot != previous.last_slot
            || first.previous_blockhash != previous.last_blockhash
        {
            return Err(Error::Conflict("archive chunk parent/fork"));
        }
    }
    Ok(chunk)
}
impl Archive {
    pub(super) fn len(&self) -> u64 {
        self.head.blocks
    }
    pub(super) fn tail(&self) -> Option<ArchiveTail> {
        self.tail
    }
    fn read_indexed(&self, path: &Path, index: usize) -> Result<Chunk<Vec<FinalizedBlock>>> {
        let chunk = read_chunk(path, &self.references[index], self.head.pool)?;
        if chunk.previous.as_ref() != index.checked_sub(1).map(|i| &self.references[i]) {
            return Err(Error::Conflict("archive indexed parent"));
        }
        Ok(chunk)
    }
    pub(super) fn replay(
        &self,
        root: &Path,
        mut visit: impl FnMut(&FinalizedBlock) -> Result<()>,
    ) -> Result<()> {
        let path = archive_directory(root)?;
        for index in 0..self.references.len() {
            let chunk = self.read_indexed(&path, index)?;
            for block in &chunk.blocks {
                visit(block)?;
            }
        }
        Ok(())
    }
    fn chunk_index(&self, slot: u64) -> Option<usize> {
        let index = self
            .references
            .partition_point(|reference| reference.last_slot < slot);
        self.references
            .get(index)
            .filter(|reference| reference.first_slot <= slot)
            .map(|_| index)
    }
    pub(super) fn block_time(&self, root: &Path, slot: u64) -> Result<Option<u64>> {
        let Some(index) = self.chunk_index(slot) else {
            return Ok(None);
        };
        let chunk = self.read_indexed(&archive_directory(root)?, index)?;
        Ok(chunk
            .blocks
            .binary_search_by_key(&slot, |block| block.slot)
            .ok()
            .map(|i| chunk.blocks[i].block_time))
    }
}
fn valid_chain(blocks: &[FinalizedBlock], previous: Option<&FinalizedBlock>) -> Result<()> {
    let mut previous = previous;
    for block in blocks {
        if !block.finalized
            || previous.is_some_and(|old| {
                block.slot <= old.slot
                    || block.parent_slot != old.slot
                    || block.previous_blockhash != old.blockhash
            })
        {
            return Err(Error::Conflict("archive gap/fork"));
        }
        previous = Some(block);
    }
    Ok(())
}
// Independently bind every original block (including transaction bytes) to the
// retained v1 source. Merely checking chunk counts would accept a rechecksummed
// empty/short head despite a nonempty legacy archive. Decode one legacy block
// at a time; no second complete history Vec is allocated on cold open.
#[derive(Debug, PartialEq, Eq)]
struct ArchiveSummary {
    blocks: u64,
    tail: Option<(u64, Hash)>,
    digest: Hash,
}
impl Default for ArchiveSummary {
    fn default() -> Self {
        Self {
            blocks: 0,
            tail: None,
            digest: sha(b"zkapi-challenger-legacy-prefix-v2"),
        }
    }
}
impl ArchiveSummary {
    fn push(&mut self, block: &FinalizedBlock) -> Result<()> {
        if !block.finalized
            || self.tail.is_some_and(|(slot, hash)| {
                block.slot <= slot || block.parent_slot != slot || block.previous_blockhash != hash
            })
        {
            return Err(Error::Conflict("legacy archive gap/fork"));
        }
        let mut writer =
            BufWriter::with_capacity(JOURNAL_IO_BUFFER_BYTES, HashWriter(Sha256::new()));
        serde_json::to_writer(&mut writer, block)?;
        let block_digest: Hash = writer
            .into_inner()
            .map_err(|e| e.into_error())?
            .0
            .finalize()
            .into();
        let mut next = Sha256::new();
        next.update(self.digest);
        next.update(block_digest);
        self.digest = next.finalize().into();
        self.blocks = self
            .blocks
            .checked_add(1)
            .ok_or(Error::Conflict("legacy archive count overflow"))?;
        self.tail = Some((block.slot, block.blockhash));
        Ok(())
    }
}
impl<'de> Deserialize<'de> for ArchiveSummary {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ArchiveSummary;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("legacy archive sequence")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut summary = ArchiveSummary::default();
                while let Some(block) = sequence.next_element::<FinalizedBlock>()? {
                    summary
                        .push(&block)
                        .map_err(|_| serde::de::Error::custom("invalid legacy archive"))?;
                }
                Ok(summary)
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}
pub(super) fn load(root: &Path, pool: Hash, head: Head) -> Result<Archive> {
    let path = archive_directory(root)?;
    if head.version != 2
        || head.pool != pool
        || head.chunks > head.blocks
        || (head.chunks == 0) != head.tail.is_none()
        || (head.blocks == 0) != head.tail.is_none()
    {
        return Err(Error::Conflict("archive head identity/count"));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct LegacyState {
        version: u32,
        pool: Hash,
        jobs: serde::de::IgnoredAny,
        checkpoint: serde::de::IgnoredAny,
        #[serde(default)]
        archive: ArchiveSummary,
        #[serde(default)]
        transport: Option<serde::de::IgnoredAny>,
        #[serde(default)]
        alerts: Option<serde::de::IgnoredAny>,
        #[serde(default)]
        absent_buffers: Option<serde::de::IgnoredAny>,
        #[serde(default)]
        proof_failure_total: Option<serde::de::IgnoredAny>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyDigest {
        digest: Hash,
        state: LegacyState,
    }
    let (legacy, hash, bytes): (LegacyDigest, _, _) = read_json(regular(&root.join(BACKUP))?)?;
    if (hash, bytes) != (head.legacy.sha256, head.legacy.bytes)
        || legacy.digest != head.legacy.state_digest
        || legacy.state.version != 1
        || legacy.state.pool != pool
        || legacy.state.archive.blocks > head.blocks
    {
        return Err(Error::Conflict("legacy archive backup checksum"));
    }
    let mut reference = head.tail.clone();
    let mut expected_sequence = head.chunks;
    let mut count = 0u64;
    let mut reversed = Vec::new();
    let mut tail = None;
    while let Some(current) = reference {
        if current.sequence != expected_sequence {
            return Err(Error::Conflict("archive chunk sequence/count"));
        }
        let chunk = read_chunk(&path, &current, pool)?;
        if tail.is_none() {
            tail = chunk.blocks.last().map(ArchiveTail::from);
        }
        count = count
            .checked_add(current.blocks)
            .ok_or(Error::Conflict("archive count overflow"))?;
        if count > head.blocks {
            return Err(Error::Conflict("archive block count"));
        }
        expected_sequence -= 1;
        reference = chunk.previous;
        reversed
            .try_reserve(1)
            .map_err(|_| Error::Conflict("archive capacity"))?;
        reversed.push(current);
        // Discard this complete payload chunk before reading its predecessor.
    }
    if expected_sequence != 0 || count != head.blocks {
        return Err(Error::Conflict("archive head count"));
    }
    reversed.reverse();
    let archive = Archive {
        references: reversed,
        tail,
        head,
    };
    // The original full-content prefix commitment is order-sensitive. Verify
    // it in a separate forward pass, without retaining history payloads.
    let mut prefix = ArchiveSummary::default();
    for index in 0..archive.references.len() {
        if prefix.blocks == legacy.state.archive.blocks {
            break;
        }
        let chunk = archive.read_indexed(&path, index)?;
        for block in &chunk.blocks {
            if prefix.blocks == legacy.state.archive.blocks {
                break;
            }
            prefix.push(block)?;
        }
    }
    if prefix != legacy.state.archive {
        return Err(Error::Conflict("legacy archive prefix mismatch"));
    }
    Ok(archive)
}

struct CountWriter(u64);
impl Write for CountWriter {
    fn write(&mut self, bytes: &[u8]) -> IoResult<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| std::io::Error::other("archive byte count overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> IoResult<()> {
        Ok(())
    }
}
fn chunk_end(blocks: &[FinalizedBlock], start: usize) -> Result<usize> {
    let mut bytes = 0u64;
    let mut end = start;
    while end < blocks.len() && end - start < CHUNK_BLOCKS {
        let mut size = CountWriter(0);
        serde_json::to_writer(&mut size, &blocks[end])?;
        let next = bytes
            .checked_add(size.0)
            .ok_or(Error::Conflict("archive byte count overflow"))?;
        if end > start && next > CHUNK_BYTES {
            break;
        }
        bytes = next;
        end += 1;
        // Preserve an oversized singleton rather than dropping historic data.
        if bytes >= CHUNK_BYTES {
            break;
        }
    }
    Ok(end)
}
struct HashingWriter<W> {
    inner: W,
    hash: Sha256,
    bytes: u64,
}
impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> IoResult<usize> {
        let count = self.inner.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("archive byte count overflow"))?;
        Ok(count)
    }
    fn flush(&mut self) -> IoResult<()> {
        self.inner.flush()
    }
}
fn write_chunk(
    path: &Path,
    pool: Hash,
    previous: Option<ChunkRef>,
    blocks: &[FinalizedBlock],
) -> Result<ChunkRef> {
    let sequence = previous
        .as_ref()
        .map_or(Some(1), |p| p.sequence.checked_add(1))
        .ok_or(Error::Conflict("archive sequence overflow"))?;
    let nonce = nonce();
    let temporary = path.join(format!("chunk-{}.next", hex::encode(nonce)));
    let mut file = create(&temporary)?;
    let (sha256, bytes) = {
        let mut writer = BufWriter::with_capacity(
            JOURNAL_IO_BUFFER_BYTES,
            HashingWriter {
                inner: &mut file,
                hash: Sha256::new(),
                bytes: 0,
            },
        );
        serde_json::to_writer(
            &mut writer,
            &Chunk {
                version: 2,
                pool,
                sequence,
                nonce,
                previous,
                blocks,
            },
        )?;
        fault("chunk_before_flush")?;
        writer.flush()?;
        let writer = writer.into_inner().map_err(|e| e.into_error())?;
        (writer.hash.finalize().into(), writer.bytes)
    };
    file.sync_all()?;
    fault("chunk_after_sync")?;
    let reference = ChunkRef {
        sha256,
        bytes,
        sequence,
        blocks: blocks.len() as u64,
        first_slot: blocks[0].slot,
        last_slot: blocks.last().unwrap().slot,
        last_blockhash: blocks.last().unwrap().blockhash,
    };
    // Atomic no-replace publication. A collision, including a symlink, fails.
    fs::hard_link(&temporary, chunk_path(path, &reference))?;
    sync_directory(path)?;
    fault("chunk_after_publish")?;
    fs::remove_file(&temporary)?;
    sync_directory(path)?;
    Ok(reference)
}
fn append_chunks(
    root: &Path,
    head: &Head,
    blocks: &[FinalizedBlock],
    cancelled: &impl Fn() -> bool,
) -> Result<Head> {
    append_chunks_indexed(root, head, blocks, cancelled).map(|(head, _)| head)
}
fn append_chunks_indexed(
    root: &Path,
    head: &Head,
    blocks: &[FinalizedBlock],
    cancelled: &impl Fn() -> bool,
) -> Result<(Head, Vec<ChunkRef>)> {
    let path = archive_directory(root)?;
    let mut next = head.clone();
    let mut references = Vec::new();
    // At most one chunk per block. Reserve metadata before any file commit.
    references
        .try_reserve(blocks.len())
        .map_err(|_| Error::Conflict("archive capacity"))?;
    let mut start = 0;
    while start < blocks.len() {
        cancellation(cancelled)?;
        let end = chunk_end(blocks, start)?;
        let reference = write_chunk(&path, head.pool, next.tail.clone(), &blocks[start..end])?;
        next.chunks = reference.sequence;
        next.blocks = next
            .blocks
            .checked_add(reference.blocks)
            .ok_or(Error::Conflict("archive count overflow"))?;
        references.push(reference.clone());
        next.tail = Some(reference);
        start = end;
    }
    Ok((next, references))
}
pub(super) fn persist_head(root: &Path, state: &State, head: &Head) -> Result<()> {
    persist_head_with_cancel(root, state, head, &|| false)
}
fn persist_head_with_cancel(
    root: &Path,
    state: &State,
    head: &Head,
    cancelled: &impl Fn() -> bool,
) -> Result<()> {
    archive_directory(root)?;
    regular(&root.join("journal.json"))?;
    let digest = digest(state, head)?;
    let temporary = root.join(format!("journal-v2-{}.next", hex::encode(nonce())));
    let mut file = create(&temporary)?;
    {
        let mut writer = BufWriter::with_capacity(JOURNAL_IO_BUFFER_BYTES, &mut file);
        writer.write_all(b"{\"digest\":")?;
        serde_json::to_writer(&mut writer, &digest)?;
        writer.write_all(b",\"state\":")?;
        serde_json::to_writer(&mut writer, state)?;
        writer.write_all(b",\"segmented\":")?;
        serde_json::to_writer(&mut writer, head)?;
        writer.write_all(b"}")?;
        fault("head_before_flush")?;
        writer.flush()?;
    }
    file.sync_all()?;
    fault("head_after_sync")?;
    fault("head_before_rename")?;
    // The activation boundary is the rename, not preparation of its temporary
    // file. A signal during serialization/flush/fsync still cancels safely.
    cancellation(cancelled)?;
    fs::rename(&temporary, root.join("journal.json"))?;
    fault("head_after_rename")?;
    sync_directory(root)?;
    fault("head_after_dirsync")?;
    Ok(())
}
fn cancellation(cancelled: &impl Fn() -> bool) -> Result<()> {
    if cancelled() {
        return Err(Error::Conflict("archive migration cancelled"));
    }
    Ok(())
}
impl Journal {
    /// Explicit, offline, single-owner migration. No network or signing work.
    /// The byte-identical v1 source is retained permanently. Partial preparation
    /// is never resumed implicitly; activation is the primary-file rename.
    pub fn migrate_v1_to_segmented(root: &Path, pool: Hash) -> Result<MigrationReport> {
        Self::migrate_v1_to_segmented_with_cancel(root, pool, || false)
    }
    pub fn migrate_v1_to_segmented_with_cancel(
        root: &Path,
        pool: Hash,
        cancelled: impl Fn() -> bool,
    ) -> Result<MigrationReport> {
        directory(root)?;
        // Existing owner.lock is mandatory; migration cannot invent authority.
        regular(&root.join("owner.lock"))?;
        let _lock = lock(root)?;
        cancellation(&cancelled)?;
        let (envelope, legacy_sha256, legacy_bytes) = read_source(root)?;
        if envelope.state.version != 1
            || envelope.segmented.is_some()
            || envelope.state.pool != pool
            || state_digest(&envelope.state)? != envelope.digest
        {
            return Err(Error::Conflict("migration requires valid v1 journal/pool"));
        }
        envelope.state.validate_job_identities()?;
        for name in [ARCHIVE_DIR, BACKUP] {
            match fs::symlink_metadata(root.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                _ => {
                    return Err(Error::Conflict(
                        "archive migration preparation already exists",
                    ))
                }
            }
        }
        cancellation(&cancelled)?;
        create_directory(&root.join(ARCHIVE_DIR))?;
        sync_directory(root)?;
        let mut backup = create(&root.join(BACKUP))?;
        let mut source = regular(&root.join("journal.json"))?;
        std::io::copy(&mut source, &mut backup)?;
        backup.sync_all()?;
        sync_directory(root)?;
        if fingerprint(regular(&root.join(BACKUP))?)? != (legacy_sha256, legacy_bytes) {
            return Err(Error::Conflict("legacy source changed during migration"));
        }
        fault("migration_after_backup")?;
        let mut state = envelope.state;
        let blocks = std::mem::take(&mut state.archive);
        state.version = 2;
        let head = Head {
            version: 2,
            pool,
            legacy: Legacy {
                sha256: legacy_sha256,
                bytes: legacy_bytes,
                state_digest: envelope.digest,
            },
            chunks: 0,
            blocks: 0,
            tail: None,
        };
        let head = append_chunks(root, &head, &blocks, &cancelled)?;
        cancellation(&cancelled)?;
        fault("migration_before_activation")?;
        let head_digest = digest(&state, &head)?;
        // The writer checks cancellation again after temporary-file fsync,
        // immediately before rename. After rename begins it never rolls back:
        // v2 may already be authoritative even if directory fsync fails.
        persist_head_with_cancel(root, &state, &head, &cancelled)?;
        Ok(MigrationReport {
            format_version: 2,
            legacy_sha256,
            legacy_bytes,
            legacy_state_digest: envelope.digest,
            archive_blocks: head.blocks,
            archive_chunks: head.chunks,
            head_digest,
        })
    }
    pub(super) fn append_segmented(&mut self, blocks: Vec<FinalizedBlock>) -> Result<()> {
        self.ensure_writable()?;
        let archive = self.segmented.as_mut().expect("segmented dispatch");
        let path = archive_directory(&self.directory)?;
        let mut suffix: Vec<FinalizedBlock> = Vec::new();
        let mut cached: Option<(usize, Chunk<Vec<FinalizedBlock>>)> = None;
        for block in blocks {
            if !block.finalized {
                return Err(Error::Conflict("unfinalized archive"));
            }
            if let Some(index) = archive.chunk_index(block.slot) {
                if cached.as_ref().map(|(i, _)| *i) != Some(index) {
                    // Release the previous payload before allocating another.
                    drop(cached.take());
                    let chunk = archive.read_indexed(&path, index)?;
                    cached = Some((index, chunk));
                }
                let old = &cached.as_ref().unwrap().1.blocks;
                if let Ok(index) = old.binary_search_by_key(&block.slot, |b| b.slot) {
                    if old[index] != block {
                        return Err(Error::Conflict("archive fork"));
                    }
                    continue;
                }
            }
            if let Ok(index) = suffix.binary_search_by_key(&block.slot, |b| b.slot) {
                if suffix[index] != block {
                    return Err(Error::Conflict("archive fork"));
                }
                continue;
            }
            if suffix
                .last()
                .map(ArchiveTail::from)
                .or(archive.tail)
                .is_some_and(|old| {
                    block.slot <= old.slot
                        || block.parent_slot != old.slot
                        || block.previous_blockhash != old.blockhash
                })
            {
                return Err(Error::Conflict("archive gap/fork"));
            }
            suffix.push(block);
        }
        if suffix.is_empty() {
            return Ok(());
        }
        // Reserve the small committed index before persistence. Full payloads
        // are released after the head fsync; none enters long-lived State.
        archive
            .references
            .try_reserve(suffix.len())
            .map_err(|_| Error::Conflict("archive capacity"))?;
        let tail = suffix.last().map(ArchiveTail::from);
        let committed = (|| {
            let (head, references) =
                append_chunks_indexed(&self.directory, &archive.head, &suffix, &|| false)?;
            persist_head(&self.directory, &self.state, &head)?;
            Ok((head, references))
        })();
        let (head, references) = match committed {
            Ok(committed) => committed,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        archive.references.extend(references);
        archive.tail = tail;
        archive.head = head;
        Ok(())
    }
}

#[cfg(test)]
thread_local! { static FAILURE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
fn fault(point: &'static str) -> Result<()> {
    #[cfg(test)]
    if FAILURE.with(|failure| failure.get() == Some(point)) {
        FAILURE.with(|failure| failure.set(None));
        return Err(Error::Io(std::io::Error::other(
            "synthetic archive persistence failure",
        )));
    }
    let _ = point;
    Ok(())
}
#[cfg(test)]
#[path = "journal_segmented_tests.rs"]
mod tests;
