//! Actual loopback HTTP diagnostics, never public provider access or billing.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use zkapi_control::{
    proxy::{self, CacheMode, Endpoint, HttpAdapter, ModelProfile, ServiceCredential},
    quote,
    wire::{Provider, Rate, Tariff},
};

#[derive(Clone)]
struct Fixture {
    status: u16,
    content_type: &'static str,
    encoding: Option<&'static str>,
    body: Vec<u8>,
    delay: Duration,
    count: Arc<AtomicUsize>,
}
async fn handler(State(f): State<Fixture>) -> Response {
    f.count.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(f.delay).await;
    let mut response = Response::builder()
        .status(StatusCode::from_u16(f.status).unwrap())
        .header("content-type", f.content_type)
        .header("x-request-id", "PRIVATE_PROVIDER_ID_CANARY");
    if let Some(encoding) = f.encoding {
        response = response.header("content-encoding", encoding);
    }
    response.body(Body::from(f.body)).unwrap()
}
fn prepared(stream: bool) -> proxy::PreparedRequest {
    prepared_for(Provider::Openai, stream)
}
fn prepared_for(provider: Provider, stream: bool) -> proxy::PreparedRequest {
    let anthropic = provider == Provider::Anthropic;
    let endpoint = if anthropic {
        Endpoint::Messages
    } else {
        Endpoint::ChatCompletions
    };
    let profile = ModelProfile {
        provider: provider.clone(),
        model: "fixture-model".into(),
        endpoints: vec![endpoint],
        context_tokens: 100,
        max_output_tokens: 50,
        cache_mode: if anthropic {
            CacheMode::AnthropicSplit
        } else {
            CacheMode::InclusiveRead
        },
    };
    let units: &[&str] = if anthropic {
        &[
            "cache_read_tokens",
            "cache_write_1h_tokens",
            "cache_write_5m_tokens",
            "input_tokens",
            "output_tokens",
        ]
    } else {
        &["cache_read_tokens", "input_tokens", "output_tokens"]
    };
    let mut tariff = Tariff {
        api: None,
        tariff_hash: String::new(),
        version: "1".into(),
        provider,
        model: "fixture-model".into(),
        pricing_basis: "fixed_usage_rates".into(),
        valid_from: "0".into(),
        valid_until: "9999999999".into(),
        operator_fee_micro_usdc: "0".into(),
        rates: units
            .iter()
            .map(|unit| Rate {
                reservation_max_count: None,
                unit: (*unit).into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "1".into(),
            })
            .collect(),
    };
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    let mut body = json!({"model":"fixture-model",
        "messages":[{"role":"user","content":"PRIVATE_PROMPT_CANARY"}],"stream":stream});
    body[if anthropic {
        "max_tokens"
    } else {
        "max_completion_tokens"
    }] = json!(10);
    proxy::validate(
        endpoint,
        &serde_json::to_vec(&body).unwrap(),
        &profile,
        &tariff,
    )
    .unwrap()
}
fn usage() -> Value {
    json!({"prompt_tokens":2,"completion_tokens":1,"total_tokens":3,"prompt_tokens_details":{"cached_tokens":0}})
}

#[tokio::test]
async fn anthropic_json_usage_diagnostics_are_fixed_private_and_never_retry() {
    let base = json!({"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":0,
        "cache_creation_input_tokens":0,"cache_creation":null,"server_tool_use":null});
    let cases = [
        ("complete", "server_tool_use", Value::Null),
        (
            "usage_keys",
            "PRIVATE_FIELD_CANARY",
            json!("PRIVATE_VALUE_CANARY"),
        ),
        (
            "usage_service_tier",
            "service_tier",
            json!("PRIVATE_TIER_CANARY"),
        ),
        (
            "usage_inference_geo",
            "inference_geo",
            json!("PRIVATE_GEO_CANARY"),
        ),
        (
            "usage_server_tools",
            "server_tool_use",
            json!({"PRIVATE_TOOL_CANARY":0}),
        ),
        ("usage_token_counts", "input_tokens", Value::Null),
        (
            "usage_output_details",
            "output_tokens_details",
            json!({"thinking_tokens":2}),
        ),
        (
            "usage_cache_breakdown",
            "cache_creation_input_tokens",
            json!(1),
        ),
    ];
    for (stage, field, value) in cases {
        let mut usage = base.clone();
        usage[field] = value;
        let count = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture {
            status: 200,
            content_type: "application/json",
            encoding: None,
            body: serde_json::to_vec(&json!({"id":"PRIVATE_PROVIDER_ID_CANARY",
                "content":[{"type":"text","text":"PRIVATE_RESPONSE_CANARY"}],"usage":usage}))
            .unwrap(),
            delay: Duration::ZERO,
            count: count.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(post(handler)).with_state(fixture),
            )
            .await
            .unwrap();
        });
        let adapter = HttpAdapter::local_fixture(
            Provider::Anthropic,
            &origin,
            ServiceCredential::new("PRIVATE_CREDENTIAL_CANARY".into()).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        let result = adapter
            .dispatch_once(prepared_for(Provider::Anthropic, false), None)
            .await;
        let event = result.diagnostic_event();
        assert_eq!(event["stage"], stage);
        assert_eq!(event["http_status"], 200);
        assert_eq!(event["completed"], stage == "complete");
        assert_eq!(event["timed_out"], false);
        assert_eq!(result.usage.is_some(), stage == "complete");
        assert_eq!(event.as_object().unwrap().len(), 6);
        assert!(!event.to_string().contains("PRIVATE_"));
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "no automatic provider retry"
        );
        let decoded: proxy::DispatchObservation =
            serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
        assert_eq!(decoded.diagnostic_event(), event);
        server.abort();
    }
}

