//! Shared build-time and host-test validation of Baby-JubJub deployment keys.
//! This module is not compiled into the SBF program.
use ark_ed_on_bn254::{EdwardsAffine, Fq};
use ark_ff::{BigInt, PrimeField};

#[derive(Debug, PartialEq, Eq)]
pub enum KeyError {
    InvalidField,
    InvalidPoint,
}

fn coordinate(bytes: &[u8]) -> Result<Fq, KeyError> {
    let mut limbs = [0u64; 4];
    for (limb, chunk) in limbs.iter_mut().rev().zip(bytes.chunks_exact(8)) {
        *limb = u64::from_be_bytes(chunk.try_into().unwrap());
    }
    // from_bigint rejects >= modulus; from_be_bytes_mod_order would not.
    Fq::from_bigint(BigInt(limbs)).ok_or(KeyError::InvalidField)
}

pub fn validate(raw: &[u8; 64]) -> Result<(), KeyError> {
    let point = EdwardsAffine::new_unchecked(coordinate(&raw[..32])?, coordinate(&raw[32..])?);
    if point.is_zero() || !point.is_on_curve() || !point.is_in_correct_subgroup_assuming_on_curve()
    {
        return Err(KeyError::InvalidPoint);
    }
    Ok(())
}
