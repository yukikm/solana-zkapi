//! Offline acceptance verifier for externally supplied public proof bundles.
//! It has no proving keys, setup generation, RPC, wallet or service state.
use ark_bn254::Bn254;
use ark_ff::Zero;
use ark_groth16::{prepare_verifying_key, Groth16, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use zkapi_solana_crypto::decode_upstream_proof;
use zkapi_tree_prover::field;

fn exact(v: &Value, fields: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    let object = v.as_object().ok_or("object required")?;
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        return Err("exact fields required".into());
    }
    Ok(())
}
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin().take(1_048_577).read_to_end(&mut input)?;
    if input.is_empty() || input.len() > 1_048_576 { return Err("input bound".into()); }
    let v: Value = serde_json::from_slice(&input)?;
    match v["kind"].as_str().ok_or("command required")? {
        "empty_path" => {
            exact(&v, &["kind"])?;
            let mut node = ark_bn254::Fr::zero();
            let mut siblings = Vec::new();
            for _ in 0..32 {
                siblings.push(format!("0x{}", hex::encode(zkapi_poseidon::bytes(node))));
                node = zkapi_poseidon::node(node, node);
            }
            Ok(json!({"root":format!("0x{}",hex::encode(zkapi_poseidon::bytes(node))),"siblings":siblings}))
        }
        "verify" => {
            exact(&v, &["kind", "circuit", "vk_hex", "vk_sha256", "proof"])?;
            let (count, header) = match v["circuit"].as_str().ok_or("circuit")? {
                "request" => (12, true), "withdrawal" => (14, true), "tree" => (11, false),
                _ => return Err("unsupported circuit".into()),
            };
            let encoded = v["vk_hex"].as_str().ok_or("VK bytes")?;
            if encoded.len() > 131_072 || encoded.bytes().any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)) {
                return Err("VK encoding".into());
            }
            let vk_bytes = hex::decode(encoded)?;
            if hex::encode(Sha256::digest(&vk_bytes)) != v["vk_sha256"].as_str().ok_or("VK pin")? {
                return Err("VK hash mismatch".into());
            }
            let mut data = if header { vk_bytes.strip_prefix(b"zkapi-v2-note-bound-v1\0").ok_or("VK revision")? } else { &vk_bytes };
            let vk = VerifyingKey::<Bn254>::deserialize_compressed(&mut data)?;
            if !data.is_empty() || vk.gamma_abc_g1.len() != count + 1 { return Err("VK input count".into()); }
            exact(&v["proof"], &["public_inputs", "proof_wire_hex"])?;
            let values = v["proof"]["public_inputs"].as_array().ok_or("public inputs")?;
            if values.len() != count { return Err("public input count".into()); }
            let mut inputs = Vec::new();
            for value in values {
                let s = value.as_str().ok_or("field string")?;
                if s.len() != 66 || !s.starts_with("0x") || s[2..].bytes().any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)) {
                    return Err("canonical field encoding".into());
                }
                let raw: [u8; 32] = hex::decode(&s[2..])?.try_into().map_err(|_| "field width")?;
                inputs.push(field(&raw)?);
            }
            let wire = v["proof"]["proof_wire_hex"].as_str().ok_or("proof string")?;
            if wire.len() != 512 || wire.bytes().any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b)) { return Err("proof width".into()); }
            let proof = decode_upstream_proof(&hex::decode(wire)?)?;
            if !Groth16::<Bn254>::verify_proof(&prepare_verifying_key(&vk), &proof, &inputs)? {
                return Err("proof verification failed".into());
            }
            Ok(json!({"verified":true,"circuit":v["circuit"],"public_inputs":count,"vk_sha256":v["vk_sha256"]}))
        }
        _ => Err("unsupported command".into()),
    }
}
fn main() {
    match run() {
        Ok(value) => { let _ = writeln!(std::io::stdout(), "{value}"); }
        Err(_) => { let _ = writeln!(std::io::stderr(), "offline bundle proof verification rejected"); std::process::exit(1); }
    }
}
