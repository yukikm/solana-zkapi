//! Test-only tree-transition setup/proofs. Deterministic public entropy; NEVER production.
use ark_bn254::{Bn254, Fr};
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar,
    poseidon::{constraints::PoseidonSpongeVar, find_poseidon_ark_and_mds, PoseidonConfig},
};
use ark_ff::{AdditiveGroup, Field, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16};
use ark_r1cs_std::{
    alloc::AllocVar,
    boolean::Boolean,
    convert::ToBitsGadget,
    eq::EqGadget,
    fields::{fp::FpVar, FieldVar},
    uint32::UInt32,
    uint64::UInt64,
};
use ark_relations::r1cs::{
    ConstraintSynthesizer, ConstraintSystem, ConstraintSystemRef, SynthesisError,
};
use ark_serialize::CanonicalSerialize;
use rand::{rngs::StdRng, SeedableRng};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use zkapi_core::v2 as core;
use zkapi_solana_crypto::{encode_upstream_proof, SolanaProof, SolanaVerifyingKey};
use zkapi_solana_types::{binding::vault_binding, field::field_bytes, FieldElement};

#[derive(Clone)]
struct Tree {
    public: [Fr; 11],
    siblings: [Fr; 32],
}
fn config() -> PoseidonConfig<Fr> {
    let (a, m) = find_poseidon_ark_and_mds::<Fr>(254, 2, 8, 57, 0);
    PoseidonConfig::new(8, 57, 5, m, a, 2, 1)
}
fn hash(cs: ConstraintSystemRef<Fr>, input: &[FpVar<Fr>]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut s = PoseidonSpongeVar::new(cs, &config());
    s.absorb(&input)?;
    Ok(s.squeeze_field_elements(1)?[0].clone())
}
fn d(label: &[u8]) -> FpVar<Fr> {
    FpVar::Constant(Fr::from_be_bytes_mod_order(label))
}
impl ConstraintSynthesizer<Fr> for Tree {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let p = self
            .public
            .iter()
            .map(|v| FpVar::new_input(cs.clone(), || Ok(*v)))
            .collect::<Result<Vec<_>, _>>()?;
        let id = UInt32::new_witness(cs.clone(), || Ok(self.public[3].into_bigint().0[0] as u32))?;
        Boolean::le_bits_to_fp(&id.to_bits_le()?)?.enforce_equal(&p[3])?;
        for i in [7, 8] {
            let value = UInt64::new_witness(cs.clone(), || Ok(self.public[i].into_bigint().0[0]))?;
            Boolean::le_bits_to_fp(&value.to_bits_le()?)?.enforce_equal(&p[i])?;
        }
        let op = &p[9];
        (op * (op - Fr::ONE) * (op - Fr::from(2))).enforce_equal(&FpVar::zero())?;
        let remove = op.is_eq(&FpVar::one())?;
        let leaf = hash(
            cs.clone(),
            &[
                d(b"zkapi.v2.leaf"),
                p[3].clone(),
                p[6].clone(),
                p[7].clone(),
                p[8].clone(),
            ],
        )?;
        remove.select(&leaf, &FpVar::zero())?.enforce_equal(&p[4])?;
        remove.select(&FpVar::zero(), &leaf)?.enforce_equal(&p[5])?;
        let bits = id.to_bits_le()?;
        let mut old = p[4].clone();
        let mut new = p[5].clone();
        for (level, s) in self.siblings.iter().enumerate() {
            let s = FpVar::new_witness(cs.clone(), || Ok(*s))?;
            for cur in [&mut old, &mut new] {
                let left = bits[level].select(&s, cur)?;
                let right = bits[level].select(cur, &s)?;
                *cur = hash(cs.clone(), &[d(b"zkapi.v2.node"), left, right])?;
            }
        }
        old.enforce_equal(&p[1])?;
        new.enforce_equal(&p[2])?;
        let mut tag = vec![d(b"solana.zkapi.tree.v1")];
        tag.extend_from_slice(&p[..10]);
        hash(cs, &tag)?.enforce_equal(&p[10])?;
        Ok(())
    }
}
fn fixture(id: u32, op: u64) -> Tree {
    let zeros = core::zero_hashes();
    let siblings = std::array::from_fn(|i| core::felt_to_field(&zeros[i]));
    let c = core::registration_commitment(&zkapi_types::Felt252::from_u64(42));
    let leaf = core::note_leaf(id, &c, 5_000_000, 4_000_000_000);
    let old = if op == 1 {
        leaf
    } else {
        zkapi_types::Felt252::ZERO
    };
    let new = if op == 1 {
        zkapi_types::Felt252::ZERO
    } else {
        leaf
    };
    let path = std::array::from_fn(|i| zeros[i]);
    let mut public = [
        vault_binding(&[0; 32], &[1; 32], &[2; 32], &[3; 32], &[4; 32]).to_field(),
        core::felt_to_field(&core::merkle_root(id, &old, &path)),
        core::felt_to_field(&core::merkle_root(id, &new, &path)),
        Fr::from(id),
        core::felt_to_field(&old),
        core::felt_to_field(&new),
        core::felt_to_field(&c),
        Fr::from(5_000_000u64),
        Fr::from(4_000_000_000u64),
        Fr::from(op),
        Fr::ZERO,
    ];
    let mut tag = vec![Fr::from_be_bytes_mod_order(b"solana.zkapi.tree.v1")];
    tag.extend_from_slice(&public[..10]);
    public[10] = core::hash_fields(&tag);
    Tree { public, siblings }
}
fn check(c: Tree) -> bool {
    let cs = ConstraintSystem::new_ref();
    c.generate_constraints(cs.clone()).unwrap();
    cs.is_satisfied().unwrap()
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = root.join("tests/fixtures/tree");
    fs::create_dir_all(&dir).unwrap();
    let mut rng = StdRng::seed_from_u64(0x49303254524545);
    let base = fixture(0, 0);
    assert!(check(base.clone()));
    for i in 0..11 {
        let mut changed = base.clone();
        changed.public[i] += Fr::ONE;
        assert!(!check(changed), "unconstrained input {i}");
    }
    let mut bad = base.clone();
    bad.siblings[31] += Fr::ONE;
    assert!(!check(bad));
    for (i, n) in [(3, 1u128 << 32), (7, 1u128 << 64), (8, 1u128 << 64), (9, 3)] {
        let mut bad = base.clone();
        bad.public[i] = Fr::from(n);
        assert!(!check(bad));
    }
    let cs = ConstraintSystem::new_ref();
    base.clone().generate_constraints(cs.clone()).unwrap();
    let constraints = cs.num_constraints();
    let pk = Groth16::<Bn254>::generate_random_parameters_with_reduction(base, &mut rng).unwrap();
    let vk = prepare_verifying_key(&pk.vk);
    let mut vk_bytes = vec![];
    pk.vk.serialize_compressed(&mut vk_bytes).unwrap();
    fs::write(dir.join("test-tree.vk"), &vk_bytes).unwrap();
    let mut pk_bytes = vec![];
    pk.serialize_compressed(&mut pk_bytes).unwrap();
    let artifacts = root.join("target/i02-tree");
    fs::create_dir_all(&artifacts).unwrap();
    fs::write(artifacts.join("test-tree.pk"), &pk_bytes).unwrap();
    let manifest = serde_json::json!({"circuit_id":"solana.zkapi.tree.v1/test-only-arkworks-0.5", "layout_version_candidate":2,"production_eligible":false,"setup":"known deterministic entropy; no ceremony", "rng_seed_hex":"49303254524545","constraints":constraints,"public_inputs":11,"private_siblings":32,"pk_sha256":hex::encode(Sha256::digest(&pk_bytes)),"vk_sha256":hex::encode(Sha256::digest(&vk_bytes)),"circuit_source_sha256":hex::encode(Sha256::digest(fs::read(root.join("crates/zkapi-solana-crypto/examples/tree_setup.rs")).unwrap()))});
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let key = SolanaVerifyingKey::from_arkworks(&pk.vk).unwrap();
    let k = key.as_verifying_key();
    fs::write(root.join("programs/i02-harness/src/tree_vk.rs"),format!("// TEST ONLY. Deterministic known setup entropy. NEVER production.\nuse groth16_solana::groth16::Groth16Verifyingkey;\npub static TREE: Groth16Verifyingkey<'static> = Groth16Verifyingkey {{nr_pubinputs:11,vk_alpha_g1:{:?},vk_beta_g2:{:?},vk_gamme_g2:{:?},vk_delta_g2:{:?},vk_ic:&{:?}}};\n",k.vk_alpha_g1,k.vk_beta_g2,k.vk_gamme_g2,k.vk_delta_g2,k.vk_ic)).unwrap();
    for id in [0, u32::MAX] {
        for op in 0..3 {
            let c = fixture(id, op);
            assert!(check(c.clone()));
            let proof =
                Groth16::<Bn254>::create_random_proof_with_reduction(c.clone(), &pk, &mut rng)
                    .unwrap();
            assert!(Groth16::<Bn254>::verify_proof(&vk, &proof, &c.public).unwrap());
            let wire = encode_upstream_proof(&proof);
            let inputs = c.public.map(FieldElement::from);
            let converted = SolanaProof::from_upstream(&wire).unwrap();
            key.verify(&converted, &inputs).unwrap();
            for i in 0..11 {
                let mut bad = inputs;
                bad[i] = FieldElement::from(c.public[i] + Fr::ONE);
                assert!(key.verify(&converted, &bad).is_err());
            }
            let json = serde_json::json!({"scope":"test-only deterministic tree setup; not production", "id":id,"op":op,"constraints":constraints,"proof_wire_hex":hex::encode(wire),"public_inputs":inputs,"siblings":c.siblings.map(|x|hex::encode(field_bytes(x)))});
            fs::write(
                dir.join(format!("tree-{id}-{op}.json")),
                serde_json::to_vec_pretty(&json).unwrap(),
            )
            .unwrap();
        }
    }
    println!("PASS: {constraints} constraints; 6 real tree proofs; 66 public-input mutations; 16 unsatisfied-witness tests");
}
