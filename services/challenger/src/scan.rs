//! Replay every finalized block, not only the control outbox. A view can only be
//! obtained after the existing indexer reconciles the exact finalized account cut.
use crate::{
    bad,
    journal::{ArchiveTail, Checkpoint},
    sha, Hash, Result, Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use zkapi_indexer::{tree::Tree, ChainState, FinalizedBlock, Indexer};

#[derive(Clone)]
pub struct Scanner {
    trust: Trust,
    index: Indexer,
    generations: BTreeMap<u32, Checkpoint>,
    now: u64,
}
const CHECKPOINT_MAGIC: &[u8; 8] = b"ZKSCAN01";
const MAX_CHECKPOINT_BYTES: usize = 256 * 1024 * 1024;
const MAX_CHECKPOINT_HEADER: usize = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedScanner {
    manifest: Hash,
    now: u64,
    generations: Vec<(u32, Checkpoint)>,
    index_sha256: Hash,
}
pub struct FinalizedView {
    pub(crate) trust: Trust,
    pub(crate) state: ChainState,
    pub(crate) generations: BTreeMap<u32, Checkpoint>,
    pub(crate) tree: Tree,
    pub(crate) now: u64,
    pub(crate) paused: bool,
}
impl Scanner {
    pub fn new(trust: Trust) -> Self {
        let program =
            zkapi_control::wire::pubkey(&trust.pool.program_id).expect("validated program");
        let index = Indexer::new(program, trust.pool());
        Self {
            trust,
            index,
            generations: BTreeMap::new(),
            now: 0,
        }
    }
    /// Private replay state only. It cannot produce a FinalizedView until the
    /// normal live account reconciliation succeeds after restoration.
    pub fn checkpoint_bytes(&self) -> Result<Vec<u8>> {
        let index = self
            .index
            .checkpoint_bytes()
            .map_err(|_| bad("index checkpoint"))?;
        let header = serde_json::to_vec(&SavedScanner {
            manifest: self.trust.manifest_hash,
            now: self.now,
            generations: self
                .generations
                .iter()
                .map(|(id, value)| (*id, value.clone()))
                .collect(),
            index_sha256: sha(&index),
        })?;
        if header.len() > MAX_CHECKPOINT_HEADER
            || header.len().saturating_add(index.len()).saturating_add(16) > MAX_CHECKPOINT_BYTES
        {
            return Err(bad("scanner checkpoint size"));
        }
        let mut bytes = Vec::with_capacity(16 + header.len() + index.len());
        bytes.extend_from_slice(CHECKPOINT_MAGIC);
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&index);
        Ok(bytes)
    }
    pub fn restore_checkpoint(
        trust: Trust,
        bytes: &[u8],
        expected_sha256: Hash,
        anchor: ArchiveTail,
    ) -> Result<Self> {
        if bytes.len() < 16
            || bytes.len() > MAX_CHECKPOINT_BYTES
            || &bytes[..8] != CHECKPOINT_MAGIC
            || sha(bytes) != expected_sha256
        {
            return Err(bad("scanner checkpoint framing"));
        }
        let length = u64::from_le_bytes(bytes[8..16].try_into().expect("header length"));
        if length > MAX_CHECKPOINT_HEADER as u64 || length > (bytes.len() - 16) as u64 {
            return Err(bad("scanner checkpoint header"));
        }
        let end = 16 + length as usize;
        let header: SavedScanner = serde_json::from_slice(&bytes[16..end])?;
        if header.manifest != trust.manifest_hash || header.now != anchor.block_time {
            return Err(bad("scanner checkpoint binding"));
        }
        let program = zkapi_control::wire::pubkey(&trust.pool.program_id)
            .map_err(|_| bad("scanner checkpoint program"))?;
        let index = Indexer::restore_checkpoint(
            &bytes[end..],
            header.index_sha256,
            program,
            trust.pool(),
            anchor.slot,
            anchor.blockhash,
        )
        .map_err(|_| bad("index checkpoint"))?;
        let state = index
            .replay_state()
            .map_err(|_| bad("scanner checkpoint state"))?;
        let mut generations = BTreeMap::new();
        let mut previous = None;
        for (id, generation) in header.generations {
            if previous.is_some_and(|old| old >= id)
                || !state.pending.contains_key(&id)
                || generation.position.slot > anchor.slot
                || generation.tree_sequence == 0
                || generation.tree_sequence > state.sequence
                || generation.position.signature.is_empty()
                || generation.position.signature.len() > 128
                || (generation.position.slot == anchor.slot
                    && generation.blockhash != anchor.blockhash)
            {
                return Err(bad("scanner checkpoint generation"));
            }
            previous = Some(id);
            generations.insert(id, generation);
        }
        if generations.len() != state.pending.len() {
            return Err(bad("scanner checkpoint pending generations"));
        }
        Ok(Self {
            trust,
            index,
            generations,
            now: header.now,
        })
    }
    pub fn apply_finalized(&mut self, block: &FinalizedBlock) -> Result<()> {
        let prior_slot = self.index.replay_state().ok().map(|state| state.slot);
        self.index
            .apply_block(block)
            .map_err(|_| bad("finalized archive replay"))?;
        if prior_slot.is_some_and(|slot| block.slot <= slot) {
            return Ok(());
        }
        for (position, event) in self.index.block_transitions() {
            if event.op == 2 {
                self.generations.insert(
                    event.note_id,
                    Checkpoint {
                        position: position.clone(),
                        blockhash: block.blockhash,
                        tree_sequence: event.sequence,
                    },
                );
            }
        }
        let state = self.index.replay_state().map_err(|_| bad("replay state"))?;
        self.generations
            .retain(|id, _| state.pending.contains_key(id));
        self.now = block.block_time;
        Ok(())
    }
    pub fn replay_state(&self) -> Result<ChainState> {
        self.index
            .replay_state()
            .map_err(|_| bad("replay unavailable"))
    }
    /// `accounts` and `pool_account` MUST come from finalized RPC at this same
    /// slot, with the replayed blockhash authenticated by the archive adapter.
    /// Reuse ArchiveRpc::capture_chain/observe_cut for Note/Pending/Tree and
    /// AccountCut::account for PoolConfig, all from that same captured response.
    pub fn reconcile(
        &mut self,
        accounts: &ChainState,
        pool_account: &Value,
    ) -> Result<FinalizedView> {
        let pool = zkapi_control::chain::validate_pool_account(
            &self.trust.pool,
            pool_account,
            accounts.slot,
        )
        .map_err(|_| bad("actual PoolConfig"))?;
        self.index
            .reconcile(accounts)
            .map_err(|_| bad("finalized account cut mismatch"))?;
        let mut tree = Tree::new();
        for note in accounts.active.values() {
            tree.update(note.id, note.leaf().map_err(|_| bad("active leaf"))?)
                .map_err(|_| bad("active tree"))?;
        }
        if tree.root() != accounts.root
            || accounts
                .pending
                .keys()
                .any(|id| !self.generations.contains_key(id))
        {
            return Err(bad("tree/Pending generation evidence"));
        }
        Ok(FinalizedView {
            trust: self.trust.clone(),
            state: accounts.clone(),
            generations: self.generations.clone(),
            tree,
            now: self.now,
            paused: pool.paused,
        })
    }
}
impl FinalizedView {
    pub fn now(&self) -> u64 {
        self.now
    }
    pub fn pending(&self) -> impl Iterator<Item = (u32, Hash)> + '_ {
        self.state.pending.iter().map(|(id, p)| (*id, p.nullifier))
    }
    pub fn slot(&self) -> u64 {
        self.state.slot
    }
    pub fn blockhash(&self) -> Hash {
        self.state.blockhash
    }
}