#[tokio::test]
async fn static_diagnostics_distinguish_http_schema_protocol_and_timeout_without_sensitive_fields_or_retry(
) {
    let good = serde_json::to_vec(&json!({"id":"PRIVATE_PROVIDER_ID_CANARY","choices":[{"message":{"content":"PRIVATE_RESPONSE_CANARY"}}],"usage":usage()})).unwrap();
    let stream = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"id":"PRIVATE_PROVIDER_ID_CANARY","choices":[],"usage":usage()})
    )
    .into_bytes();
    let cases = vec![
        ("complete",200,"application/json",None,good.clone(),false,0,false),
        ("upstream_status",401,"application/json",None,b"PRIVATE_ERROR_CANARY".to_vec(),false,0,false),
        ("content_type",200,"text/plain",None,good.clone(),false,0,false),
        ("content_encoding",200,"application/json",Some("gzip"),good.clone(),false,0,false),
        ("json_decode",200,"application/json",None,b"{PRIVATE_INVALID_JSON_CANARY".to_vec(),false,0,false),
        ("provider_error",200,"application/json",None,serde_json::to_vec(&json!({"error":{"message":"PRIVATE_ERROR_CANARY"}})).unwrap(),false,0,false),
        ("usage_schema",200,"application/json",None,serde_json::to_vec(&json!({"id":"PRIVATE_PROVIDER_ID_CANARY","usage":{"unexpected_private_field":"PRIVATE_USAGE_CANARY"}})).unwrap(),false,0,false),
        ("response_limit",200,"application/json",None,vec![b'x';8*1024*1024+1],false,0,false),
        ("stream_frame",200,"text/event-stream",None,b"data: {PRIVATE_INVALID_FRAME_CANARY\n\n".to_vec(),true,0,false),
        ("stream_terminal",200,"text/event-stream",None,format!("data: {}\n\n",json!({"id":"PRIVATE_PROVIDER_ID_CANARY","usage":usage()})).into_bytes(),true,0,false),
        ("complete",200,"text/event-stream",None,stream,true,0,false),
        ("request_transport",200,"application/json",None,good,false,200,true),
    ];
    for (stage, status, content_type, encoding, body, stream, delay, timed_out) in cases {
        let count = Arc::new(AtomicUsize::new(0));
        let f = Fixture {
            status,
            content_type,
            encoding,
            body,
            delay: Duration::from_millis(delay),
            count: count.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(post(handler)).with_state(f),
            )
            .await
            .unwrap()
        });
        let adapter = HttpAdapter::local_fixture(
            Provider::Openai,
            &origin,
            ServiceCredential::new("PRIVATE_CREDENTIAL_CANARY".into()).unwrap(),
            Duration::from_millis(if timed_out { 30 } else { 2000 }),
        )
        .unwrap();
        let result = adapter.dispatch_once(prepared(stream), None).await;
        let event = result.diagnostic_event();
        assert_eq!(event["stage"], stage);
        assert_eq!(event["timed_out"], timed_out);
        assert_eq!(event["completed"], stage == "complete");
        assert_eq!(result.usage.is_some(), stage == "complete");
        assert_eq!(
            event["http_status"],
            if timed_out {
                Value::Null
            } else {
                json!(status)
            }
        );
        assert!(event["elapsed_ms"].as_u64().unwrap() < 2500);
        assert_eq!(
            event
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            [
                "completed",
                "elapsed_ms",
                "event",
                "http_status",
                "stage",
                "timed_out"
            ]
        );
        assert!(!event.to_string().contains("PRIVATE_"));
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "no automatic provider retry"
        );
        // Child framing carries the safe diagnostic without changing usage.
        let decoded: proxy::DispatchObservation =
            serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
        assert_eq!(decoded.diagnostic_event(), event);
        server.abort();
    }
}
