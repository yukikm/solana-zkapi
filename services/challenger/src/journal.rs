//! Single-owner challenge storage, independent from financial ledger migrations.
//! Persist signed bytes before dispatch; a timeout never authorizes a replacement.
use crate::{sha, Error, Evidence, Hash, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use zkapi_indexer::Position;

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
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    pool: Hash,
    jobs: BTreeMap<String, Job>,
    checkpoint: Option<Checkpoint>,
}
impl State {
    /// The checksum protects bytes, not semantics. Apply the same invariants to
    /// recovered v1 files and new updates, including files from earlier writers.
    fn validate_job_identities(&self) -> Result<()> {
        let mut nullifiers = BTreeSet::new();
        let mut generations = BTreeSet::new();
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
            // N is permanently consumed; one tree sequence identifies one
            // Pending creation. Neither can be an alias for a second job.
            if !nullifiers.insert(identity.nullifier)
                || !generations.insert(identity.generation.tree_sequence)
            {
                return Err(Error::Conflict("Pending generation already journaled"));
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
}

pub struct Journal {
    directory: PathBuf,
    _lock: File,
    state: State,
    poisoned: bool,
}
impl Journal {
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
        if directory.join("journal.json").exists() {
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
            poisoned: false,
        })
    }
    pub fn open(directory: &Path, pool: Hash) -> Result<Self> {
        let lock = lock(directory)?;
        let envelope: Envelope =
            serde_json::from_slice(&fs::read(directory.join("journal.json"))?)?;
        if envelope.digest != sha(&serde_json::to_vec(&envelope.state)?)
            || envelope.state.version != 1
            || envelope.state.pool != pool
        {
            return Err(Error::Conflict("journal checksum/version/pool"));
        }
        envelope.state.validate_job_identities()?;
        Ok(Self {
            directory: directory.into(),
            _lock: lock,
            state: envelope.state,
            poisoned: false,
        })
    }
    pub fn jobs(&self) -> impl Iterator<Item = (&str, &Job)> {
        self.state.jobs.iter().map(|(id, j)| (id.as_str(), j))
    }
    pub fn checkpoint(&self) -> Option<&Checkpoint> {
        self.state.checkpoint.as_ref()
    }
    fn update<T>(&mut self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        if self.poisoned {
            return Err(Error::Conflict(
                "journal requires reopen after failed persistence",
            ));
        }
        let mut next = self.state.clone();
        let value = f(&mut next)?;
        next.validate_job_identities()?;
        if let Err(error) = persist(&self.directory, &next) {
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
                if !job.attempts.last().is_some_and(|attempt| {
                    matches!(attempt.outcome, Outcome::FinalizedFailure { .. })
                        && attempt.payload_digest == previous.digest
                        && attempt.buffer == previous.buffer
                }) {
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
            job.attempts.push(attempt);
            Ok(())
        })
    }
    /// Caller supplies an independently authenticated finalized status, not an
    /// account-missing/blockheight-expired inference. Unknown keeps exact bytes.
    pub fn resolve_finalized(&mut self, id: &str, signature: &str, outcome: Outcome) -> Result<()> {
        if outcome == Outcome::Unknown {
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
#[derive(Debug, PartialEq, Eq)]
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
fn persist(directory: &Path, state: &State) -> Result<()> {
    let envelope = Envelope {
        digest: sha(&serde_json::to_vec(state)?),
        state: state.clone(),
    };
    let temporary = directory.join("journal.next");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec(&envelope)?)?;
    file.sync_all()?;
    fs::rename(temporary, directory.join("journal.json"))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
