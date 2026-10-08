//! Single-owner challenge storage, independent from financial ledger migrations.
//! Persist signed bytes before dispatch; a timeout never authorizes a replacement.
use crate::{sha, Error, Evidence, Hash, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};
use zkapi_indexer::Position;

#[path = "journal_segmented.rs"]
mod segmented;
pub use segmented::ArchiveCheckpointState;
pub use segmented::MigrationReport;
pub use segmented::ReadOnlyArchive;

/// Small committed archive cursor. Full v2 block payloads stay on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveTail {
    pub slot: u64,
    pub blockhash: Hash,
    pub block_time: u64,
}
impl From<&zkapi_indexer::FinalizedBlock> for ArchiveTail {
    fn from(block: &zkapi_indexer::FinalizedBlock) -> Self {
        Self {
            slot: block.slot,
            blockhash: block.blockhash,
            block_time: block.block_time,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub position: Position,
    pub blockhash: Hash,
    pub tree_sequence: u64,
}
impl Checkpoint {
    /// Signatures identify transactions; they are not an ordering field. At a
    /// shared slot/transaction index they must agree even if their strings sort.
    fn follows(&self, previous: &Self) -> bool {
        let position = |p: &Position| {
            (
                p.slot,
                p.transaction_index,
                p.outer_instruction,
                p.invocation_index,
            )
        };
        position(&self.position) >= position(&previous.position)
            && self.tree_sequence >= previous.tree_sequence
            && (self.position.slot != previous.position.slot
                || (self.blockhash == previous.blockhash
                    && (self.position.transaction_index != previous.position.transaction_index
                        || self.position.signature == previous.position.signature)))
            && (position(&self.position) != position(&previous.position)
                || self.tree_sequence == previous.tree_sequence)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct JobIdentity {
    pub pool: Hash,
    pub note_id: u32,
    pub nullifier: Hash,
    pub deadline: u64,
    pub generation: Checkpoint,
}
impl JobIdentity {
    pub fn id(&self) -> String {
        hex::encode(sha(
            &serde_json::to_vec(self).expect("serializable identity")
        ))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub bytes: Vec<u8>,
    pub digest: Hash,
    pub buffer: Hash,
    pub checkpoint: Checkpoint,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Stage {
    Upload,
    Execute,
    CloseBuffer,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Outcome {
    /// Includes a signed transaction whose send has not yet been attempted: a
    /// crash can occur on either side of the send boundary.
    Unknown,
    FinalizedSuccess {
        slot: u64,
        blockhash: Hash,
    },
    FinalizedFailure {
        slot: u64,
        blockhash: Hash,
        error: String,
    },
    /// Not transaction finality: I04 established finalized old blockhash expiry
    /// and the exact same buffer's monotonic prefix/seal. Financial execute and
    /// close can never use this outcome.
    UploadReconciled {
        slot: u64,
        blockhash: Hash,
        finalized_height: u64,
        next_step_index: u32,
        account_bytes: Vec<u8>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub signature: String,
    pub signed_bytes: Vec<u8>,
    pub stage: Stage,
    pub payload_digest: Hash,
    pub buffer: Hash,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub identity: JobIdentity,
    pub evidence: Evidence,
    pub discovered_at: u64,
    pub payloads: Vec<Payload>,
    pub attempts: Vec<Attempt>,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_execute_send_at: Option<u64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    pool: Hash,
    jobs: BTreeMap<String, Job>,
    checkpoint: Option<Checkpoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    archive: Vec<zkapi_indexer::FinalizedBlock>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    transport: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    alerts: Vec<AlertEvent>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    absent_buffers: BTreeMap<String, FinalizedAbsence>,
    #[serde(default, skip_serializing_if = "is_zero")]
    proof_failure_total: u64,
}
fn is_zero(value: &u64) -> bool {
    *value == 0
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FinalizedAbsence {
    job_id: String,
    slot: u64,
    blockhash: Hash,
}
fn failure_precedes_observation(attempt: &Attempt, slot: u64, blockhash: Hash) -> bool {
    matches!(attempt.outcome, Outcome::FinalizedFailure { slot: failed_slot, blockhash: failed_hash, .. }
        if slot > failed_slot || slot == failed_slot && blockhash == failed_hash)
}
fn validate_transport(attempt: &Attempt, transport: &serde_json::Value) -> Result<()> {
    if transport["signature"].as_str() != Some(&attempt.signature)
        || transport["wireHex"].as_str() != Some(hex::encode(&attempt.signed_bytes).as_str())
        || transport["planDigest"].as_str() != Some(hex::encode(attempt.payload_digest).as_str())
        || transport["buffer"].as_str()
            != Some(zkapi_indexer::snapshot::key(attempt.buffer).as_str())
    {
        return Err(Error::Conflict("transport/attempt mismatch"));
    }
    let kind = transport["kind"]
        .as_str()
        .ok_or(Error::Conflict("transport kind"))?;
    if transport["plan"]["operation"] != "challenge_escape"
        || match attempt.stage {
            Stage::Execute => kind != "execute",
            Stage::Upload => !["create", "append", "seal"].contains(&kind),
            Stage::CloseBuffer => kind != "close",
        }
    {
        return Err(Error::Conflict("transport operation/stage"));
    }
    Ok(())
}
impl State {
    /// The checksum protects bytes, not semantics. Apply the same invariants to
    /// recovered v1 files and new updates, including files from earlier writers.
    fn validate_job_identities(&self) -> Result<()> {
        let mut nullifiers = BTreeSet::new();
        let mut generations = BTreeSet::new();
        let mut signatures = BTreeSet::new();
        if self.archive.iter().any(|b| !b.finalized)
            || self.archive.windows(2).any(|pair| {
                pair[1].slot <= pair[0].slot
                    || pair[1].parent_slot != pair[0].slot
                    || pair[1].previous_blockhash != pair[0].blockhash
            })
        {
            return Err(Error::Conflict("archive gap/fork"));
        }
        for (id, job) in &self.jobs {
            let identity = &job.identity;
            let evidence = &job.evidence;
            if id != &identity.id()
                || identity.pool != self.pool
                || evidence.pool != self.pool
                || identity.nullifier != evidence.nullifier
                || sha(&evidence.transcript) != evidence.transcript_digest
                || !self
                    .checkpoint
                    .as_ref()
                    .is_some_and(|cut| cut.follows(&identity.generation))
            {
                return Err(Error::Conflict("job evidence identity"));
            }
            if job
                .attempts
                .iter()
                .filter(|a| a.outcome == Outcome::Unknown)
                .count()
                > 1
                || job.complete
                    != job.attempts.iter().any(|a| {
                        a.stage == Stage::Execute
                            && matches!(a.outcome, Outcome::FinalizedSuccess { .. })
                    })
            {
                return Err(Error::Conflict("attempt completion state"));
            }
            for attempt in &job.attempts {
                if !signatures.insert(attempt.signature.clone())
                    || attempt.signature.is_empty()
                    || attempt.signed_bytes.is_empty()
                    || !job
                        .payloads
                        .iter()
                        .any(|p| p.digest == attempt.payload_digest && p.buffer == attempt.buffer)
                {
                    return Err(Error::Conflict("attempt identity/payload"));
                }
                if let Some(record) = self.transport.get(&attempt.signature) {
                    validate_transport(attempt, record)?;
                }
                if let Outcome::UploadReconciled {
                    finalized_height,
                    next_step_index,
                    account_bytes,
                    slot,
                    ..
                } = &attempt.outcome
                {
                    let record = self
                        .transport
                        .get(&attempt.signature)
                        .ok_or(Error::Conflict("reconciled upload transport"))?;
                    if attempt.stage != Stage::Upload
                        || account_bytes.is_empty()
                        || *next_step_index > 32
                        || record["lastValidBlockHeight"]
                            .as_u64()
                            .is_none_or(|height| *finalized_height <= height)
                        || record["stepIndex"]
                            .as_u64()
                            .is_none_or(|index| u64::from(*next_step_index) < index)
                        || record["plan"]["snapshotSlot"]
                            .as_u64()
                            .is_none_or(|snapshot| *slot < snapshot)
                    {
                        return Err(Error::Conflict("invalid upload reconciliation"));
                    }
                }
            }
            // N is permanently consumed; one tree sequence identifies one
            // Pending creation. Neither can be an alias for a second job.
            if !nullifiers.insert(identity.nullifier)
                || !generations.insert(identity.generation.tree_sequence)
            {
                return Err(Error::Conflict("Pending generation already journaled"));
            }
        }
        if self.transport.keys().any(|key| !signatures.contains(key)) {
            return Err(Error::Conflict("orphan transport record"));
        }
        for (buffer, absence) in &self.absent_buffers {
            let job = self
                .jobs
                .get(&absence.job_id)
                .ok_or(Error::Conflict("buffer absence job"))?;
            if !job.payloads.iter().any(|p| {
                hex::encode(p.buffer) == *buffer && absence.slot >= p.checkpoint.position.slot
            }) || !job
                .attempts
                .iter()
                .rev()
                .find(|a| hex::encode(a.buffer) == *buffer && a.stage != Stage::CloseBuffer)
                .is_some_and(|a| failure_precedes_observation(a, absence.slot, absence.blockhash))
            {
                return Err(Error::Conflict("buffer absence without definite failure"));
            }
        }
        for (i, event) in self.alerts.iter().enumerate() {
            if event.id != i as u64 + 1
                || event.pool != self.pool
                || !self.jobs.contains_key(&event.job_id)
                || i > 0 && self.alerts[i - 1].observed_at > event.observed_at
            {
                return Err(Error::Conflict("alert event identity"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    digest: Hash,
    state: State,
    // A missing field is the original v1 envelope. Explicit null is not a
    // legacy spelling and is rejected rather than silently downgrading v2.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "segmented::deserialize_head"
    )]
    segmented: Option<segmented::Head>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AlertEvent {
    pub id: u64,
    pub pool: Hash,
    pub job_id: String,
    pub severity: Alert,
    pub observed_at: u64,
    pub delivered: bool,
}
pub struct Journal {
    directory: PathBuf,
    _lock: File,
    state: State,
    segmented: Option<segmented::Archive>,
    poisoned: bool,
}
impl Journal {
    pub fn proof_failure_total(&self) -> u64 {
        self.state.proof_failure_total
    }
    pub fn record_proof_failure(&mut self) -> Result<()> {
        self.update(|s| {
            s.proof_failure_total = s
                .proof_failure_total
                .checked_add(1)
                .ok_or(Error::Conflict("proof failure counter overflow"))?;
            Ok(())
        })
    }
    pub fn record_execute_send(&mut self, id: &str, at: u64) -> Result<()> {
        self.update(|s| {
            let job = s.jobs.get_mut(id).ok_or(Error::Conflict("job absent"))?;
            if !job
                .attempts
                .iter()
                .any(|a| a.stage == Stage::Execute && a.outcome == Outcome::Unknown)
            {
                return Err(Error::Conflict("unknown execute required"));
            }
            if job.first_execute_send_at.is_none() {
                job.first_execute_send_at = Some(at.max(job.discovered_at));
            }
            Ok(())
        })
    }
    pub fn buffer_absence(&self, buffer: Hash) -> bool {
        self.state.absent_buffers.contains_key(&hex::encode(buffer))
    }
    pub fn record_buffer_absence(
        &mut self,
        id: &str,
        buffer: Hash,
        slot: u64,
        blockhash: Hash,
    ) -> Result<()> {
        self.update(|s| {
            let job = s.jobs.get(id).ok_or(Error::Conflict("job absent"))?;
            if job.complete
                || job.attempts.iter().any(|a| a.outcome == Outcome::Unknown)
                || !job
                    .attempts
                    .iter()
                    .rev()
                    .find(|a| a.buffer == buffer && a.stage != Stage::CloseBuffer)
                    .is_some_and(|a| failure_precedes_observation(a, slot, blockhash))
                || !job
                    .payloads
                    .iter()
                    .any(|p| p.buffer == buffer && slot >= p.checkpoint.position.slot)
            {
                return Err(Error::Conflict("absence requires definite failure"));
            }
            s.absent_buffers.insert(
                hex::encode(buffer),
                FinalizedAbsence {
                    job_id: id.into(),
                    slot,
                    blockhash,
                },
            );
            Ok(())
        })
    }
    pub fn alerts(&self) -> impl Iterator<Item = &AlertEvent> {
        self.state.alerts.iter()
    }
    pub fn enqueue_alerts(&mut self, now: u64) -> Result<usize> {
        // A no-op must not bypass a previous uncertain persistence failure.
        self.ensure_writable()?;
        let additions: Vec<_> = self
            .state
            .jobs
            .iter()
            .filter_map(|(id, job)| {
                let severity = alert(job, now);
                let previous = self.state.alerts.iter().rev().find(|a| &a.job_id == id);
                if previous.map_or(severity == Alert::None, |p| p.severity == severity) {
                    None
                } else {
                    Some((id.clone(), severity))
                }
            })
            .collect();
        // Avoid cloning, hashing and rewriting the complete archived history
        // when no job changed severity. Pending delivery remains independent.
        if additions.is_empty() {
            return Ok(0);
        }
        self.update(|s| {
            let added = additions.len();
            for (job_id, severity) in additions {
                let observed_at = s
                    .alerts
                    .last()
                    .map_or(now, |event| now.max(event.observed_at));
                s.alerts.push(AlertEvent {
                    id: s.alerts.len() as u64 + 1,
                    pool: s.pool,
                    job_id,
                    severity,
                    observed_at,
                    delivered: false,
                });
            }
            Ok(added)
        })
    }
    /// Local, private notification spool: content-addressed by pool/event id.
    /// A crash after rename but before ack rechecks the same bytes, never writes
    /// a second event. A configured collector can route these files externally.
    pub fn deliver_alerts(&mut self, directory: &Path) -> Result<usize> {
        fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let pending: Vec<_> = self
            .state
            .alerts
            .iter()
            .filter(|e| !e.delivered)
            .cloned()
            .collect();
        let mut delivered = 0;
        for event in pending {
            let path = directory.join(format!("{}-{}.json", hex::encode(event.pool), event.id));
            let bytes = serde_json::to_vec(&event)?;
            if path.exists() {
                if fs::read(&path)? != bytes {
                    return Err(Error::Conflict("alert sink collision"));
                }
            } else {
                let temporary = path.with_extension("next");
                let mut options = OpenOptions::new();
                options.create(true).truncate(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &path)?;
                File::open(directory)?.sync_all()?;
            }
            self.update(|s| {
                let stored = s
                    .alerts
                    .iter_mut()
                    .find(|e| e.id == event.id)
                    .ok_or(Error::Conflict("alert event absent"))?;
                stored.delivered = true;
                Ok(())
            })?;
            delivered += 1;
        }
        Ok(delivered)
    }
    pub fn archive_len(&self) -> u64 {
        self.segmented
            .as_ref()
            .map_or(self.state.archive.len() as u64, |archive| archive.len())
    }
    pub fn archive_is_empty(&self) -> bool {
        self.archive_len() == 0
    }
    pub fn archive_tail(&self) -> Option<ArchiveTail> {
        self.segmented.as_ref().map_or_else(
            || self.state.archive.last().map(ArchiveTail::from),
            |archive| archive.tail(),
        )
    }
    /// Visit all committed blocks in order. A callback may stop replay by
    /// returning an error. V2 revalidates one complete chunk before exposing
    /// its borrowed blocks; no whole-history payload Vec is materialized.
    pub fn replay_archive(
        &self,
        mut visit: impl FnMut(&zkapi_indexer::FinalizedBlock) -> Result<()>,
    ) -> Result<()> {
        if let Some(archive) = &self.segmented {
            return archive.replay(&self.directory, visit);
        }
        for block in &self.state.archive {
            visit(block)?;
        }
        Ok(())
    }
    /// Resume after an authenticated runtime checkpoint. The containing and
    /// subsequent chunks are still hashed before any block is delivered.
    pub fn replay_archive_after(
        &self,
        slot: u64,
        mut visit: impl FnMut(&zkapi_indexer::FinalizedBlock) -> Result<()>,
    ) -> Result<()> {
        if let Some(archive) = &self.segmented {
            return archive.replay_after(&self.directory, slot, visit);
        }
        for block in &self.state.archive {
            if block.slot > slot {
                visit(block)?;
            }
        }
        Ok(())
    }
    pub fn archive_block_time(&self, slot: u64) -> Result<Option<u64>> {
        if let Some(archive) = &self.segmented {
            return archive.block_time(&self.directory, slot);
        }
        Ok(self
            .state
            .archive
            .iter()
            .find(|block| block.slot == slot)
            .map(|block| block.block_time))
    }
    pub fn transport(&self, signature: &str) -> Option<&serde_json::Value> {
        self.state.transport.get(signature)
    }
    /// A caller first validates this block through Scanner. Keeping the complete
    /// finalized history permits buffer-generation replay after a process crash.
    pub fn append_archive(&mut self, block: zkapi_indexer::FinalizedBlock) -> Result<()> {
        self.append_archive_batch(vec![block])
    }
    /// Atomically append an already validated ordered prefix. A failed batch
    /// publishes none of its blocks; a caller must install its Scanner only
    /// after this durable commit. Existing v1 files keep their original format;
    /// explicitly migrated v2 files commit only new chunks and a small head.
    pub fn append_archive_batch(
        &mut self,
        blocks: Vec<zkapi_indexer::FinalizedBlock>,
    ) -> Result<()> {
        if self.segmented.is_some() {
            return self.append_segmented(blocks);
        }
        self.update(|s| {
            for block in blocks {
                if !block.finalized {
                    return Err(Error::Conflict("unfinalized archive"));
                }
                if let Some(old) = s.archive.iter().find(|b| b.slot == block.slot) {
                    if old != &block {
                        return Err(Error::Conflict("archive fork"));
                    }
                    continue;
                }
                if s.archive.last().is_some_and(|old| {
                    block.parent_slot != old.slot || block.previous_blockhash != old.blockhash
                }) {
                    return Err(Error::Conflict("archive gap/fork"));
                }
                s.archive.push(block);
            }
            Ok(())
        })
    }
    /// Persist I04's validated recovery record and exact signed bytes atomically.
    pub fn save_v0_attempt(
        &mut self,
        id: &str,
        attempt: Attempt,
        transport: serde_json::Value,
    ) -> Result<()> {
        validate_transport(&attempt, &transport)?;
        self.save_attempt(id, attempt, Some(transport))
    }
    /// Explicit initialization is separate from open, so a missing journal on
    /// recovery cannot silently become an empty queue.
    pub fn initialize(directory: &Path, pool: Hash) -> Result<Self> {
        fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let lock = lock(directory)?;
        if directory.join("journal.json").exists()
            || fs::symlink_metadata(directory.join("archive-v2")).is_ok()
            || fs::symlink_metadata(directory.join("legacy-v1.json")).is_ok()
        {
            return Err(Error::Conflict("journal exists"));
        }
        let state = State {
            version: 1,
            pool,
            ..Default::default()
        };
        persist(directory, &state)?;
        Ok(Self {
            directory: directory.into(),
            _lock: lock,
            state,
            segmented: None,
            poisoned: false,
        })
    }
    pub fn open(directory: &Path, pool: Hash) -> Result<Self> {
        Self::open_checkpointed(directory, pool, None).map(|(journal, _)| journal)
    }
    pub fn open_with_checkpoint(
        directory: &Path,
        pool: Hash,
        binding: Hash,
    ) -> Result<(Self, Option<ArchiveCheckpointState>)> {
        Self::open_checkpointed(directory, pool, Some(binding))
    }
    fn open_checkpointed(
        directory: &Path,
        pool: Hash,
        binding: Option<Hash>,
    ) -> Result<(Self, Option<ArchiveCheckpointState>)> {
        let lock = lock(directory)?;
        let (envelope, _, _) = segmented::read_source(directory)?;
        if envelope.state.pool != pool {
            return Err(Error::Conflict("journal checksum/version/pool"));
        }
        // Current jobs, signed attempts, transport and unknown outcomes always
        // come from the authoritative journal, never the optional replay cache.
        envelope.state.validate_job_identities()?;
        let mut restored = None;
        let archive = match (envelope.state.version, &envelope.segmented) {
            (1, None) if envelope.digest == state_digest(&envelope.state)? => None,
            (2, Some(head))
                if envelope.state.archive.is_empty()
                    && envelope.digest == segmented::digest(&envelope.state, head)? =>
            {
                let cached = binding.and_then(|binding| {
                    segmented::load_checkpoint(directory, pool, head.clone(), binding).ok()
                });
                match cached {
                    Some((archive, state)) => {
                        restored = Some(state);
                        Some(archive)
                    }
                    None => Some(segmented::load(directory, pool, head.clone())?),
                }
            }
            _ => return Err(Error::Conflict("journal checksum/version/pool")),
        };
        Ok((
            Self {
                directory: directory.into(),
                _lock: lock,
                state: envelope.state,
                segmented: archive,
                poisoned: false,
            },
            restored,
        ))
    }
    pub fn jobs(&self) -> impl Iterator<Item = (&str, &Job)> {
        self.state.jobs.iter().map(|(id, j)| (id.as_str(), j))
    }
    pub fn checkpoint(&self) -> Option<&Checkpoint> {
        self.state.checkpoint.as_ref()
    }
    fn ensure_writable(&self) -> Result<()> {
        if self.poisoned {
            return Err(Error::Conflict(
                "journal requires reopen after failed persistence",
            ));
        }
        Ok(())
    }
    fn update<T>(&mut self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        self.ensure_writable()?;
        let mut next = self.state.clone();
        let value = f(&mut next)?;
        next.validate_job_identities()?;
        let persisted = if let Some(archive) = &self.segmented {
            segmented::persist_head(&self.directory, &next, &archive.head)
        } else {
            persist(&self.directory, &next)
        };
        if let Err(error) = persisted {
            self.poisoned = true;
            return Err(error);
        }
        self.state = next;
        Ok(value)
    }
    /// Atomically checkpoint only after every discovered candidate has been
    /// enqueued. The cursor is private to this challenger and never marks outbox delivery.
    pub fn enqueue_cut(
        &mut self,
        checkpoint: Checkpoint,
        candidates: Vec<(JobIdentity, Evidence)>,
        now: u64,
    ) -> Result<()> {
        self.update(|s| {
            if let Some(old) = &s.checkpoint {
                if !checkpoint.follows(old) {
                    return Err(Error::Conflict("checkpoint rollback/fork"));
                }
            }
            for (identity, evidence) in candidates {
                let id = identity.id();
                if let Some(old) = s.jobs.get(&id) {
                    if old.identity != identity || old.evidence != evidence {
                        return Err(Error::Conflict("immutable job evidence"));
                    }
                } else {
                    s.jobs.insert(
                        id,
                        Job {
                            identity,
                            evidence,
                            discovered_at: now,
                            payloads: Vec::new(),
                            attempts: Vec::new(),
                            complete: false,
                            first_execute_send_at: None,
                        },
                    );
                }
            }
            s.checkpoint = Some(checkpoint);
            Ok(())
        })
    }
    /// Regeneration is allowed only after a definite finalized failure; old RP
    /// bytes are compared and retained even when the current tree has changed.
    pub fn save_payload(&mut self, id: &str, payload: Payload) -> Result<()> {
        self.update(|s| {
            let job = s.jobs.get_mut(id).ok_or(Error::Conflict("job absent"))?;
            if job.complete || job.attempts.iter().any(|a| a.outcome == Outcome::Unknown) {
                return Err(Error::Conflict("resolve old signature first"));
            }
            if !payload.checkpoint.follows(&job.identity.generation) {
                return Err(Error::Conflict(
                    "payload checkpoint predates or forks Pending",
                ));
            }
            if let Some(previous) = job.payloads.last() {
                if previous == &payload {
                    return Ok(());
                }
                if !job
                    .attempts
                    .iter()
                    .rev()
                    .find(|a| a.stage != Stage::CloseBuffer)
                    .is_some_and(|attempt| {
                        matches!(attempt.outcome, Outcome::FinalizedFailure { .. })
                            && attempt.payload_digest == previous.digest
                            && attempt.buffer == previous.buffer
                    })
                {
                    return Err(Error::Conflict("replacement needs finalized failure"));
                }
                if !payload.checkpoint.follows(&previous.checkpoint) {
                    return Err(Error::Conflict("stale checkpoint"));
                }
            }
            if sha(&payload.bytes) != payload.digest {
                return Err(Error::Conflict("payload digest"));
            }
            let command =
                zkapi_layout2::Command::decode(zkapi_layout2::Operation::Challenge, &payload.bytes)
                    .map_err(|_| Error::Conflict("challenge payload"))?;
            let request: zkapi_control::wire::SessionCreate =
                zkapi_control::wire::strict_parse(&job.evidence.transcript)
                    .map_err(|_| Error::Conflict("stored transcript"))?;
            let auth = command.authorization.ok_or(Error::Conflict("RP missing"))?;
            if command.note_id != Some(job.identity.note_id)
                || (0..12).any(|i| auth.public.get(i) != request.public_inputs[i].as_bytes())
                || *auth.proof
                    != request
                        .proof
                        .bytes()
                        .map_err(|_| Error::Conflict("RP encoding"))?
            {
                return Err(Error::Conflict("historical RP changed"));
            }
            job.payloads.push(payload);
            Ok(())
        })
    }
    /// Exact signed bytes must be generated/verified by the I04 v0 transport.
    /// This boundary stores them before the caller obtains permission to send.
    pub fn save_signed_attempt(&mut self, id: &str, attempt: Attempt) -> Result<()> {
        self.save_attempt(id, attempt, None)
    }
    fn save_attempt(
        &mut self,
        id: &str,
        attempt: Attempt,
        transport: Option<serde_json::Value>,
    ) -> Result<()> {
        self.update(|s| {
            let job = s.jobs.get_mut(id).ok_or(Error::Conflict("job absent"))?;
            if job.complete
                || attempt.outcome != Outcome::Unknown
                || attempt.signature.is_empty()
                || attempt.signed_bytes.is_empty()
            {
                return Err(Error::Conflict("invalid new signed attempt"));
            }
            if let Some(old) = job
                .attempts
                .iter()
                .find(|a| a.signature == attempt.signature)
            {
                return if old == &attempt {
                    Ok(())
                } else {
                    Err(Error::Conflict("signature bytes changed"))
                };
            }
            if job.attempts.iter().any(|a| a.outcome == Outcome::Unknown) {
                return Err(Error::Conflict("resolve old signature first"));
            }
            let payload = job
                .payloads
                .last()
                .ok_or(Error::Conflict("payload absent"))?;
            if payload.digest != attempt.payload_digest || payload.buffer != attempt.buffer {
                return Err(Error::Conflict("attempt payload/buffer"));
            }
            if let Some(value) = transport {
                if let Some(old) = s.transport.get(&attempt.signature) {
                    if old != &value {
                        return Err(Error::Conflict("immutable transport"));
                    }
                }
                s.transport.insert(attempt.signature.clone(), value);
            }
            job.attempts.push(attempt);
            Ok(())
        })
    }
    /// One durable commit replaces an expired upload's Unknown state with the
    /// I04 account reconciliation and, when needed, its refreshed signed bytes.
    /// Callers cannot use this path for execute/close or a missing buffer.
    pub fn reconcile_upload(
        &mut self,
        id: &str,
        signature: &str,
        outcome: Outcome,
        replacement: Option<(Attempt, serde_json::Value)>,
    ) -> Result<()> {
        if !matches!(outcome, Outcome::UploadReconciled { .. }) {
            return Err(Error::Conflict("upload reconciliation required"));
        }
        self.update(|s| {
            let job = s.jobs.get_mut(id).ok_or(Error::Conflict("job absent"))?;
            if job.complete {
                return Err(Error::Conflict("job complete"));
            }
            let old = job
                .attempts
                .iter_mut()
                .find(|a| a.signature == signature)
                .ok_or(Error::Conflict("signature absent"))?;
            if old.stage != Stage::Upload || old.outcome != Outcome::Unknown {
                return Err(Error::Conflict("only unknown upload may reconcile"));
            }
            let digest = old.payload_digest;
            let buffer = old.buffer;
            old.outcome = outcome;
            if let Some((attempt, record)) = replacement {
                validate_transport(&attempt, &record)?;
                if attempt.stage != Stage::Upload
                    || attempt.outcome != Outcome::Unknown
                    || attempt.payload_digest != digest
                    || attempt.buffer != buffer
                    || job
                        .attempts
                        .iter()
                        .any(|a| a.signature == attempt.signature || a.outcome == Outcome::Unknown)
                    || s.transport.contains_key(&attempt.signature)
                {
                    return Err(Error::Conflict("refreshed upload identity"));
                }
                s.transport.insert(attempt.signature.clone(), record);
                job.attempts.push(attempt);
            }
            Ok(())
        })
    }
    /// Caller supplies an independently authenticated finalized status, not an
    /// account-missing/blockheight-expired inference. Unknown keeps exact bytes.
    pub fn resolve_finalized(&mut self, id: &str, signature: &str, outcome: Outcome) -> Result<()> {
        if !matches!(
            outcome,
            Outcome::FinalizedSuccess { .. } | Outcome::FinalizedFailure { .. }
        ) {
            return Err(Error::Conflict("finalized outcome required"));
        }
        self.update(|s| {
            let job = s.jobs.get_mut(id).ok_or(Error::Conflict("job absent"))?;
            let attempt = job
                .attempts
                .iter_mut()
                .find(|a| a.signature == signature)
                .ok_or(Error::Conflict("signature absent"))?;
            if attempt.outcome != Outcome::Unknown && attempt.outcome != outcome {
                return Err(Error::Conflict("finalized status changed"));
            }
            attempt.outcome = outcome;
            if attempt.stage == Stage::Execute
                && matches!(attempt.outcome, Outcome::FinalizedSuccess { .. })
            {
                job.complete = true;
            }
            Ok(())
        })
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Alert {
    Emergency,
    Page,
    Warning,
    None,
}
pub fn alert(job: &Job, now: u64) -> Alert {
    if job.complete {
        Alert::None
    } else if job.identity.deadline.saturating_sub(now) <= 3600 {
        Alert::Emergency
    } else if now.saturating_sub(job.discovered_at) >= 300 {
        Alert::Page
    } else if now.saturating_sub(job.discovered_at) >= 60 {
        Alert::Warning
    } else {
        Alert::None
    }
}
fn lock(directory: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("owner.lock"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.try_lock_exclusive()
        .map_err(|_| Error::Conflict("another challenger owns the journal"))?;
    Ok(file)
}
const JOURNAL_IO_BUFFER_BYTES: usize = 128 * 1024;

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn state_digest(state: &State) -> Result<Hash> {
    let mut writer = BufWriter::with_capacity(JOURNAL_IO_BUFFER_BYTES, HashWriter(Sha256::new()));
    serde_json::to_writer(&mut writer, state)?;
    // into_inner must flush the final partial buffer before digest finalization.
    let writer = writer.into_inner().map_err(|error| error.into_error())?;
    Ok(writer.0.finalize().into())
}
fn persist(directory: &Path, state: &State) -> Result<()> {
    // Two bounded serializer passes preserve the exact v1 checksum/envelope
    // bytes without retaining a second full-size encoded archive in memory.
    let digest = state_digest(state)?;
    let temporary = directory.join("journal.next");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    {
        let mut writer = BufWriter::with_capacity(JOURNAL_IO_BUFFER_BYTES, &mut file);
        writer.write_all(b"{\"digest\":")?;
        serde_json::to_writer(&mut writer, &digest)?;
        writer.write_all(b",\"state\":")?;
        serde_json::to_writer(&mut writer, state)?;
        writer.write_all(b"}")?;
        // Never sync/rename before both serde and the final buffered write pass.
        writer.flush()?;
    }
    file.sync_all()?;
    fs::rename(temporary, directory.join("journal.json"))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
