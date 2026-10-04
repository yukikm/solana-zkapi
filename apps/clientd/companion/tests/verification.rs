//! Actual upstream Groth16 request proof + operator receipt + Baby-JubJub successor.
//! Entropy and keys in this file are public TEST-ONLY data, never production material.
mod support;
use ark_bn254::Fr;
use ark_ec::CurveGroup;
use ark_ed_on_bn254::Fr as Scalar;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::SigningKey;
use rand::{rngs::StdRng, SeedableRng};
use serde_json::json;
use std::sync::OnceLock;
use uuid::Uuid;
use zkapi_client_verify::*;
use zkapi_control::{
    crypto, quote,
    receipts::{Receipt, ReceiptBody, UsageUnit},
};
use zkapi_proof::{compact, groth16};
use zkapi_solana_types::{field::field_bytes, FieldElement, MicroUsdc, CHAIN_NAMESPACE};
use zkapi_types::Felt252;

#[derive(Clone)]
struct Fixture {
    ctx: Context,
    state: PrivateState,
    prepared: Prepared,
    settlement: Settlement,
    receipts: Vec<Receipt>,
    operations: Vec<String>,
}
fn f(value: u64) -> FieldElement {
    Fr::from(value).into()
}
fn scalar_field(value: Scalar) -> FieldElement {
    FieldElement::from_bytes(field_bytes(value)).unwrap()
}
fn point(value: zkapi_types::wire::CurvePointWire) -> Point {
    Point {
        x: FieldElement::from_bytes(value.x.0).unwrap(),
        y: FieldElement::from_bytes(value.y.0).unwrap(),
    }
}
fn signature(value: groth16::StateSignature) -> Signature {
    Signature {
        r_x: value.r.x.into(),
        r_y: value.r.y.into(),
        s: scalar_field(value.s),
    }
}
fn receipt_key() -> SigningKey {
    SigningKey::from_bytes(&[12; 32])
}
fn settle(fixture: &Fixture, charge: u64) -> Settlement {
    let inputs = fixture.prepared.request.public_inputs;
    let anonymous = zkapi_types::wire::CurvePointWire {
        x: Felt252(*inputs[10].as_bytes()),
        y: Felt252(*inputs[11].as_bytes()),
    };
    let blind = scalar_field(Scalar::from(29u64));
    let commitment = point(
        compact::server_update(&anonymous, charge.into(), &Felt252(*blind.as_bytes())).unwrap(),
    );
    let anchor = f(17);
    let message = groth16::state_message(
        2,
        CHAIN_NAMESPACE,
        fixture.ctx.vault_binding.to_field(),
        ark_ed_on_bn254::EdwardsAffine::new_unchecked(
            commitment.x.to_field(),
            commitment.y.to_field(),
        ),
        anchor.to_field(),
    );
    Settlement {
        charge_micro_usdc: MicroUsdc::new(charge).unwrap(),
        next_commitment: commitment,
        next_anchor: anchor,
        blind_delta_srv: blind,
        next_state_signature: signature(
            groth16::StateSigningKey::from_secret(Scalar::from(31u64))
                .sign(message, &mut StdRng::seed_from_u64(2026)),
        ),
    }
}
fn charge_receipt(fixture: &Fixture, operation: &str, count: u64) -> Receipt {
    Receipt::sign(
        ReceiptBody {
            version: "1".into(),
            receipt_id: Uuid::new_v4().to_string(),
            deployment_id: fixture.ctx.deployment_id.clone(),
            pool: fixture.ctx.pool.clone(),
            request_id: fixture.prepared.request.authorization.request_id.clone(),
            operation_id: Some(operation.into()),
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: "3000000001".into(),
            evidence_kind: "PROXY_USAGE".into(),
            provider_request_id: None,
            provider_evidence_digest: None,
            tariff_hash: fixture.prepared.tariff.tariff_hash.clone(),
            usage: vec![
                UsageUnit {
                    unit: "input_tokens".into(),
                    count: count.to_string(),
                },
                UsageUnit {
                    unit: "output_tokens".into(),
                    count: "0".into(),
                },
            ],
            provider_reported_usd: None,
            reservation_nano_usdc: "10000".into(),
            observed_nano_usdc: Some(count.div_ceil(3).to_string()),
            charged_nano_usdc: count.div_ceil(3).to_string(),
            operator_loss_nano_usdc: Some("0".into()),
            reason: "metered".into(),
        },
        &receipt_key(),
    )
    .unwrap()
}
fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let binding = support::local_binding();
        let ctx = Context {
            deployment_id: binding.deployment_id,
            pool: binding.pool,
            vault_binding: binding.vault_binding,
            state_key: binding.state_key,
            cap_micro_usdc: binding.cap,
            control_api_origin: binding.control_api_origin,
            inference_api_origin: binding.inference_api_origin,
            quote_public_key: bs58::encode(binding.quote_key).into_string(),
            receipt_public_key: bs58::encode(receipt_key().verifying_key().to_bytes())
                .into_string(),
            request_vk_sha256: crypto::REQUEST_VK_HASH.into(),
            tariff_hashes: vec![support::tariff().tariff_hash],
        };
        let initial = support::genesis_state();
        let leaf = groth16::note_leaf(
            0,
            groth16::registration_commitment(Fr::from(42u64)),
            5_000_000,
            support::fixture()["expiry"].as_u64().unwrap(),
        );
        let commitment =
            groth16::balance_commitment(initial.balance.into(), initial.blinding, leaf)
                .into_affine();
        let state = PrivateState {
            balance_micro_usdc: MicroUsdc::new(initial.balance).unwrap(),
            balance_blinding: scalar_field(initial.blinding),
            note_leaf: leaf.into(),
            commitment: Point {
                x: commitment.x.into(),
                y: commitment.y.into(),
            },
            anchor: initial.anchor.into(),
            state_signature: None,
        };
        let quote = support::signed_quote(3_000_000_000);
        let (authorization, credential) = support::authorization(&quote);
        let proxy_token = format!(
            "zkp1.{}.{}",
            authorization.request_id,
            URL_SAFE_NO_PAD.encode([8; 32])
        );
        let prepared = Prepared {
            request: support::bound_request(authorization, quote, initial),
            control_token: credential.strip_prefix("Bearer ").unwrap().into(),
            proxy_token: Some(proxy_token),
            tariff: support::tariff(),
            rerandomization: scalar_field(Scalar::from(23u64)),
        };
        let placeholder = Settlement {
            charge_micro_usdc: MicroUsdc::ZERO,
            next_commitment: state.commitment.clone(),
            next_anchor: state.anchor,
            blind_delta_srv: f(0),
            next_state_signature: Signature {
                r_x: f(0),
                r_y: f(1),
                s: f(0),
            },
        };
        let mut fixture = Fixture {
            ctx,
            state,
            prepared,
            settlement: placeholder,
            receipts: vec![],
            operations: vec![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
        };
        // Two 1 nano charges round once at the session boundary to 1 micro, not 2.
        fixture.receipts = fixture
            .operations
            .iter()
            .map(|id| charge_receipt(&fixture, id, 1))
            .collect();
        fixture.settlement = settle(&fixture, 1);
        fixture
    })
}
fn verify(f: &Fixture) -> anyhow::Result<PrivateState> {
    verify_settlement(
        &f.ctx,
        &f.state,
        &f.prepared,
        &f.settlement,
        &f.receipts,
        &f.operations,
    )
}

