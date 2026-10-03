//! Exact OpenAPI Root/Path/TreeSnapshotFile wire: integer strings, lowercase
//! canonical fields, JCS UTF-8 without newline. Hash verification is NOT trust.
use crate::{canonical, sha, tree::Tree, Bytes32, Error, Indexer, Note, Pending, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootView {
    pub pool: String,
    pub root: String,
    pub slot: String,
    pub blockhash: String,
    pub sequence: String,
    pub next_note_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathView {
    pub snapshot: RootView,
    pub note_id: String,
    pub leaf: String,
    pub siblings: [String; 32],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotNote {
    pub note_id: String,
    pub commitment: String,
    pub deposit_micro_usdc: String,
    pub expiry: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotPending {
    pub note_id: String,
    pub commitment: String,
    pub deposit_micro_usdc: String,
    pub expiry: String,
    pub nullifier: String,
    pub balance_micro_usdc: String,
    pub destination_owner: String,
    pub deadline: String,
    pub old_root: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeSnapshotFile {
    pub schema_version: String,
    pub snapshot: RootView,
    pub active_notes: Vec<SnapshotNote>,
    pub pending_withdrawals: Vec<SnapshotPending>,
}
pub fn field(value: Bytes32) -> String {
    format!("0x{}", hex::encode(value))
}
pub fn key(value: Bytes32) -> String {
    bs58::encode(value).into_string()
}
pub fn parse_key(value: &str) -> Result<Bytes32> {
    let bytes: Bytes32 = bs58::decode(value)
        .into_vec()
        .map_err(|_| Error::Snapshot)?
        .try_into()
        .map_err(|_| Error::Snapshot)?;
    if key(bytes) != value {
        return Err(Error::Snapshot);
    }
    Ok(bytes)
}
pub fn parse_field(value: &str) -> Result<Bytes32> {
    let bytes: Bytes32 = hex::decode(value.strip_prefix("0x").ok_or(Error::Snapshot)?)
        .map_err(|_| Error::Snapshot)?
        .try_into()
        .map_err(|_| Error::Snapshot)?;
    if field(bytes) != value {
        return Err(Error::Snapshot);
    }
    canonical(bytes)
}
fn integer(value: &str) -> Result<u64> {
    let number = value.parse::<u64>().map_err(|_| Error::Snapshot)?;
    if number.to_string() != value {
        return Err(Error::Snapshot);
    }
    Ok(number)
}
impl SnapshotNote {
    fn from_note(n: &Note) -> Self {
        Self {
            note_id: n.id.to_string(),
            commitment: field(n.commitment),
            deposit_micro_usdc: n.deposit.to_string(),
            expiry: n.expiry.to_string(),
        }
    }
    fn note(&self) -> Result<Note> {
        Ok(Note {
            id: u32::try_from(integer(&self.note_id)?).map_err(|_| Error::Snapshot)?,
            commitment: parse_field(&self.commitment)?,
            deposit: integer(&self.deposit_micro_usdc)?,
            expiry: integer(&self.expiry)?,
        })
    }
}
impl SnapshotPending {
    fn from_pending(p: &Pending) -> Self {
        Self {
            note_id: p.note.id.to_string(),
            commitment: field(p.note.commitment),
            deposit_micro_usdc: p.note.deposit.to_string(),
            expiry: p.note.expiry.to_string(),
            nullifier: field(p.nullifier),
            balance_micro_usdc: p.balance.to_string(),
            destination_owner: key(p.destination_owner),
            deadline: p.deadline.to_string(),
            old_root: field(p.old_root),
        }
    }
    fn pending(&self) -> Result<Pending> {
        Ok(Pending {
            note: SnapshotNote {
                note_id: self.note_id.clone(),
                commitment: self.commitment.clone(),
                deposit_micro_usdc: self.deposit_micro_usdc.clone(),
                expiry: self.expiry.clone(),
            }
            .note()?,
            nullifier: parse_field(&self.nullifier)?,
            balance: integer(&self.balance_micro_usdc)?,
            destination_owner: parse_key(&self.destination_owner)?,
            deadline: integer(&self.deadline)?,
            old_root: parse_field(&self.old_root)?,
        })
    }
}
impl Indexer {
    pub fn program(&self) -> Bytes32 {
        self.program
    }
    pub fn pool(&self) -> Bytes32 {
        self.pool
    }
    pub fn root(&self) -> Result<RootView> {
        if !self.is_ready() {
            return Err(Error::Unavailable);
        }
        let (slot, blockhash) = self.checkpoint.ok_or(Error::Unavailable)?;
        Ok(RootView {
            pool: key(self.pool),
            root: field(self.tree.root()),
            slot: slot.to_string(),
            blockhash: key(blockhash),
            sequence: self.sequence.to_string(),
            next_note_id: self.next_note_id.to_string(),
        })
    }
    /// Active note membership only; pending/deposit zero witnesses use zero_path.
    pub fn path(&self, id: u32) -> Result<PathView> {
        if !self.active.contains_key(&id) {
            return Err(Error::Unavailable);
        }
        self.path_view(id)
    }
    /// An authenticated Pending zero leaf or the one current deposit ID.
    /// Closed historical IDs and TreeFull's 2^32 sentinel cannot become deposits.
    pub fn zero_path(&self, id: u32) -> Result<PathView> {
        if (!self.pending.contains_key(&id) && self.next_note_id != u64::from(id))
            || self.tree.leaf(id) != [0; 32]
        {
            return Err(Error::Unavailable);
        }
        self.path_view(id)
    }
    fn path_view(&self, id: u32) -> Result<PathView> {
        Ok(PathView {
            snapshot: self.root()?,
            note_id: id.to_string(),
            leaf: field(self.tree.leaf(id)),
            siblings: self.tree.path(id).map(field),
        })
    }
    pub fn snapshot(&self) -> Result<TreeSnapshotFile> {
        Ok(TreeSnapshotFile {
            schema_version: "1".into(),
            snapshot: self.root()?,
            active_notes: self.active.values().map(SnapshotNote::from_note).collect(),
            pending_withdrawals: self
                .pending
                .values()
                .map(SnapshotPending::from_pending)
                .collect(),
        })
    }
    pub fn snapshot_bytes(&self) -> Result<Vec<u8>> {
        serde_jcs::to_vec(&self.snapshot()?).map_err(|_| Error::Snapshot)
    }
    /// Requires a separately trusted, reconciled replay at the snapshot's exact
    /// end-of-slot cut. Pending data, slot/blockhash and counters are all compared.
    /// Full successful buffer history is retained from that replay, not invented
    /// from account existence. No network/download or trust-on-first-use here.
    pub fn restore_snapshot(
        bytes: &[u8],
        expected_sha256: Bytes32,
        trusted: &Indexer,
    ) -> Result<Indexer> {
        if sha(bytes) != expected_sha256 || !trusted.is_ready() {
            return Err(Error::Snapshot);
        }
        let file: TreeSnapshotFile = serde_json::from_slice(bytes).map_err(|_| Error::Snapshot)?;
        if serde_jcs::to_vec(&file).map_err(|_| Error::Snapshot)? != bytes
            || file.schema_version != "1"
            || file.snapshot != trusted.root()?
        {
            return Err(Error::Snapshot);
        }
        let next = integer(&file.snapshot.next_note_id)?;
        if next > 1u64 << 32 {
            return Err(Error::Snapshot);
        }
        let mut tree = Tree::new();
        let mut active = BTreeMap::new();
        let mut pending = BTreeMap::new();
        let mut last = None;
        for item in &file.active_notes {
            let n = item.note()?;
            if u64::from(n.id) >= next || last.is_some_and(|id| n.id <= id) {
                return Err(Error::Snapshot);
            }
            tree.update(n.id, n.leaf()?)?;
            last = Some(n.id);
            active.insert(n.id, n);
        }
        last = None;
        for item in &file.pending_withdrawals {
            let p = item.pending()?;
            p.note.leaf()?;
            if p.balance > p.note.deposit
                || u64::from(p.note.id) >= next
                || active.contains_key(&p.note.id)
                || last.is_some_and(|id| p.note.id <= id)
            {
                return Err(Error::Snapshot);
            }
            last = Some(p.note.id);
            pending.insert(p.note.id, p);
        }
        if tree.root() != parse_field(&file.snapshot.root)?
            || active != trusted.active
            || pending != trusted.pending
        {
            return Err(Error::Snapshot);
        }
        let mut restored = trusted.clone();
        restored.tree = tree;
        restored.active = active;
        restored.pending = pending;
        Ok(restored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zkapi_layout2::integer;
    // Synthetic authenticated-cut fixtures cover wire boundaries independently
    // of the impractical task of executing 2^32 deposits in a unit test.
    fn full_tree_cut() -> Indexer {
        let mut index = Indexer::new([7; 32], [8; 32]);
        index.next_note_id = 1u64 << 32;
        index.sequence = 1u64 << 32;
        index.checkpoint = Some((123, [9; 32]));
        index.ready = true;
        let note = Note {
            id: u32::MAX,
            commitment: integer(42),
            deposit: 100,
            expiry: 86400,
        };
        index.tree.update(note.id, note.leaf().unwrap()).unwrap();
        index.active.insert(note.id, note);
        let note = Note {
            id: 5,
            commitment: integer(9),
            deposit: 77,
            expiry: 86400,
        };
        index.pending.insert(
            5,
            Pending {
                note,
                old_root: integer(12),
                nullifier: integer(13),
                balance: 70,
                destination_owner: [14; 32],
                deadline: 86401,
            },
        );
        index
    }
    #[test]
    fn snapshot_accepts_full_tree_sentinel_and_pending_zero_leaf() {
        let index = full_tree_cut();
        let raw = index.snapshot_bytes().unwrap();
        let restored = Indexer::restore_snapshot(&raw, sha(&raw), &index).unwrap();
        assert_eq!(restored.root().unwrap().next_note_id, "4294967296");
        assert!(restored.path(u32::MAX).is_ok());
        assert!(restored.zero_path(u32::MAX).is_err());
        assert!(restored.zero_path(5).is_ok());
    }
    #[test]
    fn snapshots_reject_duplicates_overlap_unsorted_ids_and_noncanonical_wire() {
        let index = full_tree_cut();
        let file = index.snapshot().unwrap();
        let mut cases = Vec::new();
        let mut duplicate = file.clone();
        duplicate
            .active_notes
            .push(duplicate.active_notes[0].clone());
        cases.push(duplicate);
        let mut overlap = file.clone();
        overlap.pending_withdrawals[0].note_id = u32::MAX.to_string();
        cases.push(overlap);
        let mut noncanonical = file.clone();
        noncanonical.active_notes[0].deposit_micro_usdc = "0100".into();
        cases.push(noncanonical);
        let mut nonfield = file.clone();
        nonfield.active_notes[0].commitment = field(zkapi_layout2::FR_MODULUS);
        cases.push(nonfield);
        let mut unsorted = file.clone();
        let mut lower = unsorted.active_notes[0].clone();
        lower.note_id = "7".into();
        unsorted.active_notes.push(lower);
        cases.push(unsorted);
        for case in cases {
            let bytes = serde_jcs::to_vec(&case).unwrap();
            assert!(Indexer::restore_snapshot(&bytes, sha(&bytes), &index).is_err());
        }
        let mut above = index;
        above.next_note_id += 1;
        let raw = above.snapshot_bytes().unwrap();
        assert!(Indexer::restore_snapshot(&raw, sha(&raw), &above).is_err());
    }
}
