//! Initialization authenticates the signing-key pair selected at build time.
//!
//! Generic Baby-JubJub subgroup validation takes over twelve million SBF CU for
//! two keys. This deployment therefore validates its exact public keys in
//! build.rs and authenticates their roles here. Changing either key requires a
//! corresponding build/new pool; arbitrary runtime-selected keys are rejected.
use crate::{deployment_keys, state::VaultError};
use anchor_lang::prelude::*;

pub fn validate_pair(state: &[u8; 64], clearance: &[u8; 64]) -> Result<()> {
    for key in [state, clearance] {
        for coordinate in key.chunks_exact(32) {
            zkapi_layout2::canonical(coordinate.try_into().unwrap())
                .map_err(|_| error!(VaultError::InvalidField))?;
        }
    }
    require!(
        state == &deployment_keys::STATE_KEY && clearance == &deployment_keys::CLEARANCE_KEY,
        VaultError::InvalidBinding
    );
    Ok(())
}

#[cfg(test)]
#[path = "key_validation.rs"]
mod key_validation;

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::{AffineRepr, CurveGroup};
    use ark_ed_on_bn254::{EdwardsAffine, EdwardsProjective, Fq, Fr};
    use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField, Zero};
    use key_validation::{validate, KeyError};

    fn wire(point: EdwardsAffine) -> [u8; 64] {
        let mut bytes = [0; 64];
        bytes[..32].copy_from_slice(&point.x.into_bigint().to_bytes_be());
        bytes[32..].copy_from_slice(&point.y.into_bigint().to_bytes_be());
        bytes
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
        assert_eq!(
            validate(&wire(EdwardsAffine::zero())),
            Err(KeyError::InvalidPoint)
        );
        assert_eq!(validate(&[0; 64]), Err(KeyError::InvalidPoint));
        let mut raw = wire(EdwardsAffine::generator());
        raw[..32].copy_from_slice(&Fq::MODULUS.to_bytes_be());
        assert_eq!(validate(&raw), Err(KeyError::InvalidField));
        let mut raw = wire(EdwardsAffine::generator());
        raw[32..].fill(255);
        assert_eq!(validate(&raw), Err(KeyError::InvalidField));
    }

    #[test]
    fn rejects_torsion_and_mixed_order_points_without_clearing_them() {
        let torsion = EdwardsAffine::new_unchecked(Fq::ZERO, -Fq::ONE);
        assert!(torsion.is_on_curve());
        assert!(!torsion.is_in_correct_subgroup_assuming_on_curve());
        assert_eq!(validate(&wire(torsion)), Err(KeyError::InvalidPoint));
        let mixed = (EdwardsProjective::from(EdwardsAffine::generator()) + torsion).into_affine();
        assert!(mixed.is_on_curve());
        assert!(!mixed.is_in_correct_subgroup_assuming_on_curve());
        assert_eq!(validate(&wire(mixed)), Err(KeyError::InvalidPoint));
        // Exercise the full 8-torsion component, not just its order-2 point.
        let full_order = (0u64..128)
            .filter_map(|y| EdwardsAffine::get_point_from_y_unchecked(Fq::from(y), false))
            .find(|point| {
                let torsion = point.mul_bigint(Fr::MODULUS);
                !torsion.double().double().is_zero()
            })
            .expect("a point with order divisible by eight");
        assert_eq!(validate(&wire(full_order)), Err(KeyError::InvalidPoint));
    }

    #[test]
    fn build_keys_are_valid_and_runtime_roles_are_exact() {
        let state = deployment_keys::STATE_KEY;
        let clearance = deployment_keys::CLEARANCE_KEY;
        assert_eq!(validate(&state), Ok(()));
        assert_eq!(validate(&clearance), Ok(()));
        assert!(validate_pair(&state, &clearance).is_ok());
        assert!(validate_pair(&clearance, &state).is_err());
        let other_valid = wire(EdwardsAffine::generator());
        assert_eq!(validate(&other_valid), Ok(()));
        assert!(validate_pair(&other_valid, &clearance).is_err());
        assert!(validate_pair(&state, &other_valid).is_err());
    }
}
