//! Complete private replay checkpoint, separate from public tree snapshots.
//! The checksum is local storage integrity, not proof that state came from a
//! chain. Callers must authenticate protected checkpoint storage and its archive
//! prefix, then reconcile fresh finalized accounts before serving any result.
use super::*;
use crate::canonical;
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 256 * 1024 * 1024;
const DOMAIN: &str = "zkapi-indexer-private-replay-v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedConfig {
    binding: Bytes32,
    ttl: u64,
    challenge: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedBuffer {
    address: Bytes32,
    generation: Position,
    uploader: Bytes32,
    rent_payer: Bytes32,
    op: u8,
    len: usize,
    digest: Bytes32,
    expires: u64,
    bytes: Vec<u8>,
    sealed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    domain: String,
    program: Bytes32,
    pool: Bytes32,
    slot: u64,
    blockhash: Bytes32,
    config: Option<SavedConfig>,
    root: Bytes32,
    active: Vec<Note>,
    pending: Vec<Pending>,
    exits: Vec<Bytes32>,
    buffers: Vec<SavedBuffer>,
    sequence: u64,
    next_note_id: u64,
    outstanding: u64,
    // Hex keeps large digest histories compact. Arrays preserve strict ordering
    // and make duplicate-key loss impossible during deserialization.
    blocks: Vec<(u64, String)>,
    last_transition: Option<Position>,
    block_transitions: Vec<(Position, Event)>,
}

fn require(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::Snapshot)
    }
}
fn ordered<T: Ord>(items: impl IntoIterator<Item = T>) -> bool {
    let mut previous = None;
    for item in items {
        if previous.as_ref().is_some_and(|old| old >= &item) {
            return false;
        }
        previous = Some(item);
    }
    true
}
fn field(value: Bytes32) -> Result<()> {
    canonical(value).map(|_| ()).map_err(|_| Error::Snapshot)
}
impl Saved {
    fn position(&self, value: &Position) -> Result<()> {
        require(
            value.slot <= self.slot
                && self
                    .blocks
                    .binary_search_by_key(&value.slot, |b| b.0)
                    .is_ok()
                && !value.signature.is_empty()
                && value.signature.len() <= 128,
        )
    }
    fn validate(&self) -> Result<Tree> {
        require(
            self.domain == DOMAIN
                && self.next_note_id <= 1u64 << 32
                && self.sequence >= self.next_note_id
                && self.blocks.last().map(|b| b.0) == Some(self.slot)
                && ordered(self.blocks.iter().map(|b| b.0)),
        )?;
        for (_, digest) in &self.blocks {
            require(
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            )?;
        }
        field(self.root)?;
        if let Some(c) = &self.config {
            field(c.binding)?;
            require(c.ttl > 0 && c.challenge > 0)?;
        } else {
            require(
                self.active.is_empty()
                    && self.pending.is_empty()
                    && self.exits.is_empty()
                    && self.buffers.is_empty()
                    && self.sequence == 0
                    && self.next_note_id == 0
                    && self.last_transition.is_none()
                    && self.block_transitions.is_empty(),
            )?;
        }
        require(
            ordered(self.active.iter().map(|n| n.id))
                && ordered(self.pending.iter().map(|p| p.note.id))
                && ordered(self.exits.iter())
                && ordered(self.buffers.iter().map(|b| b.address)),
        )?;
        let mut tree = Tree::new();
        let mut outstanding = 0u64;
        for n in &self.active {
            require(u64::from(n.id) < self.next_note_id)?;
            tree.update(n.id, n.leaf().map_err(|_| Error::Snapshot)?)?;
            outstanding = outstanding.checked_add(n.deposit).ok_or(Error::Snapshot)?;
        }
        for p in &self.pending {
            p.note.leaf().map_err(|_| Error::Snapshot)?;
            field(p.old_root)?;
            field(p.nullifier)?;
            require(
                u64::from(p.note.id) < self.next_note_id
                    && p.balance <= p.note.deposit
                    && p.deadline > 0
                    && self
                        .active
                        .binary_search_by_key(&p.note.id, |n| n.id)
                        .is_err()
                    && self.exits.binary_search(&p.nullifier).is_ok(),
            )?;
            outstanding = outstanding
                .checked_add(p.note.deposit)
                .ok_or(Error::Snapshot)?;
        }
        require(outstanding == self.outstanding && tree.root() == self.root)?;
        for n in &self.exits {
            field(*n)?;
        }
        for b in &self.buffers {
            self.position(&b.generation)?;
            let op = Operation::from_byte(b.op).map_err(|_| Error::Snapshot)?;
            require(
                b.len == op.payload_len()
                    && b.len <= 4096
                    && b.bytes.len() <= b.len
                    && b.expires > 0
                    && (!b.sealed || (b.bytes.len() == b.len && sha(&b.bytes) == b.digest)),
            )?;
        }
        if let Some(p) = &self.last_transition {
            self.position(p)?;
        }
        require((self.sequence == 0) == self.last_transition.is_none())?;
        let mut previous: Option<(&Position, &Event)> = None;
        for (p, e) in &self.block_transitions {
            self.position(p)?;
            require(
                p.slot == self.slot
                    && e.pool == self.pool
                    && u64::from(e.note_id) < self.next_note_id
                    && e.sequence > 0
                    && e.sequence <= self.sequence
                    && matches!(
                        (e.op, e.status),
                        (0, 1) | (1, 3) | (2, 2) | (3, 1) | (4, 3) | (5, 3)
                    ),
            )?;
            Note {
                id: e.note_id,
                commitment: e.commitment,
                deposit: e.deposit,
                expiry: e.expiry,
            }
            .leaf()
            .map_err(|_| Error::Snapshot)?;
            field(e.old_root)?;
            field(e.new_root)?;
            if let Some(n) = e.exit_nullifier {
                field(n)?;
            }
            require(e.final_balance.is_none_or(|balance| balance <= e.deposit))?;
            if let Some((last_p, last_e)) = previous {
                require(
                    last_p < p
                        && last_e.sequence.checked_add(1) == Some(e.sequence)
                        && last_e.new_root == e.old_root,
                )?;
            }
            previous = Some((p, e));
        }
        if let Some((p, e)) = previous {
            require(
                Some(p) == self.last_transition.as_ref()
                    && e.sequence == self.sequence
                    && e.new_root == self.root,
            )?;
        }
        Ok(tree)
    }
}

