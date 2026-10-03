use ed25519_dalek::SigningKey;
use zkapi_control::receipts::*;
fn body() -> ReceiptBody {
    ReceiptBody {
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
