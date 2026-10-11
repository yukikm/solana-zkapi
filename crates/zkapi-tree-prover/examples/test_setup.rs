//! Output-only reproduction of the pinned PUBLIC-ENTROPY TEST ONLY tree key.
//! Never writes tracked fixtures or creates a new trusted setup.
use ark_bn254::Bn254;
use ark_groth16::Groth16;
use ark_serialize::CanonicalSerialize;
use rand::{rngs::StdRng, SeedableRng};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use zkapi_solana_types::FieldElement;
use zkapi_tree_prover::circuit::TreeCircuit;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("usage: test_setup NEW_OUTPUT_FILE".into());
    }
    let output = Path::new(&args[0]);
    if output.exists() || output.symlink_metadata().is_ok() {
        return Err("output already exists".into());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture: Value =
        serde_json::from_slice(&fs::read(root.join("tests/fixtures/tree/tree-0-0.json"))?)?;
    let field = |value: &Value| {
        let bytes: [u8; 32] = hex::decode(value.as_str().unwrap().trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap();
        FieldElement::from_bytes(bytes).unwrap().to_field()
    };
    let circuit = TreeCircuit {
        public: std::array::from_fn(|i| field(&fixture["public_inputs"][i])),
        siblings: std::array::from_fn(|i| field(&fixture["siblings"][i])),
    };
    let key = Groth16::<Bn254>::generate_random_parameters_with_reduction(
        circuit,
        &mut StdRng::seed_from_u64(0x49303254524545),
    )?;
    let mut bytes = Vec::new();
    key.serialize_compressed(&mut bytes)?;
    let profile: Value =
        serde_json::from_slice(&fs::read(root.join("tests/fixtures/layout2/profile.json"))?)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if profile["tree_proof_artifacts"]["pk_hash"] != digest {
        return Err("pinned TEST ONLY key mismatch".into());
    }
    let mut vk = Vec::new();
    key.vk.serialize_compressed(&mut vk)?;
    if profile["tree_proof_artifacts"]["vk_hash"] != hex::encode(Sha256::digest(&vk)) {
        return Err("pinned TEST ONLY VK mismatch".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    println!(
        "{}",
        serde_json::json!({"schema":1,"kind":"test_only","sha256":digest,"bytes":bytes.len()})
    );
    Ok(())
}
