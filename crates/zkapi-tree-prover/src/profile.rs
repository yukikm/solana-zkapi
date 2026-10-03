//! Canonical profile encoding: its schema permits only ASCII strings, small
//! integers, null and objects. Sorted compact JSON is RFC 8785 JCS for this subset.
use serde_json::Value;
use sha2::{Digest, Sha256};
use zkapi_layout2::Field;
pub const PROFILE_FIELDS: [&str; 11] = [
    "protocol_layout_version",
    "tree_backend",
    "tree_tag_policy",
    "circuit_id",
    "request_pk_hash",
    "request_vk_hash",
    "withdrawal_pk_hash",
    "withdrawal_vk_hash",
    "tree_proof_artifacts",
    "setup_profile",
    "setup_transcript_hashes",
];
fn digest_string(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
/// Crypto/profile stage after Manifest schema validation. The signer must be
/// pinned outside this manifest; pool/compiled hashes come from trusted chain
/// state and the release. HTTP loading and schema validation belong to I08.
pub fn verify_signed_manifest(
    manifest: &Value,
    pinned_signer: &Field,
    signature: &[u8; 64],
    pool_profile: &Field,
    compiled_profile: &Field,
    production: bool,
) -> Result<Field, &'static str> {
    let profile = hash(manifest, production)?;
    if profile != *pool_profile
        || profile != *compiled_profile
        || manifest["circuit_profile_hash"].as_str() != Some(hex::encode(profile).as_str())
    {
        return Err("profile pin mismatch");
    }
    let mut body = manifest.as_object().ok_or("manifest object")?.clone();
    body.remove("manifest_hash");
    body.remove("manifest_signature");
    let digest: Field =
        Sha256::digest(serde_jcs::to_vec(&body).map_err(|_| "manifest JCS")?).into();
    if manifest["manifest_hash"].as_str() != Some(hex::encode(digest).as_str()) {
        return Err("manifest hash mismatch");
    }
    ed25519_dalek::VerifyingKey::from_bytes(pinned_signer)
        .map_err(|_| "manifest key")?
        .verify_strict(&digest, &ed25519_dalek::Signature::from_bytes(signature))
        .map_err(|_| "manifest signature")?;
    Ok(profile)
}
pub fn hash(manifest: &Value, production: bool) -> Result<Field, &'static str> {
    if manifest["protocol_layout_version"] != 2
        || manifest["tree_backend"] != "transition_proof"
        || manifest["tree_tag_policy"] != "proof_bound"
        || manifest["circuit_id"] != "zkapi-v2-note-bound-v1"
    {
        return Err("layout/policy/circuit");
    }
    for key in [
        "request_pk_hash",
        "request_vk_hash",
        "withdrawal_pk_hash",
        "withdrawal_vk_hash",
    ] {
        if !digest_string(&manifest[key]) {
            return Err("key digest");
        }
    }
    let tree = &manifest["tree_proof_artifacts"];
    for key in [
        "circuit_id",
        "public_inputs",
        "source_bundle_hash",
        "pk_hash",
        "vk_hash",
        "verifier_constants_hash",
        "setup_transcript_hash",
    ] {
        if tree.get(key).is_none() {
            return Err("missing tree field");
        }
    }
    if tree["circuit_id"] != "solana.zkapi.tree.v1"
        || tree["public_inputs"] != 11
        || tree.as_object().is_none_or(|o| o.len() != 7)
    {
        return Err("tree descriptor");
    }
    for key in [
        "source_bundle_hash",
        "pk_hash",
        "vk_hash",
        "verifier_constants_hash",
    ] {
        if !digest_string(&tree[key]) {
            return Err("tree digest");
        }
    }
    let setup = manifest["setup_profile"].as_str().ok_or("setup profile")?;
    let transcripts = &manifest["setup_transcript_hashes"];
    for key in ["request", "withdrawal", "tree"] {
        if transcripts.get(key).is_none() {
            return Err("missing transcript");
        }
    }
    if transcripts.as_object().is_none_or(|o| o.len() != 3) {
        return Err("transcripts");
    }
    if production || manifest["deployment_environment"] == "mainnet" {
        if setup != "ceremony_verified" {
            return Err("test setup forbidden in production");
        }
        // A relabelled test manifest and invented transcript hashes do not make
        // known public-entropy keys eligible for production.
        let known = [
            "c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584",
            "8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97",
            "8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668",
            "2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679",
            "c01b31f6806ce59114fe8befa210967415e20229b0a998018d4955a726fd0f80",
            "9141a035fdba50b13a5776182be029bb23dd15e69cd579c5d6e310b7e2ee5fb7",
            "d4048c4b228fca9ef4342de8f89f96f90f606c9beb74cd3c6606db44925d1bf9",
        ];
        for value in [
            &manifest["request_pk_hash"],
            &manifest["request_vk_hash"],
            &manifest["withdrawal_pk_hash"],
            &manifest["withdrawal_vk_hash"],
            &tree["pk_hash"],
            &tree["vk_hash"],
            &tree["verifier_constants_hash"],
        ] {
            if value.as_str().is_some_and(|s| known.contains(&s)) {
                return Err("known test artifact forbidden in production");
            }
        }
    }
    for key in ["request", "withdrawal", "tree"] {
        match setup {
            "test_only" if transcripts[key].is_null() => {}
            "ceremony_verified" if digest_string(&transcripts[key]) => {}
            _ => return Err("setup transcript"),
        }
    }
    if tree["setup_transcript_hash"] != transcripts["tree"] {
        return Err("tree transcript mismatch");
    }
    let mut object = serde_json::Map::new();
    for key in PROFILE_FIELDS {
        object.insert(
            key.into(),
            manifest.get(key).ok_or("missing profile field")?.clone(),
        );
    }
    // serde_json uses BTreeMap without preserve_order; restrict all values to the
    // schema subset above before serialization, including nested descriptors.
    Ok(Sha256::digest(serde_json::to_vec(&object).map_err(|_| "JSON")?).into())
}
