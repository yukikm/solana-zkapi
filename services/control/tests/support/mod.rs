#![allow(dead_code)]
//! TEST ONLY public deterministic note/signer entropy, pinned deployed Vault
//! fixture and actual upstream proving keys. Never included in service builds.
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::Fr as Scalar;
use ark_groth16::ProvingKey;
use ark_serialize::CanonicalDeserialize;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::StdRng, SeedableRng};
use zkapi_control::{quote::*, wire::*};
use zkapi_proof::groth16::*;
use zkapi_solana_types::{binding::authorization_context, FieldElement, CHAIN_NAMESPACE};

pub fn key<T: CanonicalDeserialize>(name: &str, extension: &str) -> T {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../vendor/ethereum-zkapi/protocol/setup/v2/{name}.{extension}"
    ));
    let bytes = std::fs::read(path).unwrap();
    let mut payload = bytes.strip_prefix(b"zkapi-v2-note-bound-v1\0").unwrap();
    let result = T::deserialize_compressed(&mut payload).unwrap();
    assert!(payload.is_empty());
    result
}
pub fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../tests/fixtures/vault/genesis-a.json"
    ))
    .unwrap()
}
pub fn field(text: &str) -> Fr {
    text.parse::<FieldElement>().unwrap().to_field()
}
#[derive(Clone)]
pub struct NoteState {
    pub balance: u64,
    pub blinding: Scalar,
    pub anchor: Fr,
    pub genesis: bool,
    pub signature: StateSignature,
}
pub fn genesis_state() -> NoteState {
    let fixture = fixture();
    let mut rng = StdRng::seed_from_u64(5);
    let signer = StateSigningKey::from_secret(Scalar::from(31u64));
    let leaf = note_leaf(
        0,
        registration_commitment(Fr::from(42u64)),
        5_000_000,
        fixture["expiry"].as_u64().unwrap(),
    );
    let blinding = Scalar::from(19u64);
    let binding = field(
        fixture["auth"]["request"]["public_inputs"][2]
            .as_str()
            .unwrap(),
    );
    let signature = signer.sign(
        state_message(
            2,
            CHAIN_NAMESPACE,
            binding,
            balance_commitment(5_000_000, blinding, leaf).into_affine(),
            Fr::from(1u64),
        ),
        &mut rng,
    );
    NoteState {
        balance: 5_000_000,
        blinding,
        anchor: Fr::from(1u64),
        genesis: true,
        signature,
    }
}
pub fn bound_request(
    authorization: Authorization,
    quote: Quote,
    state: NoteState,
) -> SessionCreate {
    let fixture = fixture();
    let stored = &fixture["auth"]["request"]["public_inputs"];
    let secret = Fr::from(42u64);
    let root = field(stored[3].as_str().unwrap());
    let binding = field(stored[2].as_str().unwrap());
    let context = authorization_context(&jcs(&authorization).unwrap())
        .unwrap()
        .to_field();
    let nullifier = request_nullifier(secret, state.anchor);
    let signer = StateSigningKey::from_secret(Scalar::from(31u64));
    let leaf = note_leaf(
        0,
        registration_commitment(secret),
        5_000_000,
        fixture["expiry"].as_u64().unwrap(),
    );
    let rerandomization = Scalar::from(23u64);
    let commitment = balance_commitment(state.balance as u128, state.blinding, leaf).into_affine();
    let circuit = RequestCircuit {
        public: RequestPublic {
            protocol_version: 2,
            chain_id: CHAIN_NAMESPACE,
            contract_address: binding,
            active_root: root,
            state_signing_key: signer.public,
            request_time: uint(&quote.body.issued_at).unwrap(),
            solvency_bound: quote.body.cap_micro_usdc.get() as u128,
            request_nullifier: nullifier,
            authorization_tag: authorization_tag(nullifier, context),
            anonymous_commitment: rerandomize_commitment(commitment.into_group(), rerandomization)
                .into_affine(),
        },
        witness: RequestWitness {
            secret,
            request_context: context,
            note_id: 0,
            deposit_amount: 5_000_000,
            expiry: fixture["expiry"].as_u64().unwrap(),
            merkle_siblings: std::array::from_fn(|i| {
                zkapi_core::v2::felt_to_field(&zkapi_core::v2::zero_hashes()[i])
            }),
            current_balance: state.balance as u128,
            current_blinding: state.blinding,
            rerandomization,
            current_anchor: state.anchor,
            is_genesis: state.genesis,
            state_signature: state.signature,
        },
    };
    let public_inputs = circuit
        .public
        .to_field_elements()
        .into_iter()
        .map(FieldElement::from)
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let proof = prove_request(
        &key::<ProvingKey<Bn254>>("request", "pk"),
        circuit,
        &mut StdRng::seed_from_u64(100),
    )
    .unwrap();
    let wire = zkapi_solana_crypto::encode_upstream_proof(&proof);
    zkapi_control::crypto::verify_request(&public_inputs, &wire).unwrap();
    SessionCreate {
        authorization,
        quote,
        public_inputs,
        proof: Proof {
            backend: "groth16_bn254".into(),
            proof: STANDARD.encode(wire),
        },
    }
}
pub fn local_binding() -> BindingConfig {
    let fixture = fixture();
    let inputs = &fixture["auth"]["request"]["public_inputs"];
    BindingConfig {
        deployment_id: "i05-local".into(),
        pool: bs58::encode(hex::decode(fixture["pool"].as_str().unwrap()).unwrap()).into_string(),
        vault_binding: inputs[2].as_str().unwrap().parse().unwrap(),
        state_key: [
            inputs[4].as_str().unwrap().parse().unwrap(),
            inputs[5].as_str().unwrap().parse().unwrap(),
        ],
        cap: zkapi_solana_types::MicroUsdc::new(1_000_000).unwrap(),
        control_api_origin: "http://127.0.0.1:8788".into(),
        inference_api_origin: "http://127.0.0.1:8789".into(),
        quote_key: ed25519_dalek::SigningKey::from_bytes(&[11; 32])
            .verifying_key()
            .to_bytes(),
    }
}
pub fn tariff() -> Tariff {
    let mut tariff = Tariff {
        api: None,
        tariff_hash: "".into(),
        version: "1".into(),
        provider: Provider::Openai,
        model: "local-test".into(),
        pricing_basis: "fixed_usage_rates".into(),
        valid_from: "0".into(),
        valid_until: "4000000000".into(),
        rates: vec![
            Rate {
                unit: "input_tokens".into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "3".into(),
            },
            Rate {
                unit: "output_tokens".into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "3".into(),
            },
        ],
        operator_fee_micro_usdc: "0".into(),
    };
    tariff.tariff_hash = tariff_hash(&tariff).unwrap();
    tariff
}
pub fn signed_quote(now: u64) -> Quote {
    issue_quote(
        &QuoteRequest {
            api: None,
            mode: Mode::Proxy,
            provider: Provider::Openai,
            models: vec!["local-test".into()],
            session_ttl_seconds: None,
        },
        &tariff(),
        &local_binding(),
        now,
        &ed25519_dalek::SigningKey::from_bytes(&[11; 32]),
    )
    .unwrap()
}
pub fn authorization(quote: &Quote) -> (Authorization, String) {
    let request_id = uuid::Uuid::new_v4().to_string();
    let token = format!(
        "Bearer zkc1.{request_id}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7; 32])
    );
    (
        Authorization {
            version: "1".into(),
            deployment_id: quote.body.deployment_id.clone(),
            pool: quote.body.pool.clone(),
            request_id,
            quote_hash: quote.quote_hash.clone(),
            mode: Mode::Proxy,
            control_secret_hash: hex::encode(sha256(&[7; 32])),
            proxy_secret_hash: Some(hex::encode(sha256(&[8; 32]))),
        },
        token,
    )
}

