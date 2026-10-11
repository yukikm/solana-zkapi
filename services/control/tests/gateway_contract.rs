//! Offline synthetic wire/accounting vectors. No provider or chain activity.
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use zkapi_control::{quote::*, receipts::*, wire::*};
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../docs/contracts/universal-api-gateway-vectors.json"
    ))
    .unwrap()
}
fn binding() -> ApiBindingV2 {
    serde_json::from_value(vectors()["binding"].clone()).unwrap()
}
fn tariff() -> Tariff {
    strict_parse(&serde_json::to_vec(&vectors()["tariff"]).unwrap()).unwrap()
}
fn resign(t: &mut Tariff) {
    t.tariff_hash = tariff_hash(t).unwrap();
}
fn body(t: &Tariff) -> ReceiptBody {
    let api = t.api.as_ref().unwrap().v2().unwrap();
    ReceiptBody {
        gateway: Some(
            GatewayReceiptFields::for_operation(
                api,
                &[8; 32],
                Some(CompletionEvidence {
                    rule_hash: hex::encode(digest(&api.completion).unwrap()),
                    outcome: "satisfied".into(),
                    http_status: 200,
                }),
            )
            .unwrap(),
        ),
        version: "3".into(),
        receipt_id: "00000000-0000-4000-8000-000000000004".into(),
        deployment_id: "gateway-synthetic-v2".into(),
        pool: "11111111111111111111111111111111".into(),
        request_id: "00000000-0000-4000-8000-000000000001".into(),
        operation_id: Some("00000000-0000-4000-8000-000000000002".into()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1".into(),
        evidence_kind: "PROXY_USAGE".into(),
        provider_request_id: None,
        provider_evidence_digest: None,
        tariff_hash: t.tariff_hash.clone(),
        usage: vec![UsageUnit {
            unit: "requests".into(),
            count: "1".into(),
        }],
        provider_reported_usd: None,
        reservation_nano_usdc: "250000".into(),
        observed_nano_usdc: Some("250000".into()),
        charged_nano_usdc: "250000".into(),
        operator_loss_nano_usdc: Some("0".into()),
        reason: "metered".into(),
    }
}
#[test]
fn tracked_v2_vectors_and_all_committed_inputs() {
    let all = vectors();
    let api = binding();
    validate_api_binding_v2(&api).unwrap();
    assert_eq!(hex::encode(digest(&api).unwrap()), all["binding_hash"]);
    let t = tariff();
    validate_tariff(&t).unwrap();
    assert_eq!(calculate_reservation(&t).unwrap(), 250000);
    let secret: [u8; 32] = hex::decode(all["proxy_secret_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    for v in all["vectors"].as_array().unwrap() {
        let i = &v["input"];
        let get = |n: &str| i[n].as_str().unwrap();
        let headers: HeaderPairs =
            serde_json::from_value(v["semantic_header_pairs"].clone()).unwrap();
        let raw = hex::decode(get("body_hex")).unwrap();
        let expected = operation_hmac_v2(
            &secret,
            get("deployment_id"),
            get("pool"),
            get("authorization_id"),
            get("operation_id"),
            all["binding_hash"].as_str().unwrap(),
            &t.tariff_hash,
            get("method"),
            get("target"),
            &headers,
            &raw,
        )
        .unwrap();
        assert_eq!(hex::encode(expected), v["operation_hmac"]);
        let args = [
            get("deployment_id").to_string(),
            get("pool").to_string(),
            get("authorization_id").to_string(),
            get("operation_id").to_string(),
            all["binding_hash"].as_str().unwrap().to_string(),
            t.tariff_hash.clone(),
            get("method").to_string(),
            get("target").to_string(),
        ];
        for idx in 0..10 {
            let mut a = args.clone();
            let mut h = headers.clone();
            let mut b = raw.clone();
            match idx {
                0 => a[0].push('x'),
                1 => a[1] = bs58::encode([1; 32]).into_string(),
                2 | 3 => a[idx] = "00000000-0000-4000-8000-000000000009".into(),
                4 | 5 => a[idx] = "00".repeat(32),
                6 => a[6] = "PUT".into(),
                7 => a[7].push('&'),
                8 => h.push(("z-test".into(), "eA==".into())),
                9 => {
                    b.push(1);
                    if a[6] == "GET" {
                        a[6] = "POST".into();
                    }
                }
                _ => unreachable!(),
            };
            assert_ne!(
                operation_hmac_v2(
                    &secret, &a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7], &h, &b
                )
                .unwrap(),
                expected
            );
        }
    }
}
#[test]
fn strict_binding_paths_limits_cross_fields_and_numbers() {
    let mut api = binding();
    api.routes[0].path = "/v1/{id}".into();
    validate_api_binding_v2(&api).unwrap();
    assert!(route_matches(&api.routes[0], "GET", "/v1/a%2E?x=1&x=2"));
    assert!(!route_matches(&api.routes[0], "GET", "/v1/a/b"));
    for target in [
        "//x",
        "/x//y",
        "/x/%2e%2E",
        "/x/%2f",
        "/x/%5C",
        "/x/%25",
        "/x/%00",
        "/x\\y",
        "/x#z",
        "/x?bad=%",
        "/x y",
    ] {
        assert!(validate_raw_target(target).is_err(), "{target}");
    }
    for target in ["/x?", "/x?a=1&a=2", "/x?a=b?c=d", "/x%2Ey/"] {
        validate_raw_target(target).unwrap();
    }
    api.limits.header_seconds = "601".into();
    assert!(validate_api_binding_v2(&api).is_err());
    let mut v = vectors()["binding"].clone();
    v["meter"]["resource"] = json!({"provider":"openai","model":"x"});
    let bad: ApiBindingV2 = serde_json::from_value(v).unwrap();
    assert!(validate_api_binding_v2(&bad).is_err());
    let mut t = tariff();
    t.api = Some(
        ApiBinding {
            version: "1".into(),
            service: "x".into(),
            operation: "y".into(),
            method: "POST".into(),
            path: "/".into(),
            origin: "https://fixture.example".into(),
            request_max_bytes: "1".into(),
            response_max_bytes: "1".into(),
            timeout_seconds: "1".into(),
            billing: "http_2xx_json".into(),
        }
        .into(),
    );
    resign(&mut t);
    assert!(validate_tariff(&t).is_err());
    let source = serde_json::to_string(&vectors()["tariff"]).unwrap();
    assert!(strict_parse::<Tariff>(source.replace("[200]", "[200.0]").as_bytes()).is_err());
    assert!(strict_parse::<Tariff>(
        source
            .replace("\"version\":\"3\"", "\"version\":\"3\",\"version\":\"3\"")
            .as_bytes()
    )
    .is_err());
    assert!(strict_parse::<Value>(b"{\"price\":200}").is_err());
}
#[test]
fn required_trailers_cannot_bypass_response_policy() {
    let mut api = binding();
    api.headers.trailers = vec!["x-checksum".into()];
    validate_api_binding_v2(&api).unwrap();
    api.headers.response_reject = api.headers.trailers.clone();
    assert!(validate_api_binding_v2(&api).is_err());
    api.headers.response_reject.clear();
    for name in [
        "access-control-allow-origin",
        "cross-origin-resource-policy",
        "content-security-policy-report-only",
        "strict-transport-security",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "permissions-policy",
        "clear-site-data",
    ] {
        api.headers.trailers = vec![name.into()];
        assert!(validate_api_binding_v2(&api).is_err(), "{name}");
    }
}

#[test]
fn v3_receipt_roundtrip_fixed_zero_unknown_and_late() {
    let t = tariff();
    let b = body(&t);
    validate_tariff_math(&b, &t).unwrap();
    let key = SigningKey::from_bytes(&[9; 32]);
    let signed = Receipt::sign(b.clone(), &key).unwrap();
    signed.verify(&key.verifying_key()).unwrap();
    let parsed: Receipt = strict_parse(&jcs(&signed).unwrap()).unwrap();
    parsed.verify(&key.verifying_key()).unwrap();
    for key in [
        "binding_hash",
        "operation_hmac",
        "meter_hash",
        "resource",
        "completion",
    ] {
        let mut v = serde_json::to_value(&signed.body).unwrap();
        v.as_object_mut().unwrap().remove(key);
        let parsed = strict_parse::<ReceiptBody>(&jcs(&v).unwrap());
        assert!(
            parsed.is_err() || parsed.unwrap().validate().is_err(),
            "missing {key}"
        );
    }
    let mut zero = b.clone();
    zero.gateway.as_mut().unwrap().completion = Some(CompletionEvidence {
        rule_hash: b
            .gateway
            .as_ref()
            .unwrap()
            .completion
            .as_ref()
            .unwrap()
            .rule_hash
            .clone(),
        outcome: "not_satisfied".into(),
        http_status: 404,
    });
    zero.usage[0].count = "0".into();
    zero.observed_nano_usdc = Some("0".into());
    zero.charged_nano_usdc = "0".into();
    validate_tariff_math(&zero, &t).unwrap();
    zero.gateway
        .as_mut()
        .unwrap()
        .completion
        .as_mut()
        .unwrap()
        .outcome = "satisfied".into();
    assert!(validate_tariff_math(&zero, &t).is_err());
    let mut unknown = b.clone();
    unknown.reason = "waived_unknown".into();
    unknown.evidence_kind = "UNKNOWN_OPERATOR_LOSS".into();
    unknown.usage.clear();
    unknown.gateway.as_mut().unwrap().completion = None;
    unknown.charged_nano_usdc = "0".into();
    unknown.observed_nano_usdc = None;
    unknown.operator_loss_nano_usdc = None;
    validate_tariff_math(&unknown, &t).unwrap();
    unknown.usage.push(UsageUnit {
        unit: "requests".into(),
        count: "0".into(),
    });
    assert!(validate_tariff_math(&unknown, &t).is_err());
    let mut late = b;
    late.reason = "late_usage".into();
    late.billing_effect = "late_loss_observation".into();
    late.related_receipt_hash = Some("a".repeat(64));
    late.charged_nano_usdc = "0".into();
    late.operator_loss_nano_usdc = late.observed_nano_usdc.clone();
    validate_tariff_math(&late, &t).unwrap();
    late.reservation_nano_usdc = "1".into();
    assert!(validate_tariff_math(&late, &t).is_err());
}
#[test]
fn conservative_rational_usage_reservation_and_operator_loss() {
    let mut t = tariff();
    let mut api = binding();
    api.meter.adapter.id = "openai_responses".into();
    api.meter.resource = Some(MeterResource {
        provider: "openai".into(),
        model: "fixture-model".into(),
    });
    api.meter.config = json!({"provider_contract_sha256":"a".repeat(64),"context_max_tokens":"10","output_max_tokens":"3","service_tier":"default","extra_cost_policy":"reject_unclassified"});
    api.meter.config_hash = hex::encode(digest(&api.meter.config).unwrap());
    api.completion.kind = "provider_terminal_usage".into();
    t.api = Some(api.into());
    t.pricing_basis = "fixed_usage_rates".into();
    t.rates = [
        ("cache_read_tokens", "1", "3", "10"),
        ("input_tokens", "1", "7", "10"),
        ("output_tokens", "2", "3", "3"),
    ]
    .into_iter()
    .map(|(unit, n, d, c)| Rate {
        unit: unit.into(),
        nano_usdc_numerator: n.into(),
        unit_denominator: d.into(),
        reservation_max_count: Some(c.into()),
    })
    .collect();
    resign(&mut t);
    assert_eq!(calculate_reservation(&t).unwrap(), 7);
    let counts = [
        ("cache_read_tokens", "11"),
        ("input_tokens", "11"),
        ("output_tokens", "4"),
    ]
    .into_iter()
    .map(|(u, c)| Usage {
        unit: u.into(),
        count: c.into(),
    })
    .collect::<Vec<_>>();
    assert_eq!(calculate_charge(&t, &counts).unwrap(), 8);
    let mut b = body(&t);
    b.usage = counts
        .into_iter()
        .map(|u| UsageUnit {
            unit: u.unit,
            count: u.count,
        })
        .collect();
    b.reservation_nano_usdc = "7".into();
    b.observed_nano_usdc = Some("8".into());
    b.charged_nano_usdc = "7".into();
    b.operator_loss_nano_usdc = Some("1".into());
    validate_tariff_math(&b, &t).unwrap();
    t.rates[0].reservation_max_count = Some("9".into());
    resign(&mut t);
    assert!(validate_tariff(&t).is_err());
    t.rates[0].reservation_max_count = Some("10".into());
    for r in &mut t.rates {
        r.nano_usdc_numerator = i64::MAX.to_string();
        r.unit_denominator = "1".into();
        r.reservation_max_count = Some(i64::MAX.to_string());
    }
    let api = match t.api.as_mut().unwrap() {
        VersionedApiBinding::V2(a) => a,
        _ => unreachable!(),
    };
    api.meter.config["context_max_tokens"] = i64::MAX.to_string().into();
    api.meter.config["output_max_tokens"] = i64::MAX.to_string().into();
    api.meter.config_hash = hex::encode(digest(&api.meter.config).unwrap());
    resign(&mut t);
    assert!(validate_tariff(&t).is_err());
}
