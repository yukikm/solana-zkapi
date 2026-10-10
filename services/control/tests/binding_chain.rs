mod support;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use support::*;
use zkapi_control::{chain::*, crypto::verify_request, quote::*, wire::*};
use zkapi_solana_types::{FieldElement, MicroUsdc};

#[test]
fn strict_parser_rejects_duplicate_unknown_float_noncanonical_and_missing_fields() {
    let quote = signed_quote(1_800_000_000);
    let (a, _) = authorization(&quote);
    let bytes = jcs(&a).unwrap();
    let parsed: Authorization = strict_parse(&bytes).unwrap();
    assert_eq!(parsed, a);
    for bytes in [
        b"{\"nullifier\":\"x\",\"nullifier\":\"y\"}".as_slice(),
        b"{\"nullifier\":3.1}",
        b"{\"nullifier\":1}",
        b"{\"nullifier\":\"x\",\"unknown\":true}",
        b"{\"nullifier\":\"\xff\"}",
        b"{\"nullifier\":\"0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF\"}",
    ] {
        assert!(strict_parse::<ClearanceRequest>(bytes).is_err())
    }
    let mut value = serde_json::to_value(&a).unwrap();
    value.as_object_mut().unwrap().remove("proxy_secret_hash");
    assert!(strict_parse::<Authorization>(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(strict_parse::<Value>(&vec![b' '; 16 * 1024 + 1]).is_err());
    for n in ["01", "1.0", "1e3", "-1", "+1", ""] {
        assert!(uint(n).is_err())
    }
    for id in [
        "00000000-0000-4000-8000-00000000000A",
        "00000000-0000-1000-8000-000000000001",
    ] {
        assert!(uuid(id).is_err())
    }
}
#[test]
fn strict_optional_values_and_numeric_objects_cannot_bypass_parser() {
    assert!(strict_parse::<Value>(b"123.4").is_err());
    assert!(strict_parse::<Value>(b"{\"a\":1}").is_err());
    assert!(strict_parse::<Value>(br#"{"a":"first","\u0061":"second"}"#).is_err());
    assert!(strict_parse::<QuoteRequest>(br#"{"mode":"proxy","provider":"openai","models":["local-test"],"session_ttl_seconds":null}"#).is_err());
    let request = QuoteRequest {
        api: None,
        mode: Mode::Proxy,
        provider: Provider::Openai,
        models: vec!["local-test".into()],
        session_ttl_seconds: None,
    };
    let parsed: QuoteRequest = strict_parse(&jcs(&request).unwrap()).unwrap();
    assert_eq!(parsed, request);
}

#[test]
fn jcs_binding_vectors_and_credentials() {
    let v: Value =
        serde_json::from_str(include_str!("../../../docs/contracts/binding-vectors.json")).unwrap();
    let a: Authorization = serde_json::from_value(v["authorization_fixture"].clone()).unwrap();
    assert_eq!(
        String::from_utf8(jcs(&a).unwrap()).unwrap(),
        v["authorization_jcs_utf8"].as_str().unwrap()
    );
    let expected = &v["vectors"][3]["field"];
    assert_eq!(
        zkapi_solana_types::binding::authorization_context(&jcs(&a).unwrap())
            .unwrap()
            .to_string(),
        expected.as_str().unwrap()
    );
    let quote = signed_quote(1_800_000_000);
    let (a, token) = authorization(&quote);
    credential_matches(
        &parse_control_token(&token).unwrap(),
        &a.request_id,
        &a.control_secret_hash,
    )
    .unwrap();
    for bad in [
        token.replace("zkc1", "zkp1"),
        format!("{token}="),
        token.replace("Bearer ", "bearer "),
    ] {
        assert!(parse_control_token(&bad).is_err())
    }
}
#[test]
fn rates_round_once_and_direct_decimal_never_uses_float() {
    let t = tariff();
    let u = vec![
        Usage {
            unit: "input_tokens".into(),
            count: "1".into(),
        },
        Usage {
            unit: "output_tokens".into(),
            count: "1".into(),
        },
    ];
    assert_eq!(calculate_charge(&t, &u).unwrap(), 1);
    assert!(calculate_charge(&t, &u[..1]).is_err());
    let mut bad = t.clone();
    bad.rates[1].unit = "input_tokens".into();
    bad.tariff_hash = tariff_hash(&bad).unwrap();
    assert!(validate_tariff(&bad).is_err());
    let cap = MicroUsdc::new(1_000_000).unwrap();
    let d = direct_charge(&["0.0000000004", "4e-10"], cap).unwrap();
    assert_eq!(d.normalized_usd, "0.0000000008");
    assert_eq!(d.observed_nano, 1);
    let d = direct_charge(&["0.1", "0.2"], cap).unwrap();
    assert_eq!(d.normalized_usd, "0.3");
    assert_eq!(d.charged_nano, 300_000_000);
    let d = direct_charge(&["1.0000000001"], cap).unwrap();
    assert_eq!(d.operator_loss_nano, 1);
    for bad in ["1e-2147483648", "NaN", "-1", "01", "1.", "1e+", "1e129"] {
        assert!(direct_charge(&[bad], cap).is_err())
    }
}
#[test]
fn fixed_vk_real_request_and_all_public_input_changes() {
    let f = fixture();
    let p = &f["auth"]["request"];
    let inputs: [FieldElement; 12] = serde_json::from_value(p["public_inputs"].clone()).unwrap();
    let proof = hex::decode(p["proof_wire_hex"].as_str().unwrap()).unwrap();
    verify_request(&inputs, &proof).unwrap();
    for i in 0..12 {
        let mut changed = inputs;
        changed[i] = (changed[i].to_field() + ark_bn254::Fr::from(1u64)).into();
        assert!(verify_request(&changed, &proof).is_err())
    }
    for index in 0..8 {
        let mut bad = proof.clone();
        bad[index * 32 + 31] ^= 1;
        assert!(verify_request(&inputs, &bad).is_err())
    }
}
#[test]
fn real_quote_bound_request_and_authorization_mutations() {
    let quote = signed_quote(1_800_000_000);
    let (a, token) = authorization(&quote);
    let request = bound_request(a, quote, genesis_state());
    let credential = parse_control_token(&token).unwrap();
    let cfg = local_binding();
    let valid = validate_binding(&request, &credential, &cfg).unwrap();
    verify_request(&request.public_inputs, &valid.proof).unwrap();
    validate_new(&request, &tariff(), 1_800_000_119, request.public_inputs[3]).unwrap();
    assert!(validate_new(&request, &tariff(), 1_800_000_120, request.public_inputs[3]).is_err());
    for field in [
        "mode",
        "provider",
        "tariff_hash",
        "control_api_origin",
        "inference_api_origin",
    ] {
        let mut value = serde_json::to_value(&request).unwrap();
        let replacement = match field {
            "mode" => "direct_openrouter",
            "provider" => "anthropic",
            "tariff_hash" => "1111111111111111111111111111111111111111111111111111111111111111",
            _ => "https://changed.example",
        };
        value["quote"]["body"][field] = replacement.into();
        let changed: SessionCreate = serde_json::from_value(value).unwrap();
        assert!(validate_binding(&changed, &credential, &cfg).is_err())
    }
    for field in [
        "deployment_id",
        "request_id",
        "quote_hash",
        "control_secret_hash",
        "proxy_secret_hash",
    ] {
        let mut changed = request.clone();
        match field {
            "deployment_id" => changed.authorization.deployment_id = "other".into(),
            "request_id" => changed.authorization.request_id = uuid::Uuid::new_v4().to_string(),
            "quote_hash" => changed.authorization.quote_hash = "11".repeat(32),
            "control_secret_hash" => changed.authorization.control_secret_hash = "11".repeat(32),
            _ => changed.authorization.proxy_secret_hash = Some("11".repeat(32)),
        }
        assert!(validate_binding(&changed, &credential, &cfg).is_err())
    }
    let recovered = validate_binding(&request, &credential, &cfg).unwrap();
    assert_eq!(recovered.digest, valid.digest)
}
fn chain_fixture() -> (Value, TrustedPool) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/i05/chain.json");
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(path).expect("run SBF control export first"))
            .unwrap();
    let raw = STANDARD
        .decode(fixture["pool_account"]["data"][0].as_str().unwrap())
        .unwrap();
    let key = |range: std::ops::Range<usize>| bs58::encode(&raw[range]).into_string();
    let trusted = TrustedPool {
        public_devnet_profile_hash: None,
        deployment_environment: Default::default(),
        program_id: fixture["pool_account"]["owner"].as_str().unwrap().into(),
        pool: fixture["pool"].as_str().unwrap().into(),
        genesis_hash: key(10..42),
        mint: key(42..74),
        token_program: key(74..106),
        vault_binding: FieldElement::from_bytes(raw[107..139].try_into().unwrap()).unwrap(),
        state_key: zkapi_control::crypto::role_key(
            &zkapi_control::crypto::deployment_keys::STATE_KEY,
        )
        .unwrap(),
        clearance_key: zkapi_control::crypto::role_key(
            &zkapi_control::crypto::deployment_keys::CLEARANCE_KEY,
        )
        .unwrap(),
        cap_micro_usdc: MicroUsdc::new(1_000_000).unwrap(),
        note_ttl_seconds: "2592000".into(),
        challenge_seconds: "86400".into(),
        circuit_profile_hash: PROFILE_HASH.into(),
    };
    (fixture, trusted)
}
#[test]
fn actual_vault_pool_and_exit_bytes_reject_owner_pda_layout_and_each_auth_setting() {
    let (f, t) = chain_fixture();
    let value = f["pool_account"].clone();
    validate_pool_account(&t, &value, 100).unwrap();
    for at in [
        0, 8, 9, 10, 42, 74, 106, 107, 203, 267, 331, 339, 347, 356, 357, 358, 390,
    ] {
        let mut changed = value.clone();
        let mut raw = STANDARD
            .decode(changed["data"][0].as_str().unwrap())
            .unwrap();
        raw[at] ^= 1;
        changed["data"][0] = STANDARD.encode(raw).into();
        assert!(
            validate_pool_account(&t, &changed, 100).is_err(),
            "offset {at}"
        )
    }
    let n = FieldElement::ZERO;
    let (address, bump) = exit_address(&t, n).unwrap();
    let mut bytes = sha256(b"account:ExitNullifier")[..8].to_vec();
    bytes.extend([2, bump, 1]);
    let exit = json!({"owner":t.program_id,"executable":false,"lamports":1,"data":[STANDARD.encode(&bytes),"base64"]});
    assert!(validate_exit_account(&t, n, &address, &exit).unwrap());
    assert!(!validate_exit_account(&t, n, &address, &Value::Null).unwrap());
    assert!(validate_exit_account(&t, n, &t.pool, &exit).is_err());
    let mut bad = exit.clone();
    bad["owner"] = t.pool.clone().into();
    assert!(validate_exit_account(&t, n, &address, &bad).is_err());
    for at in [0, 8, 9, 10] {
        let mut bytes = bytes.clone();
        bytes[at] ^= 1;
        let mut bad = exit.clone();
        bad["data"][0] = STANDARD.encode(bytes).into();
        assert!(validate_exit_account(&t, n, &address, &bad).is_err())
    }
}

#[tokio::test]
async fn dual_rpc_and_ready_indexer_fail_closed_with_real_vault_accounts() {
    use axum::{
        http::StatusCode,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    };
    let (f, t) = chain_fixture();
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/i05/exit-fixture.json");
    let exit: Value = serde_json::from_slice(
        &std::fs::read(path).expect("run actual SBF control --export first"),
    )
    .unwrap();
    let nullifier: FieldElement = exit["nullifier"].as_str().unwrap().parse().unwrap();
    assert!(validate_exit_account(
        &t,
        nullifier,
        exit["address"].as_str().unwrap(),
        &exit["account"]
    )
    .unwrap());
    let root_mode = Arc::new(AtomicU8::new(0));
    let (primary_mode, secondary_mode) = (Arc::new(AtomicU8::new(0)), Arc::new(AtomicU8::new(0)));
    let exit_reads = Arc::new(AtomicUsize::new(0));
    let root_reads = Arc::new(AtomicUsize::new(0));
    let account_minima = Arc::new(Mutex::new(Vec::new()));
    let mut tasks = vec![];
    let mut rpc_urls = vec![];
    for mode in [&primary_mode, &secondary_mode] {
        let mode = mode.clone();
        let trusted = t.clone();
        let fixture = f.clone();
        let exit = exit.clone();
        let reads = exit_reads.clone();
        let minima = account_minima.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(request): Json<Value>| {
                let mode = mode.clone();
                let trusted = trusted.clone();
                let fixture = fixture.clone();
                let exit = exit.clone();
                let reads = reads.clone();
                let minima = minima.clone();
                async move {
                    let mode = mode.load(Ordering::SeqCst);
                    if mode == 3 {
                        return Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-1}}));
                    }
                    let result = if request["method"] == "getGenesisHash" {
                        Value::String(if mode == 6 {
                            bs58::encode([1; 32]).into_string()
                        } else {
                            trusted.genesis_hash
                        })
                    } else {
                        assert_eq!(request["method"], "getAccountInfo");
                        let minimum = request["params"][1]["minContextSlot"].as_u64().unwrap();
                        assert!(matches!(minimum, 100 | 101));
                        minima.lock().unwrap().push(minimum);
                        let value = if request["params"][0] == trusted.pool {
                            assert_eq!(request["params"][1]["commitment"], "finalized");
                            let mut account = fixture["pool_account"].clone();
                            if mode == 7 {
                                let mut bytes = STANDARD
                                    .decode(account["data"][0].as_str().unwrap())
                                    .unwrap();
                                bytes[355] = 1;
                                account["data"][0] = STANDARD.encode(bytes).into()
                            }
                            account
                        } else {
                            assert_eq!(request["params"][0], exit["address"]);
                            assert_eq!(request["params"][1]["commitment"], "confirmed");
                            reads.fetch_add(1, Ordering::SeqCst);
                            match mode {
                                1 => exit["account"].clone(),
                                4 => {
                                    let mut value = exit["account"].clone();
                                    value["owner"] = trusted.pool.into();
                                    value
                                }
                                5 => {
                                    let mut value = exit["account"].clone();
                                    value["data"][0] = STANDARD.encode([0; 11]).into();
                                    value
                                }
                                _ => Value::Null,
                            }
                        };
                        json!({"context":{"slot":if mode==2{99}else{minimum}},"value":value})
                    };
                    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        rpc_urls.push(format!("http://{}", listener.local_addr().unwrap()));
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap()
        }));
    }
    let root = f["root"].clone();
    let root_state = root_mode.clone();
    let reads = root_reads.clone();
    let app = Router::new().route(
        "/zkapi/v1/tree/root",
        get(move || {
            let state = root_state.clone();
            let reads = reads.clone();
            let mut root = root.clone();
            async move {
                let mode = state.load(Ordering::SeqCst);
                let read = reads.fetch_add(1, Ordering::SeqCst);
                if mode == 1 || (mode == 5 && read == 0) {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({"error":"not_ready"})),
                    )
                } else {
                    if mode == 7 {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({"error":"failure"})),
                        );
                    }
                    match mode {
                        2 => root["slot"] = "0100".into(),
                        3 => root["blockhash"] = "invalid".into(),
                        4 => root["next_note_id"] = "18446744073709551616".into(),
                        6 if read > 0 => root["slot"] = "101".into(),
                        _ => {}
                    }
                    (StatusCode::OK, Json(root))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let indexer = format!("http://{}", listener.local_addr().unwrap());
    tasks.push(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap()
    }));
    let client = ChainClient::new(rpc_urls[0].clone(), rpc_urls[1].clone(), indexer, t).unwrap();
    client.startup().await.unwrap();
    let expected = f["root"]["root"].as_str().unwrap().parse().unwrap();
    client.assert_live(nullifier, Some(expected)).await.unwrap();
    assert_eq!(exit_reads.load(Ordering::SeqCst), 2);
    for endpoint in [&primary_mode, &secondary_mode] {
        for failure in 1..=5 {
            endpoint.store(failure, Ordering::SeqCst);
            assert!(
                client.assert_live(nullifier, Some(expected)).await.is_err(),
                "RPC mode {failure}"
            );
            endpoint.store(0, Ordering::SeqCst)
        }
    }
    // Persistent 503/deadline bounds are exercised with the same retry helper's
    // short unit-test clock; malformed observations must fail immediately here.
    for failure in 2..=4 {
        root_mode.store(failure, Ordering::SeqCst);
        assert!(matches!(
            client.observe(nullifier).await,
            Err(ValidationError::Unavailable(_))
        ));
        assert!(matches!(
            client.startup().await,
            Err(ValidationError::Unavailable(_))
        ));
    }
    root_mode.store(0, Ordering::SeqCst);
    secondary_mode.store(6, Ordering::SeqCst);
    assert!(matches!(
        client.startup().await,
        Err(ValidationError::TrustMismatch("RPC genesis"))
    ));
    secondary_mode.store(0, Ordering::SeqCst);
    primary_mode.store(7, Ordering::SeqCst);
    assert!(matches!(
        client.startup().await,
        Err(ValidationError::Conflict("pool paused"))
    ));
    assert!(matches!(
        client.assert_live(nullifier, None).await,
        Err(ValidationError::Conflict("pool paused"))
    ));
    primary_mode.store(0, Ordering::SeqCst);
    assert!(matches!(
        client
            .assert_live(nullifier, Some(FieldElement::ZERO))
            .await,
        Err(ValidationError::Conflict("stale root"))
    ));
    client.assert_live(nullifier, Some(expected)).await.unwrap();
    // Startup/current_root survive only the explicitly transient 503; all other
    // responses retain their fail-closed behavior.
    root_mode.store(5, Ordering::SeqCst);
    root_reads.store(0, Ordering::SeqCst);
    client.startup().await.unwrap();
    assert_eq!(root_reads.load(Ordering::SeqCst), 2);
    root_reads.store(0, Ordering::SeqCst);
    client.assert_live(nullifier, Some(expected)).await.unwrap();
    assert_eq!(root_reads.load(Ordering::SeqCst), 3);
    // The before/after cut changes without any note-root change. Reusing the
    // first Pool/exit observations would miss the fresh minimum of 101.
    root_mode.store(6, Ordering::SeqCst);
    root_reads.store(0, Ordering::SeqCst);
    account_minima.lock().unwrap().clear();
    let observation = client.assert_live(nullifier, Some(expected)).await.unwrap();
    assert_eq!(observation.root.slot, "101");
    assert_eq!(observation.primary_slot, 101);
    assert_eq!(observation.secondary_slot, 101);
    assert_eq!(
        *account_minima.lock().unwrap(),
        [100, 100, 100, 101, 101, 101]
    );
    assert_eq!(root_reads.load(Ordering::SeqCst), 4);
    // A terminal denial is not retried even when a next root would change.
    for (mode, expected_error) in [(7, "pool paused"), (1, "exit consumed")] {
        primary_mode.store(mode, Ordering::SeqCst);
        root_reads.store(0, Ordering::SeqCst);
        assert!(
            matches!(client.assert_live(nullifier, Some(expected)).await,
            Err(ValidationError::Conflict(reason)) if reason == expected_error)
        );
        assert_eq!(root_reads.load(Ordering::SeqCst), 1);
    }
    primary_mode.store(0, Ordering::SeqCst);
    root_reads.store(0, Ordering::SeqCst);
    assert!(matches!(
        client
            .assert_live(nullifier, Some(FieldElement::ZERO))
            .await,
        Err(ValidationError::Conflict("stale root"))
    ));
    assert_eq!(root_reads.load(Ordering::SeqCst), 1);
    root_mode.store(7, Ordering::SeqCst);
    root_reads.store(0, Ordering::SeqCst);
    account_minima.lock().unwrap().clear();
    assert!(matches!(
        client.observe(nullifier).await,
        Err(ValidationError::Unavailable("indexer HTTP"))
    ));
    assert_eq!(root_reads.load(Ordering::SeqCst), 1);
    assert!(account_minima.lock().unwrap().is_empty());
    for task in tasks {
        task.abort()
    }
}

