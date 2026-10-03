//! Exact constraint construction extracted from the I02 research circuit.
use ark_bn254::Fr;
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar,
    poseidon::{constraints::PoseidonSpongeVar, find_poseidon_ark_and_mds, PoseidonConfig},
};
use ark_ff::{Field, PrimeField};
use ark_r1cs_std::{
    alloc::AllocVar,
    boolean::Boolean,
    convert::ToBitsGadget,
    eq::EqGadget,
    fields::{fp::FpVar, FieldVar},
    uint32::UInt32,
    uint64::UInt64,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
#[derive(Clone)]
pub struct TreeCircuit {
    pub public: [Fr; 11],
    pub siblings: [Fr; 32],
}
fn config() -> PoseidonConfig<Fr> {
    let (a, m) = find_poseidon_ark_and_mds::<Fr>(254, 2, 8, 57, 0);
    PoseidonConfig::new(8, 57, 5, m, a, 2, 1)
}
fn hash(cs: ConstraintSystemRef<Fr>, input: &[FpVar<Fr>]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut s = PoseidonSpongeVar::new(cs, &config());
    s.absorb(&input)?;
    Ok(s.squeeze_field_elements(1)?[0].clone())
}
fn d(label: &[u8]) -> FpVar<Fr> {
    FpVar::Constant(Fr::from_be_bytes_mod_order(label))
}
impl ConstraintSynthesizer<Fr> for TreeCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = self
            .public
            .iter()
            .map(|v| FpVar::new_input(cs.clone(), || Ok(*v)))
            .collect::<Result<Vec<_>, _>>()?;
        let id = UInt32::new_witness(cs.clone(), || Ok(self.public[3].into_bigint().0[0] as u32))?;
        Boolean::le_bits_to_fp(&id.to_bits_le()?)?.enforce_equal(&p[3])?;
        for i in [7, 8] {
            let value = UInt64::new_witness(cs.clone(), || Ok(self.public[i].into_bigint().0[0]))?;
            Boolean::le_bits_to_fp(&value.to_bits_le()?)?.enforce_equal(&p[i])?;
        }
        let op = &p[9];
        (op * (op - Fr::ONE) * (op - Fr::from(2))).enforce_equal(&FpVar::zero())?;
        let remove = op.is_eq(&FpVar::one())?;
        let leaf = hash(
            cs.clone(),
            &[
                d(b"zkapi.v2.leaf"),
                p[3].clone(),
                p[6].clone(),
                p[7].clone(),
                p[8].clone(),
            ],
        )?;
        remove.select(&leaf, &FpVar::zero())?.enforce_equal(&p[4])?;
        remove.select(&FpVar::zero(), &leaf)?.enforce_equal(&p[5])?;
        let bits = id.to_bits_le()?;
        let mut old = p[4].clone();
        let mut new = p[5].clone();
        for (level, s) in self.siblings.iter().enumerate() {
            let s = FpVar::new_witness(cs.clone(), || Ok(*s))?;
            for cur in [&mut old, &mut new] {
                let left = bits[level].select(&s, cur)?;
                let right = bits[level].select(cur, &s)?;
                *cur = hash(cs.clone(), &[d(b"zkapi.v2.node"), left, right])?;
            }
        }
        old.enforce_equal(&p[1])?;
        new.enforce_equal(&p[2])?;
        let mut tag = vec![d(b"solana.zkapi.tree.v1")];
        tag.extend_from_slice(&p[..10]);
        hash(cs, &tag)?.enforce_equal(&p[10])?;
        Ok(())
    }
}
