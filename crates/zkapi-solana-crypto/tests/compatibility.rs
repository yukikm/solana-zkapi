//! Test-only deterministic secrets. Uses the upstream committed setup, never a
//! newly generated setup and never production credentials.
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::Fr as Scalar;
use ark_ff::{AdditiveGroup, Field};
use ark_groth16::{prepare_verifying_key, Groth16, Proof, ProvingKey, VerifyingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_serialize::CanonicalDeserialize;
use rand::{rngs::StdRng, SeedableRng};
use zkapi_core::v2 as core;
use zkapi_proof::groth16::*;
use zkapi_solana_crypto::*;
use zkapi_solana_types::{binding::*, FieldElement, CHAIN_NAMESPACE};
use zkapi_types::Felt252;

fn key<T: CanonicalDeserialize>(kind: &str, extension: &str) -> T {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../vendor/ethereum-zkapi/protocol/setup/v2/{kind}.{extension}"
    ));
    let raw = std::fs::read(path).unwrap();
    let mut bytes = raw.strip_prefix(b"zkapi-v2-note-bound-v1\0").unwrap();
    let result = T::deserialize_compressed(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    result
}

fn fixtures(genesis: bool) -> (RequestCircuit, WithdrawalCircuit) {
    let mut rng = StdRng::seed_from_u64(20261003);
    let secret = Fr::from(42u64);
    let note_id = 0;
    let deposit = 5_000_000;
    let balance = if genesis { deposit } else { 4_900_000 };
    let expiry = 4_000_000_000;
    let zeros = core::zero_hashes();
    let siblings = std::array::from_fn(|i| core::felt_to_field(&zeros[i]));
    let leaf = note_leaf(note_id, registration_commitment(secret), deposit, expiry);
    let root = merkle_root(note_id, leaf, &siblings);
    let vault = vault_binding(&[0; 32], &[1; 32], &[2; 32], &[3; 32], &[4; 32]).to_field();
    let destination = destination_binding(&[7; 32]).to_field();
    let auth: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/contracts/binding-vectors.json")).unwrap();
    let context =
        authorization_context(auth["authorization_jcs_utf8"].as_str().unwrap().as_bytes())
            .unwrap()
            .to_field();
    let anchor = Fr::from(if genesis { 1u64 } else { 12345u64 });
    let blinding = if genesis {
        Scalar::ZERO
    } else {
        Scalar::from(19u64)
    };
    let rerandomization = Scalar::from(23u64);
    let commitment = balance_commitment(balance, blinding, leaf).into_affine();
    let state_signer = StateSigningKey::from_secret(Scalar::from(31u64));
    let clearance_signer = StateSigningKey::from_secret(Scalar::from(37u64));
    let state_signature = state_signer.sign(
        state_message(2, CHAIN_NAMESPACE, vault, commitment, anchor),
        &mut rng,
    );
    let nullifier = request_nullifier(secret, anchor);
    let clearance_signature = clearance_signer.sign(
        clearance_message(2, CHAIN_NAMESPACE, vault, nullifier),
        &mut rng,
    );
    let request = RequestCircuit {
        public: RequestPublic {
            protocol_version: 2,
            chain_id: CHAIN_NAMESPACE,
            contract_address: vault,
            active_root: root,
            state_signing_key: state_signer.public,
            request_time: 3_000_000_000,
            solvency_bound: 1_000_000,
            request_nullifier: nullifier,
            authorization_tag: authorization_tag(nullifier, context),
            anonymous_commitment: rerandomize_commitment(commitment.into_group(), rerandomization)
                .into_affine(),
        },
        witness: RequestWitness {
            secret,
            request_context: context,
            note_id,
            deposit_amount: deposit,
            expiry,
            merkle_siblings: siblings,
            current_balance: balance,
            current_blinding: blinding,
            rerandomization,
            current_anchor: anchor,
            is_genesis: genesis,
            state_signature,
        },
    };
    let withdrawal = WithdrawalCircuit {
        public: WithdrawalPublic {
            protocol_version: 2,
            chain_id: CHAIN_NAMESPACE,
            contract_address: vault,
            active_root: root,
            state_signing_key: state_signer.public,
            clearance_signing_key: clearance_signer.public,
            note_id,
            final_balance: balance,
            destination,
            withdrawal_nullifier: nullifier,
            has_clearance: true,
            withdrawal_tag: withdrawal_tag(nullifier, destination, balance, true),
        },
        witness: WithdrawalWitness {
            secret,
            deposit_amount: deposit,
            expiry,
            merkle_siblings: siblings,
            final_blinding: blinding,
            current_anchor: anchor,
            is_genesis: genesis,
            state_signature,
            clearance_signature,
        },
    };
    (request, withdrawal)
}

