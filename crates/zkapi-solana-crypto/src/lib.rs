//! Native adapter for the pinned Arkworks 0.5 circuit and groth16-solana.
//! Passing host verification does not establish SBF compatibility or CU cost.
use ark_bn254::{Bn254, Fq, Fq2, G1Affine, G2Affine};
use ark_ff::PrimeField;
use ark_groth16::{Proof, VerifyingKey};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use zkapi_solana_types::{field::field_bytes, FieldElement};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("proof must contain eight 32-byte coordinates")]
    InvalidLength,
    #[error("noncanonical BN254 coordinate")]
    InvalidCoordinate,
    #[error("invalid curve or subgroup point")]
    InvalidPoint,
    #[error("verifying key input count mismatch")]
    InvalidKey,
    #[error("Groth16 verification failed")]
    InvalidProof,
}

fn fq(bytes: &[u8]) -> Result<Fq, Error> {
    let value = Fq::from_be_bytes_mod_order(bytes);
    if field_bytes(value).as_slice() != bytes {
        return Err(Error::InvalidCoordinate);
    }
    Ok(value)
}

fn valid_g1(p: &G1Affine) -> bool {
    p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve()
}
fn valid_g2(p: &G2Affine) -> bool {
    p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve()
}

/// Decode exactly the upstream uncompressed BE wire order, with no reduction.
pub fn decode_upstream_proof(bytes: &[u8]) -> Result<Proof<Bn254>, Error> {
    if bytes.len() != 256 {
        return Err(Error::InvalidLength);
    }
    let c = bytes
        .chunks_exact(32)
        .map(fq)
        .collect::<Result<Vec<_>, _>>()?;
    let a = G1Affine::new_unchecked(c[0], c[1]);
    let b = G2Affine::new_unchecked(Fq2::new(c[2], c[3]), Fq2::new(c[4], c[5]));
    let c = G1Affine::new_unchecked(c[6], c[7]);
    if !valid_g1(&a) || !valid_g2(&b) || !valid_g1(&c) {
        return Err(Error::InvalidPoint);
    }
    Ok(Proof { a, b, c })
}

pub fn encode_upstream_proof(proof: &Proof<Bn254>) -> [u8; 256] {
    let values = [
        proof.a.x,
        proof.a.y,
        proof.b.x.c0,
        proof.b.x.c1,
        proof.b.y.c0,
        proof.b.y.c1,
        proof.c.x,
        proof.c.y,
    ];
    let mut bytes = [0; 256];
    for (out, value) in bytes.chunks_exact_mut(32).zip(values) {
        out.copy_from_slice(&field_bytes(value));
    }
    bytes
}

fn g1_bytes(point: G1Affine) -> [u8; 64] {
    let mut bytes = [0; 64];
    bytes[..32].copy_from_slice(&field_bytes(point.x));
    bytes[32..].copy_from_slice(&field_bytes(point.y));
    bytes
}

fn g2_bytes(point: G2Affine) -> [u8; 128] {
    // Solana/EIP-197 order is c1,c0 for each Fq2 coordinate.
    let mut bytes = [0; 128];
    for (out, value) in bytes
        .chunks_exact_mut(32)
        .zip([point.x.c1, point.x.c0, point.y.c1, point.y.c0])
    {
        out.copy_from_slice(&field_bytes(value));
    }
    bytes
}

/// Deliberately not accepted as input to `from_upstream`: A is negated once.
pub struct SolanaProof {
    pub a_neg: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

impl SolanaProof {
    pub fn from_upstream(bytes: &[u8]) -> Result<Self, Error> {
        let proof = decode_upstream_proof(bytes)?;
        Ok(Self {
            a_neg: g1_bytes(-proof.a),
            b: g2_bytes(proof.b),
            c: g1_bytes(proof.c),
        })
    }
}

/// Build-time/test export only. A production program must embed pinned keys.
pub struct SolanaVerifyingKey {
    alpha: [u8; 64],
    beta: [u8; 128],
    gamma: [u8; 128],
    delta: [u8; 128],
    ic: Vec<[u8; 64]>,
}

impl SolanaVerifyingKey {
    pub fn from_arkworks(key: &VerifyingKey<Bn254>) -> Result<Self, Error> {
        if key.gamma_abc_g1.is_empty()
            || !valid_g1(&key.alpha_g1)
            || !valid_g2(&key.beta_g2)
            || !valid_g2(&key.gamma_g2)
            || !valid_g2(&key.delta_g2)
            || !key.gamma_abc_g1.iter().all(valid_g1)
        {
            return Err(Error::InvalidKey);
        }
        Ok(Self {
            alpha: g1_bytes(key.alpha_g1),
            beta: g2_bytes(key.beta_g2),
            gamma: g2_bytes(key.gamma_g2),
            delta: g2_bytes(key.delta_g2),
            ic: key.gamma_abc_g1.iter().copied().map(g1_bytes).collect(),
        })
    }

    /// Borrow converted bytes for a build-time VK exporter or SVM test harness.
    /// Production programs must embed and pin the exported key, not accept it
    /// from an untrusted account or instruction argument.
    pub fn as_verifying_key(&self) -> Groth16Verifyingkey<'_> {
        Groth16Verifyingkey {
            nr_pubinputs: self.ic.len() - 1,
            vk_alpha_g1: self.alpha,
            vk_beta_g2: self.beta,
            vk_gamme_g2: self.gamma,
            vk_delta_g2: self.delta,
            vk_ic: &self.ic,
        }
    }

    pub fn verify<const N: usize>(
        &self,
        proof: &SolanaProof,
        inputs: &[FieldElement; N],
    ) -> Result<(), Error> {
        if self.ic.len() != N + 1 {
            return Err(Error::InvalidKey);
        }
        let key = self.as_verifying_key();
        let inputs = inputs.map(|f| *f.as_bytes());
        Groth16Verifier::new(&proof.a_neg, &proof.b, &proof.c, &inputs, &key)
            .map_err(|_| Error::InvalidProof)?
            .verify()
            .map_err(|_| Error::InvalidProof)
    }
}