impl Indexer {
    /// Serialize complete private state at the current accepted block. The
    /// caller persists this atomically with its protected archive-prefix anchor.
    /// Unlike public snapshots this also retains unexecuted buffer generations,
    /// spent nullifiers and every accepted block digest. A halted index cannot
    /// be saved. Readiness is deliberately not persisted.
    pub fn checkpoint_bytes(&self) -> Result<Vec<u8>> {
        require(!self.halted)?;
        let (slot, blockhash) = self.checkpoint.ok_or(Error::Unavailable)?;
        let saved = Saved {
            domain: DOMAIN.into(),
            program: self.program,
            pool: self.pool,
            slot,
            blockhash,
            config: self.config.as_ref().map(|c| SavedConfig {
                binding: c.binding,
                ttl: c.ttl,
                challenge: c.challenge,
            }),
            root: self.tree.root(),
            active: self.active.values().cloned().collect(),
            pending: self.pending.values().cloned().collect(),
            exits: self.exits.iter().copied().collect(),
            buffers: self
                .buffers
                .iter()
                .map(|(address, b)| SavedBuffer {
                    address: *address,
                    generation: b.generation.clone(),
                    uploader: b.uploader,
                    rent_payer: b.rent_payer,
                    op: b.op as u8,
                    len: b.len,
                    digest: b.digest,
                    expires: b.expires,
                    bytes: b.bytes.clone(),
                    sealed: b.sealed,
                })
                .collect(),
            sequence: self.sequence,
            next_note_id: self.next_note_id,
            outstanding: self.outstanding,
            blocks: self
                .blocks
                .iter()
                .map(|(slot, digest)| (*slot, hex::encode(digest)))
                .collect(),
            last_transition: self.last_transition.clone(),
            block_transitions: self.block_transitions.clone(),
        };
        saved.validate()?;
        let bytes = serde_json::to_vec(&saved).map_err(|_| Error::Snapshot)?;
        require(bytes.len() <= MAX_BYTES)?;
        Ok(bytes)
    }

    /// Restore trusted local replay state bound to an independently authenticated
    /// retained-archive cut. A matching self-supplied checksum alone is not chain
    /// authentication. Missing/invalid checkpoints must use ordinary full replay.
    /// Restored state is unavailable until existing finalized reconciliation.
    pub fn restore_checkpoint(
        bytes: &[u8],
        expected_sha256: Bytes32,
        program: Bytes32,
        pool: Bytes32,
        expected_slot: u64,
        expected_blockhash: Bytes32,
    ) -> Result<Self> {
        require(bytes.len() <= MAX_BYTES && sha(bytes) == expected_sha256)?;
        let saved: Saved = serde_json::from_slice(bytes).map_err(|_| Error::Snapshot)?;
        require(
            saved.program == program
                && saved.pool == pool
                && saved.slot == expected_slot
                && saved.blockhash == expected_blockhash
                && serde_json::to_vec(&saved).map_err(|_| Error::Snapshot)? == bytes,
        )?;
        let tree = saved.validate()?;
        let blocks = saved
            .blocks
            .into_iter()
            .map(|(slot, h)| {
                let hash: Bytes32 = hex::decode(h)
                    .map_err(|_| Error::Snapshot)?
                    .try_into()
                    .map_err(|_| Error::Snapshot)?;
                Ok((slot, hash))
            })
            .collect::<Result<_>>()?;
        let buffers = saved
            .buffers
            .into_iter()
            .map(|b| {
                Ok((
                    b.address,
                    Buffer {
                        generation: b.generation,
                        uploader: b.uploader,
                        rent_payer: b.rent_payer,
                        op: Operation::from_byte(b.op).map_err(|_| Error::Snapshot)?,
                        len: b.len,
                        digest: b.digest,
                        expires: b.expires,
                        bytes: b.bytes,
                        sealed: b.sealed,
                    },
                ))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            program,
            pool,
            config: saved.config.map(|c| Config {
                binding: c.binding,
                ttl: c.ttl,
                challenge: c.challenge,
            }),
            tree,
            active: saved.active.into_iter().map(|n| (n.id, n)).collect(),
            pending: saved.pending.into_iter().map(|p| (p.note.id, p)).collect(),
            exits: saved.exits.into_iter().collect(),
            buffers,
            sequence: saved.sequence,
            next_note_id: saved.next_note_id,
            outstanding: saved.outstanding,
            checkpoint: Some((saved.slot, saved.blockhash)),
            blocks,
            ready: false,
            halted: false,
            last_transition: saved.last_transition,
            block_transitions: saved.block_transitions,
        })
    }
}

#[cfg(test)]
#[path = "replay_checkpoint_tests.rs"]
mod tests;
