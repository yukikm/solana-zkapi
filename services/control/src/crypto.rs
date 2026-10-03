//! Request proof verification embeds the deployment's fixed request VK.
use crate::wire::{invalid, Result};
use ark_bn254::{Bn254, Fr};
use ark_ed_on_bn254::EdwardsAffine;
use ark_groth16::{prepare_verifying_key, Groth16, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use std::sync::OnceLock;
use zkapi_solana_types::FieldElement;
#[path = "../../../programs/zkapi-vault/src/deployment_keys.rs"]
pub mod deployment_keys;
pub const REQUEST_VK_HASH: &str =
    "8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97";
const REQUEST_VK: &[u8] =
    include_bytes!("../../../vendor/ethereum-zkapi/protocol/setup/v2/request.vk");
static KEY: OnceLock<ark_groth16::PreparedVerifyingKey<Bn254>> = OnceLock::new();
pub fn verify_request(inputs: &[FieldElement; 12], proof_bytes: &[u8]) -> Result<()> {
    let key = KEY.get_or_init(|| {
        assert_eq!(
            hex::encode(crate::wire::sha256(REQUEST_VK)),
            REQUEST_VK_HASH,
            "embedded request VK must match build pin"
        );
        let mut encoded = REQUEST_VK
            .strip_prefix(b"zkapi-v2-note-bound-v1\0")
            .expect("pinned VK header");
        let vk = VerifyingKey::<Bn254>::deserialize_compressed(&mut encoded)
            .expect("pinned VK canonical");
        assert!(encoded.is_empty() && vk.gamma_abc_g1.len() == 13);
        prepare_verifying_key(&vk)
    });
    let proof = zkapi_solana_crypto::decode_upstream_proof(proof_bytes)
        .map_err(|_| invalid("proof encoding"))?;
    let fields: [Fr; 12] = inputs.map(|x| x.to_field());
    if !Groth16::<Bn254>::verify_proof(key, &proof, &fields)
        .map_err(|_| invalid("request proof"))?
    {
        return Err(invalid("request proof"));
    }
    Ok(())
}
pub fn validate_point(point: [FieldElement; 2]) -> Result<()> {
    let point = EdwardsAffine::new_unchecked(point[0].to_field(), point[1].to_field());
    if point.is_zero() || !point.is_on_curve() || !point.is_in_correct_subgroup_assuming_on_curve()
    {
        return Err(invalid("Baby-JubJub point"));
    }
    Ok(())
}
pub fn role_key(bytes: &[u8; 64]) -> Result<[FieldElement; 2]> {
    let key = [
        FieldElement::from_bytes(bytes[..32].try_into().unwrap())
            .map_err(|_| invalid("state key encoding"))?,
        FieldElement::from_bytes(bytes[32..].try_into().unwrap())
            .map_err(|_| invalid("state key encoding"))?,
    ];
    validate_point(key)?;
    Ok(key)
}
