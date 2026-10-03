//! I03 real proofs bound to actual Vault pool PDAs. TEST ONLY: all secrets and
//! setup/proving entropy are public. Never use these notes or keys for funds.
//! Run: RAYON_NUM_THREADS=4 cargo run --locked --release -p zkapi-tree-prover --example vault_fixtures
//! Existing I02 artifacts and the pinned circuit profile are read-only inputs.
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::Fr as Scalar;
use ark_ff::{AdditiveGroup, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, time::Instant};
use zkapi_layout2::Field as Bytes;
use zkapi_proof::groth16::*;
use zkapi_solana_crypto::{decode_upstream_proof, encode_upstream_proof};
use zkapi_solana_types::{
    binding::{destination_binding, vault_binding},
    field::field_bytes,
};
use zkapi_tree_prover::{prepare, prove, TreeCircuit, TreeRequest};
fn read_json(p: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_json(p: impl AsRef<Path>, v: &Value) {
    let p = p.as_ref();
    let temporary = p.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    fs::rename(temporary, p).unwrap();
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
    let dir = root.join("tests/fixtures/vault");
    let target = root.join("target/i03");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&target).unwrap();
    let legacy = read_json(root.join("tests/fixtures/tree/tree-0-0.json"));
    let old = TreeCircuit {
        public: fields(&legacy, "public_inputs").try_into().unwrap(),
        siblings: fields(&legacy, "siblings").try_into().unwrap(),
    };
    // Recreate the SAME test setup only if its local PK cache is missing. The
    // immutable I02 profile pins both the PK and VK; no new setup is selected.
    let profile = read_json(root.join("tests/fixtures/layout2/profile.json"));
    let cache = target.join("test-tree.pk");
    let pkbytes = if cache.exists() {
        fs::read(&cache).unwrap()
    } else {
        let mut setup_rng = StdRng::seed_from_u64(0x49303254524545);
        let key = Groth16::<Bn254>::generate_random_parameters_with_reduction(old, &mut setup_rng)
            .unwrap();
        let mut bytes = vec![];
        key.serialize_compressed(&mut bytes).unwrap();
        fs::write(&cache, &bytes).unwrap();
        bytes
    };
    assert_eq!(digest(&pkbytes), profile["tree_proof_artifacts"]["pk_hash"]);
    let tree_pk = ProvingKey::<Bn254>::deserialize_compressed(pkbytes.as_slice()).unwrap();
    let mut vkbytes = vec![];
    tree_pk.vk.serialize_compressed(&mut vkbytes).unwrap();
    assert_eq!(digest(&vkbytes), profile["tree_proof_artifacts"]["vk_hash"]);
    for name in ["request", "withdrawal"] {
        for extension in ["pk", "vk"] {
            let bytes = fs::read(root.join(format!(
                "vendor/ethereum-zkapi/protocol/setup/v2/{name}.{extension}"
            )))
            .unwrap();
            assert_eq!(digest(bytes), profile[format!("{name}_{extension}_hash")]);
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
    let mut rng = StdRng::seed_from_u64(0x493033464958);
    let mut times = vec![];
    let state_signer = StateSigningKey::from_secret(Scalar::from(31u64));
    let clearance_signer = StateSigningKey::from_secret(Scalar::from(37u64));
    for (name, id, secret, pool_id, companion, genesis_state) in [
        ("a", 0, 42, 2, false, false),
        ("a-with-b", 0, 42, 2, true, false),
        ("b-with-a", 1, 43, 2, true, false),
        ("other-vault", 0, 42, 9, false, false),
        ("max-id", u32::MAX, 42, 2, false, false),
        ("genesis-a", 0, 42, 2, false, true),
    ] {
        // Solana find_program_address([b"pool", [pool_id; 32]], [43; 32]).
        // Independently recalculated and asserted by the SVM harness.
        let (pool_hex, pool_bump) = if pool_id == 2 {
            (
                "29103ebf110dbfe8e7bd21387637de047f501457bbbdc6280530de0da7798bda",
                255,
            )
        } else {
            (
                "d1258bb6a3bb5a12ce18d0fae941de1ad344d7d9deac36eb68f9108cad3c1c81",
                253,
            )
        };
        let pool: Bytes = hex::decode(pool_hex).unwrap().try_into().unwrap();
        let secret = Fr::from(secret as u64);
        let deposit = 5_000_000;
        let balance = if genesis_state { deposit } else { 4_900_000 };
        let anchor = Fr::from(if genesis_state { 1u64 } else { 12345u64 });
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
        let vault = vault_binding(&[0; 32], &[43; 32], &pool, &token, &[4; 32]).to_field();
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
                is_genesis: genesis_state,
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
                is_genesis: genesis_state,
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
            &json!({"scope":"test-only real proofs; deterministic public entropy","name":name,"id":id,"program_id":hex::encode([43;32]),"pool_id":hex::encode([pool_id;32]),"pool":hex::encode(pool),"pool_bump":pool_bump,"genesis":hex::encode([0;32]),"mint":hex::encode([4;32]),"destination_owner":hex::encode([7;32]),"now":now,"ttl":ttl,"expiry":expiry,"deposit":deposit,"balance":balance,"anchor":if genesis_state {1} else {12345},"is_genesis":genesis_state,"challenge":86400,"commitment":hex::encode(field_bytes(commitment)),"auth":proofs,"trees":trees}),
        );
        eprintln!("generated {name}: three upstream and three tree proofs");
    }
    write_json(
        target.join("proving-times.json"),
        &json!({"scope":"native release test fixture generation; not browser/production latency","cases":times}),
    );
    let fixture_names = [
        "a",
        "a-with-b",
        "b-with-a",
        "other-vault",
        "max-id",
        "genesis-a",
    ];
    let files = fixture_names
        .iter()
        .map(|name| {
            let filename = format!("{name}.json");
            json!({"file": filename, "sha256": digest(fs::read(dir.join(&filename)).unwrap())})
        })
        .collect::<Vec<_>>();
    write_json(
        dir.join("manifest.json"),
        &json!({
            "scope": "TEST ONLY; public secrets and deterministic public entropy; not production eligible",
        "program_id": hex::encode([43; 32]),
        "generator_sha256": digest(fs::read(root.join("crates/zkapi-tree-prover/examples/vault_fixtures.rs")).unwrap()),
        "circuit_profile_hash": profile["circuit_profile_hash"],
            "real_upstream_proofs": 18,
            "real_tree_proofs": 18,
            "all_proofs_verified_against_pinned_vks": true,
            "files": files,
            "trace_contract": {
                "mutual_close": ["a.trees[0]", "a.auth.request", "a.auth.withdrawal + a.trees[1]"],
                "genesis_finalize": ["genesis-a.trees[0]", "genesis-a.auth.escape + genesis-a.trees[1]", "finalize at now + challenge"],
                "historical_challenge": ["a.trees[0]", "save a.auth.request", "b-with-a.trees[0]", "a-with-b.auth.escape + a-with-b.trees[1]", "a.auth.request + a-with-b.trees[2]"],
                "active_expiry": ["a.trees[0]", "a.trees[1] at expiry"],
                "maximum_id": ["max-id.trees[0] with next_note_id = 4294967295", "counter becomes 4294967296; next deposit rejected"]
            }
        }),
    );
    println!("PASS: 18 real upstream proofs + 18 real tree proofs, actual Vault PDA bindings, immutable I02 profile {}", profile["circuit_profile_hash"]);
}
