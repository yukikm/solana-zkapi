//! Deterministic PUBLIC-ENTROPY TEST artifacts. No production key generation.
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::Fr as Scalar;
use ark_ff::{AdditiveGroup, Field, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::Instant};
use zkapi_layout2::Field as Bytes;
use zkapi_proof::groth16::*;
use zkapi_solana_crypto::{decode_upstream_proof, encode_upstream_proof, SolanaVerifyingKey};
use zkapi_solana_types::{
    binding::{destination_binding, vault_binding},
    field::field_bytes,
};
use zkapi_tree_prover::{prepare, prove, satisfied, verify, TreeCircuit, TreeRequest};
fn read_json(p: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_json(p: impl AsRef<Path>, v: &Value) {
    fs::write(p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
fn fields(v: &Value, key: &str) -> Vec<Fr> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            Fr::from_be_bytes_mod_order(
                &hex::decode(s.as_str().unwrap().trim_start_matches("0x")).unwrap(),
            )
        })
        .collect()
}
fn bytes_fields(fields: &[Fr]) -> Vec<String> {
    fields
        .iter()
        .map(|f| format!("0x{}", hex::encode(field_bytes(*f))))
        .collect()
}
fn upstream_pk(root: &Path, name: &str) -> ProvingKey<Bn254> {
    let bytes =
        fs::read(root.join(format!("vendor/ethereum-zkapi/protocol/setup/v2/{name}.pk"))).unwrap();
    ProvingKey::deserialize_compressed(bytes.strip_prefix(b"zkapi-v2-note-bound-v1\0").unwrap())
        .unwrap()
}
fn check_constraints(c: &impl CloneCircuit) {
    assert!(c.satisfied());
}
trait CloneCircuit {
    fn satisfied(&self) -> bool;
}
impl CloneCircuit for RequestCircuit {
    fn satisfied(&self) -> bool {
        let cs = ConstraintSystem::new_ref();
        self.clone().generate_constraints(cs.clone()).unwrap();
        cs.is_satisfied().unwrap()
    }
}
impl CloneCircuit for WithdrawalCircuit {
    fn satisfied(&self) -> bool {
        let cs = ConstraintSystem::new_ref();
        self.clone().generate_constraints(cs.clone()).unwrap();
        cs.is_satisfied().unwrap()
    }
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = root.join("tests/fixtures/layout2");
    let target = root.join("target/i02b");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&target).unwrap();
    let legacy = read_json(root.join("tests/fixtures/tree/tree-0-0.json"));
    let old = TreeCircuit {
        public: fields(&legacy, "public_inputs").try_into().unwrap(),
        siblings: fields(&legacy, "siblings").try_into().unwrap(),
    };
    // Recreate the research setup using the extracted circuit, not its PK bytes.
    let mut setup_rng = StdRng::seed_from_u64(0x49303254524545);
    let tree_pk =
        Groth16::<Bn254>::generate_random_parameters_with_reduction(old.clone(), &mut setup_rng)
            .unwrap();
    let mut pkbytes = vec![];
    tree_pk.serialize_compressed(&mut pkbytes).unwrap();
    let mut vkbytes = vec![];
    tree_pk.vk.serialize_compressed(&mut vkbytes).unwrap();
    let manifest = read_json(root.join("tests/fixtures/tree/manifest.json"));
    assert_eq!(digest(&pkbytes), manifest["pk_sha256"]);
    assert_eq!(digest(&vkbytes), manifest["vk_sha256"]);
    fs::write(target.join("test-tree.pk"), &pkbytes).unwrap();
    fs::write(dir.join("test-tree.vk"), &vkbytes).unwrap();
    let cs = ConstraintSystem::new_ref();
    old.clone().generate_constraints(cs.clone()).unwrap();
    assert_eq!(cs.num_constraints(), 33198);
    assert!(cs.is_satisfied().unwrap());
    let mut negative = 0;
    for i in 0..11 {
        let mut c = old.clone();
        c.public[i] += Fr::ONE;
        assert!(!satisfied(&c));
        negative += 1;
    }
    for i in 0..32 {
        let mut c = old.clone();
        c.siblings[i] += Fr::ONE;
        assert!(!satisfied(&c));
        negative += 1;
    }
    for (i, n) in [(3, 1u128 << 32), (7, 1u128 << 64), (8, 1u128 << 64), (9, 3)] {
        let mut c = old.clone();
        c.public[i] = Fr::from(n);
        assert!(!satisfied(&c));
        negative += 1;
    }
    for id in [0, u32::MAX] {
        for op in 0..3 {
            let f = read_json(root.join(format!("tests/fixtures/tree/tree-{id}-{op}.json")));
            let c = TreeCircuit {
                public: fields(&f, "public_inputs").try_into().unwrap(),
                siblings: fields(&f, "siblings").try_into().unwrap(),
            };
            assert!(satisfied(&c));
            let update = zkapi_layout2::TreeUpdate {
                public: c.public.map(field_bytes),
                proof: hex::decode(f["proof_wire_hex"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap(),
            };
            verify(&update, &tree_pk.vk).unwrap();
        }
    }
    let request_pk = upstream_pk(&root, "request");
    let withdrawal_pk = upstream_pk(&root, "withdrawal");
    let token: Bytes = bs58::decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        .into_vec()
        .unwrap()
        .try_into()
        .unwrap();
    let now = 3_000_000_000u64;
    let ttl = 2_592_000u64;
    let expiry = (now + ttl).div_ceil(86400) * 86400;
    let mut rng = StdRng::seed_from_u64(0x49303242464958);
    let mut times = vec![];
    let state_signer = StateSigningKey::from_secret(Scalar::from(31u64));
    let clearance_signer = StateSigningKey::from_secret(Scalar::from(37u64));
    for (name, id, secret, pool, companion) in [
        ("a", 0, 42, 2, false),
        ("a-with-b", 0, 42, 2, true),
        ("b-with-a", 1, 43, 2, true),
        ("other-vault", 0, 42, 9, false),
        ("max-id", u32::MAX, 42, 2, false),
    ] {
        let secret = Fr::from(secret as u64);
        let deposit = 5_000_000;
        let balance = 4_900_000;
        let anchor = Fr::from(12345u64);
        let commitment = registration_commitment(secret);
        let l = note_leaf(id, commitment, deposit, expiry);
        let zeros = zkapi_core::v2::zero_hashes();
        let mut siblings: [Fr; 32] =
            std::array::from_fn(|i| zkapi_core::v2::felt_to_field(&zeros[i]));
        if companion {
            siblings[0] = note_leaf(
                if id == 0 { 1 } else { 0 },
                registration_commitment(Fr::from(if id == 0 { 43u64 } else { 42u64 })),
                deposit,
                expiry,
            );
        }
        let active_root = merkle_root(id, l, &siblings);
        let absent_root = merkle_root(id, Fr::ZERO, &siblings);
        let vault = vault_binding(&[0; 32], &[42; 32], &[pool; 32], &token, &[4; 32]).to_field();
        let destination = destination_binding(&[7; 32]).to_field();
        let nullifier = request_nullifier(secret, anchor);
        let blinding = Scalar::from(19u64);
        let rerandomization = Scalar::from(23u64);
        let balance_c = balance_commitment(balance, blinding, l).into_affine();
        let state_signature = state_signer.sign(
            state_message(2, zkapi_layout2::NAMESPACE, vault, balance_c, anchor),
            &mut rng,
        );
        let clearance_signature = clearance_signer.sign(
            clearance_message(2, zkapi_layout2::NAMESPACE, vault, nullifier),
            &mut rng,
        );
        let context = Fr::from(98765u64);
        let request = RequestCircuit {
            public: RequestPublic {
                protocol_version: 2,
                chain_id: zkapi_layout2::NAMESPACE,
                contract_address: vault,
                active_root,
                state_signing_key: state_signer.public,
                request_time: now,
                solvency_bound: 1_000_000,
                request_nullifier: nullifier,
                authorization_tag: authorization_tag(nullifier, context),
                anonymous_commitment: rerandomize_commitment(
                    balance_c.into_group(),
                    rerandomization,
                )
                .into_affine(),
            },
            witness: RequestWitness {
                secret,
                request_context: context,
                note_id: id,
                deposit_amount: deposit,
                expiry,
                merkle_siblings: siblings,
                current_balance: balance,
                current_blinding: blinding,
                rerandomization,
                current_anchor: anchor,
                is_genesis: false,
                state_signature,
            },
        };
        let mut withdrawal = WithdrawalCircuit {
            public: WithdrawalPublic {
                protocol_version: 2,
                chain_id: zkapi_layout2::NAMESPACE,
                contract_address: vault,
                active_root,
                state_signing_key: state_signer.public,
                clearance_signing_key: clearance_signer.public,
                note_id: id,
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
                is_genesis: false,
                state_signature,
                clearance_signature,
            },
        };
        let mut proofs = serde_json::Map::new();
        check_constraints(&request);
        let t = Instant::now();
        let proof = prove_request(&request_pk, request.clone(), &mut rng).unwrap();
        assert!(Groth16::<Bn254>::verify_proof(
            &prepare_verifying_key(&request_pk.vk),
            &proof,
            &request.public.to_field_elements()
        )
        .unwrap());
        times.push(json!({"case":format!("{name}/request"),"ms":t.elapsed().as_millis()}));
        proofs.insert("request".into(),json!({"public_inputs":bytes_fields(&request.public.to_field_elements()),"proof_wire_hex":hex::encode(encode_upstream_proof(&proof))}));
        for (kind, clearance) in [("withdrawal", true), ("escape", false)] {
            withdrawal.public.has_clearance = clearance;
            withdrawal.public.withdrawal_tag =
                withdrawal_tag(nullifier, destination, balance, clearance);
            check_constraints(&withdrawal);
            let t = Instant::now();
            let proof = prove_withdrawal(&withdrawal_pk, withdrawal.clone(), &mut rng).unwrap();
            assert!(Groth16::<Bn254>::verify_proof(
                &prepare_verifying_key(&withdrawal_pk.vk),
                &proof,
                &withdrawal.public.to_field_elements()
            )
            .unwrap());
            times.push(json!({"case":format!("{name}/{kind}"),"ms":t.elapsed().as_millis()}));
            proofs.insert(kind.into(),json!({"public_inputs":bytes_fields(&withdrawal.public.to_field_elements()),"proof_wire_hex":hex::encode(encode_upstream_proof(&proof))}));
        }
        let mut trees = vec![];
        for op in 0..3 {
            let c = prepare(
                TreeRequest {
                    vault: field_bytes(vault),
                    old_root: field_bytes(if op == 1 { active_root } else { absent_root }),
                    id,
                    commitment: field_bytes(commitment),
                    deposit: deposit.try_into().unwrap(),
                    expiry,
                    op,
                },
                siblings.map(field_bytes),
            )
            .unwrap();
            let t = Instant::now();
            let update = prove(c.clone(), &tree_pk, &mut rng).unwrap();
            times.push(json!({"case":format!("{name}/tree-{op}"),"ms":t.elapsed().as_millis()}));
            // Verify freshly generated proof with the independently loaded OLD VK.
            let legacy_vk = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(
                fs::read(root.join("tests/fixtures/tree/test-tree.vk"))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            assert!(Groth16::<Bn254>::verify_proof(
                &prepare_verifying_key(&legacy_vk),
                &decode_upstream_proof(&update.proof).unwrap(),
                &c.public
            )
            .unwrap());
            trees.push(json!({"public_inputs":bytes_fields(&c.public),"proof_wire_hex":hex::encode(update.proof),"siblings":bytes_fields(&siblings)}));
        }
        write_json(
            dir.join(format!("{name}.json")),
            &json!({"scope":"test-only real proofs; deterministic public entropy","name":name,"id":id,"pool":hex::encode([pool;32]),"genesis":hex::encode([0;32]),"mint":hex::encode([4;32]),"destination_owner":hex::encode([7;32]),"now":now,"ttl":ttl,"expiry":expiry,"deposit":deposit,"commitment":hex::encode(field_bytes(commitment)),"auth":proofs,"trees":trees}),
        );
        eprintln!("generated {name}: three upstream and three tree proofs");
    }
    write_json(
        target.join("proving-times.json"),
        &json!({"scope":"native release test fixture generation; not browser/production latency","cases":times}),
    );
    let converted = SolanaVerifyingKey::from_arkworks(&tree_pk.vk).unwrap();
    let k = converted.as_verifying_key();
    let mut wire = vec![];
    wire.extend(k.vk_alpha_g1);
    wire.extend(k.vk_beta_g2);
    wire.extend(k.vk_gamme_g2);
    wire.extend(k.vk_delta_g2);
    for ic in k.vk_ic {
        wire.extend(ic);
    }
    fs::write(dir.join("tree-vk-wire.bin"), &wire).unwrap();
    let mut profile = json!({"protocol_layout_version":2,"tree_backend":"transition_proof","tree_tag_policy":"proof_bound","circuit_id":"zkapi-v2-note-bound-v1","setup_profile":"test_only","setup_transcript_hashes":{"request":null,"withdrawal":null,"tree":null},"tree_proof_artifacts":{"circuit_id":"solana.zkapi.tree.v1","public_inputs":11,"source_bundle_hash":digest(fs::read(target.join("circuit-source.tar")).expect("create source bundle first")),"pk_hash":digest(&pkbytes),"vk_hash":digest(&vkbytes),"verifier_constants_hash":digest(&wire),"setup_transcript_hash":null}});
    for name in ["request", "withdrawal"] {
        for ext in ["pk", "vk"] {
            profile[format!("{name}_{ext}_hash")] = digest(
                fs::read(root.join(format!(
                    "vendor/ethereum-zkapi/protocol/setup/v2/{name}.{ext}"
                )))
                .unwrap(),
            )
            .into();
        }
    }
    let hash = zkapi_tree_prover::profile::hash(&profile, false).unwrap();
    profile["circuit_profile_hash"] = hex::encode(hash).into();
    write_json(dir.join("profile.json"), &profile);
    let empty = zkapi_core::v2::felt_to_field(&zkapi_core::v2::zero_hashes()[32]);
    write_json(
        dir.join("extraction.json"),
        &json!({"constraints":33198,"legacy_pk_identical":true,"legacy_vk_identical":true,"old_proofs_verified":6,"new_proofs_verified_by_old_vk":15,"invalid_witnesses_rejected":negative,"empty_root":hex::encode(field_bytes(empty)),"empty_root_sha256":digest(field_bytes(empty)),"production_eligible":false}),
    );
    fs::create_dir_all(root.join("programs/i02-layout2/src")).unwrap();
    fs::write(root.join("programs/i02-layout2/src/profile.rs"),format!("// Generated TEST-ONLY profile; never production.\npub const PROFILE: [u8;32] = {hash:?};\npub const EMPTY_ROOT: [u8;32] = {:?};\n",field_bytes(empty))).unwrap();
    println!(
        "PASS: exact legacy PK/VK; 47 invalid witnesses; 30 new real proofs; profile {}",
        hex::encode(hash)
    );
}
