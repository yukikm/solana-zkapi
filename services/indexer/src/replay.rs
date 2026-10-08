use crate::{
    discriminator, sha, tree::Tree, u64_field, Bytes32, Error, Event, FinalizedBlock, Instruction,
    Note, Pending, Position, Reader, Result,
};
use std::collections::{BTreeMap, BTreeSet};
use zkapi_layout2::{Command, Operation};

#[path = "replay_checkpoint.rs"]
mod checkpoint;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainState {
    pub slot: u64,
    pub blockhash: Bytes32,
    pub root: Bytes32,
    pub sequence: u64,
    pub next_note_id: u64,
    pub outstanding_deposits: u64,
    pub active: BTreeMap<u32, Note>,
    pub pending: BTreeMap<u32, Pending>,
}
#[derive(Clone, Debug)]
struct Config {
    binding: Bytes32,
    ttl: u64,
    challenge: u64,
}
#[derive(Clone, Debug)]
struct Buffer {
    generation: Position,
    uploader: Bytes32,
    rent_payer: Bytes32,
    op: Operation,
    len: usize,
    digest: Bytes32,
    expires: u64,
    bytes: Vec<u8>,
    sealed: bool,
}
#[derive(Clone, Debug)]
pub struct Indexer {
    pub(crate) program: Bytes32,
    pub(crate) pool: Bytes32,
    config: Option<Config>,
    pub(crate) tree: Tree,
    pub(crate) active: BTreeMap<u32, Note>,
    pub(crate) pending: BTreeMap<u32, Pending>,
    exits: BTreeSet<Bytes32>,
    buffers: BTreeMap<Bytes32, Buffer>,
    pub(crate) sequence: u64,
    pub(crate) next_note_id: u64,
    pub(crate) outstanding: u64,
    pub(crate) checkpoint: Option<(u64, Bytes32)>,
    blocks: BTreeMap<u64, Bytes32>,
    pub(crate) ready: bool,
    pub(crate) halted: bool,
    pub last_transition: Option<Position>,
    block_transitions: Vec<(Position, Event)>,
}
impl Indexer {
    pub fn new(program: Bytes32, pool: Bytes32) -> Self {
        Self {
            program,
            pool,
            config: None,
            tree: Tree::new(),
            active: BTreeMap::new(),
            pending: BTreeMap::new(),
            exits: BTreeSet::new(),
            buffers: BTreeMap::new(),
            sequence: 0,
            next_note_id: 0,
            outstanding: 0,
            checkpoint: None,
            blocks: BTreeMap::new(),
            ready: false,
            halted: false,
            last_transition: None,
            block_transitions: Vec::new(),
        }
    }
    /// Atomically replay an entire finalized block. Any inconsistent archive data
    /// latches the service closed; recovery creates a new indexer and replays history.
    pub fn apply_block(&mut self, block: &FinalizedBlock) -> Result<()> {
        if self.halted {
            return Err(Error::Unavailable);
        }
        if !block.finalized {
            self.halt();
            return Err(Error::Unfinalized);
        }
        let digest = sha(&serde_json::to_vec(block).map_err(|_| Error::History)?);
        if let Some(previous) = self.blocks.get(&block.slot) {
            if previous == &digest {
                return Ok(());
            }
            self.halt();
            return Err(Error::History);
        }
        // Replay mutates financial/buffer state, but never the accepted-block
        // digest history. Keep that growing map in the original until commit;
        // cloning it for every block makes an otherwise quiet archive O(B²).
        let mut candidate = Self {
            program: self.program,
            pool: self.pool,
            config: self.config.clone(),
            tree: self.tree.clone(),
            active: self.active.clone(),
            pending: self.pending.clone(),
            exits: self.exits.clone(),
            buffers: self.buffers.clone(),
            sequence: self.sequence,
            next_note_id: self.next_note_id,
            outstanding: self.outstanding,
            checkpoint: self.checkpoint,
            blocks: BTreeMap::new(),
            ready: false,
            halted: self.halted,
            last_transition: self.last_transition.clone(),
            block_transitions: Vec::new(),
        };
        let result = candidate.apply(block);
        match result {
            Ok(()) => {
                candidate.blocks = std::mem::take(&mut self.blocks);
                candidate.blocks.insert(block.slot, digest);
                candidate.checkpoint = Some((block.slot, block.blockhash));
                *self = candidate;
                Ok(())
            }
            Err(error) => {
                self.halt();
                Err(error)
            }
        }
    }
    pub fn halt(&mut self) {
        self.halted = true;
        self.ready = false;
    }
    pub fn is_ready(&self) -> bool {
        self.ready && !self.halted
    }
    /// Verified transitions from the latest successfully replayed block. These
    /// are reconstructed from instruction/buffer history even if logs are absent.
    pub fn block_transitions(&self) -> &[(Position, Event)] {
        &self.block_transitions
    }
    fn apply(&mut self, block: &FinalizedBlock) -> Result<()> {
        if let Some((slot, hash)) = self.checkpoint {
            if block.slot <= slot || block.parent_slot != slot || block.previous_blockhash != hash {
                return Err(Error::History);
            }
        }
        let mut signatures = BTreeSet::new();
        for (tx_index, tx) in block.transactions.iter().enumerate() {
            if !signatures.insert(&tx.signature) {
                return Err(Error::History);
            }
            // Successful earlier instructions in a subsequently failed transaction
            // have emitted logs but every account write has rolled back.
            if !tx.succeeded {
                continue;
            }
            let mut last = None;
            for instruction in &tx.instructions {
                let order = (instruction.outer_index, instruction.invocation_index);
                if last.is_some_and(|value| order <= value) {
                    return Err(Error::History);
                }
                last = Some(order);
                if instruction.program != self.program {
                    continue;
                }
                match instruction.succeeded {
                    Some(false) => continue,
                    None => return Err(Error::Invocation),
                    Some(true) => {}
                }
                let position = Position {
                    slot: block.slot,
                    transaction_index: u32::try_from(tx_index).map_err(|_| Error::History)?,
                    signature: tx.signature.clone(),
                    outer_instruction: instruction.outer_index,
                    invocation_index: instruction.invocation_index,
                };
                self.instruction(instruction, &position, block.block_time)?;
            }
        }
        Ok(())
    }
    fn instruction(&mut self, ix: &Instruction, position: &Position, now: u64) -> Result<()> {
        let d: [u8; 8] = ix
            .data
            .get(..8)
            .ok_or(Error::Encoding("instruction discriminator"))?
            .try_into()
            .unwrap();
        let args = &ix.data[8..];
        let key = |i| {
            ix.accounts
                .get(i)
                .copied()
                .ok_or(Error::Encoding("account index"))
        };
        let is = |name| d == discriminator("global", name);
        if is("initialize_pool") {
            if key(0)? != self.pool {
                return Ok(());
            }
            if self.config.is_some() || args.len() != 280 {
                return Err(Error::State);
            }
            let genesis = args[32..64].try_into().unwrap();
            let ttl = u64::from_le_bytes(args[192..200].try_into().unwrap());
            let challenge = u64::from_le_bytes(args[200..208].try_into().unwrap());
            if ttl == 0 || challenge == 0 {
                return Err(Error::State);
            }
            let binding = zkapi_layout2::framing::reduce(sha(&zkapi_layout2::framing::vault(
                &genesis,
                &self.program,
                &self.pool,
                &key(8)?,
                &key(3)?,
            )));
            self.config = Some(Config {
                binding,
                ttl,
                challenge,
            });
            if !ix.events.is_empty() {
                return Err(Error::Event);
            }
            return Ok(());
        }
        let buffer_op = is("create_payload")
            || is("append_payload")
            || is("seal_payload")
            || is("close_payload");
        let execute = is("execute_payload");
        let pool_index = if buffer_op {
            1
        } else if execute {
            3
        } else {
            0
        };
        if key(pool_index)? != self.pool {
            return Ok(());
        }
        if self.config.is_none() {
            return Err(Error::History);
        }
        if buffer_op {
            if !ix.events.is_empty() {
                return Err(Error::Event);
            }
            let address = key(0)?;
            if is("create_payload") {
                let mut r = Reader(args);
                let op = Operation::from_byte(r.byte()?).map_err(|_| Error::Buffer)?;
                let len = r.u32()? as usize;
                let digest = r.array()?;
                let _nonce = r.array::<32>()?;
                let expires = r.u64()?;
                r.end()?;
                if len != op.payload_len()
                    || len > 4096
                    || expires <= now
                    || expires > now.checked_add(3600).ok_or(Error::Buffer)?
                    || self.buffers.contains_key(&address)
                {
                    return Err(Error::Buffer);
                }
                self.buffers.insert(
                    address,
                    Buffer {
                        generation: position.clone(),
                        uploader: key(2)?,
                        rent_payer: key(3)?,
                        op,
                        len,
                        digest,
                        expires,
                        bytes: Vec::with_capacity(len),
                        sealed: false,
                    },
                );
            } else if is("close_payload") {
                if !args.is_empty() {
                    return Err(Error::Buffer);
                }
                let b = self.buffers.get(&address).ok_or(Error::Buffer)?;
                if key(3)? != b.rent_payer || (key(2)? != b.uploader && now < b.expires) {
                    return Err(Error::Buffer);
                }
                self.buffers.remove(&address);
            } else {
                let b = self.buffers.get_mut(&address).ok_or(Error::Buffer)?;
                if key(2)? != b.uploader || now >= b.expires || b.sealed {
                    return Err(Error::Buffer);
                }
                if is("append_payload") {
                    let mut r = Reader(args);
                    let offset = r.u32()? as usize;
                    let len = r.u32()? as usize;
                    if offset != b.bytes.len()
                        || len != r.0.len()
                        || offset.checked_add(len).is_none_or(|n| n > b.len)
                    {
                        return Err(Error::Buffer);
                    }
                    b.bytes.extend_from_slice(r.0);
                } else {
                    if !args.is_empty() || b.bytes.len() != b.len || sha(&b.bytes) != b.digest {
                        return Err(Error::Buffer);
                    }
                    b.sealed = true;
                }
            }
            return Ok(());
        }
        let event = if execute {
            let address = key(0)?;
            let b = self.buffers.get(&address).ok_or(Error::Buffer)?.clone();
            if args != b.digest
                || !b.sealed
                || now >= b.expires
                || b.uploader != key(1)?
                || b.rent_payer != key(2)?
                || b.generation >= *position
                || sha(&b.bytes) != b.digest
            {
                return Err(Error::Buffer);
            }
            let event = self.transition(b.op, &b.bytes, key(12)?, now)?;
            self.buffers.remove(&address);
            Some(event)
        } else if is("finalize_escape") {
            let mut r = Reader(args);
            let id = r.u32()?;
            r.end()?;
            Some(self.finalize(id, now)?)
        } else if is("deposit_compact_v1") {
            // The binding belongs to this pool's accepted initialization history;
            // compact wire cannot supply or override it. Reuse the same canonical
            // transition/event reconstruction as legacy inline and buffer deposits.
            let binding = self.config.as_ref().ok_or(Error::State)?.binding;
            let canonical = zkapi_layout2::expand_deposit_compact_v1(args, &binding)
                .map_err(|_| Error::Encoding("compact deposit payload"))?;
            Some(self.transition(Operation::Deposit, &canonical, key(9)?, now)?)
        } else {
            let op = [
                ("deposit", Operation::Deposit),
                ("mutual_close", Operation::Close),
                ("initiate_escape", Operation::Escape),
                ("challenge_escape", Operation::Challenge),
                ("claim_expired", Operation::Expiry),
            ]
            .into_iter()
            .find_map(|(name, op)| is(name).then_some(op));
            if let Some(op) = op {
                Some(self.transition(op, args, key(9)?, now)?)
            } else {
                let length = if is("set_treasury") {
                    32
                } else if is("pause") || is("unpause") {
                    0
                } else {
                    return Err(Error::Encoding("unknown Vault instruction"));
                };
                if args.len() != length {
                    return Err(Error::Encoding("admin wire"));
                }
                None
            }
        };
        if let Some(expected) = event {
            if ix.events.len() > 1 {
                return Err(Error::Event);
            }
            if let Some(bytes) = ix.events.first() {
                if Event::decode(bytes)? != expected {
                    return Err(Error::Event);
                }
            }
            self.last_transition = Some(position.clone());
            self.block_transitions.push((position.clone(), expected));
        } else if !ix.events.is_empty() {
            return Err(Error::Event);
        }
        Ok(())
    }
    fn transition(
        &mut self,
        op: Operation,
        args: &[u8],
        destination: Bytes32,
        now: u64,
    ) -> Result<Event> {
        let c = Command::decode(op, args).map_err(|_| Error::Encoding("layout2 payload"))?;
        let p = c.tree.public;
        let cfg = self.config.as_ref().ok_or(Error::State)?;
        let id = u32::try_from(u64_field(p.get(3))?).map_err(|_| Error::State)?;
        let old_root = self.tree.root();
        if *p.get(0) != cfg.binding || *p.get(1) != old_root || u64_field(p.get(9))? != op.tree_op()
        {
            return Err(Error::State);
        }
        let expected_tag = zkapi_poseidon::hash_fields(
            &std::iter::once(zkapi_poseidon::domain(b"solana.zkapi.tree.v1"))
                .chain((0..10).map(|i| zkapi_poseidon::parse(p.get(i)).unwrap()))
                .collect::<Vec<_>>(),
        );
        if *p.get(10) != zkapi_poseidon::bytes(expected_tag) {
            return Err(Error::State);
        }
        let note = if op == Operation::Deposit {
            let a = c.deposit.ok_or(Error::State)?;
            let expiry = now
                .checked_add(cfg.ttl)
                .and_then(|x| x.checked_add(86399))
                .and_then(|x| (x / 86400).checked_mul(86400))
                .ok_or(Error::State)?;
            if self.next_note_id >= 1u64 << 32
                || u64::from(id) != self.next_note_id
                || a.expected_id != id
                || a.expected_root != old_root
                || a.expiry != expiry
            {
                return Err(Error::State);
            }
            Note {
                id,
                commitment: a.commitment,
                deposit: a.amount,
                expiry: a.expiry,
            }
        } else if op == Operation::Challenge {
            if c.note_id != Some(id) {
                return Err(Error::State);
            }
            self.pending.get(&id).ok_or(Error::State)?.note.clone()
        } else {
            if op == Operation::Expiry && c.note_id != Some(id) {
                return Err(Error::State);
            }
            self.active.get(&id).ok_or(Error::State)?.clone()
        };
        let leaf = note.leaf()?;
        if *p.get(6) != note.commitment
            || u64_field(p.get(7))? != note.deposit
            || u64_field(p.get(8))? != note.expiry
        {
            return Err(Error::State);
        }
        let insert = matches!(op, Operation::Deposit | Operation::Challenge);
        let (old_leaf, new_leaf) = if insert {
            ([0; 32], leaf)
        } else {
            (leaf, [0; 32])
        };
        if self.tree.leaf(id) != old_leaf || *p.get(4) != old_leaf || *p.get(5) != new_leaf {
            return Err(Error::State);
        }
        let mut details = None;
        let status = match op {
            Operation::Deposit => {
                self.next_note_id += 1;
                self.outstanding = self
                    .outstanding
                    .checked_add(note.deposit)
                    .ok_or(Error::State)?;
                self.active.insert(id, note.clone());
                1
            }
            Operation::Close | Operation::Escape => {
                let w = c.authorization.ok_or(Error::State)?.public;
                let n = *w.get(11);
                let balance = u64_field(w.get(9))?;
                let destination_binding = zkapi_layout2::framing::reduce(sha(
                    &zkapi_layout2::framing::destination(&destination),
                ));
                if *w.get(2) != cfg.binding
                    || *w.get(3) != old_root
                    || u64_field(w.get(8))? != id as u64
                    || balance > note.deposit
                    || *w.get(10) != destination_binding
                    || u64_field(w.get(12))? != u64::from(op == Operation::Close)
                    || !self.exits.insert(n)
                {
                    return Err(Error::State);
                }
                self.active.remove(&id);
                if op == Operation::Escape {
                    let deadline = now.checked_add(cfg.challenge).ok_or(Error::State)?;
                    self.pending.insert(
                        id,
                        Pending {
                            note: note.clone(),
                            old_root,
                            nullifier: n,
                            balance,
                            destination_owner: destination,
                            deadline,
                        },
                    );
                    details = Some((n, balance, destination, Some(deadline)));
                    2
                } else {
                    self.outstanding = self
                        .outstanding
                        .checked_sub(note.deposit)
                        .ok_or(Error::State)?;
                    details = Some((n, balance, destination, None));
                    3
                }
            }
            Operation::Challenge => {
                let pending = self.pending.remove(&id).ok_or(Error::State)?;
                let rp = c.authorization.ok_or(Error::State)?.public;
                if now >= pending.deadline
                    || *rp.get(2) != cfg.binding
                    || *rp.get(8) != pending.nullifier
                {
                    return Err(Error::State);
                }
                // RP[3] is intentionally historical; never bind it to current root.
                details = Some((
                    pending.nullifier,
                    pending.balance,
                    pending.destination_owner,
                    Some(pending.deadline),
                ));
                self.active.insert(id, note.clone());
                1
            }
            Operation::Expiry => {
                if now < note.expiry {
                    return Err(Error::State);
                }
                self.active.remove(&id);
                self.outstanding = self
                    .outstanding
                    .checked_sub(note.deposit)
                    .ok_or(Error::State)?;
                3
            }
        };
        self.tree.update(id, new_leaf)?;
        if self.tree.root() != *p.get(2) {
            return Err(Error::State);
        }
        self.sequence = self.sequence.checked_add(1).ok_or(Error::State)?;
        Ok(self.event(
            &note,
            if op == Operation::Expiry { 5 } else { op as u8 },
            status,
            old_root,
            details,
        ))
    }
    fn finalize(&mut self, id: u32, now: u64) -> Result<Event> {
        let p = self.pending.remove(&id).ok_or(Error::State)?;
        if now < p.deadline {
            return Err(Error::State);
        }
        self.outstanding = self
            .outstanding
            .checked_sub(p.note.deposit)
            .ok_or(Error::State)?;
        self.sequence = self.sequence.checked_add(1).ok_or(Error::State)?;
        Ok(self.event(
            &p.note,
            4,
            3,
            self.tree.root(),
            Some((
                p.nullifier,
                p.balance,
                p.destination_owner,
                Some(p.deadline),
            )),
        ))
    }
    fn event(
        &self,
        n: &Note,
        op: u8,
        status: u8,
        old_root: Bytes32,
        details: Option<(Bytes32, u64, Bytes32, Option<u64>)>,
    ) -> Event {
        Event {
            pool: self.pool,
            sequence: self.sequence,
            op,
            note_id: n.id,
            status,
            old_root,
            new_root: self.tree.root(),
            commitment: n.commitment,
            deposit: n.deposit,
            expiry: n.expiry,
            exit_nullifier: details.map(|d| d.0),
            final_balance: details.map(|d| d.1),
            destination_owner: details.map(|d| d.2),
            deadline: details.and_then(|d| d.3),
        }
    }
    /// Must be supplied from authenticated finalized TreeState AND all live
    /// Note/Pending accounts at this same end-of-slot cut (or trusted full replay).
    pub fn reconcile(&mut self, state: &ChainState) -> Result<()> {
        let matches = !self.halted
            && self.config.is_some()
            && self.checkpoint == Some((state.slot, state.blockhash))
            && state.root == self.tree.root()
            && state.sequence == self.sequence
            && state.next_note_id == self.next_note_id
            && state.next_note_id <= 1u64 << 32
            && state.outstanding_deposits == self.outstanding
            && state.active == self.active
            && state.pending == self.pending;
        if !matches {
            self.halt();
            return Err(Error::State);
        }
        self.ready = true;
        Ok(())
    }
    /// Diagnostic view, NOT an independent chain observation and not an
    /// authorization/nullifier oracle. Useful for cross-checking a replay worker.
    pub fn replay_state(&self) -> Result<ChainState> {
        let (slot, blockhash) = self.checkpoint.ok_or(Error::Unavailable)?;
        Ok(ChainState {
            slot,
            blockhash,
            root: self.tree.root(),
            sequence: self.sequence,
            next_note_id: self.next_note_id,
            outstanding_deposits: self.outstanding,
            active: self.active.clone(),
            pending: self.pending.clone(),
        })
    }
}

#[cfg(test)]
#[path = "replay_history_tests.rs"]
mod history_tests;
