//! Host-only tree prover. Never link this crate or its setup code into SBF.
pub mod circuit;
pub mod profile;
use ark_bn254::{Bn254, Fr};
use ark_ff::PrimeField;
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey, VerifyingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_serialize::CanonicalDeserialize;
pub use circuit::TreeCircuit;
use rand::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use zkapi_layout2::{canonical, Field, TreeUpdate};
use zkapi_solana_crypto::{decode_upstream_proof, encode_upstream_proof};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid witness or public input")]
    Witness,
    #[error("key hash or encoding mismatch")]
    Key,
    #[error("proof verification failed")]
    Proof,
}
pub fn field(b: &Field) -> Result<Fr, Error> {
    canonical(b).map_err(|_| Error::Witness)?;
    Ok(Fr::from_be_bytes_mod_order(b))
}
#[derive(Clone, Copy)]
pub struct TreeRequest {
    pub vault: Field,
    pub old_root: Field,
    pub id: u32,
    pub commitment: Field,
    pub deposit: u64,
    pub expiry: u64,
    pub op: u8,
}
pub fn prepare(request: TreeRequest, siblings: [Field; 32]) -> Result<TreeCircuit, Error> {
    use zkapi_poseidon::{domain, hash_fields, leaf, root};
    if request.op > 2 {
        return Err(Error::Witness);
    }
    let siblings = siblings
        .map(|b| field(&b))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .try_into()
        .unwrap();
    let l = leaf(
        request.id,
        field(&request.commitment)?,
        request.deposit,
        request.expiry,
    );
    let (old, new) = if request.op == 1 {
        (l, Fr::from(0))
    } else {
        (Fr::from(0), l)
    };
    if root(request.id, old, &siblings) != field(&request.old_root)? {
        return Err(Error::Witness);
    }
    let mut public = [
        field(&request.vault)?,
        field(&request.old_root)?,
        root(request.id, new, &siblings),
        Fr::from(request.id),
        old,
        new,
        field(&request.commitment)?,
        Fr::from(request.deposit),
        Fr::from(request.expiry),
        Fr::from(request.op),
        Fr::from(0),
    ];
    let mut tag = [Fr::from(0); 11];
    tag[0] = domain(b"solana.zkapi.tree.v1");
    tag[1..].copy_from_slice(&public[..10]);
    public[10] = hash_fields(&tag);
    Ok(TreeCircuit { public, siblings })
}
pub fn satisfied(c: &TreeCircuit) -> bool {
    let cs = ConstraintSystem::new_ref();
    c.clone().generate_constraints(cs.clone()).is_ok() && cs.is_satisfied().unwrap_or(false)
}
pub fn load_pk(bytes: &[u8], expected_sha256: &Field) -> Result<ProvingKey<Bn254>, Error> {
    if Sha256::digest(bytes).as_slice() != expected_sha256 {
        return Err(Error::Key);
    }
    let mut data = bytes;
    let key = ProvingKey::deserialize_compressed(&mut data).map_err(|_| Error::Key)?;
    if !data.is_empty() || key.vk.gamma_abc_g1.len() != 12 {
        return Err(Error::Key);
    }
    Ok(key)
}
pub fn prove(
    c: TreeCircuit,
    pk: &ProvingKey<Bn254>,
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<TreeUpdate, Error> {
    if !satisfied(&c) {
        return Err(Error::Witness);
    }
    let public = c.public.map(zkapi_poseidon::bytes);
    let proof = Groth16::<Bn254>::create_random_proof_with_reduction(c, pk, rng)
        .map_err(|_| Error::Proof)?;
    let update = TreeUpdate {
        public,
        proof: encode_upstream_proof(&proof),
    };
    verify(&update, &pk.vk)?;
    Ok(update)
}
pub fn verify(update: &TreeUpdate, vk: &VerifyingKey<Bn254>) -> Result<(), Error> {
    if vk.gamma_abc_g1.len() != 12 {
        return Err(Error::Key);
    }
    let inputs = update
        .public
        .iter()
        .map(field)
        .collect::<Result<Vec<_>, _>>()?;
    let proof = decode_upstream_proof(&update.proof).map_err(|_| Error::Proof)?;
    if !Groth16::<Bn254>::verify_proof(&prepare_verifying_key(vk), &proof, &inputs)
        .map_err(|_| Error::Proof)?
    {
        return Err(Error::Proof);
    }
    Ok(())
}
