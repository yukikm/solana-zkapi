use ed25519_dalek::SigningKey;
use zkapi_control::receipts::*;
fn body() -> ReceiptBody {
    ReceiptBody {
        gateway: None,
        version: "1".into(),
        receipt_id: uuid::Uuid::new_v4().to_string(),
        deployment_id: "local-I05".into(),
        pool: bs58::encode([2; 32]).into_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        operation_id: Some(uuid::Uuid::new_v4().to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1".into(),
        evidence_kind: "PROXY_USAGE".into(),
        provider_request_id: Some("local-observation".into()),
        provider_evidence_digest: None,
        tariff_hash: hex::encode([1; 32]),
        usage: vec![
            UsageUnit {
                unit: "input_tokens".into(),
                count: "1".into(),
            },
            UsageUnit {
                unit: "output_tokens".into(),
                count: "1".into(),
            },
        ],
        provider_reported_usd: None,
        reservation_nano_usdc: "1000".into(),
        observed_nano_usdc: Some("1001".into()),
        charged_nano_usdc: "1000".into(),
        operator_loss_nano_usdc: Some("1".into()),
        reason: "metered".into(),
    }
}
#[test]
fn signed_receipts_bind_session_usage_and_operator_loss() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let receipt = Receipt::sign(body(), &key).unwrap();
    receipt.verify(&key.verifying_key()).unwrap();
    assert!(receipt
        .verify(&SigningKey::from_bytes(&[10; 32]).verifying_key())
        .is_err());
    let mut edited = receipt.clone();
    edited.body.request_id = uuid::Uuid::new_v4().to_string();
    assert!(edited.verify(&key.verifying_key()).is_err());
    let mut edited = receipt.body;
    edited.charged_nano_usdc = "1001".into();
    assert!(Receipt::sign(edited, &key).is_err());
}
#[test]
fn unknown_and_late_observation_never_recharge() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let mut b = body();
    b.evidence_kind = "UNKNOWN_OPERATOR_LOSS".into();
    b.reason = "waived_unknown".into();
    b.charged_nano_usdc = "0".into();
    b.observed_nano_usdc = None;
    b.operator_loss_nano_usdc = None;
    b.usage.clear();
    let unknown = Receipt::sign(b, &key).unwrap();
    unknown.verify(&key.verifying_key()).unwrap();
    let mut late = body();
    late.receipt_id = uuid::Uuid::new_v4().to_string();
    late.billing_effect = "late_loss_observation".into();
    late.reason = "late_usage".into();
    late.related_receipt_hash = Some(unknown.receipt_hash);
    late.charged_nano_usdc = "0".into();
    late.operator_loss_nano_usdc = late.observed_nano_usdc.clone();
    Receipt::sign(late.clone(), &key)
        .unwrap()
        .verify(&key.verifying_key())
        .unwrap();
    late.charged_nano_usdc = "1".into();
    assert!(Receipt::sign(late, &key).is_err());
}

#[test]
fn direct_unknown_waiver_requires_openrouter_approval_digest_without_fabricated_usage() {
    use zkapi_control::{quote, wire};
    let mut tariff = wire::Tariff {
        version: "1".into(),
        provider: wire::Provider::Openrouter,
        model: "*".into(),
        pricing_basis: "provider_reported_usd".into(),
        valid_from: "0".into(),
        valid_until: "9999999999".into(),
        rates: vec![],
        operator_fee_micro_usdc: "0".into(),
        tariff_hash: String::new(),
        api: None,
    };
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    let mut b = body();
    b.operation_id = None;
    b.reason = "waived_unknown".into();
    b.evidence_kind = "UNKNOWN_OPERATOR_LOSS".into();
    b.provider_request_id = None;
    b.provider_evidence_digest = Some("ab".repeat(32));
    b.tariff_hash = tariff.tariff_hash.clone();
    b.usage.clear();
    b.charged_nano_usdc = "0".into();
    b.observed_nano_usdc = None;
    b.operator_loss_nano_usdc = None;
    validate_tariff_math(&b, &tariff).unwrap();
    for mutation in 0..8 {
        let mut changed = b.clone();
        match mutation {
            0 => changed.provider_evidence_digest = None,
            1 => changed.provider_request_id = Some("invented".into()),
            2 => changed.observed_nano_usdc = Some("0".into()),
            3 => changed.operator_loss_nano_usdc = Some("0".into()),
            4 => changed.provider_reported_usd = Some("0".into()),
            5 => changed.charged_nano_usdc = "1".into(),
            6 => changed.operation_id = Some(uuid::Uuid::new_v4().to_string()),
            7 => changed.provider_evidence_digest = Some("not-a-digest".into()),
            _ => unreachable!(),
        }
        assert!(
            validate_tariff_math(&changed, &tariff).is_err(),
            "mutation {mutation}"
        );
    }
    tariff.provider = wire::Provider::Oa;
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    b.tariff_hash = tariff.tariff_hash.clone();
    assert!(validate_tariff_math(&b, &tariff).is_err());
}
