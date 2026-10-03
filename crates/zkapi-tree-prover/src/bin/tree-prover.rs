//! Native recovery path. The expected profile hash must come from the verified
//! manifest AND pool; this CLI does not authenticate a manifest signature.
use ark_serialize::CanonicalSerialize;
use rand::rngs::OsRng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{env, fs};
use zkapi_layout2::{Field, TreeUpdate};
use zkapi_tree_prover::{field, load_pk, prepare, profile, prove, TreeRequest};
fn bytes(v: &Value) -> Result<Field, Box<dyn std::error::Error>> {
    Ok(
        hex::decode(v.as_str().ok_or("hex string")?.trim_start_matches("0x"))?
            .try_into()
            .map_err(|_| "field length")?,
    )
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = env::args().collect();
    if a.len() != 7 || !["--test-profile", "--production"].contains(&a[1].as_str()) {
        return Err("usage: tree-prover --test-profile|--production PROFILE_JSON TRUSTED_PROFILE_HASH PK WITNESS_JSON OUTPUT_608_BYTES".into());
    }
    let manifest: Value = serde_json::from_slice(&fs::read(&a[2])?)?;
    let expected: Field = hex::decode(&a[3])?
        .try_into()
        .map_err(|_| "profile hash length")?;
    if profile::hash(&manifest, a[1] == "--production")? != expected {
        return Err("profile mismatch".into());
    }
    let pk = load_pk(
        &fs::read(&a[4])?,
        &bytes(&manifest["tree_proof_artifacts"]["pk_hash"])?,
    )?;
    let mut vk = vec![];
    pk.vk.serialize_compressed(&mut vk)?;
    if Sha256::digest(&vk).as_slice() != bytes(&manifest["tree_proof_artifacts"]["vk_hash"])? {
        return Err("VK mismatch".into());
    }
    let v: Value = serde_json::from_slice(&fs::read(&a[5])?)?;
    let p: Vec<Field> = v["public_inputs"]
        .as_array()
        .ok_or("public inputs")?
        .iter()
        .map(bytes)
        .collect::<Result<_, _>>()?;
    let s: Vec<Field> = v["siblings"]
        .as_array()
        .ok_or("siblings")?
        .iter()
        .map(bytes)
        .collect::<Result<_, _>>()?;
    let public: [Field; 11] = p.try_into().map_err(|_| "11 inputs required")?;
    let n = |i| zkapi_layout2::to_u64(&public[i]).map_err(|_| "integer range");
    let c = prepare(
        TreeRequest {
            vault: public[0],
            old_root: public[1],
            id: n(3)?.try_into()?,
            commitment: public[6],
            deposit: n(7)?,
            expiry: n(8)?,
            op: n(9)?.try_into()?,
        },
        s.try_into().map_err(|_| "32 siblings required")?,
    )?;
    for (i, p) in public.iter().enumerate() {
        if c.public[i] != field(p)? {
            return Err("expected transition mismatch".into());
        }
    }
    let update: TreeUpdate = prove(c, &pk, &mut OsRng)?;
    let mut wire = [0; 608];
    update.encode(&mut wire).map_err(|_| "encoding")?;
    fs::write(&a[6], wire)?;
    println!(
        "verified tree proof: 608 bytes; profile {}",
        hex::encode(expected)
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
