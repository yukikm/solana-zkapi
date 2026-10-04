//! TEST ONLY public fixture entropy. These proofs are never production setup.
use ark_bn254::Fr;
use ark_ec::CurveGroup;
use ark_ed_on_bn254::Fr as ScalarField;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use zkapi_client_prover::{execute, Command};
use zkapi_proof::groth16::*;
use zkapi_solana_types::{FieldElement, Scalar, CHAIN_NAMESPACE};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn read(path: &str) -> Value {
    serde_json::from_slice(&fs::read(root().join(path)).unwrap()).unwrap()
}
fn field(text: &Value) -> FieldElement {
    text.as_str().unwrap().parse().unwrap()
}
fn key(name: &str) -> Value {
    let (pk, vk) = if name == "tree" {
        (
            "target/i09-challenger/test-tree.pk".into(),
            "tests/fixtures/layout2/test-tree.vk".into(),
        )
    } else {
        (
            format!("vendor/ethereum-zkapi/protocol/setup/v2/{name}.pk"),
            format!("vendor/ethereum-zkapi/protocol/setup/v2/{name}.vk"),
        )
    };
    let pk = fs::read(root().join(pk)).expect("run I09 tree key fixture setup first");
    let vk = fs::read(root().join(vk)).unwrap();
    json!({"bytes_base64":STANDARD.encode(&pk),"pk_sha256":hex::encode(Sha256::digest(pk)),"vk_sha256":hex::encode(Sha256::digest(vk))})
}
fn run(value: Value) -> anyhow::Result<Value> {
    execute(serde_json::from_value::<Command>(value)?)
}
fn fixture() -> Value {
    let f = read("tests/fixtures/vault/genesis-a.json");
    let p = &f["auth"]["escape"]["public_inputs"];
    let secret = Fr::from(42u64);
    let expiry = f["expiry"].as_u64().unwrap();
    let n = request_nullifier(secret, Fr::from(1u64));
    let l = note_leaf(0, registration_commitment(secret), 5_000_000, expiry);
    let blinding = ScalarField::from(19u64);
    let c = balance_commitment(5_000_000, blinding, l).into_affine();
    let sig = StateSigningKey::from_secret(ScalarField::from(37u64)).sign(
        clearance_message(2, CHAIN_NAMESPACE, field(&p[2]).to_field(), n),
        &mut StdRng::seed_from_u64(808),
    );
    json!({"context":{"vault_binding":p[2],"state_key":[p[4],p[5]],"clearance_key":[p[6],p[7]]},
        "witness":{"secret":FieldElement::from(secret),"note_id":0,"deposit_micro_usdc":"5000000","expiry":expiry.to_string()},
        "state":{"balance_micro_usdc":"5000000","balance_blinding":Scalar::from(blinding),"note_leaf":FieldElement::from(l),"commitment":{"x":FieldElement::from(c.x),"y":FieldElement::from(c.y)},"anchor":FieldElement::from(Fr::from(1u64)),"state_signature":null},
        "clearance":{"r_x":FieldElement::from(sig.r.x),"r_y":FieldElement::from(sig.r.y),"s":Scalar::from(sig.s)},
        "nullifier":FieldElement::from(n),"root":p[3],"empty_root":f["trees"][0]["public_inputs"][1],"siblings":f["trees"][0]["siblings"],
        "note":{"note_id":0,"registration_commitment":FieldElement::from(registration_commitment(secret)),"deposit_micro_usdc":"5000000","expiry":expiry.to_string()},"now":f["now"].as_u64().unwrap().to_string()})
}
#[test]
fn real_native_request_withdrawals_tree_and_invalid_binding() {
    let f = fixture();
    let out = root().join("target/i08-wallet");
    fs::create_dir_all(&out).unwrap();
    fs::write(
        out.join("crypto-fixture.json"),
        serde_json::to_vec_pretty(&f).unwrap(),
    )
    .unwrap();
    let identity = run(
        json!({"kind":"inspect","context":f["context"],"witness":f["witness"],"state":f["state"]}),
    )
    .unwrap();
    assert_eq!(identity["nullifier"], f["nullifier"]);
    let c = json!({"kind":"clearance","context":f["context"],"nullifier":f["nullifier"],"signature":f["clearance"]});
    run(c.clone()).unwrap();
    let mut bad = c;
    bad["nullifier"] = json!(FieldElement::from(Fr::from(99u64)));
    assert!(run(bad).is_err());
    let request = json!({"kind":"request","context":f["context"],"witness":f["witness"],"state":f["state"],"root":f["root"],"siblings":f["siblings"],"authorization":{"version":"1","purpose":"native real-proof fixture"},"request_time":f["now"],"cap":"1000000","key":key("request")});
    let rp = run(request.clone()).unwrap();
    assert_eq!(rp["auth"]["public_inputs"][8], f["nullifier"]);
    let mut bad = request;
    bad["key"]["vk_sha256"] = json!("00".repeat(32));
    assert!(run(bad).is_err());
    fs::write(
        out.join("native-request.json"),
        serde_json::to_vec_pretty(&rp).unwrap(),
    )
    .unwrap();
    let mut vault = read("tests/fixtures/vault/genesis-a.json");
    for mutual in [true, false] {
        let c = if mutual {
            f["clearance"].clone()
        } else {
            Value::Null
        };
        let result=run(json!({"kind":"withdrawal","context":f["context"],"witness":f["witness"],"state":f["state"],"root":f["root"],"siblings":f["siblings"],"destination_owner_hex":"07".repeat(32),"mutual":mutual,"clearance":c,"key":key("withdrawal")})).unwrap();
        assert_eq!(result["public_inputs"][11], f["nullifier"]);
        vault["auth"][if mutual { "withdrawal" } else { "escape" }] = result;
    }
    for op in [0, 1] {
        let result=run(json!({"kind":"tree","context":f["context"],"note":f["note"],"root":f[if op==0 {"empty_root"}else{"root"}],"siblings":f["siblings"],"op":op,"key":key("tree")})).unwrap();
        assert_eq!(result["public_inputs"][op + 1], f["empty_root"]);
        vault["trees"][op] = result;
    }
    fs::write(
        out.join("native-vault.json"),
        serde_json::to_vec_pretty(&vault).unwrap(),
    )
    .unwrap();
}
#[test]
fn witness_mismatch_and_genesis_rebase_fail_closed() {
    let f = fixture();
    let mut s = f["state"].clone();
    s["note_leaf"] = json!(FieldElement::from(Fr::from(1u64)));
    assert!(
        run(json!({"kind":"inspect","context":f["context"],"witness":f["witness"],"state":s}))
            .is_err()
    );
    let new = run(
        json!({"kind":"rebase_deposit","witness":f["witness"],"note_id":1,"expiry":"3003000000"}),
    )
    .unwrap();
    assert_eq!(new["witness"]["secret"], f["witness"]["secret"]);
    assert_ne!(new["state"]["note_leaf"], f["state"]["note_leaf"]);
    run(json!({"kind":"inspect","context":f["context"],"witness":new["witness"],"state":new["state"]})).unwrap();
}
