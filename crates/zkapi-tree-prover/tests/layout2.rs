use ark_bn254::Fr;
use ark_ff::PrimeField;
use ark_groth16::VerifyingKey;
use ark_serialize::CanonicalDeserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zkapi_layout2::{
    binding, framing, Command, Field, Inputs, Operation, TreeUpdate, FR_MODULUS, ZERO,
};
use zkapi_solana_types::{binding as reference, field::field_bytes};
use zkapi_tree_prover::{prepare, profile, verify, TreeRequest};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/layout2/a.json")).unwrap()
}
fn fields(v: &Value) -> Vec<Field> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| {
            hex::decode(x.as_str().unwrap().trim_start_matches("0x"))
                .unwrap()
                .try_into()
                .unwrap()
        })
        .collect()
}
fn update(v: &Value) -> TreeUpdate {
    TreeUpdate {
        public: fields(&v["public_inputs"]).try_into().unwrap(),
        proof: hex::decode(v["proof_wire_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap(),
    }
}
#[test]
fn exact_field_modulus_and_allocation_free_h2f_match_original() {
    assert_eq!(Fr::MODULUS.to_string(), num_modulus());
    for i in 0u64..1024 {
        let h: [u8; 32] = Sha256::digest(i.to_be_bytes()).into();
        assert_eq!(
            framing::reduce(h),
            field_bytes(Fr::from_be_bytes_mod_order(&h))
        );
        let seed: [u8; 32] = Sha256::digest(h).into();
        let frame = framing::vault(&h, &seed, &[2; 32], &[3; 32], &[4; 32]);
        let got = framing::reduce(Sha256::digest(frame).into());
        assert_eq!(
            got,
            field_bytes(
                reference::vault_binding(&h, &seed, &[2; 32], &[3; 32], &[4; 32]).to_field()
            )
        );
        assert_eq!(
            framing::reduce(Sha256::digest(framing::destination(&seed)).into()),
            field_bytes(reference::destination_binding(&seed).to_field())
        );
    }
    for x in [ZERO, FR_MODULUS, [255; 32]] {
        assert_eq!(
            framing::reduce(x),
            field_bytes(Fr::from_be_bytes_mod_order(&x))
        );
    }
}
fn num_modulus() -> String {
    "21888242871839275222246405745257275088548364400416034343698204186575808495617".into()
}
#[test]
fn normative_codec_fixed_lengths_canonical_fields_and_order() {
    let fixture = fixture();
    let tree = update(&fixture["trees"][0]);
    let mut wire = [0; 608];
    tree.encode(&mut wire).unwrap();
    assert_eq!(TreeUpdate::decode(&wire).unwrap(), tree);
    assert_eq!(&wire[..32], &tree.public[0]);
    assert_eq!(&wire[352..], &tree.proof);
    for n in [0, 256, 352, 607, 609, 1024] {
        assert!(TreeUpdate::decode(&vec![0; n]).is_err());
    }
    for i in 0..11 {
        let mut b = wire;
        b[i * 32..(i + 1) * 32].copy_from_slice(&FR_MODULUS);
        assert!(TreeUpdate::decode(&b).is_err());
    }
    for (op, n) in [
        (Operation::Deposit, 692),
        (Operation::Close, 1312),
        (Operation::Escape, 1312),
        (Operation::Challenge, 1252),
        (Operation::Expiry, 612),
    ] {
        assert_eq!(op.payload_len(), n);
        let mut bytes = vec![0; n];
        bytes[n - 608..].copy_from_slice(&wire);
        let c = Command::decode(op, &bytes).unwrap();
        assert_eq!(*c.tree.public.get(0), tree.public[0]);
        assert!(Command::decode(op, &bytes[..n - 1]).is_err());
        bytes.push(0);
        assert!(Command::decode(op, &bytes).is_err());
    }
}
#[test]
fn extracted_prepare_matches_legacy_inputs_and_rejects_mismatched_path() {
    let v = fixture();
    for op in 0..3 {
        let tree = update(&v["trees"][op]);
        let siblings: [Field; 32] = fields(&v["trees"][op]["siblings"]).try_into().unwrap();
        let request = TreeRequest {
            vault: tree.public[0],
            old_root: tree.public[1],
            id: 0,
            commitment: tree.public[6],
            deposit: 5_000_000,
            expiry: v["expiry"].as_u64().unwrap(),
            op: op as u8,
        };
        let c = prepare(request, siblings).unwrap();
        assert_eq!(c.public.map(field_bytes), tree.public);
        let mut bad = siblings;
        bad[31][31] ^= 1;
        assert!(prepare(request, bad).is_err());
        let mut bad = request;
        bad.op = 3;
        assert!(prepare(bad, siblings).is_err());
    }
}
#[test]
fn profile_pins_and_production_separation() {
    let p: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    let h = profile::hash(&p, false).unwrap();
    assert_eq!(hex::encode(h), p["circuit_profile_hash"]);
    assert!(profile::hash(&p, true).is_err());
    let mut bad = p.clone();
    bad["deployment_environment"] = "mainnet".into();
    assert!(profile::hash(&bad, false).is_err());
    let mut bad = p.clone();
    bad["setup_profile"] = "ceremony_verified".into();
    for k in ["request", "withdrawal", "tree"] {
        bad["setup_transcript_hashes"][k] = "a".repeat(64).into();
    }
    bad["tree_proof_artifacts"]["setup_transcript_hash"] = "a".repeat(64).into();
    assert!(profile::hash(&bad, true)
        .unwrap_err()
        .contains("known test"));
    for key in profile::PROFILE_FIELDS {
        let mut bad = p.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(profile::hash(&bad, false).is_err());
    }
    for key in ["request", "withdrawal", "tree"] {
        let mut bad = p.clone();
        bad["setup_transcript_hashes"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        bad["setup_transcript_hashes"]["extra"] = Value::Null;
        assert!(profile::hash(&bad, false).is_err());
    }
    let mut bad = p.clone();
    bad["tree_proof_artifacts"]
        .as_object_mut()
        .unwrap()
        .remove("setup_transcript_hash");
    bad["tree_proof_artifacts"]["extra"] = Value::Null;
    assert!(profile::hash(&bad, false).is_err());
    let mut changed = p.clone();
    changed["tree_proof_artifacts"]["source_bundle_hash"] = "a".repeat(64).into();
    assert_ne!(profile::hash(&changed, false).unwrap(), h);
    let mut outside = p;
    outside["manifest_hash"] = "b".repeat(64).into();
    assert_eq!(profile::hash(&outside, false).unwrap(), h);
}
#[test]
fn tree_fixture_native_verification_and_wrong_vk_rejection() {
    let vk = VerifyingKey::deserialize_compressed(
        include_bytes!("../../../tests/fixtures/tree/test-tree.vk").as_slice(),
    )
    .unwrap();
    let v = fixture();
    let t = update(&v["trees"][0]);
    verify(&t, &vk).unwrap();
    let mut bad = vk.clone();
    bad.alpha_g1 = -bad.alpha_g1;
    assert!(verify(&t, &bad).is_err());
    assert!(zkapi_tree_prover::load_pk(b"tampered", &[0; 32]).is_err());
}
#[test]
fn semantic_api_rejects_malformed_input_arity_without_panicking() {
    let v = fixture();
    let mut b = [0; 608];
    update(&v["trees"][0]).encode(&mut b).unwrap();
    let tree = zkapi_layout2::TreeRef::decode(&b).unwrap();
    let mut c = Command {
        op: Operation::Close,
        tree,
        authorization: Some(zkapi_layout2::Authorization {
            public: Inputs::decode(&[], 0).unwrap(),
            proof: &[0; 256],
        }),
        deposit: None,
        note_id: None,
    };
    let ctx = binding::Context {
        vault: ZERO,
        state_key: [ZERO; 2],
        clearance_key: [ZERO; 2],
        root: ZERO,
        next_id: 0,
        note: None,
        pending: None,
        now: 0,
        ttl: 1,
        paused: false,
        exit_consumed: false,
        destination: ZERO,
    };
    assert_eq!(
        binding::validate(&c, &ctx),
        Err(zkapi_layout2::Error::Encoding)
    );
    c.tree.public = Inputs::decode(&[], 0).unwrap();
    assert_eq!(
        binding::validate(&c, &ctx),
        Err(zkapi_layout2::Error::Encoding)
    );
}

#[test]
fn signed_manifest_profile_must_match_pinned_signer_pool_and_binary() {
    use ed25519_dalek::Signer;
    let mut m: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    // Test the crypto/profile projection, not the I08 HTTP/schema loader.
    m["deployment_id"] = "test-signed-profile".into();
    let h = profile::hash(&m, false).unwrap();
    let signer = ed25519_dalek::SigningKey::from_bytes(&[57; 32]);
    let pk = signer.verifying_key().to_bytes();
    let digest: Field = Sha256::digest(serde_jcs::to_vec(&m).unwrap()).into();
    let sig = signer.sign(&digest).to_bytes();
    m["manifest_hash"] = hex::encode(digest).into();
    m["manifest_signature"] = hex::encode(sig).into();
    assert_eq!(
        profile::verify_signed_manifest(&m, &pk, &sig, &h, &h, false).unwrap(),
        h
    );
    assert!(profile::verify_signed_manifest(&m, &pk, &sig, &[0; 32], &h, false).is_err());
    assert!(profile::verify_signed_manifest(&m, &pk, &sig, &h, &[0; 32], false).is_err());
    let other = ed25519_dalek::SigningKey::from_bytes(&[58; 32])
        .verifying_key()
        .to_bytes();
    assert!(profile::verify_signed_manifest(&m, &other, &sig, &h, &h, false).is_err());
    let mut bad = sig;
    bad[0] ^= 1;
    assert!(profile::verify_signed_manifest(&m, &pk, &bad, &h, &h, false).is_err());
    m["deployment_id"] = "tampered".into();
    assert!(profile::verify_signed_manifest(&m, &pk, &sig, &h, &h, false).is_err());
}
