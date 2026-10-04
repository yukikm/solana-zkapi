//! Native scan/prove/broadcast orchestration. All terminal transaction outcomes
//! come from the existing I04 transport's exact-message finalized receipts.
use crate::{
    bad,
    journal::{Attempt, Checkpoint, Journal, Outcome, Payload, Stage},
    read_model::ReadRepository,
    scan::{FinalizedView, Scanner},
    sha, Hash, PreparedChallenge, Result, Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;
use zkapi_indexer::{
    runtime::{ArchiveRpc, Config as IndexConfig},
    Position,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub manifest: PathBuf,
    pub manifest_sha256: String,
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
        let trust = Trust::from_pinned_manifest(&manifest, hash(&self.manifest_sha256)?)?;
        let url = reqwest::Url::parse(&self.rpc_url).map_err(|_| bad("RPC URL"))?;
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
    if sha(&std::fs::read(&config.transport_bridge)?) != hash(&config.transport_bridge_sha256)? {
        return Err(bad("transport bridge pin"));
    }
    let mut child = tokio::process::Command::new(&config.node)
        .arg(&config.transport_bridge)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().ok_or(bad("bridge stdin"))?;
    stdin.write_all(&serde_json::to_vec(&input)?).await?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(45), child.wait_with_output())
        .await
        .map_err(|_| bad("transport bridge timeout"))??;
    if !output.status.success() || output.stdout.len() > 2_000_000 {
        return Err(bad("transport bridge failed"));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub struct Runtime {
    config: Config,
    pub journal: Journal,
    scanner: Scanner,
    trust: Trust,
    rpc: ArchiveRpc,
}
impl Runtime {
    pub fn open(config: Config, initialize: bool) -> Result<Self> {
        let trust = config.trust()?;
        let journal = if initialize {
            Journal::initialize(&config.journal_directory, trust.pool())?
        } else {
            Journal::open(&config.journal_directory, trust.pool())?
        };
        let mut scanner = Scanner::new(trust.clone());
        for block in journal.archive() {
            scanner.apply_finalized(block)?;
        }
        // A v1 queue with a checkpoint but no archive must explicitly import its
        // finalized history, never silently continue from an empty scanner.
        if journal.checkpoint().is_some() && journal.archive().is_empty() {
            return Err(bad("legacy journal requires archive import"));
        }
        let rpc = ArchiveRpc::new(config.rpc_url.clone()).map_err(|_| bad("RPC config"))?;
        Ok(Self {
            config,
            journal,
            scanner,
            trust,
            rpc,
        })
    }
    /// Every restart replays durable history and then authenticates the current
    /// genesis, block anchor, PoolConfig, Note, Pending and tree account cut.
    pub async fn scan(&mut self) -> Result<FinalizedView> {
        if self
            .rpc
            .call("getGenesisHash", json!([]))
            .await
            .map_err(|_| bad("RPC genesis unavailable"))?
            .as_str()
            != Some(&self.trust.pool.genesis_hash)
        {
            return Err(bad("RPC genesis mismatch"));
        }
        let tip = self
            .rpc
            .call("getSlot", json!([{"commitment":"finalized"}]))
            .await
            .map_err(|_| bad("RPC finalized tip"))?
            .as_u64()
            .ok_or(bad("RPC slot"))?;
        let mut next = self
            .journal
            .archive()
            .last()
            .map_or(self.config.start_slot, |b| b.slot.saturating_add(1));
        if self.journal.archive().last().is_some_and(|b| tip < b.slot) {
            return Err(bad("RPC rollback"));
        }
        while next <= tip {
            let end = next.saturating_add(999).min(tip);
            let slots = self
                .rpc
                .call("getBlocks", json!([next,end,{"commitment":"finalized"}]))
                .await
                .map_err(|_| bad("RPC block range"))?;
            let mut previous = None;
            for slot in slots.as_array().ok_or(bad("RPC block range"))? {
                let slot = slot.as_u64().ok_or(bad("RPC slot"))?;
                if slot < next || slot > end || previous.is_some_and(|p| slot <= p) {
                    return Err(bad("RPC unordered blocks"));
                }
                let value = self.rpc.call("getBlock", json!([slot,{"commitment":"finalized","encoding":"json","transactionDetails":"full","maxSupportedTransactionVersion":0,"rewards":false}])).await.map_err(|_| bad("RPC archive unavailable"))?;
                let block = zkapi_indexer::rpc::decode_finalized_block(slot, &value)
                    .map_err(|_| bad("RPC archive encoding"))?;
                let mut checked = self.scanner.clone();
                checked.apply_finalized(&block)?;
                self.journal.append_archive(block)?;
                self.scanner = checked;
                previous = Some(slot);
            }
            next = end.checked_add(1).ok_or(bad("slot overflow"))?;
        }
        let expected = self.scanner.replay_state()?;
        if expected.slot != tip {
            return Err(bad("RPC finalized tail missing"));
        }
        let accounts = self
            .rpc
            .observe_chain(&self.config.index(&self.trust), &expected)
            .await
            .map_err(|_| bad("RPC account cut"))?;
        let pool = self.rpc.call("getAccountInfo", json!([self.trust.pool.pool,{"commitment":"finalized","encoding":"base64","minContextSlot":tip}])).await.map_err(|_| bad("RPC PoolConfig"))?;
        if pool["context"]["slot"].as_u64() != Some(tip) {
            return Err(bad("RPC PoolConfig cut"));
        }
        self.scanner.reconcile(&accounts, &pool["value"])
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
            if let Some(evidence) = repository.auth(nullifier).await? {
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
        let block = self
            .journal
            .archive()
            .iter()
            .find(|b| b.slot == payload.checkpoint.position.slot)
            .ok_or(bad("payload clock absent"))?;
        let nonce = sha(&[job.identity.id().as_bytes(), &payload.digest].concat());
        let fee = self.config.priority_fee.as_ref().map_or(0, |policy| {
            policy.price(job.discovered_at, block.block_time, job.identity.deadline)
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
            json!({"programId":self.trust.pool.program_id,"pool":self.trust.pool.pool,"mint":self.trust.pool.mint,"payer":self.config.payer,"noteId":job.identity.note_id,"payloadHex":hex::encode(&payload.bytes),"nonceHex":hex::encode(nonce),"expires":block.block_time.saturating_add(3600).min(job.identity.deadline).to_string(),"slot":payload.checkpoint.position.slot,"sequence":payload.checkpoint.tree_sequence.to_string(),"priorityFeeMicroLamports":fee.to_string()}),
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
            let info = bridge(&self.config, json!({"command":"plan","plan":plan})).await?;
            payload.buffer = key(info["buffer"].as_str().ok_or(bad("transport buffer"))?)?;
            self.journal.save_payload(&id, payload)?;
            count += 1;
        }
        Ok(count)
    }
    async fn authenticate_rpc(&self) -> Result<()> {
        if self
            .rpc
            .call("getGenesisHash", json!([]))
            .await
            .map_err(|_| bad("RPC genesis unavailable"))?
            .as_str()
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
        let observed = bridge(
            &self.config,
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
        let blockhash=self.rpc.call("getLatestBlockhash",json!([{"commitment":"finalized","minContextSlot":payload.checkpoint.position.slot}])).await.map_err(|_|bad("cleanup blockhash"))?;
        let value=bridge(&self.config,json!({"command":"prepare-close","attempt":transport,"keyFile":self.config.fee_key_file,"blockhash":blockhash["value"]})).await?;
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
            if attempt.stage == Stage::Execute {
                self.journal.record_execute_send(&id, now())?;
            }
            let transport = self
                .journal
                .transport(&attempt.signature)
                .ok_or(bad("validated v0 record absent"))?;
            let reply = bridge(
                &self.config,
                json!({"command":"recover","rpcUrl":self.config.rpc_url,"attempt":transport}),
            )
            .await?;
            let state = reply["result"]["state"]
                .as_str()
                .ok_or(bad("transport recovery result"))?;
            if state == "expired_reconcile_required" && attempt.stage == Stage::Upload {
                // Missing buffers, unavailable signing keys and inconclusive
                // RPC leave this attempt Unknown. They never permit recreate.
                let Ok(reconciled) = bridge(&self.config, json!({"command":"refresh","rpcUrl":self.config.rpc_url,"attempt":transport,"keyFile":self.config.fee_key_file})).await else { continue; };
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
                .rpc
                .call(
                    "getLatestBlockhash",
                    json!([{"commitment":"finalized","minContextSlot":view.slot()}]),
                )
                .await
                .map_err(|_| bad("RPC blockhash"))?;
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
            let mut value = bridge(&self.config, json!({"command":"prepare","plan":plan,"stepIndex":step_index,"keyFile":self.config.fee_key_file,"blockhash":blockhash["value"]})).await?;
            value["stepIndex"] = json!(step_index);
            let attempt = signed_attempt(&value, payload.digest, payload.buffer)?;
            self.journal.save_v0_attempt(&id, attempt, value)?;
            count += 1;
        }
        Ok(count)
    }
}
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
    let mut m = Metrics {
        pending_jobs: 0,
        unknown_signatures: 0,
        complete_jobs: 0,
        regenerated_proofs: 0,
        warning_jobs: 0,
        page_jobs: 0,
        emergency_jobs: 0,
        oldest_unresolved_seconds: 0,
        finalized_slot: journal.archive().last().map(|b| b.slot),
        finalized_lag_seconds: journal
            .archive()
            .last()
            .map(|b| at.saturating_sub(b.block_time)),
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
    let mut runtime = Runtime::open(config, command == "init")?;
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
    let mut repository = ReadRepository::connect_local(dsn.trim(), runtime.trust.clone()).await?;
    loop {
        let result: Result<()> = async {
            runtime.recover().await?;
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
        if result.is_err() {
            eprintln!("challenger paused: reconciliation or transport unavailable");
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(runtime.config.poll_seconds))=>{}, _=tokio::signal::ctrl_c()=>return Ok(()) }
    }
}
pub fn read_config(path: &Path) -> Result<Config> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
