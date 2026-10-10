//! Native scan/prove/broadcast orchestration. All terminal transaction outcomes
//! come from the existing I04 transport's exact-message finalized receipts.
use crate::{
    bad,
    journal::{Attempt, Checkpoint, Journal, Outcome, Payload, Stage},
    read_model::ReadRepository,
    scan::{FinalizedView, Scanner},
    sha,
    shutdown::{interruptible, Shutdown, Signals},
    Error, Hash, PreparedChallenge, Result, Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zkapi_indexer::{
    runtime::{ArchiveRpc, Config as IndexConfig},
    Position,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub manifest: PathBuf,
    pub manifest_sha256: String,
    /// A devnet manifest alone never switches the local default trust profile.
    #[serde(default)]
    pub devnet: Option<zkapi_control::config::DevnetConfig>,
    pub rpc_url: String,
    pub database_dsn_file: PathBuf,
    pub start_slot: u64,
    pub journal_directory: PathBuf,
    pub tree_pk: PathBuf,
    pub node: PathBuf,
    pub transport_bridge: PathBuf,
    pub transport_bridge_sha256: String,
    pub fee_key_file: PathBuf,
    pub payer: String,
    pub poll_seconds: u64,
    #[serde(default)]
    pub alert_sink_directory: Option<PathBuf>,
    #[serde(default)]
    pub priority_fee: Option<PriorityFeePolicy>,
    /// Read-only replay commit frequency; never changes the v1 archive format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_batch: Option<ArchiveBatchPolicy>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveBatchPolicy {
    pub max_blocks: usize,
    pub max_bytes: usize,
    /// Finalized read scheduling only. Omission preserves four in flight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc_concurrency: Option<usize>,
}
impl Default for ArchiveBatchPolicy {
    fn default() -> Self {
        Self {
            max_blocks: 64,
            max_bytes: 8 * 1024 * 1024,
            rpc_concurrency: None,
        }
    }
}
impl ArchiveBatchPolicy {
    pub fn validate(&self) -> Result<()> {
        if self.max_blocks == 0
            || self.max_blocks > 256
            || self.max_bytes == 0
            || self.max_bytes > 32 * 1024 * 1024
            || !(1..=16).contains(&self.rpc_concurrency.unwrap_or(4))
        {
            return Err(bad("archive batch policy"));
        }
        Ok(())
    }
}
/// Integer micro-lamports per CU; capped at one lamport/CU. A rate is selected
/// only for a new payload plan and remains immutable throughout its upload.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PriorityFeePolicy {
    pub base: u64,
    pub warning: u64,
    pub page: u64,
    pub emergency: u64,
    pub cap: u64,
}
impl PriorityFeePolicy {
    pub fn validate(&self) -> Result<()> {
        if self.base == 0
            || self.base > self.warning
            || self.warning > self.page
            || self.page > self.emergency
            || self.emergency > self.cap
            || self.cap > 1_000_000
        {
            return Err(bad("priority fee policy"));
        }
        Ok(())
    }
    pub fn price(&self, discovered_at: u64, observed_at: u64, deadline: u64) -> u64 {
        if deadline.saturating_sub(observed_at) <= 3600 {
            self.emergency
        } else if observed_at.saturating_sub(discovered_at) >= 300 {
            self.page
        } else if observed_at.saturating_sub(discovered_at) >= 60 {
            self.warning
        } else {
            self.base
        }
    }
}
fn hash(s: &str) -> Result<Hash> {
    hex::decode(s)
        .map_err(|_| bad("hash"))?
        .try_into()
        .map_err(|_| bad("hash length"))
}
fn key(s: &str) -> Result<Hash> {
    zkapi_control::wire::pubkey(s).map_err(|_| bad("public key"))
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl Config {
    pub fn trust(&self) -> Result<Trust> {
        let manifest = serde_json::from_slice(&std::fs::read(&self.manifest)?)?;
        let trust = if let Some(devnet) = &self.devnet {
            Trust::from_pinned_devnet_manifest(&manifest, hash(&self.manifest_sha256)?, devnet)?
        } else {
            Trust::from_pinned_manifest(&manifest, hash(&self.manifest_sha256)?)?
        };
        let url = reqwest::Url::parse(&self.rpc_url).map_err(|_| bad("RPC URL"))?;
        if self.devnet.is_some()
            && (url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some())
        {
            return Err(bad("devnet RPC transport"));
        }
        if url.scheme() != "https"
            && !(url.scheme() == "http"
                && url.host_str().is_some_and(|s| {
                    s.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
                }))
        {
            return Err(bad("RPC transport"));
        }
        if self.poll_seconds == 0
            || self.poll_seconds > 30
            || !self.node.is_absolute()
            || !self.transport_bridge.is_absolute()
        {
            return Err(bad("runtime config"));
        }
        key(&self.payer)?;
        if let Some(policy) = &self.priority_fee {
            policy.validate()?;
        }
        self.archive_batch.unwrap_or_default().validate()?;
        Ok(trust)
    }
    fn index(&self, trust: &Trust) -> IndexConfig {
        IndexConfig {
            rpc_url: self.rpc_url.clone(),
            program_id: trust.pool.program_id.clone(),
            pool: trust.pool.pool.clone(),
            genesis_hash: trust.pool.genesis_hash.clone(),
            circuit_profile_hash: trust.pool.circuit_profile_hash.clone(),
            start_slot: self.start_slot,
            listen: String::new(),
            public_origin: String::new(),
            snapshots_directory: self.journal_directory.clone(),
        }
    }
}
/// The Node bridge's distribution directory must be immutable to other users.
/// Its configured hash is independent of all RPC inputs. It reads fee material
/// from a mode-0600 file only for prepare; recovery needs no signing capability.
pub async fn bridge(config: &Config, input: Value) -> Result<Value> {
    bridge_supervised(config, input, None).await
}
async fn bridge_supervised(
    config: &Config,
    input: Value,
    shutdown: Option<&Shutdown>,
) -> Result<Value> {
    if let Some(shutdown) = shutdown {
        shutdown.checkpoint()?;
    }
    if sha(&std::fs::read(&config.transport_bridge)?) != hash(&config.transport_bridge_sha256)? {
        return Err(bad("transport bridge pin"));
    }
    let input = serde_json::to_vec(&input)?;
    let mut child = tokio::process::Command::new(&config.node)
        .arg(&config.transport_bridge)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().ok_or(bad("bridge stdin"))?;
    let stdout = child.stdout.take().ok_or(bad("bridge stdout"))?;
    let exchange = async {
        let write = async {
            stdin.write_all(&input).await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let read = async {
            let mut bytes = Vec::new();
            stdout.take(2_000_001).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (_, bytes, status) = tokio::try_join!(write, read, child.wait())?;
        Ok::<_, Error>((status, bytes))
    };
    let result = match interruptible(
        shutdown,
        tokio::time::timeout(Duration::from_secs(45), exchange),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(bad("transport bridge timeout")),
        Err(error) => Err(error),
    };
    let (status, bytes) = match result {
        Ok(value) => value,
        Err(error) => {
            // A recover bridge can only send already durable exact bytes. An
            // interrupted response leaves that attempt Unknown for restart.
            // Prepare/refresh have no send capability. Never drop an unreaped
            // child on graceful stop, timeout, or pipe error.
            child.start_kill().map_err(|_| Error::BridgeCleanup)?;
            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .map_err(|_| Error::BridgeCleanup)?
                .map_err(|_| Error::BridgeCleanup)?;
            return Err(error);
        }
    };
    if !status.success() || bytes.len() > 2_000_000 {
        return Err(bad("transport bridge failed"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub struct Runtime {
    config: Config,
    pub journal: Journal,
    scanner: Scanner,
    trust: Trust,
    rpc: ArchiveRpc,
    shutdown: Option<Shutdown>,
    checkpoint_binding: Hash,
    checkpoint_saved: Option<Instant>,
}
impl Runtime {
    pub fn open(config: Config, initialize: bool) -> Result<Self> {
        Self::open_with_shutdown(config, initialize, None)
    }
    pub(crate) fn open_with_shutdown(
        config: Config,
        initialize: bool,
        shutdown: Option<Shutdown>,
    ) -> Result<Self> {
        if let Some(shutdown) = &shutdown {
            shutdown.checkpoint()?;
        }
        let trust = config.trust()?;
        // Transport credentials do not change the authenticated replay domain.
        let checkpoint_binding = sha(&serde_json::to_vec(&json!({
            "domain": "zkapi-challenger-replay-v1",
            "program": trust.pool.program_id, "pool": trust.pool.pool,
            "genesis": trust.pool.genesis_hash, "profile": trust.pool.circuit_profile_hash,
            "start_slot": config.start_slot, "manifest": hex::encode(trust.manifest_hash),
        }))?);
        let (mut journal, cached) = if initialize {
            (
                Journal::initialize(&config.journal_directory, trust.pool())?,
                None,
            )
        } else {
            Journal::open_with_checkpoint(
                &config.journal_directory,
                trust.pool(),
                checkpoint_binding,
            )?
        };
        let restored = cached.as_ref().and_then(|cache| {
            Scanner::restore_checkpoint(trust.clone(), &cache.bytes, cache.sha256, cache.tail?).ok()
        });
        // Metadata reuse is allowed only with a complete valid runtime payload.
        // A damaged/incompatible runtime payload takes the original cold path.
        if cached.is_some() && restored.is_none() {
            drop(journal);
            journal = Journal::open(&config.journal_directory, trust.pool())?;
        }
        let restored_slot = restored
            .as_ref()
            .and_then(|scan| scan.replay_state().ok())
            .map(|s| s.slot);
        let mut scanner = restored.unwrap_or_else(|| Scanner::new(trust.clone()));
        let mut replay = |block: &zkapi_indexer::FinalizedBlock| {
            if let Some(shutdown) = &shutdown {
                shutdown.checkpoint()?;
            }
            scanner.apply_finalized(block)
        };
        if let Some(slot) = restored_slot {
            journal.replay_archive_after(slot, &mut replay)?;
        } else {
            journal.replay_archive(&mut replay)?;
        }
        // A v1 queue with a checkpoint but no archive must explicitly import its
        // finalized history, never silently continue from an empty scanner.
        if journal.checkpoint().is_some() && journal.archive_is_empty() {
            return Err(bad("legacy journal requires archive import"));
        }
        let rpc = ArchiveRpc::new(config.rpc_url.clone()).map_err(|_| bad("RPC config"))?;
        let mut runtime = Self {
            config,
            journal,
            scanner,
            trust,
            rpc,
            shutdown,
            checkpoint_binding,
            checkpoint_saved: None,
        };
        // A valid durable prefix is useful even when the next RPC is unavailable.
        // It remains a candidate: restoring it never restores readiness.
        runtime.save_replay_checkpoint();
        Ok(runtime)
    }
    fn save_replay_checkpoint(&mut self) {
        if self
            .checkpoint_saved
            .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
        {
            return;
        }
        let Some(anchor) = self.journal.archive_tail() else {
            return;
        };
        self.checkpoint_saved = Some(Instant::now());
        let result = (|| -> Result<()> {
            let state = self.scanner.replay_state()?;
            if (state.slot, state.blockhash) != (anchor.slot, anchor.blockhash) {
                return Err(bad("scanner checkpoint archive anchor"));
            }
            self.journal.save_checkpoint(
                self.checkpoint_binding,
                &self.scanner.checkpoint_bytes()?,
                anchor,
            )?;
            Ok(())
        })();
        if result.is_err() {
            // Cache failure cannot change durable jobs, cause a send, or assert readiness.
            eprintln!("challenger replay checkpoint unavailable");
        }
    }
    fn checkpoint_stop(&self) -> Result<()> {
        self.shutdown.as_ref().map_or(Ok(()), Shutdown::checkpoint)
    }
    async fn rpc_call(&self, method: &str, params: Value) -> Result<Value> {
        interruptible(self.shutdown.as_ref(), self.rpc.call(method, params))
            .await?
            .map_err(|_| bad("RPC unavailable"))
    }
    async fn bridge(&self, input: Value) -> Result<Value> {
        bridge_supervised(&self.config, input, self.shutdown.as_ref()).await
    }
    /// Every restart restores authenticated history and then authenticates the current
    /// genesis, block anchor, PoolConfig, Note, Pending and tree account cut.
    pub async fn scan(&mut self) -> Result<FinalizedView> {
        if self.rpc_call("getGenesisHash", json!([])).await?.as_str()
            != Some(&self.trust.pool.genesis_hash)
        {
            return Err(bad("RPC genesis mismatch"));
        }
        let tip = self
            .rpc_call("getSlot", json!([{"commitment":"finalized"}]))
            .await?
            .as_u64()
            .ok_or(bad("RPC slot"))?;
        self.catch_up_to(tip).await?;
        let cfg = self.config.index(&self.trust);
        let cut = interruptible(
            self.shutdown.as_ref(),
            self.rpc.capture_chain(&cfg, &self.scanner.replay_state()?),
        )
        .await?
        .map_err(|_| bad("RPC account capture"))?;
        // Preserve every new block and Pending generation before reconciling
        // the captured bank. An inventory changed by replay fails closed until
        // the next complete capture; it never discards durable history.
        self.catch_up_to(cut.slot()).await?;
        let accounts = interruptible(
            self.shutdown.as_ref(),
            self.rpc
                .observe_cut(&cfg, &self.scanner.replay_state()?, &cut),
        )
        .await?
        .map_err(|_| bad("RPC account cut"))?;
        let pool = cut
            .account(&self.trust.pool())
            .map_err(|_| bad("RPC captured PoolConfig"))?;
        self.scanner.reconcile(&accounts, &pool)
    }
    async fn catch_up_to(&mut self, tip: u64) -> Result<()> {
        let batch = self.config.archive_batch.unwrap_or_default();
        let tail = self.journal.archive_tail();
        let mut next = tail.map_or(self.config.start_slot, |b| b.slot.saturating_add(1));
        if tail.is_some_and(|b| tip < b.slot) {
            return Err(bad("RPC rollback"));
        }
        while next <= tip {
            let end = next.saturating_add(999).min(tip);
            let slots = self
                .rpc_call("getBlocks", json!([next,end,{"commitment":"finalized"}]))
                .await?;
            let mut pending = Vec::new();
            let mut pending_bytes = 0usize;
            let mut checked = self.scanner.clone();
            let result: Result<()> = async {
                let mut previous = None;
                let concurrency = batch.rpc_concurrency.unwrap_or(4);
                for window in slots
                    .as_array()
                    .ok_or(bad("RPC block range"))?
                    .chunks(concurrency)
                {
                    let mut ordered = Vec::with_capacity(window.len());
                    for slot in window {
                        let slot = slot.as_u64().ok_or(bad("RPC slot"))?;
                        if slot < next || slot > end || previous.is_some_and(|p| slot <= p) {
                            return Err(bad("RPC unordered blocks"));
                        }
                        ordered.push(slot);
                        previous = Some(slot);
                    }
                    let values = interruptible(
                        self.shutdown.as_ref(),
                        self.rpc
                            .finalized_block_window_bounded(&ordered, concurrency),
                    )
                    .await?
                    .map_err(|_| bad("RPC archive read window"))?;
                    for (slot, value) in ordered.into_iter().zip(values) {
                        self.checkpoint_stop()?;
                        let value = value.map_err(|_| bad("RPC archive unavailable"))?;
                        let block = zkapi_indexer::rpc::decode_finalized_block(slot, &value)
                            .map_err(|_| bad("RPC archive encoding"))?;
                        let bytes = serde_json::to_vec(&block)?.len();
                        if pending_bytes.saturating_add(bytes) > batch.max_bytes {
                            self.commit_archive_prefix(&mut pending, &checked)?;
                            pending_bytes = 0;
                        }
                        // Stage directly: cloning a Scanner also copies its
                        // complete accepted-block digest history. The durable
                        // Scanner and successful pending blocks can reconstruct
                        // this candidate if a later block latches it closed.
                        checked.apply_finalized(&block)?;
                        pending.push(block);
                        pending_bytes = pending_bytes.saturating_add(bytes);
                        // A single oversized block is committed alone: batching
                        // must not invent an archive size rejection/truncation.
                        if pending.len() >= batch.max_blocks || pending_bytes >= batch.max_bytes {
                            self.commit_archive_prefix(&mut pending, &checked)?;
                            pending_bytes = 0;
                        }
                    }
                }
                Ok(())
            }
            .await;
            if result.is_err() {
                // apply_finalized can latch the staged Scanner closed. Never
                // flush that object: rebuild only the successful suffix from
                // the last durable Scanner. Failed blocks are never pending.
                // A failed journal commit remains poisoned and is not retried.
                checked = self.scanner.clone();
                for block in &pending {
                    checked.apply_finalized(block)?;
                }
            }
            // Fetch/decode/replay errors retain the same successful durable
            // prefix as before batching. A crash re-fetches the uncommitted
            // read-only suffix; no view, proof or send observes that suffix.
            self.commit_archive_prefix(&mut pending, &checked)?;
            result?;
            next = end.checked_add(1).ok_or(bad("slot overflow"))?;
        }
        let expected = self.scanner.replay_state()?;
        if expected.slot != tip {
            return Err(bad("RPC finalized tail missing"));
        }
        Ok(())
    }
    fn commit_archive_prefix(
        &mut self,
        blocks: &mut Vec<zkapi_indexer::FinalizedBlock>,
        checked: &Scanner,
    ) -> Result<()> {
        if !blocks.is_empty() {
            self.journal.append_archive_batch(std::mem::take(blocks))?;
            self.scanner = checked.clone();
            // Long catch-up can span many polls; save at most once per minute,
            // and only after the archive prefix itself is durable.
            self.save_replay_checkpoint();
        }
        Ok(())
    }
    pub fn publish_health(&self, ready: bool, observed_at: u64) -> Result<()> {
        use std::io::Write;
        let summary = metrics(&self.journal, observed_at);
        let minimum_pending_deadline = self
            .journal
            .jobs()
            .filter(|(_, j)| !j.complete)
            .map(|(_, j)| j.identity.deadline)
            .min();
        let health = json!({"schema":1,"pool":self.trust.pool.pool,"observed_at":observed_at,"ready":ready,"oldest_detection_to_send_seconds":summary.oldest_detection_to_send_seconds,"minimum_pending_deadline":minimum_pending_deadline,"proof_failure_total":summary.proof_failure_total,"root_conflict_reproves_total":summary.root_conflict_reproves_total,"metrics":summary});
        let temporary = self.config.journal_directory.join("health.next");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&health)?)?;
        file.sync_all()?;
        std::fs::rename(
            &temporary,
            self.config.journal_directory.join("health.json"),
        )?;
        std::fs::File::open(&self.config.journal_directory)?.sync_all()?;
        Ok(())
    }
    pub fn emit_alerts(&mut self, at: u64) -> Result<()> {
        self.journal.enqueue_alerts(at)?;
        if let Some(directory) = &self.config.alert_sink_directory {
            self.journal.deliver_alerts(directory)?;
        }
        Ok(())
    }
    pub fn checkpoint(&self, view: &FinalizedView) -> Checkpoint {
        Checkpoint {
            position: Position {
                slot: view.slot(),
                transaction_index: u32::MAX,
                signature: "finalized-block-cut".into(),
                outer_instruction: u32::MAX,
                invocation_index: u32::MAX,
            },
            blockhash: view.blockhash(),
            tree_sequence: view.state.sequence,
        }
    }
    pub async fn discover(
        &mut self,
        view: &FinalizedView,
        repository: &mut ReadRepository,
    ) -> Result<()> {
        let mut candidates = Vec::new();
        for (id, nullifier) in view.pending() {
            self.checkpoint_stop()?;
            if let Some(evidence) =
                interruptible(self.shutdown.as_ref(), repository.auth(nullifier)).await??
            {
                let pending = &view.state.pending[&id];
                let generation = view
                    .generations
                    .get(&id)
                    .ok_or(bad("Pending generation"))?
                    .clone();
                candidates.push((
                    crate::journal::JobIdentity {
                        pool: self.trust.pool(),
                        note_id: id,
                        nullifier,
                        deadline: pending.deadline,
                        generation,
                    },
                    evidence,
                ));
            }
        }
        self.journal
            .enqueue_cut(self.checkpoint(view), candidates, now())
    }
    fn plan(&self, job: &crate::journal::Job, payload: &Payload) -> Result<Value> {
        let block_time = self
            .journal
            .archive_block_time(payload.checkpoint.position.slot)?
            .ok_or(bad("payload clock absent"))?;
        let nonce = sha(&[job.identity.id().as_bytes(), &payload.digest].concat());
        let fee = self.config.priority_fee.as_ref().map_or(0, |policy| {
            policy.price(job.discovered_at, block_time, job.identity.deadline)
        });
        for attempt in job
            .attempts
            .iter()
            .filter(|a| a.payload_digest == payload.digest)
        {
            let record = self
                .journal
                .transport(&attempt.signature)
                .ok_or(bad("immutable fee record"))?;
            if record["plan"]["priorityFeeMicroLamports"]
                .as_str()
                .unwrap_or("0")
                != fee.to_string()
            {
                return Err(bad("fee schedule changed for existing plan"));
            }
        }
        Ok(
            json!({"programId":self.trust.pool.program_id,"pool":self.trust.pool.pool,"mint":self.trust.pool.mint,"payer":self.config.payer,"noteId":job.identity.note_id,"payloadHex":hex::encode(&payload.bytes),"nonceHex":hex::encode(nonce),"expires":block_time.saturating_add(3600).min(job.identity.deadline).to_string(),"slot":payload.checkpoint.position.slot,"sequence":payload.checkpoint.tree_sequence.to_string(),"priorityFeeMicroLamports":fee.to_string()}),
        )
    }
    pub async fn prove(&mut self, view: &FinalizedView) -> Result<usize> {
        let mut jobs: Vec<_> = self
            .journal
            .jobs()
            .map(|(id, j)| (id.to_owned(), j.clone()))
            .collect();
        jobs.sort_by_key(|(_, job)| (job.identity.deadline, job.discovered_at));
        let mut count = 0;
        for (id, job) in jobs {
            self.checkpoint_stop()?;
            if job.complete || job.attempts.iter().any(|a| a.outcome == Outcome::Unknown) {
                continue;
            }
            if let Some(current) = job.payloads.last() {
                let failure =
                    job.attempts.iter().rev().find(|a| {
                        a.payload_digest == current.digest && a.stage != Stage::CloseBuffer
                    });
                let Some(failure) = failure else {
                    continue;
                };
                let Outcome::FinalizedFailure { error, .. } = &failure.outcome else {
                    continue;
                };
                if failure.stage != Stage::Upload
                    && error != "stale_proof"
                    && error != "buffer_rejected"
                {
                    continue;
                }
                if !self.cleanup_buffer(&id, &job).await? {
                    continue;
                }
            }
            if view.now >= job.identity.deadline
                || view.generations.get(&job.identity.note_id) != Some(&job.identity.generation)
            {
                continue;
            }
            self.checkpoint_stop()?;
            let pk = self
                .trust
                .load_tree_key(&std::fs::read(&self.config.tree_pk)?)?;
            let prepared = PreparedChallenge::from_finalized(
                view,
                job.identity.note_id,
                job.evidence.clone(),
            )?;
            if prepared.job != job.identity {
                return Err(bad("Pending generation changed"));
            }
            let bytes = match prepared.prove(&self.trust, &pk) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.journal.record_proof_failure()?;
                    return Err(error);
                }
            };
            let mut payload = Payload {
                digest: sha(&bytes),
                bytes,
                buffer: [0; 32],
                checkpoint: self.checkpoint(view),
            };
            let plan = self.plan(&job, &payload)?;
            let info = self.bridge(json!({"command":"plan","plan":plan})).await?;
            payload.buffer = key(info["buffer"].as_str().ok_or(bad("transport buffer"))?)?;
            self.journal.save_payload(&id, payload)?;
            count += 1;
        }
        Ok(count)
    }
    async fn authenticate_rpc(&self) -> Result<()> {
        if self.rpc_call("getGenesisHash", json!([])).await?.as_str()
            != Some(&self.trust.pool.genesis_hash)
        {
            return Err(bad("RPC genesis mismatch"));
        }
        Ok(())
    }
    /// Reclaim a failed plan's rent before creating its replacement. Absence is
    /// accepted only after a definite failed financial/upload outcome; it never
    /// resolves an Unknown execute or claims that a challenge succeeded.
    async fn cleanup_buffer(&mut self, id: &str, job: &crate::journal::Job) -> Result<bool> {
        let payload = job.payloads.last().ok_or(bad("cleanup payload"))?;
        if job.attempts.iter().any(|a| a.outcome == Outcome::Unknown) {
            return Ok(false);
        }
        if self.journal.buffer_absence(payload.buffer)
            || job.attempts.iter().any(|a| {
                a.buffer == payload.buffer
                    && a.stage == Stage::CloseBuffer
                    && matches!(a.outcome, Outcome::FinalizedSuccess { .. })
            })
        {
            return Ok(true);
        }
        let failed = job
            .attempts
            .iter()
            .rev()
            .find(|a| a.buffer == payload.buffer && a.stage != Stage::CloseBuffer)
            .ok_or(bad("cleanup failure absent"))?;
        let Outcome::FinalizedFailure {
            slot: failed_slot, ..
        } = failed.outcome
        else {
            return Err(bad("cleanup requires finalized failure"));
        };
        let transport = self
            .journal
            .transport(&failed.signature)
            .ok_or(bad("cleanup transport"))?;
        let observed = self.bridge(
            json!({"command":"inspect-buffer","attempt":transport,"rpcUrl":self.config.rpc_url,"minContextSlot":failed_slot}),
        )
        .await?;
        if observed["absent"] == true {
            self.journal.record_buffer_absence(
                id,
                payload.buffer,
                observed["slot"]
                    .as_u64()
                    .ok_or(bad("buffer observation slot"))?,
                key(observed["blockhash"]
                    .as_str()
                    .ok_or(bad("buffer observation block"))?)?,
            )?;
            return Ok(true);
        }
        let blockhash=self.rpc_call("getLatestBlockhash",json!([{"commitment":"finalized","minContextSlot":payload.checkpoint.position.slot}])).await?;
        let value=self.bridge(json!({"command":"prepare-close","attempt":transport,"keyFile":self.config.fee_key_file,"blockhash":blockhash["value"]})).await?;
        let attempt = signed_attempt(&value, payload.digest, payload.buffer)?;
        self.journal.save_v0_attempt(id, attempt, value)?;
        Ok(false)
    }
    pub async fn cleanup_failed(&mut self) -> Result<()> {
        self.authenticate_rpc().await?;
        let jobs: Vec<_> = self
            .journal
            .jobs()
            .map(|(id, j)| (id.to_owned(), j.clone()))
            .collect();
        for (id, job) in jobs {
            self.checkpoint_stop()?;
            if job.complete || job.attempts.iter().any(|a| a.outcome == Outcome::Unknown) {
                continue;
            }
            if job.payloads.last().is_some_and(|p| {
                job.attempts
                    .iter()
                    .rev()
                    .find(|a| a.buffer == p.buffer && a.stage != Stage::CloseBuffer)
                    .is_some_and(|a| matches!(a.outcome, Outcome::FinalizedFailure { .. }))
            }) {
                self.cleanup_buffer(&id, &job).await?;
            }
        }
        Ok(())
    }
    /// Resolve all saved signatures before considering new work. A timeout,
    /// missing buffer keeps the same financial attempt until a finalized receipt.
    /// Only I04's finalized-expired monotonic-upload reconciliation can refresh
    /// upload bytes; it can never authorize a new execute/close signature.
    pub async fn recover(&mut self) -> Result<usize> {
        self.authenticate_rpc().await?;
        let unknown: Vec<_> = self
            .journal
            .jobs()
            .flat_map(|(id, j)| {
                j.attempts
                    .iter()
                    .filter(|a| a.outcome == Outcome::Unknown)
                    .map(move |a| (id.to_owned(), a.clone()))
            })
            .collect();
        let mut resolved = 0;
        for (id, attempt) in unknown {
            self.checkpoint_stop()?;
            if attempt.stage == Stage::Execute {
                self.journal.record_execute_send(&id, now())?;
            }
            let transport = self
                .journal
                .transport(&attempt.signature)
                .ok_or(bad("validated v0 record absent"))?;
            let reply = self
                .bridge(
                    json!({"command":"recover","rpcUrl":self.config.rpc_url,"attempt":transport}),
                )
                .await?;
            let state = reply["result"]["state"]
                .as_str()
                .ok_or(bad("transport recovery result"))?;
            if state == "expired_reconcile_required" && attempt.stage == Stage::Upload {
                // Missing buffers, unavailable signing keys and inconclusive
                // RPC leave this attempt Unknown. They never permit recreate.
                let reconciled = match self.bridge( json!({"command":"refresh","rpcUrl":self.config.rpc_url,"attempt":transport,"keyFile":self.config.fee_key_file})).await { Ok(value) => value, Err(error @ (Error::Interrupted | Error::BridgeCleanup)) => return Err(error), Err(_) => continue };
                let next_step_index = reconciled["nextStepIndex"]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or(bad("upload step"))?;
                let outcome = Outcome::UploadReconciled {
                    slot: reconciled["accountSlot"]
                        .as_u64()
                        .ok_or(bad("upload account slot"))?,
                    blockhash: key(reconciled["blockhash"]
                        .as_str()
                        .ok_or(bad("upload blockhash"))?)?,
                    finalized_height: reconciled["finalizedHeight"]
                        .as_u64()
                        .ok_or(bad("upload expiry height"))?,
                    next_step_index,
                    account_bytes: hex::decode(
                        reconciled["accountHex"]
                            .as_str()
                            .ok_or(bad("upload account"))?,
                    )
                    .map_err(|_| bad("upload account"))?,
                };
                let replacement = reconciled
                    .get("replacement")
                    .map(|record| {
                        if record["stepIndex"].as_u64() != Some(u64::from(next_step_index)) {
                            return Err(bad("upload replacement step"));
                        }
                        Ok((
                            signed_attempt(record, attempt.payload_digest, attempt.buffer)?,
                            record.clone(),
                        ))
                    })
                    .transpose()?;
                self.journal
                    .reconcile_upload(&id, &attempt.signature, outcome, replacement)?;
                resolved += 1;
                continue;
            }
            if state != "finalized" && state != "rejected" {
                continue;
            }
            let slot = reply["slot"].as_u64().ok_or(bad("receipt slot"))?;
            let blockhash = key(reply["blockhash"]
                .as_str()
                .ok_or(bad("receipt blockhash"))?)?;
            let outcome = if state == "finalized" {
                Outcome::FinalizedSuccess { slot, blockhash }
            } else {
                Outcome::FinalizedFailure {
                    slot,
                    blockhash,
                    error: if reply["result"]["needsNewProof"] == true {
                        "stale_proof"
                    } else if reply["result"]["error"]["InstructionError"][1]["Custom"].as_u64()
                        == Some(6017)
                    {
                        "buffer_rejected"
                    } else {
                        "transaction_rejected"
                    }
                    .into(),
                }
            };
            self.journal
                .resolve_finalized(&id, &attempt.signature, outcome)?;
            resolved += 1;
        }
        Ok(resolved)
    }
    pub async fn prepare_next(&mut self, view: &FinalizedView) -> Result<usize> {
        let mut jobs: Vec<_> = self
            .journal
            .jobs()
            .map(|(id, j)| (id.to_owned(), j.clone()))
            .collect();
        jobs.sort_by_key(|(_, job)| (job.identity.deadline, job.discovered_at));
        let mut count = 0;
        for (id, job) in jobs {
            self.checkpoint_stop()?;
            if job.complete
                || view.now >= job.identity.deadline
                || job.attempts.iter().any(|a| a.outcome == Outcome::Unknown)
            {
                continue;
            }
            let Some(payload) = job.payloads.last() else {
                continue;
            };
            let relevant: Vec<_> = job
                .attempts
                .iter()
                .filter(|a| a.payload_digest == payload.digest)
                .collect();
            if relevant
                .iter()
                .any(|a| matches!(a.outcome, Outcome::FinalizedFailure { .. }))
            {
                continue;
            }
            if view.generations.get(&job.identity.note_id) != Some(&job.identity.generation) {
                continue;
            }
            let plan = self.plan(&job, payload)?;
            let blockhash = self
                .rpc_call(
                    "getLatestBlockhash",
                    json!([{"commitment":"finalized","minContextSlot":view.slot()}]),
                )
                .await?;
            if blockhash["context"]["slot"]
                .as_u64()
                .is_none_or(|slot| slot < view.slot())
            {
                return Err(bad("blockhash context"));
            }
            let mut step_index = 0;
            for previous in &relevant {
                match previous.outcome {
                    Outcome::FinalizedSuccess { .. } => {
                        let record = self
                            .journal
                            .transport(&previous.signature)
                            .ok_or(bad("upload step record"))?;
                        step_index = step_index.max(
                            record["stepIndex"]
                                .as_u64()
                                .ok_or(bad("upload step index"))?
                                + 1,
                        );
                    }
                    Outcome::UploadReconciled {
                        next_step_index, ..
                    } => step_index = step_index.max(u64::from(next_step_index)),
                    _ => {}
                }
            }
            let mut value = self.bridge( json!({"command":"prepare","plan":plan,"stepIndex":step_index,"keyFile":self.config.fee_key_file,"blockhash":blockhash["value"]})).await?;
            value["stepIndex"] = json!(step_index);
            let attempt = signed_attempt(&value, payload.digest, payload.buffer)?;
            self.journal.save_v0_attempt(&id, attempt, value)?;
            count += 1;
        }
        Ok(count)
    }
}

#[cfg(test)]
#[path = "tests/runtime_catch_up.rs"]
mod catch_up_tests;
fn signed_attempt(value: &Value, payload_digest: Hash, buffer: Hash) -> Result<Attempt> {
    let stage = match value["kind"].as_str() {
        Some("execute") => Stage::Execute,
        Some("close") => Stage::CloseBuffer,
        Some("create" | "append" | "seal") => Stage::Upload,
        _ => return Err(bad("challenger stage")),
    };
    Ok(Attempt {
        signature: value["signature"].as_str().ok_or(bad("signature"))?.into(),
        signed_bytes: hex::decode(value["wireHex"].as_str().ok_or(bad("signed bytes"))?)
            .map_err(|_| bad("signed bytes"))?,
        stage,
        payload_digest,
        buffer,
        outcome: Outcome::Unknown,
    })
}
#[derive(Serialize)]
pub struct Metrics {
    pub pending_jobs: usize,
    pub unknown_signatures: usize,
    pub complete_jobs: usize,
    pub regenerated_proofs: usize,
    pub warning_jobs: usize,
    pub page_jobs: usize,
    pub emergency_jobs: usize,
    pub oldest_unresolved_seconds: u64,
    pub finalized_slot: Option<u64>,
    pub finalized_lag_seconds: Option<u64>,
    pub minimum_deadline_remaining_seconds: Option<u64>,
    pub undelivered_alerts: usize,
    pub oldest_detection_to_send_seconds: u64,
    pub proof_failure_total: u64,
    pub root_conflict_reproves_total: usize,
}
pub fn metrics(journal: &Journal, at: u64) -> Metrics {
    let tail = journal.archive_tail();
    let mut m = Metrics {
        pending_jobs: 0,
        unknown_signatures: 0,
        complete_jobs: 0,
        regenerated_proofs: 0,
        warning_jobs: 0,
        page_jobs: 0,
        emergency_jobs: 0,
        oldest_unresolved_seconds: 0,
        finalized_slot: tail.map(|b| b.slot),
        finalized_lag_seconds: tail.map(|b| at.saturating_sub(b.block_time)),
        undelivered_alerts: journal.alerts().filter(|a| !a.delivered).count(),
        oldest_detection_to_send_seconds: journal.jobs().filter(|(_,j)|!j.complete).map(|(_,j)|j.first_execute_send_at.unwrap_or(at).saturating_sub(j.discovered_at)).max().unwrap_or(0),
        proof_failure_total: journal.proof_failure_total(),
        root_conflict_reproves_total: journal.jobs().map(|(_,j)|j.payloads.windows(2).filter(|pair|j.attempts.iter().any(|a|a.payload_digest==pair[0].digest && matches!(&a.outcome,Outcome::FinalizedFailure{error,..} if error=="stale_proof"))).count()).sum(),
        minimum_deadline_remaining_seconds: journal
            .jobs()
            .filter(|(_, j)| !j.complete)
            .map(|(_, j)| j.identity.deadline.saturating_sub(at))
            .min(),
    };
    for (_, job) in journal.jobs() {
        if job.complete {
            m.complete_jobs += 1;
        } else {
            m.pending_jobs += 1;
            m.oldest_unresolved_seconds = m
                .oldest_unresolved_seconds
                .max(at.saturating_sub(job.discovered_at));
        }
        m.unknown_signatures += job
            .attempts
            .iter()
            .filter(|a| a.outcome == Outcome::Unknown)
            .count();
        m.regenerated_proofs += job.payloads.len().saturating_sub(1);
        match crate::journal::alert(job, at) {
            crate::journal::Alert::Warning => m.warning_jobs += 1,
            crate::journal::Alert::Page => m.page_jobs += 1,
            crate::journal::Alert::Emergency => m.emergency_jobs += 1,
            _ => {}
        }
    }
    m
}
pub async fn run(config: Config, command: &str) -> Result<()> {
    let signals = Signals::install()?;
    if command == "migrate-archive" {
        // Explicit offline storage conversion, before any Scanner, RPC client,
        // repository or transport bridge is opened. Normal startup never migrates.
        signals.shutdown.checkpoint()?;
        let trust = config.trust()?;
        let report = Journal::migrate_v1_to_segmented_with_cancel(
            &config.journal_directory,
            trust.pool(),
            || signals.shutdown.checkpoint().is_err(),
        )?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    let mut runtime = match Runtime::open_with_shutdown(
        config,
        command == "init",
        Some(signals.shutdown.clone()),
    ) {
        Ok(runtime) => runtime,
        Err(Error::Interrupted) => return Ok(()),
        Err(error) => return Err(error),
    };
    match run_command(&mut runtime, command).await {
        Err(Error::Interrupted) => {
            runtime.publish_health(false, now())?;
            Ok(())
        }
        result => result,
    }
}
async fn run_command(runtime: &mut Runtime, command: &str) -> Result<()> {
    runtime.checkpoint_stop()?;
    if command == "init" {
        return Ok(());
    }
    if command == "status" {
        println!(
            "{}",
            serde_json::to_string(&metrics(&runtime.journal, now()))?
        );
        return Ok(());
    }
    if command == "cleanup" {
        runtime.recover().await?;
        runtime.cleanup_failed().await?;
        runtime.recover().await?;
        runtime.emit_alerts(now())?;
        return Ok(());
    }
    if command == "recover" {
        runtime.recover().await?;
        runtime.emit_alerts(now())?;
        return Ok(());
    }
    let dsn = std::fs::read_to_string(&runtime.config.database_dsn_file)?;
    let mut repository = interruptible(
        runtime.shutdown.as_ref(),
        ReadRepository::connect_local(dsn.trim(), runtime.trust.clone()),
    )
    .await??;
    loop {
        let result: Result<()> = async {
            // Observation-only prewarming must never rebroadcast a saved
            // unknown attempt. Signing/recovery remains explicit for workers.
            if command != "scan" {
                runtime.recover().await?;
            }
            let view = runtime.scan().await?;
            runtime.discover(&view, &mut repository).await?;
            if command != "scan" {
                runtime.prove(&view).await?;
            }
            if command == "run" || command == "once" {
                runtime.prepare_next(&view).await?;
                runtime.recover().await?;
            }
            Ok(())
        }
        .await;
        if matches!(result, Err(Error::Interrupted | Error::BridgeCleanup)) {
            return result;
        }
        runtime.save_replay_checkpoint();
        let alerts = runtime.emit_alerts(now());
        let result = result.and(alerts);
        runtime.publish_health(result.is_ok(), now())?;
        println!(
            "{}",
            serde_json::to_string(&metrics(&runtime.journal, now()))?
        );
        if command != "run" {
            return result;
        }
        if let Err(error) = &result {
            // Error's Display exposes static evidence/conflict categories and
            // redacts all nested I/O, JSON and database error details.
            eprintln!("challenger paused: {error}");
        }
        interruptible(
            runtime.shutdown.as_ref(),
            tokio::time::sleep(Duration::from_secs(runtime.config.poll_seconds)),
        )
        .await?;
    }
}
pub fn read_config(path: &Path) -> Result<Config> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