#[test]
fn real_request_receipts_successor_and_next_request() {
    let fixture = fixture();
    verify_prepared(&fixture.ctx, &fixture.state, &fixture.prepared).unwrap();
    let next = verify(fixture).unwrap();
    assert_eq!(next.balance_micro_usdc.get(), 4_999_999);
    assert_eq!(next.balance_blinding, f(19 + 23 + 29));
    let next_signature = next.state_signature.as_ref().unwrap();
    let quote = support::signed_quote(3_000_000_001);
    let (authorization, credential) = support::authorization(&quote);
    let next_prepared = Prepared {
        request: support::bound_request(
            authorization.clone(),
            quote,
            support::NoteState {
                balance: next.balance_micro_usdc.get(),
                blinding: Scalar::from(71u64),
                anchor: next.anchor.to_field(),
                genesis: false,
                signature: groth16::StateSignature {
                    r: ark_ed_on_bn254::EdwardsAffine::new_unchecked(
                        next_signature.r_x.to_field(),
                        next_signature.r_y.to_field(),
                    ),
                    s: Scalar::from_be_bytes_mod_order(next_signature.s.as_bytes()),
                },
            },
        ),
        control_token: credential.strip_prefix("Bearer ").unwrap().into(),
        proxy_token: Some(format!(
            "zkp1.{}.{}",
            authorization.request_id,
            URL_SAFE_NO_PAD.encode([8; 32])
        )),
        tariff: support::tariff(),
        rerandomization: f(23),
    };
    verify_prepared(&fixture.ctx, &next, &next_prepared).unwrap();
    assert_ne!(
        next_prepared.request.public_inputs[8],
        fixture.prepared.request.public_inputs[8]
    );
    if let Ok(directory) = std::env::var("ZKAPI_I08_FIXTURE_DIR") {
        let directory = std::path::Path::new(&directory);
        std::fs::create_dir_all(directory).unwrap();
        let prepare = json!({"kind":"prepare","context":fixture.ctx,"state":fixture.state,"prepared":fixture.prepared,"now":"3000000000","root":fixture.prepared.request.public_inputs[3]});
        let settlement = json!({"kind":"settle","context":fixture.ctx,"state":fixture.state,"prepared":fixture.prepared,"settlement":fixture.settlement,"receipts":fixture.receipts,"operations":fixture.operations});
        for (name, value) in [
            ("prepare-command.json", prepare),
            ("settlement-command.json", settlement),
            (
                "expected-next-state.json",
                serde_json::to_value(next).unwrap(),
            ),
        ] {
            let path = directory.join(name);
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options.open(path).unwrap();
            file.write_all(&serde_json::to_vec_pretty(&value).unwrap())
                .unwrap();
            file.sync_all().unwrap();
        }
    }
}
use ark_ff::PrimeField;

