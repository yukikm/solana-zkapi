//! Offline, single-party OS-random setup for a NEW experimental devnet pool.
//! This does not deploy, reuse a funded pool, or establish a reviewed ceremony.
use ark_bn254::{Bn254, Fr};
use ark_ed_on_bn254::Fr as Scalar;
use ark_ff::{UniformRand, Zero};
use ark_groth16::Groth16;
use ark_serialize::CanonicalSerialize;
use ed25519_dalek::SigningKey;
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use zkapi_proof::groth16::StateSigningKey;
use zkapi_solana_crypto::SolanaVerifyingKey;
use zkapi_solana_types::field::field_bytes;
use zkapi_tree_prover::{prepare, profile, prove, TreeRequest};

fn digest(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}
fn write(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}
fn point(key: &StateSigningKey) -> Value {
    json!({"x":format!("0x{}",hex::encode(field_bytes(key.public.x))),
           "y":format!("0x{}",hex::encode(field_bytes(key.public.y)))})
}
fn scalar() -> Scalar {
    loop {
        let value = Scalar::rand(&mut OsRng);
        if !value.is_zero() && value != Scalar::from(31u64) && value != Scalar::from(37u64) {
            return value;
        }
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: public_devnet_setup NEW_OUTPUT_DIRECTORY SOURCE_BUNDLE".into());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let output = Path::new(&args[1]);
    let parent = output
        .parent()
        .ok_or("output parent required")?
        .canonicalize()?;
    let target = root.join("target").canonicalize()?;
    if !parent.starts_with(&target) || output.exists() {
        return Err("new output directory under repository target is required".into());
    }
    let source = fs::read(&args[2])?;
    if source.is_empty() {
        return Err("source bundle is empty".into());
    }
    directory(output)?;
    let private = output.join("private");
    directory(&private)?;
    let state = scalar();
    let mut clearance = scalar();
    while clearance == state {
        clearance = scalar();
    }
    let state_key = StateSigningKey::from_secret(state);
    let clearance_key = StateSigningKey::from_secret(clearance);
    write(&private.join("state.seed"), &field_bytes(state))?;
    write(&private.join("clearance.seed"), &field_bytes(clearance))?;
    let mut ed_keys = Vec::new();
    for role in ["quote", "receipt"] {
        let mut seed = [0; 32];
        OsRng.fill_bytes(&mut seed);
        let key = SigningKey::from_bytes(&seed);
        write(&private.join(format!("{role}.seed")), &seed)?;
        ed_keys.push(bs58::encode(key.verifying_key().to_bytes()).into_string());
    }
    if ed_keys[0] == ed_keys[1] {
        return Err("independent role keys required".into());
    }
    let zeros = zkapi_core::v2::zero_hashes();
    let circuit = prepare(
        TreeRequest {
            vault: field_bytes(Fr::from(1)),
            old_root: zeros[32].0,
            id: 0,
            commitment: field_bytes(Fr::from(1)),
            deposit: 1,
            expiry: 86400,
            op: 0,
        },
        std::array::from_fn(|i| zeros[i].0),
    )?;
    let key =
        Groth16::<Bn254>::generate_random_parameters_with_reduction(circuit.clone(), &mut OsRng)?;
    // Fresh proof and local verification bind the emitted keys to this circuit.
    let check = prove(circuit, &key, &mut OsRng)?;
    let mut pk = Vec::new();
    key.serialize_compressed(&mut pk)?;
    let mut vk = Vec::new();
    key.vk.serialize_compressed(&mut vk)?;
    let converted = SolanaVerifyingKey::from_arkworks(&key.vk)?;
    let solana = converted.as_verifying_key();
    let mut wire = Vec::new();
    wire.extend(solana.vk_alpha_g1);
    wire.extend(solana.vk_beta_g2);
    wire.extend(solana.vk_gamme_g2);
    wire.extend(solana.vk_delta_g2);
    for ic in solana.vk_ic {
        wire.extend(ic);
    }
    let mut files = serde_json::Map::new();
    for (name, bytes) in [
        ("tree.pk", pk),
        ("tree.vk", vk),
        ("tree-vk-wire.bin", wire),
        ("circuit-source.tar", source),
    ] {
        files.insert(name.into(), digest(&bytes).into());
        write(&output.join(name), &bytes)?;
    }
    for name in ["request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk"] {
        let bytes = fs::read(
            root.join("vendor/ethereum-zkapi/protocol/setup/v2")
                .join(name),
        )?;
        files.insert(name.into(), digest(&bytes).into());
        write(&output.join(name), &bytes)?;
    }
    let mut p = json!({"protocol_layout_version":2,"tree_backend":"transition_proof","tree_tag_policy":"proof_bound",
        "circuit_id":"zkapi-v2-note-bound-v1","setup_profile":"test_only",
        "setup_transcript_hashes":{"request":null,"withdrawal":null,"tree":null},
        "request_pk_hash":files["request.pk"],"request_vk_hash":files["request.vk"],
        "withdrawal_pk_hash":files["withdrawal.pk"],"withdrawal_vk_hash":files["withdrawal.vk"],
        "tree_proof_artifacts":{"circuit_id":"solana.zkapi.tree.v1","public_inputs":11,
          "source_bundle_hash":files["circuit-source.tar"],"pk_hash":files["tree.pk"],"vk_hash":files["tree.vk"],
          "verifier_constants_hash":files["tree-vk-wire.bin"],"setup_transcript_hash":null}});
    p["circuit_profile_hash"] = hex::encode(profile::hash(&p, false)?).into();
    write(
        &output.join("profile.json"),
        &serde_json::to_vec_pretty(&p)?,
    )?;
    files.insert(
        "profile.json".into(),
        digest(&fs::read(output.join("profile.json"))?).into(),
    );
    p["schema"] = 1.into();
    p["kind"] = "public_devnet".into();
    p["tree_setup"] = "single_party_os_random".into();
    p["production_eligible"] = false.into();
    p["state_key"] = point(&state_key);
    p["clearance_key"] = point(&clearance_key);
    p["quote_public_key"] = ed_keys[0].clone().into();
    p["receipt_public_key"] = ed_keys[1].clone().into();
    p["artifact_hashes"] = Value::Object(files);
    p["limitations"] = json!(["Experimental devnet only; no reviewed ceremony or audit.",
        "Request and withdrawal setup reuse the pinned upstream single-party artifacts.",
        "Tree setup uses OS randomness; no toxic-waste serialization is performed, but erasure is not independently attested.",
        "New program and new pool required; never change existing funded pool pins."]);
    let mut proof_bytes = [0; 608];
    check
        .encode(&mut proof_bytes)
        .map_err(|_| "proof encoding")?;
    write(&output.join("self-check-proof.bin"), &proof_bytes)?;
    let public = serde_json::to_vec_pretty(&p)?;
    write(&output.join("public-profile.json"), &public)?;
    println!(
        "{}",
        json!({"created":true,"public_profile_sha256":digest(&public),"circuit_profile_hash":p["circuit_profile_hash"],"production_eligible":false})
    );
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("public devnet profile generation failed; partial private directory retained; choose a new directory after reviewing the failure");
        std::process::exit(1);
    }
}
