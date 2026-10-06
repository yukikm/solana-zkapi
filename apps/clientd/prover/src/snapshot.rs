//! Shared native/WASM path reconstruction. Only public snapshot data enters this
//! command; neither the selected ID nor the resulting path needs a network call.
use anyhow::{ensure, Result};
use ark_bn254::Fr;
use ark_ff::{PrimeField, Zero};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use zkapi_proof::groth16::{note_leaf, poseidon_hash};
use zkapi_solana_types::{FieldElement, MicroUsdc};

pub const MAX_NOTES: usize = 16_384;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotNote {
    pub note_id: String,
    pub commitment: FieldElement,
    pub deposit_micro_usdc: MicroUsdc,
    pub expiry: String,
}

fn node(left: Fr, right: Fr) -> Fr {
    // Original zkAPI domain and sponge, identical to the request circuit.
    poseidon_hash(&[Fr::from_be_bytes_mod_order(b"zkapi.v2.node"), left, right])
}

pub fn path(
    root: FieldElement,
    next_note_id: String,
    notes: Vec<SnapshotNote>,
    selected: u32,
) -> Result<Value> {
    let next = super::number(&next_note_id)?;
    ensure!(
        next <= 1u64 << 32 && u64::from(selected) < next,
        "snapshot ID"
    );
    ensure!(notes.len() <= MAX_NOTES, "snapshot note bound");
    let mut zeros = [Fr::zero(); 33];
    for level in 0..32 {
        zeros[level + 1] = node(zeros[level], zeros[level]);
    }
    let mut current = BTreeMap::new();
    let mut last = None;
    for item in notes {
        let id = u32::try_from(super::number(&item.note_id)?)?;
        ensure!(
            u64::from(id) < next && last.is_none_or(|old| id > old),
            "snapshot note order"
        );
        ensure!(item.deposit_micro_usdc.get() > 0, "snapshot empty note");
        let expiry = super::number(&item.expiry)?;
        ensure!(expiry > 0, "snapshot expiry");
        current.insert(
            id,
            note_leaf(
                id,
                item.commitment.to_field(),
                u128::from(item.deposit_micro_usdc.get()),
                expiry,
            ),
        );
        last = Some(id);
    }
    ensure!(
        current.contains_key(&selected),
        "active snapshot membership"
    );
    // Sparse levels never allocate proportional to next_note_id. Even a valid
    // u32::MAX leaf uses at most 32 ancestors. Each parent is hashed once.
    let mut siblings = Vec::with_capacity(32);
    for level in 0..32 {
        siblings.push(FieldElement::from(
            *current
                .get(&((selected >> level) ^ 1))
                .unwrap_or(&zeros[level]),
        ));
        let mut parents = BTreeMap::new();
        for &id in current.keys() {
            let parent = id >> 1;
            parents.entry(parent).or_insert_with(|| {
                node(
                    *current.get(&(parent << 1)).unwrap_or(&zeros[level]),
                    *current.get(&((parent << 1) | 1)).unwrap_or(&zeros[level]),
                )
            });
        }
        current = parents;
    }
    ensure!(
        current.get(&0).copied().unwrap_or(zeros[32]) == root.to_field(),
        "snapshot root mismatch"
    );
    Ok(json!({"root":root,"note_id":selected,"siblings":siblings}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zkapi_core::merkle::MerkleTree;
    use zkapi_proof::groth16::merkle_root;
    use zkapi_types::Felt252;

    fn note(id: u32) -> SnapshotNote {
        SnapshotNote {
            note_id: id.to_string(),
            commitment: Fr::from(42u64).into(),
            deposit_micro_usdc: MicroUsdc::new(100).unwrap(),
            expiry: "86400".into(),
        }
    }
    fn single_root(n: &SnapshotNote) -> FieldElement {
        let id = n.note_id.parse().unwrap();
        let mut zeros = [Fr::zero(); 32];
        for i in 1..32 {
            zeros[i] = node(zeros[i - 1], zeros[i - 1]);
        }
        merkle_root(
            id,
            note_leaf(id, n.commitment.to_field(), 100, 86400),
            &zeros,
        )
        .into()
    }
    #[test]
    fn paths_match_original_circuit_including_last_possible_leaf() {
        for id in [0, 37, u32::MAX] {
            let n = note(id);
            let root = single_root(&n);
            let value = path(root, (u64::from(id) + 1).to_string(), vec![n], id).unwrap();
            let siblings: [FieldElement; 32] =
                serde_json::from_value(value["siblings"].clone()).unwrap();
            assert_eq!(
                FieldElement::from(merkle_root(
                    id,
                    note_leaf(id, Fr::from(42u64), 100, 86400),
                    &siblings.map(FieldElement::to_field)
                )),
                root
            );
        }
    }
    #[test]
    fn multiple_note_paths_match_upstream_tree_and_detect_omission() {
        let notes: Vec<_> = [0, 1, 5, 37, 64].into_iter().map(note).collect();
        let mut upstream = MerkleTree::new();
        for n in &notes {
            let id = n.note_id.parse().unwrap();
            let leaf = FieldElement::from(note_leaf(id, n.commitment.to_field(), 100, 86400));
            upstream.set_leaf(id, Felt252::try_from_bytes_be(*leaf.as_bytes()).unwrap());
        }
        let root = FieldElement::from_bytes(*upstream.root().as_bytes()).unwrap();
        for id in [0, 1, 5, 37, 64] {
            let value = path(root, "65".into(), notes.clone(), id).unwrap();
            let siblings: [FieldElement; 32] =
                serde_json::from_value(value["siblings"].clone()).unwrap();
            assert_eq!(
                siblings.map(|f| *f.as_bytes()),
                upstream.get_siblings(id).map(|f| *f.as_bytes())
            );
        }
        let mut omitted = notes;
        omitted.remove(2);
        assert!(path(root, "65".into(), omitted, 0).is_err());
    }
    #[test]
    fn rejects_changed_omitted_duplicate_unsorted_or_noncanonical_notes() {
        let n = note(37);
        let root = single_root(&n);
        assert!(path(root, "38".into(), vec![], 37).is_err());
        assert!(path(Fr::from(1u64).into(), "38".into(), vec![n.clone()], 37).is_err());
        assert!(path(root, "38".into(), vec![n.clone(), n.clone()], 37).is_err());
        assert!(path(root, "38".into(), vec![n.clone(), note(1)], 37).is_err());
        assert!(path(root, "38".into(), vec![n.clone()], 1).is_err());
        assert!(path(root, "37".into(), vec![n.clone()], 37).is_err());
        assert!(path(root, "4294967297".into(), vec![n.clone()], 37).is_err());
        let mut changed = n.clone();
        changed.commitment = Fr::from(43u64).into();
        assert!(path(root, "38".into(), vec![changed], 37).is_err());
        let mut changed = n;
        changed.note_id = "037".into();
        assert!(path(root, "38".into(), vec![changed], 37).is_err());
    }
}