#[test]
fn dual_rpc_configuration_rejects_aliases_of_the_same_origin() {
    let (_, trusted) = chain_fixture();
    for secondary in [
        "https://rpc.example/",
        "https://RPC.EXAMPLE:443",
        "https://rpc.example/other",
        "https://rpc.example?key=other",
    ] {
        assert!(ChainClient::new(
            "https://rpc.example".into(),
            secondary.into(),
            "http://127.0.0.1:8080".into(),
            trusted.clone(),
        )
        .is_err());
    }
    assert!(ChainClient::new(
        "http://127.0.0.1:8081".into(),
        "http://127.0.0.1:8082".into(),
        "http://127.0.0.1:8080".into(),
        trusted,
    )
    .is_ok());
}

#[test]
fn operation_hmac_binds_raw_bytes_endpoint_and_api_version() {
    let body = br#"{"model":"local-test","messages":[]}"#;
    let digest = operation_hmac(&[8; 32], "POST", "/v1/chat/completions", "", body).unwrap();
    // Independent Python stdlib hashlib/hmac calculation of the specified frame.
    assert_eq!(
        hex::encode(digest),
        "c1f84bb8e64cf25f90b9a11ec6341a370ad7d084bbf7352bd6ee3b77c218f7db"
    );
    assert_ne!(
        digest,
        operation_hmac(&[8; 32], "POST", "/v1/responses", "", body).unwrap()
    );
    assert_ne!(
        digest,
        operation_hmac(
            &[8; 32],
            "POST",
            "/v1/chat/completions",
            "",
            b"{ \"model\":\"local-test\",\"messages\":[]}"
        )
        .unwrap()
    );
    assert_ne!(
        digest,
        operation_hmac(&[9; 32], "POST", "/v1/chat/completions", "", body).unwrap()
    );
    assert_ne!(
        operation_hmac(&[8; 32], "POST", "/v1/messages", "2023-06-01", body).unwrap(),
        operation_hmac(&[8; 32], "POST", "/v1/messages", "2024-06-01", body).unwrap()
    );
    for (method, path, version, body) in [
        ("GET", "/v1/responses", "", body.as_slice()),
        ("POST", "/v1/responses?x=1", "", body.as_slice()),
        ("POST", "/v1/responses", "2023-06-01", body.as_slice()),
        ("POST", "/v1/messages", "", body.as_slice()),
        ("POST", "/v1/messages", "2023-06-01", b"\xff".as_slice()),
    ] {
        assert!(operation_hmac(&[8; 32], method, path, version, body).is_err());
    }
}
#[test]
fn signed_receipt_must_recompute_frozen_tariff_math() {
    use zkapi_control::receipts::{validate_tariff_math, Receipt, ReceiptBody, UsageUnit};
    let t = tariff();
    let b = ReceiptBody {
        version: "1".into(),
        receipt_id: uuid::Uuid::new_v4().to_string(),
        deployment_id: "i05-local".into(),
        pool: local_binding().pool,
        request_id: uuid::Uuid::new_v4().to_string(),
        operation_id: Some(uuid::Uuid::new_v4().to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1800000001".into(),
        evidence_kind: "PROXY_USAGE".into(),
        provider_request_id: Some("test-only".into()),
        provider_evidence_digest: None,
        tariff_hash: t.tariff_hash.clone(),
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
        observed_nano_usdc: Some("1".into()),
        charged_nano_usdc: "1".into(),
        operator_loss_nano_usdc: Some("0".into()),
        reason: "metered".into(),
    };
    validate_tariff_math(&b, &t).unwrap();
    let mut false_bill = b.clone();
    false_bill.observed_nano_usdc = Some("2".into());
    false_bill.charged_nano_usdc = "2".into();
    let key = ed25519_dalek::SigningKey::from_bytes(&[13; 32]);
    let signed = Receipt::sign(false_bill, &key).unwrap();
    signed.verify(&key.verifying_key()).unwrap();
    assert!(validate_tariff_math(&signed.body, &t).is_err());
    let mut missing = b.clone();
    missing.usage.pop();
    assert!(validate_tariff_math(&missing, &t).is_err());
    let mut direct_tariff = t.clone();
    direct_tariff.provider = Provider::Openrouter;
    direct_tariff.model = "*".into();
    direct_tariff.pricing_basis = "provider_reported_usd".into();
    direct_tariff.rates.clear();
    direct_tariff.tariff_hash = tariff_hash(&direct_tariff).unwrap();
    let mut direct = b.clone();
    direct.operation_id = None;
    direct.evidence_kind = "OPENROUTER_USAGE".into();
    direct.provider_evidence_digest = Some("00".repeat(32));
    direct.tariff_hash = direct_tariff.tariff_hash.clone();
    direct.usage.clear();
    direct.provider_reported_usd = Some("0.0000000008".into());
    validate_tariff_math(&direct, &direct_tariff).unwrap();
    direct.provider_reported_usd = Some("0.0000000011".into());
    assert!(validate_tariff_math(&direct, &direct_tariff).is_err());
    let mut late = b;
    late.billing_effect = "late_loss_observation".into();
    late.related_receipt_hash = Some("00".repeat(32));
    late.reason = "late_usage".into();
    late.charged_nano_usdc = "0".into();
    late.operator_loss_nano_usdc = Some("1".into());
    validate_tariff_math(&late, &t).unwrap();
}
