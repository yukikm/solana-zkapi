//! Replay every finalized block, not only the control outbox. A view can only be
//! obtained after the existing indexer reconciles the exact finalized account cut.
use crate::{bad, journal::Checkpoint, Hash, Result, Trust};
use serde_json::Value;
use std::collections::BTreeMap;
use zkapi_indexer::{tree::Tree, ChainState, Event, FinalizedBlock, Indexer, Position};

pub struct Scanner {
    trust: Trust,
    index: Indexer,
    generations: BTreeMap<u32, Checkpoint>,
    now: u64,
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
    pub fn apply_finalized(&mut self, block: &FinalizedBlock) -> Result<()> {
        let prior_slot = self.index.replay_state().ok().map(|state| state.slot);
        self.index
            .apply_block(block)
            .map_err(|_| bad("finalized archive replay"))?;
        if prior_slot.is_some_and(|slot| block.slot <= slot) {
            return Ok(());
        }
        let program =
            zkapi_control::wire::pubkey(&self.trust.pool.program_id).expect("validated program");
        for (transaction_index, transaction) in block.transactions.iter().enumerate() {
            if !transaction.succeeded {
                continue;
            }
            for instruction in &transaction.instructions {
                if instruction.program != program || instruction.succeeded != Some(true) {
                    continue;
                }
                for bytes in &instruction.events {
                    let event = Event::decode(bytes).map_err(|_| bad("Vault event"))?;
                    if event.pool == self.trust.pool() && event.op == 2 {
                        self.generations.insert(
                            event.note_id,
                            Checkpoint {
                                position: Position {
                                    slot: block.slot,
                                    transaction_index: transaction_index as u32,
                                    signature: transaction.signature.clone(),
                                    outer_instruction: instruction.outer_index,
                                    invocation_index: instruction.invocation_index,
                                },
                                blockhash: block.blockhash,
                                tree_sequence: event.sequence,
                            },
                        );
                    }
                }
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
    /// Reuse ArchiveRpc::observe_chain for the Note/Pending/Tree account cut.
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