fn assert_satisfied(circuit: impl ConstraintSynthesizer<Fr>) {
    let cs = ConstraintSystem::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(cs.is_satisfied().unwrap());
}

fn check_proof<const N: usize>(
    kind: &str,
    variant: &str,
    proof: Proof<Bn254>,
    vk: VerifyingKey<Bn254>,
    fields: Vec<Fr>,
) {
    assert_eq!(fields.len(), N);
    let prepared = prepare_verifying_key(&vk);
    assert!(Groth16::<Bn254>::verify_proof(&prepared, &proof, &fields).unwrap());
    let wire = encode_upstream_proof(&proof);
    let saved_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/fixtures/crypto/{kind}-{variant}.json"));
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(saved_path).unwrap()).unwrap();
    assert_eq!(saved["proof_wire_hex"], hex::encode(wire));
    assert_eq!(decode_upstream_proof(&wire).unwrap(), proof);
    let solana = SolanaProof::from_upstream(&wire).unwrap();
    let key = SolanaVerifyingKey::from_arkworks(&vk).unwrap();
    let inputs: [FieldElement; N] = fields
        .iter()
        .copied()
        .map(FieldElement::from)
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    assert_eq!(
        saved["public_inputs"],
        serde_json::to_value(inputs.to_vec()).unwrap()
    );
    key.verify(&solana, &inputs).unwrap();
    for index in 0..N {
        let mut changed = fields.clone();
        changed[index] += Fr::ONE;
        assert!(!Groth16::<Bn254>::verify_proof(&prepared, &proof, &changed).unwrap());
        let mut changed = inputs;
        changed[index] = (changed[index].to_field() + Fr::ONE).into();
        assert!(
            key.verify(&solana, &changed).is_err(),
            "{kind} input {index}"
        );
    }
    for coordinate in 0..8 {
        let mut changed = wire;
        changed[coordinate * 32 + 31] ^= 1;
        assert!(SolanaProof::from_upstream(&changed)
            .and_then(|p| key.verify(&p, &inputs))
            .is_err());
    }
    let mut wrong_a = SolanaProof::from_upstream(&wire).unwrap();
    wrong_a.a_neg.copy_from_slice(&wire[..64]); // omitted negation / double negation
    assert!(key.verify(&wrong_a, &inputs).is_err());
    let mut wrong_b = SolanaProof::from_upstream(&wire).unwrap();
    wrong_b.b.copy_from_slice(&wire[64..192]);
    assert!(key.verify(&wrong_b, &inputs).is_err());
    let mut wrong_vk = vk.clone();
    wrong_vk.alpha_g1 = -wrong_vk.alpha_g1;
    assert!(SolanaVerifyingKey::from_arkworks(&wrong_vk)
        .unwrap()
        .verify(&solana, &inputs)
        .is_err());
    let mut wrong_vk = vk;
    wrong_vk.gamma_abc_g1.pop();
    assert!(SolanaVerifyingKey::from_arkworks(&wrong_vk)
        .unwrap()
        .verify(&solana, &inputs)
        .is_err());
    if let Ok(out) = std::env::var("ZKAPI_TEST_ARTIFACT_DIR") {
        let out = std::path::PathBuf::from(out);
        let out = if out.is_absolute() {
            out
        } else {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(out)
        };
        std::fs::create_dir_all(&out).unwrap();
        let json = serde_json::json!({"scope":"native_real_proof_not_svm", "kind":kind, "variant":variant,
            "proof_wire_hex":hex::encode(wire), "public_inputs":inputs.to_vec(),
            "wire_bytes":256, "public_input_bytes":N*32, "public_input_mutations_rejected":N});
        std::fs::write(
            std::path::Path::new(&out).join(format!("{kind}-{variant}.json")),
            serde_json::to_vec_pretty(&json).unwrap(),
        )
        .unwrap();
    }
    eprintln!("{kind}/{variant}: native Arkworks + groth16-solana OK; {N}/{N} public mutations, 8/8 coordinates, A sign, G2 order, VK rejected; wire=256 input_bytes={}",N*32);
}