#[test]
fn proof_quote_credential_private_state_and_successor_tampering_rejected() {
    let original = fixture();
    let mut changed = original.clone();
    changed.prepared.request.public_inputs[3] = f(5);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    let mut proof = STANDARD
        .decode(&changed.prepared.request.proof.proof)
        .unwrap();
    proof[0] ^= 1;
    changed.prepared.request.proof.proof = STANDARD.encode(proof);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.prepared.control_token.push('x');
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.prepared.proxy_token = None;
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.prepared.request.quote.body.cap_micro_usdc = MicroUsdc::new(999).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.state.balance_micro_usdc = MicroUsdc::new(5_000_001).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.state.note_leaf = f(10);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.state.balance_blinding =
        FieldElement::from_bytes(field_bytes(-Scalar::from(1u64))).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.prepared.rerandomization = f(24);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.ctx.request_vk_sha256 = "00".repeat(32);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.settlement.next_commitment.x = f(12);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.settlement.next_anchor = original.state.anchor;
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.settlement.next_state_signature.s = f(9);
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.settlement.charge_micro_usdc = MicroUsdc::new(2).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.settlement.blind_delta_srv = f(30);
    assert!(verify(&changed).is_err());
}

#[test]
fn missing_duplicate_foreign_receipts_math_and_reservation_rejected() {
    let original = fixture();
    let mut changed = original.clone();
    changed.receipts.pop();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts.push(changed.receipts[0].clone());
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.operations.push(changed.operations[0].clone());
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts[0].body.charged_nano_usdc = "1000".into();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts[0].body.request_id = Uuid::new_v4().to_string();
    changed.receipts[0] = Receipt::sign(changed.receipts[0].body.clone(), &receipt_key()).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts[0].body.usage[0].count = "4".into();
    changed.receipts[0] = Receipt::sign(changed.receipts[0].body.clone(), &receipt_key()).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts[0].body.reservation_nano_usdc = "1000000001".into();
    changed.receipts[0] = Receipt::sign(changed.receipts[0].body.clone(), &receipt_key()).unwrap();
    assert!(verify(&changed).is_err());
    let mut changed = original.clone();
    changed.receipts[0].body.operation_id = Some(changed.operations[1].clone());
    changed.receipts[0] = Receipt::sign(changed.receipts[0].body.clone(), &receipt_key()).unwrap();
    assert!(verify(&changed).is_err());
}

