//! Host-only validation of a separately pinned, NEW public-devnet profile.
use ark_bn254::{Bn254, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::VerifyingKey;
use ark_serialize::CanonicalDeserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn hex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2, "public pin length");
    assert!(
        s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "canonical public pin"
    );
    std::array::from_fn(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("public pin hex"))
}
fn read(root: &Path, name: &str) -> Vec<u8> {
    let path = root.join(name);
    println!("cargo:rerun-if-changed={}", path.display());
    assert!(
        fs::symlink_metadata(&path)
            .expect("public artifact metadata")
            .file_type()
            .is_file(),
        "regular public artifact required"
    );
    fs::read(path).expect("public artifact read")
}
fn field<F: PrimeField>(value: F) -> [u8; 32] {
    let raw = value.into_bigint().to_bytes_be();
    let mut out = [0; 32];
    out[32 - raw.len()..].copy_from_slice(&raw);
    out
}
fn g1(p: G1Affine) -> [u8; 64] {
    assert!(
        !p.is_zero() && p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve(),
        "valid tree G1 required"
    );
    let mut out = [0; 64];
    out[..32].copy_from_slice(&field(p.x));
    out[32..].copy_from_slice(&field(p.y));
    out
}
fn g2(p: G2Affine) -> [u8; 128] {
    assert!(
        !p.is_zero() && p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve(),
        "valid tree G2 required"
    );
    let mut out = [0; 128];
    for (dst, x) in out
        .chunks_exact_mut(32)
        .zip([p.x.c1, p.x.c0, p.y.c1, p.y.c0])
    {
        dst.copy_from_slice(&field(x));
    }
    out
}
fn role(profile: &Value, name: &str) -> [u8; 64] {
    let mut out = [0; 64];
    for (index, coordinate) in ["x", "y"].iter().enumerate() {
        let text = profile[name][coordinate]
            .as_str()
            .expect("public signing coordinate");
        out[index * 32..(index + 1) * 32].copy_from_slice(&hex::<32>(
            text.strip_prefix("0x").expect("public field prefix"),
        ));
    }
    crate::key_validation::validate(&out).expect("valid signing key");
    out
}
pub fn generate(root: &Path, expected_digest: &str, output: &Path) {
    let encoded = read(root, "public-profile.json");
    assert_eq!(
        digest(&encoded),
        expected_digest,
        "independent public profile hash mismatch"
    );
    let public: Value = serde_json::from_slice(&encoded).expect("public profile JSON");
    assert!(
        public["schema"] == 1
            && public["kind"] == "public_devnet"
            && public["tree_setup"] == "single_party_os_random"
            && public["production_eligible"] == false,
        "explicit experimental OS-random profile required"
    );
    let profile_bytes = read(root, "profile.json");
    let profile: Value = serde_json::from_slice(&profile_bytes).expect("circuit profile JSON");
    let mut body = profile.as_object().expect("profile object").clone();
    let hash = body.remove("circuit_profile_hash").expect("profile hash");
    assert_eq!(
        hash.as_str(),
        Some(digest(&serde_json::to_vec(&body).unwrap()).as_str()),
        "canonical circuit profile mismatch"
    );
    let profile_hash = hex::<32>(hash.as_str().expect("profile hash string"));
    assert_ne!(profile_hash, crate::legacy_profile::PROFILE, "legacy fixture profile forbidden");
    let legacy: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/layout2/profile.json")).unwrap();
    assert_ne!(
        hash, legacy["circuit_profile_hash"],
        "legacy fixture profile forbidden"
    );
    for (name, value) in profile.as_object().unwrap() {
        assert_eq!(public[name], *value, "public/circuit profile mismatch");
    }
    for name in [
        "protocol_layout_version",
        "tree_backend",
        "tree_tag_policy",
        "circuit_id",
        "setup_profile",
        "setup_transcript_hashes",
    ] {
        assert_eq!(profile[name], legacy[name], "unsupported circuit policy");
    }
    for name in [
        "request_pk_hash",
        "request_vk_hash",
        "withdrawal_pk_hash",
        "withdrawal_vk_hash",
    ] {
        assert_eq!(profile[name], legacy[name], "upstream artifact pin changed");
    }
    let tree = &profile["tree_proof_artifacts"];
    assert!(
        tree["circuit_id"] == "solana.zkapi.tree.v1"
            && tree["public_inputs"] == 11
            && tree["setup_transcript_hash"].is_null(),
        "tree descriptor"
    );
    for name in ["pk_hash", "vk_hash", "verifier_constants_hash"] {
        assert_ne!(
            tree[name], legacy["tree_proof_artifacts"][name],
            "public deterministic tree fixture forbidden"
        );
    }
    let state = role(&public, "state_key");
    let clearance = role(&public, "clearance_key");
    assert!(
        state != clearance
            && ![state, clearance]
                .iter()
                .any(|k| *k == crate::deployment_keys::STATE_KEY
                    || *k == crate::deployment_keys::CLEARANCE_KEY),
        "public fixture signing keys forbidden"
    );
    let mut ed_keys = Vec::new();
    for name in ["quote_public_key", "receipt_public_key"] {
        let text = public[name].as_str().expect("Ed25519 public key");
        let value: [u8; 32] = bs58::decode(text)
            .into_vec()
            .expect("public base58")
            .try_into()
            .expect("public key length");
        assert_eq!(
            bs58::encode(value).into_string(),
            text,
            "canonical public key"
        );
        assert!(
            value != [0; 32]
                && value
                    != hex::<32>(
                        "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a"
                    )
                && value
                    != hex::<32>(
                        "0b513ad9b4924015ca0902ed079044d3ac5dbec2306f06948c10da8eb6e39f2d"
                    ),
            "public fixture Ed25519 keys forbidden"
        );
        ed_keys.push(value);
    }
    assert_ne!(ed_keys[0], ed_keys[1], "independent role keys required");
    let artifacts = public["artifact_hashes"]
        .as_object()
        .expect("artifact hashes");
    let names = [
        "tree.pk",
        "tree.vk",
        "tree-vk-wire.bin",
        "circuit-source.tar",
        "request.pk",
        "request.vk",
        "withdrawal.pk",
        "withdrawal.vk",
        "profile.json",
    ];
    assert_eq!(artifacts.len(), names.len(), "exact artifact set required");
    for name in names {
        assert_eq!(
            artifacts[name].as_str(),
            Some(digest(&read(root, name)).as_str()),
            "public artifact digest mismatch"
        );
    }
    for (artifact, pin) in [
        ("tree.pk", "pk_hash"),
        ("tree.vk", "vk_hash"),
        ("tree-vk-wire.bin", "verifier_constants_hash"),
        ("circuit-source.tar", "source_bundle_hash"),
    ] {
        assert_eq!(artifacts[artifact], tree[pin], "tree artifact binding");
    }
    for (artifact, pin) in [
        ("request.pk", "request_pk_hash"),
        ("request.vk", "request_vk_hash"),
        ("withdrawal.pk", "withdrawal_pk_hash"),
        ("withdrawal.vk", "withdrawal_vk_hash"),
    ] {
        assert_eq!(
            artifacts[artifact], profile[pin],
            "upstream artifact binding"
        );
    }
    let vk_bytes = read(root, "tree.vk");
    let mut cursor = vk_bytes.as_slice();
    let vk = VerifyingKey::<Bn254>::deserialize_compressed(&mut cursor).expect("canonical tree VK");
    assert!(
        cursor.is_empty() && vk.gamma_abc_g1.len() == 12,
        "tree VK input count/length"
    );
    let pk_bytes = read(root, "tree.pk");
    let mut cursor = pk_bytes.as_slice();
    // Arkworks 0.5 serializes ProvingKey's VK first. Validate that prefix against
    // the separately validated VK; the independently pinned digest authenticates
    // the complete PK. Generator/client validate the full PK and a real proof.
    // Revalidating every proving-query subgroup in an unoptimized build script
    // would add minutes to every program build without strengthening the pin.
    let pk_vk = VerifyingKey::<Bn254>::deserialize_compressed(&mut cursor)
        .expect("canonical tree PK verification-key prefix");
    assert!(!cursor.is_empty() && pk_vk == vk, "tree PK/VK correspondence");
    let alpha = g1(vk.alpha_g1);
    let beta = g2(vk.beta_g2);
    let gamma = g2(vk.gamma_g2);
    let delta = g2(vk.delta_g2);
    let ic: Vec<_> = vk.gamma_abc_g1.into_iter().map(g1).collect();
    let mut wire = Vec::new();
    wire.extend(alpha);
    wire.extend(beta);
    wire.extend(gamma);
    wire.extend(delta);
    for point in &ic {
        wire.extend(point);
    }
    assert_eq!(
        wire,
        read(root, "tree-vk-wire.bin"),
        "VK/constants mismatch"
    );
    fs::write(output.join("selected_deployment_keys.rs"),format!("pub const STATE_KEY:[u8;64]={state:?};\npub const CLEARANCE_KEY:[u8;64]={clearance:?};\n")).unwrap();
    fs::write(
        output.join("selected_profile.rs"),
        format!(
            "pub const PROFILE:[u8;32]={profile_hash:?};\npub const EMPTY_ROOT:[u8;32]={:?};\n",
            crate::legacy_profile::EMPTY_ROOT
        ),
    )
    .unwrap();
    fs::write(output.join("selected_tree_vk.rs"),format!("use groth16_solana::groth16::Groth16Verifyingkey;\npub static TREE:Groth16Verifyingkey<'static>=Groth16Verifyingkey{{nr_pubinputs:11,vk_alpha_g1:{alpha:?},vk_beta_g2:{beta:?},vk_gamme_g2:{gamma:?},vk_delta_g2:{delta:?},vk_ic:&{ic:?}}};\n")).unwrap();
}
