use ark_ff::{BigInteger, PrimeField};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zkapi_solana_types::{amount::*, binding::*, *};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../docs/contracts/binding-vectors.json")).unwrap()
}

#[test]
fn canonical_binding_vectors_and_vault_arity() {
    for v in vectors()["vectors"].as_array().unwrap() {
        let owned = v["parts_hex"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| hex::decode(p.as_str().unwrap()).unwrap())
            .collect::<Vec<_>>();
        let parts = owned.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let label = v["label"].as_str().unwrap();
        let encoded = frame(label, &parts).unwrap();
        assert_eq!(hex::encode(&encoded), v["frame_hex"]);
        assert_eq!(hex::encode(Sha256::digest(&encoded)), v["sha256"]);
        assert_eq!(h2f(label, &parts).unwrap().to_string(), v["field"]);
        if label == VAULT_LABEL {
            assert_eq!(parts.len(), 6);
            assert_eq!(
                vault_binding(
                    &owned[0].clone().try_into().unwrap(),
                    &owned[1].clone().try_into().unwrap(),
                    &owned[2].clone().try_into().unwrap(),
                    &owned[3].clone().try_into().unwrap(),
                    &owned[4].clone().try_into().unwrap()
                )
                .to_string(),
                v["field"]
            );
        }
    }
}

#[test]
fn bindings_separate_every_domain_component_and_frame_boundary() {
    let parts = [[0u8; 32]; 5];
    let bind = |p: &[[u8; 32]; 5]| vault_binding(&p[0], &p[1], &p[2], &p[3], &p[4]);
    for i in 0..5 {
        let mut changed = parts;
        changed[i][31] = 1;
        assert_ne!(bind(&parts), bind(&changed));
    }
    assert_ne!(destination_binding(&[0; 32]), destination_binding(&[1; 32]));
    assert_ne!(
        h2f(AUTHORIZATION_LABEL, &[b"ab", b"c"]).unwrap(),
        h2f(AUTHORIZATION_LABEL, &[b"a", b"bc"]).unwrap()
    );
    assert_ne!(
        authorization_context(b"mode=proxy").unwrap(),
        authorization_context(b"mode=direct").unwrap()
    );
    assert!(frame("unregistered", &[]).is_err());
    assert!(frame(VAULT_LABEL, &vec![&[] as &[u8]; 65_536]).is_err());
}

#[test]
fn canonical_field_and_babyjub_scalar_have_distinct_bounds() {
    let fr_mod: [u8; 32] = ark_bn254::Fr::MODULUS.to_bytes_be().try_into().unwrap();
    let scalar_mod: [u8; 32] = ark_ed_on_bn254::Fr::MODULUS
        .to_bytes_be()
        .try_into()
        .unwrap();
    assert!(FieldElement::from_bytes(fr_mod).is_err());
    assert!(Scalar::from_bytes(scalar_mod).is_err());
    assert!(FieldElement::from_bytes(scalar_mod).is_ok());
    let mut below = scalar_mod;
    below[31] -= 1;
    assert!(Scalar::from_bytes(below).is_ok());
    let canonical = format!("0x{}", hex::encode(below));
    assert!(canonical.parse::<Scalar>().is_ok());
    assert!(canonical.to_uppercase().parse::<Scalar>().is_err());
    for invalid in ["0x0", "0", "0xgg", " 0x01"] {
        assert!(invalid.parse::<FieldElement>().is_err());
    }
    assert!(serde_json::from_str::<FieldElement>("0").is_err());
}

#[test]
fn session_rounding_vectors_and_maximum() {
    let cap = MicroUsdc::new(MAX_MICRO_USDC).unwrap();
    for v in vectors()["rounding"].as_array().unwrap() {
        let ns = v["nano_values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().parse::<u128>().unwrap());
        assert_eq!(
            settle_session(ns, cap).unwrap().get().to_string(),
            v["expected_micro"]
        );
    }
    assert_eq!(settle_session([cap.as_nano() - 1], cap).unwrap(), cap);
    assert!(settle_session([cap.as_nano() + 1], cap).is_err());
    assert!(settle_session([u128::MAX, 1], cap).is_err());
    assert!(check_reservation(u128::MAX, 1, 0, cap).is_err());
    assert!(check_reservation(0, cap.as_nano() - 1, 1, cap).is_ok());
    assert!(check_reservation(0, cap.as_nano(), 1, cap).is_err());
    assert!(cap.checked_add(MicroUsdc::new(1).unwrap()).is_err());
    assert!(MicroUsdc::ZERO.checked_sub(cap).is_err());
}

#[test]
fn amounts_require_canonical_decimal_strings() {
    for invalid in [
        "\"01\"",
        "\"-1\"",
        "\"+1\"",
        "\"1.0\"",
        "\"1e3\"",
        "\" 1\"",
        "1",
        "1.0",
        "null",
        "\"9007199254740992\"",
    ] {
        assert!(
            serde_json::from_str::<MicroUsdc>(invalid).is_err(),
            "{invalid}"
        );
    }
    let max = MicroUsdc::new(MAX_MICRO_USDC).unwrap();
    assert_eq!(serde_json::to_string(&max).unwrap(), "\"9007199254740991\"");
}
