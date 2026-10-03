//! Fixed-width, allocation-free implementation of the ORIGINAL zkAPI sponge.
//! Capacity 1, rate 2, alpha 5, 8 full / 57 partial rounds; no syscall substitution.
#![no_std]
use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, Field, PrimeField};
mod constants;

#[inline(never)]
fn permute(state: &mut [Fr; 3]) {
    for (round, constants) in constants::ARK.iter().enumerate() {
        for (s, c) in state.iter_mut().zip(constants) {
            *s += c;
        }
        for s in state
            .iter_mut()
            .take(if !(4..61).contains(&round) { 3 } else { 1 })
        {
            *s *= s.square().square();
        }
        let old = *state;
        for (s, row) in state.iter_mut().zip(constants::MDS) {
            #[cfg(not(feature = "research-dot-product"))]
            {
                *s = row[0] * old[0] + row[1] * old[1] + row[2] * old[2];
            }
            #[cfg(feature = "research-dot-product")]
            {
                *s = Fr::sum_of_products(&row, &old);
            }
        }
    }
}

pub fn hash_fields(inputs: &[Fr]) -> Fr {
    let mut state = [Fr::ZERO; 3];
    for chunk in inputs.chunks(2) {
        for (i, value) in chunk.iter().enumerate() {
            state[1 + i] += value;
        }
        permute(&mut state);
    }
    if inputs.is_empty() {
        permute(&mut state);
    }
    state[1]
}
pub fn domain(label: &[u8]) -> Fr {
    Fr::from_be_bytes_mod_order(label)
}
pub fn node(left: Fr, right: Fr) -> Fr {
    hash_fields(&[domain(b"zkapi.v2.node"), left, right])
}
pub fn leaf(id: u32, commitment: Fr, deposit: u64, expiry: u64) -> Fr {
    hash_fields(&[
        domain(b"zkapi.v2.leaf"),
        Fr::from(id),
        commitment,
        Fr::from(deposit),
        Fr::from(expiry),
    ])
}
pub fn root(id: u32, mut leaf: Fr, siblings: &[Fr; 32]) -> Fr {
    for (i, s) in siblings.iter().enumerate() {
        leaf = if (id >> i) & 1 == 0 {
            node(leaf, *s)
        } else {
            node(*s, leaf)
        };
    }
    leaf
}
pub fn bytes(f: Fr) -> [u8; 32] {
    // Avoid BigInteger::to_bytes_be's heap allocation in SBF.
    let mut out = [0; 32];
    for (i, limb) in f.into_bigint().as_ref().iter().rev().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_be_bytes());
    }
    out
}
pub fn parse(b: &[u8; 32]) -> Option<Fr> {
    let f = Fr::from_be_bytes_mod_order(b);
    (bytes(f) == *b).then_some(f)
}
#[cfg(test)]
extern crate std;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_sponge_for_all_absorption_boundaries() {
        for n in 0..=16 {
            for salt in [Fr::ZERO, -Fr::from(1), Fr::from(u64::MAX)] {
                let input: std::vec::Vec<_> = (0..n).map(|i| salt + Fr::from(i as u64)).collect();
                assert_eq!(
                    hash_fields(&input),
                    zkapi_core::v2::hash_fields(&input),
                    "length {n}"
                );
            }
        }
    }
    #[test]
    fn canonical_encoding_and_tree_boundaries_match_upstream() {
        use ark_ff::BigInteger;
        use core::{felt_to_field, field_to_felt};
        use zkapi_core::v2 as core;
        for value in [Fr::ZERO, -Fr::from(1), Fr::from(u64::MAX)] {
            assert_eq!(parse(&bytes(value)), Some(value));
        }
        assert!(parse(&Fr::MODULUS.to_bytes_be().try_into().unwrap()).is_none());
        let zeros = core::zero_hashes();
        let path = std::array::from_fn(|i| zeros[i]);
        let siblings = path.map(|x| felt_to_field(&x));
        for id in [0, 1, u32::MAX] {
            let l = leaf(id, Fr::from(42), u64::MAX, u64::MAX);
            assert_eq!(
                field_to_felt(&l),
                core::note_leaf(
                    id,
                    &field_to_felt(&Fr::from(42)),
                    u64::MAX as u128,
                    u64::MAX
                )
            );
            assert_eq!(
                field_to_felt(&root(id, l, &siblings)),
                core::merkle_root(id, &field_to_felt(&l), &path)
            );
        }
    }
}