#[test]
fn unknown_waiver_zero_charge_successor_and_late_loss_do_not_increase_charge() {
    let mut fixture = fixture().clone();
    for receipt in &mut fixture.receipts {
        let b = &mut receipt.body;
        b.reason = "waived_unknown".into();
        b.evidence_kind = "UNKNOWN_OPERATOR_LOSS".into();
        b.usage.clear();
        b.observed_nano_usdc = None;
        b.charged_nano_usdc = "0".into();
        b.operator_loss_nano_usdc = None;
        *receipt = Receipt::sign(b.clone(), &receipt_key()).unwrap();
    }
    fixture.settlement = settle(&fixture, 0);
    let next = verify(&fixture).unwrap();
    assert_eq!(next.balance_micro_usdc, fixture.state.balance_micro_usdc);
    assert_ne!(next.anchor, fixture.state.anchor);
    let mut late = charge_receipt(&fixture, &fixture.operations[0], 3000).body;
    late.billing_effect = "late_loss_observation".into();
    late.reason = "late_usage".into();
    late.related_receipt_hash = Some(fixture.receipts[0].receipt_hash.clone());
    late.charged_nano_usdc = "0".into();
    late.operator_loss_nano_usdc = Some("1000".into());
    fixture
        .receipts
        .push(Receipt::sign(late.clone(), &receipt_key()).unwrap());
    assert_eq!(verify(&fixture).unwrap(), next);
    late.related_receipt_hash = Some("00".repeat(32));
    *fixture.receipts.last_mut().unwrap() = Receipt::sign(late, &receipt_key()).unwrap();
    assert!(verify(&fixture).is_err());
}

#[test]
fn admission_checks_time_root_but_recovery_does_not_reapply_quote_expiry() {
    let fixture = fixture();
    assert!(quote::validate_new(
        &fixture.prepared.request,
        &fixture.prepared.tariff,
        3_000_000_120,
        fixture.prepared.request.public_inputs[3]
    )
    .is_err());
    assert!(quote::validate_new(
        &fixture.prepared.request,
        &fixture.prepared.tariff,
        3_000_000_000,
        f(0)
    )
    .is_err());
    verify(fixture).unwrap();
    let mut value = serde_json::to_value(&fixture.state).unwrap();
    value["balance_micro_usdc"] = json!(5_000_000);
    assert!(serde_json::from_value::<PrivateState>(value).is_err());
    let mut value = serde_json::to_value(&fixture.prepared).unwrap();
    value["unknown"] = json!(true);
    assert!(serde_json::from_value::<Prepared>(value).is_err());
    let mut changed = fixture.clone();
    use ark_ff::BigInteger;
    let modulus = Scalar::MODULUS.to_bytes_be();
    let mut bytes = [0u8; 32];
    bytes[32 - modulus.len()..].copy_from_slice(&modulus);
    let scalar_modulus = FieldElement::from_bytes(bytes).unwrap();
    changed.settlement.blind_delta_srv = scalar_modulus;
    assert!(verify(&changed).is_err());
}

