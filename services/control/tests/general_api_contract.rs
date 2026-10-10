//! Generic API contract tests use local synthetic metadata and no wallet state.
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use zkapi_control::{quote::*, receipts::*, wire::*};
use zkapi_solana_types::MicroUsdc;

fn api() -> ApiBinding {
    ApiBinding {
        version: "1".into(),
        service: "catalog".into(),
        operation: "lookup".into(),
        method: "POST".into(),
        path: "/lookup".into(),
        origin: "http://127.0.0.1:9090".into(),
        request_max_bytes: "4096".into(),
        response_max_bytes: "8192".into(),
        timeout_seconds: "30".into(),
        billing: "http_2xx_json".into(),
    }
}
fn tariff() -> Tariff {
    let mut t = Tariff {
        tariff_hash: String::new(),
        version: "2".into(),
        provider: Provider::Generic,
        model: String::new(),
        api: Some(api()),
        pricing_basis: "fixed_request".into(),
        valid_from: "1".into(),
        valid_until: "4000000000".into(),
        rates: vec![Rate {
            unit: "requests".into(),
            nano_usdc_numerator: "7000".into(),
            unit_denominator: "1".into(),
        }],
        operator_fee_micro_usdc: "0".into(),
    };
    t.tariff_hash = tariff_hash(&t).unwrap();
    t
}
fn config() -> BindingConfig {
    BindingConfig {
        deployment_id: "generic-contract-local".into(),
        pool: bs58::encode([2; 32]).into_string(),
        vault_binding: ark_bn254::Fr::from(1u64).into(),
        state_key: [ark_bn254::Fr::from(1u64).into(); 2],
        cap: MicroUsdc::new(1_000_000).unwrap(),
        control_api_origin: "http://127.0.0.1:8788".into(),
        inference_api_origin: "http://127.0.0.1:8789".into(),
        quote_key: SigningKey::from_bytes(&[11; 32]).verifying_key().to_bytes(),
    }
}
fn request() -> QuoteRequest {
    QuoteRequest {
        mode: Mode::Proxy,
        provider: Provider::Generic,
        models: vec![],
        api: Some(api()),
        session_ttl_seconds: None,
    }
}
fn receipt() -> ReceiptBody {
    ReceiptBody {
        version: "2".into(),
        receipt_id: uuid::Uuid::new_v4().to_string(),
        deployment_id: "generic-contract-local".into(),
        pool: bs58::encode([2; 32]).into_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        operation_id: Some(uuid::Uuid::new_v4().to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "100".into(),
        evidence_kind: "PROXY_USAGE".into(),
        provider_request_id: None,
        provider_evidence_digest: None,
        tariff_hash: tariff().tariff_hash,
        usage: vec![UsageUnit {
            unit: "requests".into(),
            count: "1".into(),
        }],
        provider_reported_usd: None,
        reservation_nano_usdc: "7000".into(),
        observed_nano_usdc: Some("7000".into()),
        charged_nano_usdc: "7000".into(),
        operator_loss_nano_usdc: Some("0".into()),
        reason: "metered".into(),
    }
}

#[test]
fn legacy_signed_bytes_round_trip_without_api_fields() {
    let legacy = json!({"tariff_hash":"00".repeat(32),"version":"1","provider":"openai","model":"example-model",
        "pricing_basis":"fixed_usage_rates","valid_from":"1","valid_until":"1000",
        "rates":[{"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"3"},
            {"unit":"output_tokens","nano_usdc_numerator":"2","unit_denominator":"3"}],"operator_fee_micro_usdc":"0"});
    let bytes = jcs(&legacy).unwrap();
    let parsed: Tariff = strict_parse(&bytes).unwrap();
    assert_eq!(jcs(&parsed).unwrap(), bytes);
    let quote = json!({"quote_id":"00000000-0000-4000-8000-000000000001","deployment_id":"local","pool":bs58::encode([2;32]).into_string(),
        "mode":"proxy","provider":"openai","models":["example-model"],"tariff_hash":"11".repeat(32),"cap_micro_usdc":"1000000",
        "issued_at":"100","expires_at":"220","session_ttl_seconds":"60","max_concurrency":"4",
        "control_api_origin":"http://127.0.0.1:8788","inference_api_origin":"http://127.0.0.1:8789"});
    let bytes = jcs(&quote).unwrap();
    let parsed: QuoteBody = strict_parse(&bytes).unwrap();
    assert_eq!(jcs(&parsed).unwrap(), bytes);
    quote_body_valid(&parsed).unwrap();
    let key = SigningKey::from_bytes(&[11; 32]);
    let (hash, signature) = sign_hash(&quote, &key).unwrap();
    verify_hash_signature(&parsed, &hash, &signature, &key.verifying_key().to_bytes()).unwrap();
    assert!(
        strict_parse::<QuoteRequest>(br#"{"provider":"generic","mode":"proxy","api":null}"#)
            .is_err()
    );
}

#[test]
fn explicit_empty_inference_fields_cannot_change_signed_canonical_bytes() {
    let mut quote_request = serde_json::to_value(request()).unwrap();
    assert!(strict_parse::<QuoteRequest>(&jcs(&quote_request).unwrap()).is_ok());
    quote_request["models"] = json!([]);
    assert!(strict_parse::<QuoteRequest>(&jcs(&quote_request).unwrap()).is_err());
    assert!(serde_json::from_value::<QuoteRequest>(quote_request).is_err());

    let signed = issue_quote(
        &request(),
        &tariff(),
        &config(),
        100,
        &SigningKey::from_bytes(&[11; 32]),
    )
    .unwrap();
    let mut quote_body = serde_json::to_value(signed.body).unwrap();
    assert!(strict_parse::<QuoteBody>(&jcs(&quote_body).unwrap()).is_ok());
    quote_body["models"] = json!([]);
    assert!(strict_parse::<QuoteBody>(&jcs(&quote_body).unwrap()).is_err());
    assert!(serde_json::from_value::<QuoteBody>(quote_body).is_err());

    let mut tariff = serde_json::to_value(tariff()).unwrap();
    assert!(strict_parse::<Tariff>(&jcs(&tariff).unwrap()).is_ok());
    tariff["model"] = json!("");
    assert!(strict_parse::<Tariff>(&jcs(&tariff).unwrap()).is_err());
    assert!(serde_json::from_value::<Tariff>(tariff).is_err());
}

#[test]
fn generic_quote_binds_descriptor_without_a_model() {
    let t = tariff();
    let cfg = config();
    let key = SigningKey::from_bytes(&[11; 32]);
    let q = issue_quote(&request(), &t, &cfg, 100, &key).unwrap();
    assert!(quote_matches_tariff(&q.body, &t));
    let value = serde_json::to_value(&q.body).unwrap();
    assert!(value.get("models").is_none());
    assert!(serde_json::to_value(&t).unwrap().get("model").is_none());
    let parsed: Quote = strict_parse(&jcs(&q).unwrap()).unwrap();
    assert_eq!(parsed, q);
    for field in [
        "service",
        "operation",
        "path",
        "origin",
        "request_max_bytes",
        "response_max_bytes",
        "timeout_seconds",
        "billing",
    ] {
        let mut v = value.clone();
        v["api"][field] = match field {
            "path" => "/other",
            "origin" => "http://127.0.0.1:9091",
            "request_max_bytes" | "response_max_bytes" => "1024",
            "timeout_seconds" => "10",
            _ => "changed",
        }
        .into();
        let changed: QuoteBody = serde_json::from_value(v).unwrap();
        assert!(!quote_matches_tariff(&changed, &t), "{field}");
        assert!(
            verify_hash_signature(&changed, &q.quote_hash, &q.signature, &cfg.quote_key).is_err(),
            "{field}"
        );
    }
    let mut invalid = request();
    invalid.models.push("pretend-model".into());
    assert!(issue_quote(&invalid, &t, &cfg, 100, &key).is_err());
    let mut invalid = request();
    invalid.api = None;
    assert!(issue_quote(&invalid, &t, &cfg, 100, &key).is_err());
    let mut invalid = request();
    invalid.mode = Mode::DirectOpenrouter;
    assert!(issue_quote(&invalid, &t, &cfg, 100, &key).is_err());
    let mut invalid = request();
    invalid.provider = Provider::Openai;
    assert!(issue_quote(&invalid, &t, &cfg, 100, &key).is_err());
    let mut invalid = request();
    invalid.api.as_mut().unwrap().operation = "other".into();
    assert!(issue_quote(&invalid, &t, &cfg, 100, &key).is_err());
}

#[test]
fn descriptor_and_operation_hmac_reject_ambiguous_paths() {
    validate_api_binding(&api()).unwrap();
    for bad in [
        "",
        "//host/path",
        "/a/../b",
        "/a/./b",
        "/lookup?x=1",
        "/lookup#x",
        "/%2e%2e",
        "/a\\b",
        "/é",
    ] {
        let mut a = api();
        a.path = bad.into();
        assert!(validate_api_binding(&a).is_err(), "{bad}");
    }
    for bad in ["", "UPPER", "_first", "a/b", "a.b"] {
        let mut a = api();
        a.service = bad.into();
        assert!(validate_api_binding(&a).is_err(), "{bad}");
    }
    let route = api_path(&api());
    let mac = operation_hmac(&[9; 32], "POST", &route, "", br#"{"key":1}"#).unwrap();
    assert_ne!(
        mac,
        operation_hmac(&[9; 32], "POST", &route, "", br#"{"key":2}"#).unwrap()
    );
    assert_ne!(
        mac,
        operation_hmac(
            &[9; 32],
            "POST",
            "/zkapi/v1/api/catalog/other",
            "",
            br#"{"key":1}"#
        )
        .unwrap()
    );
    for bad in [
        "/zkapi/v1/api/catalog/lookup/",
        "/zkapi/v1/api/catalog/lookup?x=1",
        "/zkapi/v1/api/catalog/%6c",
    ] {
        assert!(operation_hmac(&[9; 32], "POST", bad, "", b"{}").is_err());
    }
}

#[test]
fn fixed_request_tariff_and_receipts_recompute_exact_integer_charges() {
    let t = tariff();
    validate_tariff(&t).unwrap();
    for count in ["0", "1"] {
        assert_eq!(
            calculate_charge(
                &t,
                &[Usage {
                    unit: "requests".into(),
                    count: count.into()
                }]
            )
            .unwrap(),
            count.parse::<u128>().unwrap() * 7000
        );
    }
    for count in ["2", "01", "1.0", "-1"] {
        assert!(calculate_charge(
            &t,
            &[Usage {
                unit: "requests".into(),
                count: count.into()
            }]
        )
        .is_err());
    }
    for (field, value) in [
        ("version", json!("1")),
        ("provider", json!("openai")),
        ("model", json!("fake")),
        ("api", Value::Null),
        (
            "rates",
            json!([{ "unit":"requests","nano_usdc_numerator":"0","unit_denominator":"1"}]),
        ),
        (
            "rates",
            json!([{ "unit":"requests","nano_usdc_numerator":"7000","unit_denominator":"2"}]),
        ),
    ] {
        let mut v = serde_json::to_value(&t).unwrap();
        v[field] = value;
        if let Ok(mut bad) = serde_json::from_value::<Tariff>(v) {
            bad.tariff_hash = tariff_hash(&bad).unwrap();
            assert!(validate_tariff(&bad).is_err(), "{field}");
        }
    }
    let b = receipt();
    validate_tariff_math(&b, &t).unwrap();
    let signed = Receipt::sign(b.clone(), &SigningKey::from_bytes(&[9; 32])).unwrap();
    signed
        .verify(&SigningKey::from_bytes(&[9; 32]).verifying_key())
        .unwrap();
    let mut zero = b.clone();
    zero.usage[0].count = "0".into();
    zero.charged_nano_usdc = "0".into();
    zero.observed_nano_usdc = Some("0".into());
    validate_tariff_math(&zero, &t).unwrap();
    let mut bad = b.clone();
    bad.version = "1".into();
    assert!(validate_tariff_math(&bad, &t).is_err());
    let mut bad = b.clone();
    bad.usage[0].count = "2".into();
    assert!(bad.validate().is_err());
    let mut bad = b.clone();
    bad.usage[0].unit = "input_tokens".into();
    assert!(bad.validate().is_err());
    let mut bad = b.clone();
    bad.reservation_nano_usdc = "7001".into();
    assert!(validate_tariff_math(&bad, &t).is_err());
    let mut bad = b;
    bad.usage[0].count = "0".into();
    assert!(validate_tariff_math(&bad, &t).is_err());
}
