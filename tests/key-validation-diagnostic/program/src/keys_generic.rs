//! Initialization checks for the original Baby-JubJub signing keys.
//!
//! Coordinates use the BN254 scalar field; the point order is the distinct
//! Baby-JubJub scalar modulus. Never cofactor-clear an untrusted key: doing so
//! would silently replace the configured signing key.
use anchor_lang::prelude::*;
use ark_ed_on_bn254::{EdwardsAffine, Fq};
use ark_ff::{BigInt, PrimeField};

use crate::state::VaultError;

fn coordinate(bytes: &[u8]) -> Result<Fq> {
    let mut limbs = [0u64; 4];
    for (limb, chunk) in limbs.iter_mut().rev().zip(bytes.chunks_exact(8)) {
        *limb = u64::from_be_bytes(chunk.try_into().unwrap());
    }
    // from_bigint rejects >= modulus; from_be_bytes_mod_order would not.
    Fq::from_bigint(BigInt(limbs)).ok_or_else(|| error!(VaultError::InvalidField))
}

#[inline(never)]
pub fn validate(raw: &[u8; 64]) -> Result<()> {
    let point = EdwardsAffine::new_unchecked(coordinate(&raw[..32])?, coordinate(&raw[32..])?);
    require!(
        !point.is_zero() && point.is_on_curve(),
        VaultError::InvalidBinding
    );
    require!(
        point.is_in_correct_subgroup_assuming_on_curve(),
        VaultError::InvalidBinding
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::{AffineRepr, CurveGroup};
    use ark_ed_on_bn254::{EdwardsProjective, Fr};
    use ark_ff::{AdditiveGroup, BigInteger, Field, Zero};

    fn wire(point: EdwardsAffine) -> [u8; 64] {
        let mut bytes = [0; 64];
        bytes[..32].copy_from_slice(&point.x.into_bigint().to_bytes_be());
        bytes[32..].copy_from_slice(&point.y.into_bigint().to_bytes_be());
        bytes
    }

    fn error_code(raw: [u8; 64]) -> u32 {
        match validate(&raw).unwrap_err() {
            anchor_lang::error::Error::AnchorError(error) => error.error_code_number,
            error => panic!("unexpected error: {error}"),
        }
    }

    #[test]
    fn canonical_subgroup_keys_match_original_arkworks() {
        let generator = EdwardsAffine::generator();
        for scalar in [1u64, 2, 3, 17, u32::MAX as u64, u64::MAX] {
            let point = (generator * Fr::from(scalar)).into_affine();
            assert!(validate(&wire(point)).is_ok());
            assert!(validate(&wire(-point)).is_ok());
        }
    }

    #[test]
    fn rejects_identity_offcurve_and_noncanonical_coordinates() {
        assert_eq!(error_code(wire(EdwardsAffine::zero())), 6001);
        assert_eq!(error_code([0; 64]), 6001);
        let mut raw = wire(EdwardsAffine::generator());
        raw[..32].copy_from_slice(&Fq::MODULUS.to_bytes_be());
        assert_eq!(error_code(raw), 6004);
        let mut raw = wire(EdwardsAffine::generator());
        raw[32..].fill(255);
        assert_eq!(error_code(raw), 6004);
    }

    #[test]
    fn rejects_torsion_and_mixed_order_points_without_clearing_them() {
        let torsion = EdwardsAffine::new_unchecked(Fq::ZERO, -Fq::ONE);
        assert!(torsion.is_on_curve());
        assert!(!torsion.is_in_correct_subgroup_assuming_on_curve());
        assert_eq!(error_code(wire(torsion)), 6001);
        let mixed = (EdwardsProjective::from(EdwardsAffine::generator()) + torsion).into_affine();
        assert!(mixed.is_on_curve());
        assert!(!mixed.is_in_correct_subgroup_assuming_on_curve());
        assert_eq!(error_code(wire(mixed)), 6001);
        // Exercise the full 8-torsion component, not just its order-2 point.
        let full_order = (0u64..128)
            .filter_map(|y| EdwardsAffine::get_point_from_y_unchecked(Fq::from(y), false))
            .find(|point| {
                let torsion = point.mul_bigint(Fr::MODULUS);
                !torsion.double().double().is_zero()
            })
            .expect("a point with order divisible by eight");
        assert_eq!(error_code(wire(full_order)), 6001);
    }
}
