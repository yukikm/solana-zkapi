//! Loopback JSON fixtures: no external API, provider credits or wallet state.
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::Response,
    Router,
};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use zkapi_control::{
    generic::{self, ApiProviderConfig, HttpAdapter},
    proxy::RelayEvent,
    quote,
    wire::{ApiBinding, Provider, Rate, Tariff},
};

type Calls = Arc<Mutex<BTreeMap<String, u64>>>;
const RAW: &[u8] = br#"{"sku":"example","count":7}"#;
async fn handle(State(calls): State<Calls>, request: Request) -> Response<Body> {
    assert_eq!(request.method(), "POST");
    assert_eq!(
        request.headers()["authorization"],
        "Bearer local-fixture-only"
    );
    assert_eq!(request.headers()["content-type"], "application/json");
    assert!(request.headers().get("cookie").is_none());
    let path = request.uri().path().to_string();
    *calls.lock().unwrap().entry(path.clone()).or_default() += 1;
    assert_eq!(
        to_bytes(request.into_body(), 4096).await.unwrap().as_ref(),
        RAW
    );
    let (status, content_type, body) = match path.as_str() {
        "/ok" => (
            200,
            "application/json",
            br#"{"available":true,"stock":42}"#.to_vec(),
        ),
        "/rejected" => (
            503,
            "application/json",
            br#"{"private":"local-fixture-only"}"#.to_vec(),
        ),
        "/redirect" => {
            return Response::builder()
                .status(302)
                .header("location", "/ok")
                .body(Body::empty())
                .unwrap()
        }
        "/malformed" => (200, "application/json", b"{".to_vec()),
        "/duplicate" => (200, "application/json", br#"{"a":1,"a":2}"#.to_vec()),
        "/wrong-type" => (200, "text/html", b"not JSON".to_vec()),
        "/large" => (200, "application/json", vec![b' '; 2048]),
        "/slow" => {
            tokio::time::sleep(Duration::from_millis(1250)).await;
            (200, "application/json", b"{}".to_vec())
        }
        _ => panic!("unexpected fixture route"),
    };
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Body::from(body))
        .unwrap()
}
fn tariff(api: &ApiBinding) -> Tariff {
    let mut value = Tariff {
        tariff_hash: String::new(),
        version: "2".into(),
        provider: Provider::Generic,
        model: String::new(),
        api: Some(api.clone()),
        pricing_basis: "fixed_request".into(),
        valid_from: "1".into(),
        valid_until: "4000000000".into(),
        operator_fee_micro_usdc: "0".into(),
        rates: vec![Rate {
            unit: "requests".into(),
            nano_usdc_numerator: "7000".into(),
            unit_denominator: "1".into(),
        }],
    };
    value.tariff_hash = quote::tariff_hash(&value).unwrap();
    value
}
fn api(origin: &str, path: &str) -> ApiBinding {
    ApiBinding {
        version: "1".into(),
        service: "catalog".into(),
        operation: "lookup".into(),
        method: "POST".into(),
        path: path.into(),
        origin: origin.into(),
        request_max_bytes: "1024".into(),
        response_max_bytes: "1024".into(),
        timeout_seconds: "1".into(),
        billing: "http_2xx_json".into(),
    }
}

#[tokio::test]
async fn bounded_json_results_errors_timeouts_and_disconnects_never_retry() {
    let calls: Calls = Arc::new(Mutex::new(BTreeMap::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let service = Router::new().fallback(handle).with_state(calls.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, service).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let credential_file = directory.path().join("credential");
    std::fs::write(&credential_file, b"local-fixture-only").unwrap();
    std::fs::set_permissions(&credential_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    for (path, expected_usage) in [
        ("/ok", Some("1")),
        ("/rejected", Some("0")),
        ("/redirect", Some("0")),
        ("/malformed", None),
        ("/duplicate", None),
        ("/wrong-type", None),
        ("/large", None),
        ("/slow", None),
    ] {
        let api = api(&origin, path);
        let tariff = tariff(&api);
        let adapter = HttpAdapter::connect(
            &ApiProviderConfig {
                api: api.clone(),
                credential_file: credential_file.clone(),
            },
            true,
        )
        .await
        .unwrap();
        let request = generic::validate(&api, RAW, &tariff).unwrap();
        assert_eq!(request.reservation_nano, 7000);
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let observation = adapter.dispatch_once(request, Some(tx)).await;
        assert_eq!(
            observation.usage.as_ref().map(|u| u[0].count.as_str()),
            expected_usage,
            "{path}"
        );
        assert_eq!(
            calls.lock().unwrap().get(path),
            Some(&1),
            "one explicit upstream execution only"
        );
        let mut body = Vec::new();
        let mut status = None;
        while let Some(event) = rx.recv().await {
            match event {
                RelayEvent::Head { status: value, .. } => status = Some(value),
                RelayEvent::Data(bytes) => body.extend_from_slice(&bytes),
            }
        }
        assert_eq!(status, Some(if path == "/ok" { 200 } else { 502 }));
        if path == "/ok" {
            assert_eq!(body, br#"{"available":true,"stock":42}"#);
        } else {
            assert!(!String::from_utf8_lossy(&body).contains("local-fixture-only"));
        }
        if path == "/slow" {
            assert!(observation.diagnostic.timed_out);
        }
    }
    // A 302 was returned but its destination was never fetched automatically.
    assert_eq!(calls.lock().unwrap().get("/ok"), Some(&1));
    let api = api(&origin, "/ok");
    let tariff = tariff(&api);
    let adapter = HttpAdapter::connect(
        &ApiProviderConfig {
            api: api.clone(),
            credential_file,
        },
        true,
    )
    .await
    .unwrap();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    let observation = adapter
        .dispatch_once(generic::validate(&api, RAW, &tariff).unwrap(), Some(tx))
        .await;
    assert!(observation.downstream_dropped);
    assert_eq!(observation.usage.unwrap()[0].count, "1");
    assert_eq!(calls.lock().unwrap().get("/ok"), Some(&2));
    server.abort();
}

#[test]
fn request_validation_and_destination_rules_fail_before_dispatch() {
    let api = api("http://127.0.0.1:9090", "/lookup");
    let t = tariff(&api);
    assert!(generic::validate(&api, br#"{"a":1,"a":2}"#, &t).is_err());
    assert!(generic::validate(&api, &vec![b' '; 1025], &t).is_err());
    assert!(generic::validate(&api, b"\xff", &t).is_err());
    let mut changed = api.clone();
    changed.operation = "other".into();
    assert!(generic::validate(&changed, RAW, &t).is_err());
    generic::validate_origin(&api, true).unwrap();
    assert!(generic::validate_origin(&api, false).is_err());
    changed.origin = "http://localhost:9090".into();
    assert!(generic::validate_origin(&changed, true).is_err());
    changed.origin = "https://127.0.0.1:9090".into();
    assert!(generic::validate_origin(&changed, false).is_err());
    changed.origin = "https://example.com".into();
    generic::validate_origin(&changed, false).unwrap();
}
