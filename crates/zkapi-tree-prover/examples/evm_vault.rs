//! I03 EVM parity fixtures. PUBLIC-ENTROPY TEST PROOFS, never production setup.
//! Same D/B/id/time/secret/hash as the Solana Vault fixtures, with valid EVM bindings.
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::Fr as Scalar;
use ark_ff::{AdditiveGroup, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use ark_serialize::CanonicalDeserialize;
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use std::{fs, path::Path};
use zkapi_proof::groth16::*;
use zkapi_solana_crypto::encode_upstream_proof;
use zkapi_solana_types::field::field_bytes;

fn fields(values: &[Fr]) -> Vec<String> {
    values
        .iter()
        .map(|v| format!("0x{}", hex::encode(field_bytes(*v))))
        .collect()
}
fn pk(root: &Path, name: &str) -> ProvingKey<Bn254> {
    let bytes =
        fs::read(root.join(format!("vendor/ethereum-zkapi/protocol/setup/v2/{name}.pk"))).unwrap();
    ProvingKey::deserialize_compressed(bytes.strip_prefix(b"zkapi-v2-note-bound-v1\0").unwrap())
        .unwrap()
}
fn artifact(public: &[Fr], proof: &ark_groth16::Proof<Bn254>) -> Value {
    json!({"public_inputs":fields(public),"inputs_abi":format!("0x{}",hex::encode(public.iter().flat_map(|v| field_bytes(*v)).collect::<Vec<_>>())),"proof_wire_hex":format!("0x{}",hex::encode(encode_upstream_proof(proof)))})
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let request_pk = pk(&root, "request");
    let withdrawal_pk = pk(&root, "withdrawal");
    let now = 3_000_000_000u64;
    let ttl = 2_592_000u64;
    let expiry = (now + ttl).div_ceil(86_400) * 86_400;
    let deposit = 5_000_000u128;
    let balance = 4_900_000u128;
    let chain = 31_337;
    let vault = Fr::from_be_bytes_mod_order(
        &hex::decode("Fb1b848e938aE6474F890bfb28f6a793a515BAcb").unwrap(),
    );
    let destination = Fr::from_be_bytes_mod_order(&[0x11; 20]);
    let mut rng = StdRng::seed_from_u64(0x49303345564d);
    let state = StateSigningKey::from_secret(Scalar::from(31u64));
    let clearance = StateSigningKey::from_secret(Scalar::from(37u64));
    let secret = Fr::from(42u64);
    let commitment = registration_commitment(secret);
    let b_commitment = registration_commitment(Fr::from(43u64));
    let leaf = note_leaf(0, commitment, deposit, expiry);
    let b_leaf = note_leaf(1, b_commitment, deposit, expiry);
    let anchor = Fr::from(12345u64);
    let nullifier = request_nullifier(secret, anchor);
    let blinding = Scalar::from(19u64);
    let rerandomization = Scalar::from(23u64);
    let context = Fr::from(98765u64);
    let zeros = zkapi_core::v2::zero_hashes();
    let empty: [Fr; 32] = std::array::from_fn(|i| zkapi_core::v2::felt_to_field(&zeros[i]));
    let balance_c = balance_commitment(balance, blinding, leaf).into_affine();
    let state_signature = state.sign(state_message(2, chain, vault, balance_c, anchor), &mut rng);
    let clearance_signature =
        clearance.sign(clearance_message(2, chain, vault, nullifier), &mut rng);
    let request = RequestCircuit {
        public: RequestPublic {
            protocol_version: 2,
            chain_id: chain,
            contract_address: vault,
            active_root: merkle_root(0, leaf, &empty),
            state_signing_key: state.public,
            request_time: now,
            solvency_bound: 1_000_000,
            request_nullifier: nullifier,
            authorization_tag: authorization_tag(nullifier, context),
            anonymous_commitment: rerandomize_commitment(balance_c.into_group(), rerandomization)
                .into_affine(),
        },
        witness: RequestWitness {
            secret,
            request_context: context,
            note_id: 0,
            deposit_amount: deposit,
            expiry,
            merkle_siblings: empty,
            current_balance: balance,
            current_blinding: blinding,
            rerandomization,
            current_anchor: anchor,
            is_genesis: false,
            state_signature,
        },
    };
    let proof = prove_request(&request_pk, request.clone(), &mut rng).unwrap();
    assert!(Groth16::<Bn254>::verify_proof(
        &prepare_verifying_key(&request_pk.vk),
        &proof,
        &request.public.to_field_elements()
    )
    .unwrap());
    let mut proofs = serde_json::Map::new();
    proofs.insert(
        "request".into(),
        artifact(&request.public.to_field_elements(), &proof),
    );
    eprintln!("I03 EVM: verified signed request");
    for (name, companion, has_clearance) in [
        ("withdrawal", false, true),
        ("escape", false, false),
        ("escape_with_b", true, false),
    ] {
        let mut siblings = empty;
        if companion {
            siblings[0] = b_leaf;
        }
        let withdrawal = WithdrawalCircuit {
            public: WithdrawalPublic {
                protocol_version: 2,
                chain_id: chain,
                contract_address: vault,
                active_root: merkle_root(0, leaf, &siblings),
                state_signing_key: state.public,
                clearance_signing_key: clearance.public,
                note_id: 0,
                final_balance: balance,
                destination,
                withdrawal_nullifier: nullifier,
                has_clearance,
                withdrawal_tag: withdrawal_tag(nullifier, destination, balance, has_clearance),
            },
            witness: WithdrawalWitness {
                secret,
                deposit_amount: deposit,
                expiry,
                merkle_siblings: siblings,
                final_blinding: blinding,
                current_anchor: anchor,
                is_genesis: false,
                state_signature,
                clearance_signature,
            },
        };
        let proof = prove_withdrawal(&withdrawal_pk, withdrawal.clone(), &mut rng).unwrap();
        assert!(Groth16::<Bn254>::verify_proof(
            &prepare_verifying_key(&withdrawal_pk.vk),
            &proof,
            &withdrawal.public.to_field_elements()
        )
        .unwrap());
        proofs.insert(
            name.into(),
            artifact(&withdrawal.public.to_field_elements(), &proof),
        );
        eprintln!("I03 EVM: verified {name}");
    }
    let mut with_b = empty;
    with_b[0] = b_leaf;
    let output = json!({
        "scope":"test-only, four real Groth16 proofs under fixed upstream setup",
        "upstream_commit":"045b444ea1b52538d1b40273c7cb6ed09468a052",
        "circuit_id":"zkapi-v2-note-bound-v1","now":now,"ttl":ttl,"challenge":86400,
        "expiry":expiry,"deposit":deposit,"balance":balance,
        "commitment_a":format!("0x{}",hex::encode(field_bytes(commitment))),
        "commitment_b":format!("0x{}",hex::encode(field_bytes(b_commitment))),
        "leaf_a":format!("0x{}",hex::encode(field_bytes(leaf))),
        "leaf_b":format!("0x{}",hex::encode(field_bytes(b_leaf))),
        "root_empty":format!("0x{}",hex::encode(field_bytes(merkle_root(0,Fr::ZERO,&empty)))),
        "root_a":format!("0x{}",hex::encode(field_bytes(merkle_root(0,leaf,&empty)))),
        "root_b":format!("0x{}",hex::encode(field_bytes(merkle_root(0,Fr::ZERO,&with_b)))),
        "root_ab":format!("0x{}",hex::encode(field_bytes(merkle_root(0,leaf,&with_b)))),
        "auth":proofs,
    });
    fs::create_dir_all(root.join("tests/evm-vault")).unwrap();
    fs::write(
        root.join("tests/evm-vault/fixtures.json"),
        serde_json::to_vec_pretty(&output).unwrap(),
    )
    .unwrap();
}
