//! Synthetic loopback HTTP tests only: no provider credentials, proof, wallet or chain.
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use zkapi_control::{
    gateway::{self, GatewayProviderConfig, HttpAdapter, RequestMetadata},
    wire::{self, ApiBindingV2, Tariff},
};
fn binding() -> ApiBindingV2 {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/contracts/universal-api-gateway-vectors.json"
    ))
    .unwrap();
    let mut api: ApiBindingV2 = serde_json::from_value(value["binding"].clone()).unwrap();
    api.transport.artifact_sha256 = gateway::transport_artifact_sha256();
    api.meter.adapter.artifact_sha256 = gateway::meter_artifact_sha256();
    api
}
fn tariff(api: &ApiBindingV2) -> Tariff {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/contracts/universal-api-gateway-vectors.json"
    ))
    .unwrap();
    let mut value = value["tariff"].clone();
    value["api"] = serde_json::to_value(api).unwrap();
    value.as_object_mut().unwrap().remove("tariff_hash");
    if api.meter.adapter.id != "fixed_http" {
        value["pricing_basis"] = "fixed_usage_rates".into();
        value["rates"] = json!([{"unit":"cache_read_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"output_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"10"}]);
    }
    if api.meter.adapter.id == "anthropic_messages" {
        value["rates"] = json!([{"unit":"cache_read_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"cache_write_1h_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"cache_write_5m_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"100"},{"unit":"output_tokens","nano_usdc_numerator":"1","unit_denominator":"1","reservation_max_count":"10"}]);
    }
    value["tariff_hash"] = gateway::digest(&value).unwrap().into();
    serde_json::from_value(value).unwrap()
}
fn metadata(api: &ApiBindingV2, method: &str, target: &str, body: &[u8]) -> RequestMetadata {
    RequestMetadata {
        version: "2".into(),
        binding_hash: gateway::digest(api).unwrap(),
        method: method.into(),
        target: target.into(),
        headers: vec![],
        body_length: body.len().to_string(),
    }
}
async fn run(
    api: ApiBindingV2,
    metadata: RequestMetadata,
    body: Vec<u8>,
    response: Vec<u8>,
) -> (gateway::Observation, Vec<Vec<u8>>, Vec<u8>) {
    run_with_credential(api, metadata, body, response, None).await
}
async fn run_with_credential(
    mut api: ApiBindingV2,
    mut metadata: RequestMetadata,
    body: Vec<u8>,
    response: Vec<u8>,
    credential: Option<&str>,
) -> (gateway::Observation, Vec<Vec<u8>>, Vec<u8>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    api.origin = format!("http://{}", listener.local_addr().unwrap());
    metadata.binding_hash = gateway::digest(&api).unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        let mut buf = [0; 4096];
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..p]);
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() >= p + 4 + len {
                    break;
                }
            }
        }
        socket.write_all(&response).await.unwrap();
        socket.shutdown().await.unwrap();
        bytes
    });
    let secrets = tempfile::tempdir().unwrap();
    let credential_file = credential.map(|value| {
        use std::os::unix::fs::PermissionsExt;
        let path = secrets.path().join("credential");
        std::fs::write(&path, value).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    });
    let cfg = GatewayProviderConfig {
        api: api.clone(),
        credential_file,
        transport_artifact_sha256: gateway::transport_artifact_sha256(),
        meter_artifact_sha256: gateway::meter_artifact_sha256(),
    };
    let adapter = HttpAdapter::connect(&cfg, true).unwrap();
    let prepared = gateway::validate_request(&api, metadata, &body, &tariff(&api)).unwrap();
    let (tx, mut rx) = mpsc::channel(1);
    let forward = async {
        let mut frames = vec![];
        while let Some(frame) = rx.recv().await {
            frames.push(frame)
        }
        frames
    };
    let (observation, frames) = tokio::join!(
        adapter.dispatch_once(prepared, Some(tx), Duration::from_secs(3)),
        forward
    );
    (observation, frames, server.await.unwrap())
}
fn frame_payload(frame: &[u8]) -> &[u8] {
    assert_eq!(
        u32::from_be_bytes(frame[1..5].try_into().unwrap()) as usize,
        frame.len() - 5
    );
    &frame[5..]
}
#[tokio::test]
async fn opaque_octets_query_and_duplicate_headers_survive_exactly() {
    let mut api = binding();
    api.headers.trailers = vec!["x-checksum".into()];
    let body = vec![0, 255, 9, 42];
    let mut meta = metadata(&api, "POST", "/v1/lookup?x=1+2&x=%2f?", &body);
    meta.headers = vec![
        ("x-test".into(), gateway::encode_value(&[128, 255])),
        ("x-test".into(), gateway::encode_value(b"second")),
    ];
    let response=b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: x-checksum\r\nX-Test: one\r\nX-Test: two\r\nSet-Cookie: secret\r\nClear-Site-Data: \"*\"\r\nConnection: close, x-private\r\nX-Private: no\r\n\r\n4\r\n\0\xff\t*\r\n0\r\nX-Checksum: abc\r\n\r\n".to_vec();
    let (observation, frames, sent) = run(api, meta, body.clone(), response).await;
    assert_eq!(observation.usage.unwrap()[0].count, "1");
    assert_eq!(observation.completion.unwrap().outcome, "satisfied");
    assert!(sent.starts_with(b"POST /v1/lookup?x=1+2&x=%2f? HTTP/1.1\r\n"));
    assert!(sent
        .windows(28)
        .any(|s| s == b"x-test: \x80\xff\r\nx-test: second\r\n"));
    assert!(sent.ends_with(&body));
    assert!(!sent.windows(16).any(|s| s == b"Accept-Encoding:"));
    assert_eq!(
        frames.iter().map(|f| f[0]).collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert_eq!(frame_payload(&frames[1]), body);
    let head: serde_json::Value = serde_json::from_slice(frame_payload(&frames[0])).unwrap();
    assert_eq!(
        head["headers"],
        json!([["x-test", "b25l"], ["x-test", "dHdv"]])
    );
}
#[tokio::test]
async fn complete_nonbillable_status_is_measured_zero_but_truncation_is_unknown() {
    let api = binding();
    let meta = metadata(&api, "GET", "/v1/lookup?", &[]);
    let (observation, frames, _) = run(
        api.clone(),
        meta.clone(),
        vec![],
        b"HTTP/1.1 404 Missing\r\nContent-Length: 0\r\n\r\n".to_vec(),
    )
    .await;
    assert_eq!(observation.usage.unwrap()[0].count, "0");
    assert_eq!(observation.completion.unwrap().outcome, "not_satisfied");
    assert_eq!(frames.last().unwrap()[0], 4);
    let (observation, frames, _) = run(
        api,
        meta,
        vec![],
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabc".to_vec(),
    )
    .await;
    assert!(observation.usage.is_none());
    assert!(observation.error.is_some());
    assert!(frames.iter().all(|f| f[0] != 4));
}
#[tokio::test]
async fn bodyless_status_and_required_trailer_are_enforced() {
    let mut api = binding();
    api.headers.trailers = vec!["x-checksum".into()];
    let meta = metadata(&api, "GET", "/v1/lookup", &[]);
    for response in [
        b"HTTP/1.1 205 Reset\r\nContent-Length: 1\r\n\r\nx".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: x-checksum\r\n\r\n0\r\n\r\n"
            .to_vec(),
    ] {
        let (observation, frames, _) = run(api.clone(), meta.clone(), vec![], response).await;
        assert!(observation.usage.is_none());
        assert!(frames.iter().all(|f| f[0] != 4));
    }
}
fn responses() -> ApiBindingV2 {
    let mut api = binding();
    api.meter.adapter.id = "openai_responses".into();
    api.meter.resource = Some(wire::MeterResource {
        provider: "openai".into(),
        model: "fixture-model".into(),
    });
    api.meter.config = json!({"provider_contract_sha256":gateway::provider_contract_sha256(),"context_max_tokens":"100","output_max_tokens":"10","service_tier":"default","extra_cost_policy":"reject_unclassified"});
    api.meter.config_hash = gateway::digest(&api.meter.config).unwrap();
    api.completion.kind = "provider_terminal_usage".into();
    api.representation.response_encodings = vec![
        "br".into(),
        "deflate".into(),
        "gzip".into(),
        "identity".into(),
    ];
    api
}
async fn encode(bytes: &[u8], encoding: &str) -> Vec<u8> {
    use async_compression::tokio::bufread::{BrotliEncoder, GzipEncoder, ZlibEncoder};
    let mut output = vec![];
    match encoding {
        "br" => {
            BrotliEncoder::new(bytes)
                .read_to_end(&mut output)
                .await
                .unwrap();
        }
        "gzip" => {
            GzipEncoder::new(bytes)
                .read_to_end(&mut output)
                .await
                .unwrap();
        }
        "deflate" => {
            ZlibEncoder::new(bytes)
                .read_to_end(&mut output)
                .await
                .unwrap();
        }
        _ => output.extend_from_slice(bytes),
    }
    output
}
#[tokio::test]
async fn compressed_json_and_sse_preserve_raw_bytes_and_equal_identity_usage() {
    let api = responses();
    let body=br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hello","tools":[{"type":"custom","name":"terminal","format":{"type":"text"}}]}"#.to_vec();
    for sse in [false, true] {
        let value = json!({"status":"completed","usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}});
        let raw = if sse {
            format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":value})
            )
            .into_bytes()
        } else {
            serde_json::to_vec(&value).unwrap()
        };
        for encoding in ["identity", "gzip", "deflate", "br"] {
            let encoded = encode(&raw, encoding).await;
            let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Encoding: {}\r\nContent-Length: {}\r\n\r\n",if sse{"text/event-stream"}else{"application/json"},encoding,encoded.len()).into_bytes();
            response.extend_from_slice(&encoded);
            let meta = metadata(&api, "POST", "/v1/lookup", &body);
            let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
            assert_eq!(
                observation
                    .usage
                    .unwrap()
                    .iter()
                    .map(|u| (&*u.unit, &*u.count))
                    .collect::<Vec<_>>(),
                vec![
                    ("cache_read_tokens", "2"),
                    ("input_tokens", "5"),
                    ("output_tokens", "4")
                ]
            );
            assert_eq!(
                frames
                    .iter()
                    .filter(|f| f[0] == 2)
                    .flat_map(|f| frame_payload(f).iter().copied())
                    .collect::<Vec<_>>(),
                encoded
            );
            assert_eq!(frames.last().unwrap()[0], 4);
        }
    }
}
#[tokio::test]
async fn bad_compression_and_missing_terminal_have_complete_carrier_but_unknown_usage() {
    let api = responses();
    let body = br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hi"}"#
        .to_vec();
    for (kind, bytes) in [
        ("gzip", vec![1, 2, 3]),
        (
            "identity",
            b"data: {\"type\":\"response.created\"}\n\n".to_vec(),
        ),
    ] {
        let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: {kind}\r\nContent-Length: {}\r\n\r\n",bytes.len()).into_bytes();
        response.extend(bytes);
        let meta = metadata(&api, "POST", "/v1/lookup", &body);
        let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
        assert!(observation.usage.is_none());
        assert!(observation.error.is_none());
        assert_eq!(frames.last().unwrap()[0], 4);
    }
}
#[test]
fn invalid_targets_auth_collisions_encodings_and_envelope_lengths_fail_before_dispatch() {
    let api = binding();
    let tariff = tariff(&api);
    for target in [
        "//evil",
        "/v1/../lookup",
        "/v1/%2e%2e/lookup",
        "/v1/%252f/lookup",
        "/v1/%2flookup",
        "/v1//lookup",
        "/v1/lookup?bad=%xy",
    ] {
        assert!(
            gateway::validate_request(&api, metadata(&api, "GET", target, &[]), &[], &tariff)
                .is_err(),
            "{target}"
        );
    }
    for (name, value) in [
        ("authorization", "Bearer secret"),
        ("cookie", "secret"),
        ("content-encoding", "gzip"),
        ("accept-encoding", "gzip"),
        ("x-test", " leading"),
    ] {
        let mut meta = metadata(&api, "GET", "/v1/lookup", &[]);
        meta.headers = vec![(name.into(), gateway::encode_value(value.as_bytes()))];
        assert!(gateway::validate_request(&api, meta, &[], &tariff).is_err());
    }
    let meta = metadata(&api, "POST", "/v1/lookup", b"x");
    let json = serde_jcs::to_vec(&meta).unwrap();
    let mut envelope = (json.len() as u32).to_be_bytes().to_vec();
    envelope.extend(json);
    assert!(gateway::parse_envelope(&envelope, &api, &tariff).is_err());
    envelope.push(b'x');
    assert!(gateway::parse_envelope(&envelope, &api, &tariff).is_ok());
    envelope.push(b'y');
    assert!(gateway::parse_envelope(&envelope, &api, &tariff).is_err());
}

#[tokio::test]
async fn repeat_final_usage_is_idempotent_and_conflicts_are_unknown() {
    let api = responses();
    let body = br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hi"}"#
        .to_vec();
    let final_event = |count| {
        format!(
            "data: {}\n\n",
            json!({"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":count,"input_tokens_details":{"cached_tokens":2}}}})
        )
    };
    for count in [4, 5] {
        let raw = format!(
            "{}{}data: {{\"type\":\"future.event\"}}\n\n",
            final_event(4),
            final_event(count)
        );
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
            raw.len()
        )
        .into_bytes();
        response.extend(raw.as_bytes());
        let meta = metadata(&api, "POST", "/v1/lookup", &body);
        let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
        assert_eq!(observation.usage.is_some(), count == 4);
        assert_eq!(frames.last().unwrap()[0], 4);
    }
}
#[tokio::test]
async fn decoded_expansion_and_truncated_gzip_never_become_zero_usage() {
    let mut api = responses();
    let body = br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hi"}"#
        .to_vec();
    let value = json!({"status":"completed","output":"x".repeat(4000),"usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}});
    let raw = serde_json::to_vec(&value).unwrap();
    let good = encode(&raw, "gzip").await;
    for truncated in [false, true] {
        let mut encoded = good.clone();
        if truncated {
            encoded.truncate(encoded.len() - 3);
        } else {
            api.limits.decode_ratio = "1".into();
        }
        let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n",encoded.len()).into_bytes();
        response.extend(encoded);
        let meta = metadata(&api, "POST", "/v1/lookup", &body);
        let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
        assert!(observation.usage.is_none());
        assert!(observation.completion.is_none());
        assert_eq!(frames.last().unwrap()[0], 4);
        api.limits.decode_ratio = "64".into();
    }
}
#[tokio::test]
async fn head_retains_length_as_metadata_without_data() {
    let mut api = binding();
    api.routes.push(wire::HttpRoute {
        method: "HEAD".into(),
        path: "/v1/lookup".into(),
    });
    api.routes
        .sort_by(|a, b| (&a.method, &a.path).cmp(&(&b.method, &b.path)));
    let meta = metadata(&api, "HEAD", "/v1/lookup", &[]);
    let (observation, frames, _) = run(
        api,
        meta,
        vec![],
        b"HTTP/1.1 200 OK\r\nContent-Length: 1234\r\n\r\n".to_vec(),
    )
    .await;
    assert!(observation.usage.is_some());
    assert_eq!(frames.iter().map(|f| f[0]).collect::<Vec<_>>(), vec![1, 4]);
    let head: serde_json::Value = serde_json::from_slice(frame_payload(&frames[0])).unwrap();
    assert_eq!(head["headers"], json!([["content-length", "MTIzNA=="]]));
}

#[tokio::test]
async fn missing_required_trailer_declaration_and_terminal_mismatch_fail_closed() {
    let mut api = binding();
    api.headers.trailers = vec!["x-checksum".into()];
    let meta = metadata(&api, "GET", "/v1/lookup", &[]);
    let (observation, frames, _) = run(
        api,
        meta,
        vec![],
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
    )
    .await;
    assert!(observation.usage.is_none());
    assert!(frames.iter().all(|f| f[0] != 4));
    let api = responses();
    let body = br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hi"}"#
        .to_vec();
    let raw = format!(
        "data: {}\n\n",
        json!({"type":"response.completed","response":{"status":"failed","usage":{"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}})
    );
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
        raw.len()
    )
    .into_bytes();
    response.extend(raw.as_bytes());
    let meta = metadata(&api, "POST", "/v1/lookup", &body);
    let (observation, frames, _) = run(api, meta, body, response).await;
    assert!(observation.usage.is_none());
    assert_eq!(frames.last().unwrap()[0], 4);
}
#[tokio::test]
async fn anthropic_cumulative_json_and_sse_meter_without_payload_rewrite() {
    let mut api = responses();
    api.meter.adapter.id = "anthropic_messages".into();
    api.meter.resource = Some(wire::MeterResource {
        provider: "anthropic".into(),
        model: "fixture-model".into(),
    });
    api.meter.config["service_tier"] = "standard_only".into();
    api.meter.config_hash = gateway::digest(&api.meter.config).unwrap();
    let body=br#"{"model":"fixture-model","service_tier":"standard_only","max_tokens":10,"messages":[],"thinking":{"type":"adaptive"},"tools":[{"name":"Bash","input_schema":{"type":"object"}}],"metadata":{"user_id":"local fixture"}}"#.to_vec();
    let usage = json!({"input_tokens":7,"output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"cache_creation":{"ephemeral_5m_input_tokens":1,"ephemeral_1h_input_tokens":2},"service_tier":"standard","output_tokens_details":{"thinking_tokens":1}});
    for sse in [false, true] {
        let raw = if sse {
            let mut start = usage.clone();
            start["output_tokens"] = 0.into();
            start
                .as_object_mut()
                .unwrap()
                .remove("output_tokens_details");
            [json!({"type":"message_start","message":{"model":"fixture-model","usage":start}}),json!({"type":"unknown_future_event"}),json!({"type":"message_delta","usage":{"output_tokens":2}}),json!({"type":"message_delta","usage":{"output_tokens":4,"output_tokens_details":{"thinking_tokens":1}}}),json!({"type":"message_stop"}),json!({"type":"message_stop"})].iter().map(|v|format!("data: {v}\n\n")).collect::<String>().into_bytes()
        } else {
            serde_json::to_vec(&json!({"type":"message","model":"fixture-model","stop_reason":"end_turn","usage":usage})).unwrap()
        };
        let encoded = encode(&raw, "br").await;
        let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Encoding: br\r\nContent-Length: {}\r\n\r\n",if sse{"text/event-stream"}else{"application/json"},encoded.len()).into_bytes();
        response.extend(&encoded);
        let meta = metadata(&api, "POST", "/v1/lookup", &body);
        let (observation, frames, sent) = run(api.clone(), meta, body.clone(), response).await;
        assert!(sent.ends_with(&body));
        let counts = observation
            .usage
            .unwrap()
            .into_iter()
            .map(|u| (u.unit, u.count))
            .collect::<Vec<_>>();
        assert_eq!(
            counts,
            vec![
                ("cache_read_tokens".into(), "2".into()),
                ("cache_write_1h_tokens".into(), "2".into()),
                ("cache_write_5m_tokens".into(), "1".into()),
                ("input_tokens".into(), "7".into()),
                ("output_tokens".into(), "4".into())
            ]
        );
        assert_eq!(
            frames
                .iter()
                .filter(|f| f[0] == 2)
                .flat_map(|f| frame_payload(f).iter().copied())
                .collect::<Vec<_>>(),
            encoded
        );
    }
}
#[test]
fn retained_references_and_tier_drift_are_rejected_recursively() {
    let api = responses();
    let tariff = tariff(&api);
    for extra in [
        json!({"previous_response_id":"private"}),
        json!({"prompt":{"id":"pmpt_private","version":"1"}}),
        json!({"input":[{"nested":{"file_id":"private"}}]}),
        json!({"input":[{"type":"item_reference","id":"private"}]}),
        json!({"tools":[{"container":{"id":"private"}}]}),
        json!({"service_tier":"priority"}),
    ] {
        let mut value =
            json!({"model":"fixture-model","service_tier":"default","store":false,"input":"hello"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let body = serde_json::to_vec(&value).unwrap();
        assert!(gateway::validate_request(
            &api,
            metadata(&api, "POST", "/v1/lookup", &body),
            &body,
            &tariff
        )
        .is_err());
    }
    let nested = br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hello","tools":[{"type":"function","name":"fixture","parameters":{"type":"object","properties":{"prompt":{"type":"string"}}}}]}"#;
    assert!(gateway::validate_request(
        &api,
        metadata(&api, "POST", "/v1/lookup", nested),
        nested,
        &tariff
    )
    .is_ok());
    let body = br#"{"model":"fixture-model","store":false,"input":"hello"}"#;
    assert!(gateway::validate_request(
        &api,
        metadata(&api, "POST", "/v1/lookup", body),
        body,
        &tariff
    )
    .is_err());
}

#[tokio::test]
async fn credential_policies_inject_once_after_binding_without_client_delegation() {
    for (auth, secret, expected) in [
        (
            wire::AuthenticationPolicy::ApiKeyHeader {
                policy_id: "fixture".into(),
                header: "x-api-key".into(),
            },
            "public-fixture-key",
            "x-api-key: public-fixture-key\r\n",
        ),
        (
            wire::AuthenticationPolicy::Basic {
                policy_id: "fixture".into(),
            },
            r#"{"username":"user","password":"p:a:ss"}"#,
            "authorization: Basic dXNlcjpwOmE6c3M=\r\n",
        ),
    ] {
        let mut api = binding();
        api.authentication = auth;
        let meta = metadata(&api, "POST", "/v1/lookup", &[]);
        let (observation, _, sent) = run_with_credential(
            api.clone(),
            meta,
            vec![],
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
            Some(secret),
        )
        .await;
        assert!(observation.usage.is_some());
        assert_eq!(
            sent.windows(expected.len())
                .filter(|w| *w == expected.as_bytes())
                .count(),
            1
        );
        let field = api.authentication.header().unwrap();
        let mut meta = metadata(&api, "POST", "/v1/lookup", &[]);
        meta.headers = vec![(field.into(), gateway::encode_value(b"caller credential"))];
        assert!(gateway::validate_request(&api, meta, &[], &tariff(&api)).is_err());
    }
}

#[tokio::test]
async fn measured_failed_generations_do_not_satisfy_completion() {
    for openai in [true, false] {
        let mut api = responses();
        let body = if openai {
            br#"{"model":"fixture-model","service_tier":"default","store":false,"input":"hello"}"#
                .to_vec()
        } else {
            api.meter.adapter.id = "anthropic_messages".into();
            api.meter.resource.as_mut().unwrap().provider = "anthropic".into();
            api.meter.config["service_tier"] = "standard_only".into();
            api.meter.config_hash = gateway::digest(&api.meter.config).unwrap();
            br#"{"model":"fixture-model","service_tier":"standard_only","max_tokens":10,"messages":[]}"#.to_vec()
        };
        let outcomes: &[(&str, bool)] = if openai {
            &[
                ("completed", true),
                ("incomplete", false),
                ("failed", false),
            ]
        } else {
            &[
                ("end_turn", true),
                ("tool_use", true),
                ("max_tokens", false),
                ("refusal", false),
                ("pause_turn", false),
            ]
        };
        for &(outcome, succeeded) in outcomes {
            for sse in [false, true] {
                let usage = if openai {
                    json!({"input_tokens":7,"output_tokens":4,"input_tokens_details":{"cached_tokens":0}})
                } else {
                    json!({"input_tokens":7,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}})
                };
                let raw = if openai {
                    let value = json!({"status":outcome,"usage":usage});
                    if sse {
                        format!(
                            "data: {}\n\n",
                            json!({"type":format!("response.{outcome}"),"response":value})
                        )
                        .into_bytes()
                    } else {
                        serde_json::to_vec(&value).unwrap()
                    }
                } else if sse {
                    let mut initial = usage.clone();
                    initial["output_tokens"] = 0.into();
                    [json!({"type":"message_start","message":{"usage":initial}}),json!({"type":"message_delta","delta":{"stop_reason":outcome},"usage":{"output_tokens":4}}),json!({"type":"message_stop"})].iter().map(|v|format!("data: {v}\n\n")).collect::<String>().into_bytes()
                } else {
                    serde_json::to_vec(
                        &json!({"type":"message","stop_reason":outcome,"usage":usage}),
                    )
                    .unwrap()
                };
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
                    if sse {
                        "text/event-stream"
                    } else {
                        "application/json"
                    },
                    raw.len()
                )
                .into_bytes();
                response.extend(raw);
                let meta = metadata(&api, "POST", "/v1/lookup", &body);
                let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
                assert!(
                    observation.usage.is_some(),
                    "{openai}/{outcome}/{sse}: accounting remains measured"
                );
                assert_eq!(
                    observation.completion.unwrap().outcome,
                    if succeeded {
                        "satisfied"
                    } else {
                        "not_satisfied"
                    }
                );
                assert!(frames.iter().any(|frame| frame[0] == 4));
            }
        }
    }
}

#[test]
fn static_request_fields_obey_the_combined_representation_policy() {
    let mut api = binding();
    api.representation.request_media_types = vec!["application/json".into()];
    api.headers.static_request = vec![(
        "content-type".into(),
        gateway::encode_value(b"application/json"),
    )];
    let body = b"{}";
    assert!(
        gateway::validate_request(
            &api,
            metadata(&api, "POST", "/v1/lookup", body),
            body,
            &tariff(&api)
        )
        .is_ok(),
        "registered Content-Type supplies the request representation"
    );
    for (name, value) in [("content-encoding", "gzip"), ("accept-encoding", "gzip")] {
        let mut api = binding();
        api.headers.static_request = vec![(name.into(), gateway::encode_value(value.as_bytes()))];
        assert!(
            gateway::validate_request(
                &api,
                metadata(&api, "POST", "/v1/lookup", body),
                body,
                &tariff(&api)
            )
            .is_err(),
            "static {name} must not bypass the representation policy"
        );
    }
}

#[tokio::test]
async fn anthropic_nested_cumulative_counters_cannot_decrease_or_hide_invalid_details() {
    let mut api = responses();
    api.meter.adapter.id = "anthropic_messages".into();
    api.meter.resource.as_mut().unwrap().provider = "anthropic".into();
    api.meter.config["service_tier"] = "standard_only".into();
    api.meter.config_hash = gateway::digest(&api.meter.config).unwrap();
    let body = br#"{"model":"fixture-model","service_tier":"standard_only","max_tokens":10,"messages":[]}"#.to_vec();
    let initial = json!({"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":0}});
    for intermediate in [
        json!({"output_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3}}),
        json!({"output_tokens":2,"output_tokens_details":{"thinking_tokens":3}}),
    ] {
        let raw = [
            json!({"type":"message_start","message":{"usage":initial}}),
            json!({"type":"message_delta","usage":intermediate}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4,"output_tokens_details":{"thinking_tokens":1}}}),
            json!({"type":"message_stop"}),
        ].iter().map(|value| format!("data: {value}\n\n")).collect::<String>();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
            raw.len()
        )
        .into_bytes();
        response.extend(raw.as_bytes());
        let meta = metadata(&api, "POST", "/v1/lookup", &body);
        let (observation, frames, _) = run(api.clone(), meta, body.clone(), response).await;
        assert!(
            observation.usage.is_none(),
            "contradictory usage cannot become measured"
        );
        assert!(observation.completion.is_none());
        assert_eq!(
            frames.last().unwrap()[0],
            4,
            "carrier bytes remain complete"
        );
    }
}

#[tokio::test]
async fn informational_responses_precede_exactly_one_final_header_frame() {
    let api = binding();
    let response = b"HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\nHTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec();
    let (observation, frames, sent) = run(
        api.clone(),
        metadata(&api, "GET", "/v1/lookup", &[]),
        vec![],
        response,
    )
    .await;
    assert_eq!(observation.usage.unwrap()[0].count, "1");
    assert_eq!(
        frames.iter().map(|f| f[0]).collect::<Vec<_>>(),
        vec![1, 2, 4]
    );
    let head: serde_json::Value = serde_json::from_slice(frame_payload(&frames[0])).unwrap();
    assert_eq!(head, json!({"status":200,"headers":[]}));
    assert_eq!(frame_payload(&frames[1]), b"ok");
    assert_eq!(sent.windows(4).filter(|bytes| *bytes == b"GET ").count(), 1);
}

#[tokio::test]
async fn informational_upgrade_framing_and_count_limits_fail_closed() {
    let api = binding();
    for interim in [
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n".into(),
        "HTTP/1.1 103 Early Hints\r\nContent-Length: 1\r\n\r\nx".into(),
        "HTTP/1.1 100 Continue\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".into(),
        "HTTP/1.1 103 Early Hints\r\n\r\n".repeat(17),
    ] {
        let response =
            format!("{interim}HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").into_bytes();
        let (observation, frames, _) = run(
            api.clone(),
            metadata(&api, "GET", "/v1/lookup", &[]),
            vec![],
            response,
        )
        .await;
        assert!(observation.usage.is_none());
        assert!(observation.error.is_some());
        assert!(frames.is_empty());
    }
}

#[tokio::test]
async fn anthropic_cumulative_breakdowns_cannot_drop_observed_counters() {
    let mut api = responses();
    api.meter.adapter.id = "anthropic_messages".into();
    api.meter.resource.as_mut().unwrap().provider = "anthropic".into();
    api.meter.config["service_tier"] = "standard_only".into();
    api.meter.config_hash = gateway::digest(&api.meter.config).unwrap();
    let body = br#"{"model":"fixture-model","service_tier":"standard_only","max_tokens":10,"messages":[]}"#.to_vec();
    let raw = [
        json!({"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":0}}}}),
        json!({"type":"message_delta","usage":{"output_tokens":2,"cache_creation":{"ephemeral_1h_input_tokens":3}}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":3}}}),
        json!({"type":"message_stop"}),
    ].iter().map(|value| format!("data: {value}\n\n")).collect::<String>();
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
        raw.len()
    )
    .into_bytes();
    response.extend(raw.as_bytes());
    let meta = metadata(&api, "POST", "/v1/lookup", &body);
    let (observation, frames, _) = run(api, meta, body, response).await;
    assert!(
        observation.usage.is_none(),
        "an omitted interim counter cannot erase earlier evidence of its decrease"
    );
    assert!(observation.completion.is_none());
    assert_eq!(frames.last().unwrap()[0], 4);
}
