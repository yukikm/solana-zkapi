//! TEST ONLY known public fixture secret 37. Never built into a release binary.
use ark_ed_on_bn254::Fr;
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use std::io::Read;
use zkapi_proof::groth16::{clearance_message, StateSigningKey};
use zkapi_solana_types::{FieldElement, Scalar, CHAIN_NAMESPACE};
fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    let field = |key: &str| {
        v[key]
            .as_str()
            .unwrap()
            .parse::<FieldElement>()
            .unwrap()
            .to_field()
    };
    let signature = StateSigningKey::from_secret(Fr::from(37u64)).sign(
        clearance_message(
            2,
            CHAIN_NAMESPACE,
            field("vault_binding"),
            field("nullifier"),
        ),
        &mut StdRng::seed_from_u64(808),
    );
    println!(
        "{}",
        json!({"nullifier":v["nullifier"],"signature":{"r_x":FieldElement::from(signature.r.x),"r_y":FieldElement::from(signature.r.y),"s":Scalar::from(signature.s)}})
    );
}