#[test]
fn both_direct_modes_require_exact_quote_cap_usd_receipt_and_no_proxy_credential() {
    use zkapi_control::wire;
    for (mode, provider, evidence) in [
        (
            wire::Mode::DirectOa,
            wire::Provider::Oa,
            "OA_SIGNED_RECEIPT",
        ),
        (
            wire::Mode::DirectOpenrouter,
            wire::Provider::Openrouter,
            "OPENROUTER_USAGE",
        ),
    ] {
        let mut fixture = fixture().clone();
        let mut tariff = support::tariff();
        tariff.provider = provider.clone();
        tariff.model = "*".into();
        tariff.pricing_basis = "provider_reported_usd".into();
        tariff.rates.clear();
        tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
        let quote = quote::issue_quote(
            &wire::QuoteRequest {
                mode: mode.clone(),
                provider,
                models: vec!["*".into()],
                session_ttl_seconds: None,
            },
            &tariff,
            &support::local_binding(),
            3_000_000_000,
            &SigningKey::from_bytes(&[11; 32]),
        )
        .unwrap();
        let (mut authorization, token) = support::authorization(&quote);
        authorization.mode = mode;
        authorization.proxy_secret_hash = None;
        fixture.prepared = Prepared {
            request: support::bound_request(authorization, quote, support::genesis_state()),
            control_token: token.strip_prefix("Bearer ").unwrap().into(),
            proxy_token: None,
            tariff,
            rerandomization: f(23),
        };
        fixture.ctx.tariff_hashes = vec![fixture.prepared.tariff.tariff_hash.clone()];
        fixture.operations.clear();
        let mut receipt = fixture.receipts[0].body.clone();
        receipt.request_id = fixture.prepared.request.authorization.request_id.clone();
        receipt.operation_id = None;
        receipt.evidence_kind = evidence.into();
        receipt.provider_evidence_digest = Some("ab".repeat(32));
        receipt.tariff_hash = fixture.prepared.tariff.tariff_hash.clone();
        receipt.usage.clear();
        receipt.provider_reported_usd = Some("0.000000001".into());
        receipt.reservation_nano_usdc = fixture.ctx.cap_micro_usdc.as_nano().to_string();
        fixture.receipts = vec![Receipt::sign(receipt.clone(), &receipt_key()).unwrap()];
        fixture.settlement = settle(&fixture, 1);
        assert_eq!(
            verify(&fixture).unwrap().balance_micro_usdc.get(),
            4_999_999
        );
        receipt.reservation_nano_usdc = "1000".into();
        fixture.receipts[0] = Receipt::sign(receipt, &receipt_key()).unwrap();
        assert!(verify(&fixture).is_err());
        fixture.prepared.proxy_token = Some("not allowed".into());
        assert!(verify_prepared(&fixture.ctx, &fixture.state, &fixture.prepared).is_err());
    }
}

#[test]
fn native_cli_stdin_roundtrip_and_rejections_redact_private_material() {
    use std::io::Write;
    use std::process::{Command as ProcessCommand, Stdio};
    let fixture = fixture();
    let command = json!({"kind":"settle","context":fixture.ctx,"state":fixture.state,"prepared":fixture.prepared,"settlement":fixture.settlement,"receipts":fixture.receipts,"operations":fixture.operations});
    let invoke = |input: &[u8]| {
        let mut process = ProcessCommand::new(env!("CARGO_BIN_EXE_zkapi-client-verify"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process.stdin.take().unwrap().write_all(input).unwrap();
        process.wait_with_output().unwrap()
    };
    let encoded = serde_json::to_vec(&command).unwrap();
    let good = invoke(&encoded);
    assert!(good.status.success());
    assert!(good.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<PrivateState>(&good.stdout).unwrap(),
        verify(fixture).unwrap()
    );
    let mut missing = command.clone();
    missing["receipts"] = json!([]);
    let duplicate = String::from_utf8(encoded.clone()).unwrap().replacen(
        "\"cap_micro_usdc\":",
        "\"cap_micro_usdc\":\"1000000\",\"cap_micro_usdc\":",
        1,
    );
    let mut unknown = command;
    unknown["prepared"]["private_unknown"] = json!("do not echo");
    for invalid in [
        serde_json::to_vec(&missing).unwrap(),
        duplicate.into_bytes(),
        serde_json::to_vec(&unknown).unwrap(),
        b"{bad json secret}".to_vec(),
    ] {
        let output = invoke(&invalid);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"client verification rejected\n");
    }
}