#[test]
fn pinned_request_and_withdrawal_proofs_verify_with_solana_bindings() {
    let request_pk: ProvingKey<Bn254> = key("request", "pk");
    let request_vk: VerifyingKey<Bn254> = key("request", "vk");
    let withdrawal_pk: ProvingKey<Bn254> = key("withdrawal", "pk");
    let withdrawal_vk: VerifyingKey<Bn254> = key("withdrawal", "vk");
    assert_eq!(request_pk.vk, request_vk);
    assert_eq!(withdrawal_pk.vk, withdrawal_vk);
    let mut rng = StdRng::seed_from_u64(20261003);
    for genesis in [true, false] {
        let variant = if genesis { "genesis" } else { "signed" };
        let (request, mut withdrawal) = fixtures(genesis);
        assert_satisfied(request.clone());
        assert_satisfied(withdrawal.clone());
        let proof = prove_request(&request_pk, request.clone(), &mut rng).unwrap();
        check_proof::<12>(
            "request",
            variant,
            proof,
            request_vk.clone(),
            request.public.to_field_elements(),
        );
        let proof = prove_withdrawal(&withdrawal_pk, withdrawal.clone(), &mut rng).unwrap();
        check_proof::<14>(
            "withdrawal",
            variant,
            proof,
            withdrawal_vk.clone(),
            withdrawal.public.to_field_elements(),
        );
        withdrawal.public.has_clearance = false;
        withdrawal.public.withdrawal_tag = withdrawal_tag(
            withdrawal.public.withdrawal_nullifier,
            withdrawal.public.destination,
            withdrawal.public.final_balance,
            false,
        );
        assert_satisfied(withdrawal.clone());
        let proof = prove_withdrawal(&withdrawal_pk, withdrawal.clone(), &mut rng).unwrap();
        check_proof::<14>(
            "escape",
            variant,
            proof,
            withdrawal_vk.clone(),
            withdrawal.public.to_field_elements(),
        );
    }
}

#[test]
fn preserves_upstream_poseidon_vectors_and_tree_semantics() {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../vendor/ethereum-zkapi/protocol/setup/v2/manifest.json"
    ))
    .unwrap();
    for n in [3, 5] {
        let values = (1..=n).map(Fr::from).collect::<Vec<_>>();
        assert_eq!(poseidon_hash(&values), core::hash_fields(&values));
        assert_eq!(
            FieldElement::from(poseidon_hash(&values)).to_string(),
            manifest["poseidon"][format!("test_hash{n}")]
        );
    }
    let zeros = core::zero_hashes();
    let path = std::array::from_fn(|i| zeros[i]);
    for id in [0, 1, u32::MAX] {
        assert_eq!(core::merkle_root(id, &Felt252::ZERO, &path), zeros[32]);
        let commitment = core::registration_commitment(&Felt252::from_u64(42));
        let leaf = core::note_leaf(id, &commitment, 5_000_000, 4_000_000_000);
        let root = core::merkle_root(id, &leaf, &path);
        assert_ne!(root, zeros[32]);
        assert_eq!(
            core::felt_to_field(&root),
            merkle_root(
                id,
                core::felt_to_field(&leaf),
                &path.map(|x| core::felt_to_field(&x))
            )
        );
        let mut wrong = path;
        wrong[31] = Felt252::from_u64(1);
        assert_ne!(root, core::merkle_root(id, &leaf, &wrong));
    }
}

#[test]
fn rejects_malformed_proof_coordinates_and_lengths() {
    for size in [0, 128, 255, 257] {
        assert!(decode_upstream_proof(&vec![0; size]).is_err());
    }
    assert!(decode_upstream_proof(&[255; 256]).is_err());
    assert!(decode_upstream_proof(&[0; 256]).is_err());
}