/// Full public Manifest shape for a local fixture. These governance addresses are
/// test metadata, never a claim that a production multisig has been deployed.
pub fn complete_local_manifest(manifest: &mut serde_json::Value) {
    use ed25519_dalek::Signer as _;
    let authority = serde_json::json!({"authority":bs58::encode([61;32]).into_string(),"program_id":bs58::encode([62;32]).into_string(),"config_hash":hex::encode(sha256(b"I05 local undeployed governance fixture")),"threshold":2,"members":[bs58::encode([63;32]).into_string(),bs58::encode([64;32]).into_string(),bs58::encode([65;32]).into_string()]});
    manifest["authorities"] = serde_json::json!({"admin":authority,"upgrade":authority});
    manifest["artifact_digests"] = serde_json::json!({"vault_idl":hex::encode(sha256(include_bytes!("../../../../docs/contracts/zkapi_vault.json")))});
    manifest["api_endpoints"] = serde_json::json!([
        "/zkapi/v1/config",
        "/zkapi/v1/catalog",
        "/zkapi/v1/attestation",
        "/zkapi/v1/tariffs/{tariff_hash}",
        "/zkapi/v1/quotes",
        "/zkapi/v1/sessions",
        "/zkapi/v1/sessions/{request_id}",
        "/zkapi/v1/sessions/{request_id}/close",
        "/zkapi/v1/sessions/{request_id}/operations/{operation_id}",
        "/zkapi/v1/sessions/{request_id}/receipts",
        "/zkapi/v1/withdraw/clearance",
        "/zkapi/v1/nullifiers/{nullifier}"
    ]);
    let mut body = manifest.clone();
    body.as_object_mut().unwrap().remove("manifest_hash");
    body.as_object_mut().unwrap().remove("manifest_signature");
    let hash = digest(&body).unwrap();
    manifest["manifest_hash"] = hex::encode(hash).into();
    manifest["manifest_signature"] = STANDARD
        .encode(
            ed25519_dalek::SigningKey::from_bytes(&[13; 32])
                .sign(&hash)
                .to_bytes(),
        )
        .into();
}
