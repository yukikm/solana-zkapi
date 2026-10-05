use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::HeaderMap,
    response::Response,
    routing::post,
    Router,
};
use futures_util::stream;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};
use zkapi_control::{
    proxy::{
        self, CacheMode, Endpoint, HttpAdapter, ModelProfile, RelayEvent, ServiceCredential,
        SseMeter,
    },
    quote,
    wire::{Provider, Rate, Tariff},
};

fn setup(provider: Provider, cache_mode: CacheMode) -> (ModelProfile, Tariff) {
    let endpoints = match provider {
        Provider::Openai => vec![Endpoint::ChatCompletions, Endpoint::Responses],
        Provider::Openrouter => vec![Endpoint::ChatCompletions],
        Provider::Anthropic => vec![Endpoint::Messages, Endpoint::CountTokens],
        _ => unreachable!(),
    };
    let profile = ModelProfile {
        provider: provider.clone(),
        model: "fixture-model".into(),
        endpoints,
        context_tokens: 100,
        max_output_tokens: 50,
        cache_mode,
    };
    let units = match cache_mode {
        CacheMode::InclusiveRead => vec!["cache_read_tokens", "input_tokens", "output_tokens"],
        CacheMode::InclusiveReadWrite => vec![
            "cache_read_tokens",
            "cache_write_tokens",
            "input_tokens",
            "output_tokens",
        ],
        CacheMode::AnthropicSplit => vec![
            "cache_read_tokens",
            "cache_write_1h_tokens",
            "cache_write_5m_tokens",
            "input_tokens",
            "output_tokens",
        ],
    };
    let mut tariff = Tariff {
        tariff_hash: "".into(),
        version: "1".into(),
        provider,
        model: profile.model.clone(),
        pricing_basis: "fixed_usage_rates".into(),
        valid_from: "0".into(),
        valid_until: "9999999999".into(),
        operator_fee_micro_usdc: "0".into(),
        rates: units
            .into_iter()
            .map(|unit| Rate {
                unit: unit.into(),
                nano_usdc_numerator: if unit == "output_tokens" { "2" } else { "1" }.into(),
                unit_denominator: "3".into(),
            })
            .collect(),
    };
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    (profile, tariff)
}
fn request(endpoint: Endpoint, streaming: bool) -> Value {
    match endpoint {
        Endpoint::ChatCompletions => {
            json!({"model":"fixture-model","messages":[{"role":"user","content":"PROMPT_CANARY_I07"}],"max_completion_tokens":10,"stream":streaming})
        }
        Endpoint::Responses => {
            json!({"model":"fixture-model","input":"PROMPT_CANARY_I07","max_output_tokens":10,"stream":streaming})
        }
        Endpoint::Messages => {
            json!({"model":"fixture-model","messages":[{"role":"user","content":"PROMPT_CANARY_I07"}],"max_tokens":10,"stream":streaming})
        }
        Endpoint::CountTokens => {
            json!({"model":"fixture-model","messages":[{"role":"user","content":"PROMPT_CANARY_I07"}]})
        }
    }
}
fn openai_usage() -> Value {
    json!({"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":2}})
}
// Public OpenRouter Chat schema, not a retained live response.
// https://openrouter.ai/docs/api_reference/overview#completionsresponse-format
fn openrouter_zero_image_usage() -> Value {
    json!({
        "prompt_tokens":14,"completion_tokens":2,"total_tokens":16,
        "prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},
        "completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"image_tokens":0},
        "cost":0.0000033,"cost_details":{"upstream_inference_cost":null},"is_byok":false
    })
}
fn openrouter_sse(usage: &Value) -> String {
    // OpenRouter's final usage chunk may retain a nonempty choices array.
    let content = json!({"id":"router-fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}],"usage":null});
    let final_usage = json!({"id":"router-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":usage});
    format!(": keepalive\r\n\r\ndata: {content}\r\n\r\ndata: {final_usage}\n\ndata: [DONE]\n\n")
}
fn responses_usage() -> Value {
    json!({"input_tokens":10,"output_tokens":3,"total_tokens":13,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":2}})
}
fn anthropic_usage() -> Value {
    json!({"input_tokens":6,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3}})
}
fn sse(endpoint: Endpoint) -> String {
    match endpoint {
        Endpoint::ChatCompletions=>format!(": keepalive\r\n\r\ndata: {}\r\n\r\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"chat-fixture","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","type":"function","function":{"name":"test","arguments":"{}"}}]}}],"usage":null}),json!({"id":"chat-fixture","choices":[],"usage":openai_usage()})),
        Endpoint::Responses=>format!("event: response.created\ndata: {}\n\nevent: response.output_text.delta\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",json!({"type":"response.created","response":{"id":"resp-fixture"}}),json!({"type":"response.output_text.delta","delta":"reply"}),json!({"type":"response.completed","response":{"id":"resp-fixture","usage":responses_usage()}})),
        Endpoint::Messages=>format!("event: message_start\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n",json!({"type":"message_start","message":{"id":"msg-fixture","usage":{"input_tokens":6,"output_tokens":0,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3}}}}),json!({"type":"message_delta","usage":{"output_tokens":2}}),json!({"type":"message_delta","usage":{"output_tokens":3}}),json!({"type":"message_stop"})),
        _=>unreachable!(),
    }
}

#[test]
fn proxy_request_accepts_native_text_function_tools_and_pins_persistence() {
    for (provider, cache, endpoint) in [
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::Responses,
        ),
        (
            Provider::Openrouter,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
        (
            Provider::Anthropic,
            CacheMode::AnthropicSplit,
            Endpoint::Messages,
        ),
    ] {
        let (profile, tariff) = setup(provider, cache);
        let mut req = request(endpoint, true);
        req["tools"] = match endpoint {
            Endpoint::ChatCompletions => {
                json!([{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{}}}}])
            }
            Endpoint::Responses => {
                json!([{"type":"function","name":"lookup","parameters":{"type":"object","properties":{}}}])
            }
            _ => {
                json!([{"name":"lookup","input_schema":{"type":"object","properties":{}},"cache_control":{"type":"ephemeral","ttl":"1h"}}])
            }
        };
        let p = proxy::validate(
            endpoint,
            &serde_json::to_vec(&req).unwrap(),
            &profile,
            &tariff,
        )
        .unwrap();
        assert_eq!(p.reservation_nano, 40); // ceil((100+10*2)/3), one rounding.
        let body: Value = serde_json::from_slice(&p.upstream_body).unwrap();
        if endpoint == Endpoint::ChatCompletions {
            assert_eq!(body["stream_options"]["include_usage"], true);
            assert_eq!(body["store"], false);
        }
        if endpoint == Endpoint::Responses {
            assert_eq!(body["store"], false);
            assert_eq!(body["background"], false);
        }
    }
}

#[test]
fn proxy_accepts_client_function_call_and_result_histories() {
    for (provider, cache, endpoint, history) in [
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
            json!([
                {"role":"assistant","content":null,"tool_calls":[{"id":"call1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"call1","content":"client result"}
            ]),
        ),
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::Responses,
            json!([
                {"type":"function_call","id":"fc_1","status":"completed","call_id":"call1","name":"lookup","arguments":"{}"},
                {"type":"function_call_output","call_id":"call1","output":"client result"},
                {"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"previous answer","annotations":[],"logprobs":[]}]}
            ]),
        ),
        (
            Provider::Anthropic,
            CacheMode::AnthropicSplit,
            Endpoint::Messages,
            json!([
                {"role":"assistant","content":[{"type":"tool_use","id":"call1","name":"lookup","input":{"key":"value"}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"call1","content":[{"type":"text","text":"client result"}],"is_error":false}]}
            ]),
        ),
    ] {
        let (profile, tariff) = setup(provider, cache);
        let mut body = request(endpoint, false);
        body[if endpoint == Endpoint::Responses {
            "input"
        } else {
            "messages"
        }] = history;
        assert!(proxy::validate(
            endpoint,
            &serde_json::to_vec(&body).unwrap(),
            &profile,
            &tariff
        )
        .is_ok());
    }
}

#[test]
fn proxy_rejects_unsupported_before_egress_and_requires_meterable_limits() {
    let (profile, tariff) = setup(Provider::Openai, CacheMode::InclusiveRead);
    for (endpoint, field, val) in [
        (Endpoint::Responses, "store", json!(true)),
        (Endpoint::Responses, "background", json!(true)),
        (
            Endpoint::Responses,
            "previous_response_id",
            json!("resp-old"),
        ),
        (Endpoint::Responses, "tools", json!([{"type":"web_search"}])),
        (
            Endpoint::Responses,
            "input",
            json!([{"role":"user","content":[{"type":"input_image","image_url":"http://internal/"}]}]),
        ),
        (Endpoint::ChatCompletions, "n", json!(2)),
        (Endpoint::ChatCompletions, "max_completion_tokens", json!(0)),
        (
            Endpoint::ChatCompletions,
            "max_completion_tokens",
            json!(51),
        ),
        (
            Endpoint::ChatCompletions,
            "provider",
            json!({"order":["unreviewed"]}),
        ),
        (
            Endpoint::ChatCompletions,
            "messages",
            json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://private/"}}]}]),
        ),
    ] {
        let mut req = request(endpoint, false);
        req[field] = val;
        assert!(
            proxy::validate(
                endpoint,
                &serde_json::to_vec(&req).unwrap(),
                &profile,
                &tariff
            )
            .is_err(),
            "{field}"
        );
    }
    let mut req = request(Endpoint::ChatCompletions, false);
    req.as_object_mut().unwrap().remove("max_completion_tokens");
    assert!(proxy::validate(
        Endpoint::ChatCompletions,
        &serde_json::to_vec(&req).unwrap(),
        &profile,
        &tariff
    )
    .is_err());
    assert!(proxy::parse_json(
        br#"{"messages":[{"role":"user","role":"assistant"}]}"#,
        1024
    )
    .is_err());
    assert!(proxy::parse_json(&[0xff], 1024).is_err());
    assert!(proxy::parse_json(&vec![b' '; 1024 * 1024 + 1], 1024 * 1024).is_err());
    assert!(Endpoint::from_path("/v1/responses?x=1").is_err());
    assert!(proxy::validate(Endpoint::Messages, b"{}", &profile, &tariff).is_err());
}

#[test]
fn proxy_normalizes_inclusive_exclusive_cache_and_reasoning_without_double_charge() {
    let (profile, tariff) = setup(Provider::Openai, CacheMode::InclusiveRead);
    let usage =
        proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &openai_usage()).unwrap();
    assert_eq!(
        usage.iter().map(|u| u.count.as_str()).collect::<Vec<_>>(),
        ["4", "6", "3"]
    );
    assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 6);
    let (profile, tariff) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    let usage = proxy::normalize_usage(Endpoint::Messages, &profile, &anthropic_usage()).unwrap();
    assert_eq!(
        usage.iter().map(|u| u.count.as_str()).collect::<Vec<_>>(),
        ["4", "3", "2", "6", "3"]
    );
    assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 7);
    let (profile, tariff) = setup(Provider::Openrouter, CacheMode::InclusiveReadWrite);
    let mut u = openai_usage();
    u["prompt_tokens_details"]["cache_write_tokens"] = json!(2);
    u["cost"] = json!(0.99);
    let usage = proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &u).unwrap();
    assert_eq!(
        usage.iter().map(|u| u.count.as_str()).collect::<Vec<_>>(),
        ["4", "2", "4", "3"]
    );
    assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 6);
}

#[test]
fn proxy_anthropic_thinking_details_are_nullable_bounded_and_never_double_charged() {
    let (profile, tariff) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    for details in [
        Value::Null,
        json!({"thinking_tokens":0}),
        json!({"thinking_tokens":2}),
        json!({"thinking_tokens":3}),
    ] {
        let mut u = anthropic_usage();
        u["output_tokens_details"] = details;
        let usage = proxy::normalize_usage(Endpoint::Messages, &profile, &u).unwrap();
        assert_eq!(
            usage.iter().map(|u| u.count.as_str()).collect::<Vec<_>>(),
            ["4", "3", "2", "6", "3"]
        );
        assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 7);
    }
    for details in [
        json!({}),
        json!([]),
        json!(0),
        json!("0"),
        json!(true),
        json!({"thinking_tokens":null}),
        json!({"thinking_tokens":-1}),
        json!({"thinking_tokens":1.5}),
        json!({"thinking_tokens":"2"}),
        json!({"thinking_tokens":4}),
        json!({"thinking_tokens":u64::MAX}),
        json!({"thinking_tokens":0,"new_billable_tokens":0}),
        json!({"reasoning_tokens":0}),
    ] {
        let mut u = anthropic_usage();
        u["output_tokens_details"] = details;
        assert!(proxy::normalize_usage(Endpoint::Messages, &profile, &u).is_err());
    }
}

#[test]
fn proxy_anthropic_final_only_thinking_details_survive_all_sse_byte_boundaries() {
    let (profile, tariff) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    let mut initial = anthropic_usage();
    initial["output_tokens"] = json!(0);
    initial["output_tokens_details"] = Value::Null;
    let start = json!({"type":"message_start","message":{"id":"msg-thinking","usage":initial}});
    let partial = json!({"type":"message_delta","usage":{"output_tokens":1}});
    let final_delta = json!({"type":"message_delta","usage":{"output_tokens":3,"output_tokens_details":{"thinking_tokens":2}}});
    let wire = format!("data: {start}\n\ndata: {partial}\n\ndata: {final_delta}\n\ndata: {{\"type\":\"message_stop\"}}\n\n");
    for split in 1..wire.len() {
        let mut meter = SseMeter::new(Endpoint::Messages, profile.clone());
        let mut frames = meter.push(&wire.as_bytes()[..split]).unwrap();
        frames.extend(meter.push(&wire.as_bytes()[split..]).unwrap());
        assert_eq!(frames.concat(), wire.as_bytes());
        let (usage, id) = meter.finish().unwrap();
        assert_eq!(id.as_deref(), Some("msg-thinking"));
        assert_eq!(usage.last().unwrap().count, "3");
        assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 7);
    }
}

#[test]
fn proxy_anthropic_sse_invalid_or_decreasing_thinking_details_cannot_be_erased() {
    let (profile, _) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    let start = json!({"type":"message_start","message":{"id":"msg-thinking-invalid","usage":anthropic_usage()}});
    for details in [
        json!({"thinking_tokens":4}),
        json!({"thinking_tokens":-1}),
        json!({"thinking_tokens":0,"unknown":1}),
        json!({}),
    ] {
        let invalid = json!({"type":"message_delta","usage":{"output_tokens":3,"output_tokens_details":details}});
        let replacement = json!({"type":"message_delta","usage":{"output_tokens":3,"output_tokens_details":null}});
        let wire = format!("data: {start}\n\ndata: {invalid}\n\ndata: {replacement}\n\ndata: {{\"type\":\"message_stop\"}}\n\n");
        let mut meter = SseMeter::new(Endpoint::Messages, profile.clone());
        assert!(meter.push(wire.as_bytes()).is_err());
    }
    let observed = json!({"type":"message_delta","usage":{"output_tokens":3,"output_tokens_details":{"thinking_tokens":2}}});
    let null =
        json!({"type":"message_delta","usage":{"output_tokens":3,"output_tokens_details":null}});
    let decrease = json!({"type":"message_delta","usage":{"output_tokens":4,"output_tokens_details":{"thinking_tokens":1}}});
    let mut meter = SseMeter::new(Endpoint::Messages, profile);
    meter
        .push(format!("data: {start}\n\ndata: {observed}\n\ndata: {null}\n\n").as_bytes())
        .unwrap();
    assert!(meter
        .push(format!("data: {decrease}\n\n").as_bytes())
        .is_err());
}

#[test]
fn proxy_missing_contradictory_or_unpriced_usage_is_unknown() {
    let (profile, _) = setup(Provider::Openai, CacheMode::InclusiveRead);
    for (key, val) in [
        ("prompt_tokens", json!(null)),
        ("completion_tokens", json!(-1)),
        ("completion_tokens", json!(1.5)),
        ("total_tokens", json!(99)),
        ("new_billable_units", json!(1)),
        ("prompt_tokens_details", json!({"cached_tokens":11})),
        (
            "prompt_tokens_details",
            json!({"cached_tokens":4,"cache_write_tokens":1}),
        ),
        (
            "prompt_tokens_details",
            json!({"cached_tokens":4,"audio_tokens":1}),
        ),
        ("completion_tokens_details", json!({"reasoning_tokens":4})),
    ] {
        let mut u = openai_usage();
        u[key] = val;
        assert!(
            proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &u).is_err(),
            "{key}"
        );
    }
    let (profile, _) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    for (key, val) in [
        ("cache_creation_input_tokens", json!(4)),
        ("cache_creation", json!({"ephemeral_5m_input_tokens":5})),
        ("server_tool_use", json!({"web_search_requests":1})),
        ("service_tier", json!("priority")),
    ] {
        let mut u = anthropic_usage();
        u[key] = val;
        assert!(proxy::normalize_usage(Endpoint::Messages, &profile, &u).is_err());
    }
}

#[test]
fn proxy_openrouter_image_tokens_accepts_only_integer_zero_without_new_billing_units() {
    let (profile, tariff) = setup(Provider::Openrouter, CacheMode::InclusiveRead);
    let mut absent = openrouter_zero_image_usage();
    absent["completion_tokens_details"]
        .as_object_mut()
        .unwrap()
        .remove("image_tokens");
    let baseline = proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &absent).unwrap();
    let zero = proxy::normalize_usage(
        Endpoint::ChatCompletions,
        &profile,
        &openrouter_zero_image_usage(),
    )
    .unwrap();
    assert_eq!(zero, baseline);
    assert_eq!(
        zero.iter()
            .map(|u| (u.unit.as_str(), u.count.as_str()))
            .collect::<Vec<_>>(),
        [
            ("cache_read_tokens", "0"),
            ("input_tokens", "14"),
            ("output_tokens", "2")
        ]
    );
    assert_eq!(profile.calculate_charge(&tariff, &zero).unwrap(), 6);
    for invalid in [
        json!(1),
        json!(-1),
        Value::Null,
        json!("0"),
        json!(0.0),
        json!(0.5),
        json!(true),
        json!(u64::MAX),
        json!({}),
        json!([]),
    ] {
        let mut usage = openrouter_zero_image_usage();
        usage["completion_tokens_details"]["image_tokens"] = invalid;
        assert!(proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &usage).is_err());
    }
    let mut unknown = openrouter_zero_image_usage();
    unknown["completion_tokens_details"]["unknown_image_tokens"] = json!(0);
    assert!(proxy::normalize_usage(Endpoint::ChatCompletions, &profile, &unknown).is_err());
    // The compatibility rule does not broaden other providers or endpoints.
    let (openai, _) = setup(Provider::Openai, CacheMode::InclusiveRead);
    let mut openai_chat = openai_usage();
    openai_chat["completion_tokens_details"]["image_tokens"] = json!(0);
    assert!(proxy::normalize_usage(Endpoint::ChatCompletions, &openai, &openai_chat).is_err());
    let mut responses = responses_usage();
    responses["output_tokens_details"]["image_tokens"] = json!(0);
    assert!(proxy::normalize_usage(Endpoint::Responses, &openai, &responses).is_err());
    assert!(proxy::normalize_usage(Endpoint::Responses, &profile, &responses).is_err());
    let (anthropic, _) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    let mut messages = anthropic_usage();
    messages["output_tokens_details"] = json!({"thinking_tokens":0,"image_tokens":0});
    assert!(proxy::normalize_usage(Endpoint::Messages, &anthropic, &messages).is_err());
}

#[test]
fn proxy_openrouter_zero_image_usage_survives_every_sse_byte_boundary() {
    let (profile, tariff) = setup(Provider::Openrouter, CacheMode::InclusiveRead);
    let wire = openrouter_sse(&openrouter_zero_image_usage());
    for split in 1..wire.len() {
        let mut meter = SseMeter::new(Endpoint::ChatCompletions, profile.clone());
        let mut frames = meter.push(&wire.as_bytes()[..split]).unwrap();
        frames.extend(meter.push(&wire.as_bytes()[split..]).unwrap());
        assert_eq!(frames.concat(), wire.as_bytes());
        let (usage, id) = meter.finish().unwrap();
        assert_eq!(id.as_deref(), Some("router-fixture"));
        assert_eq!(profile.calculate_charge(&tariff, &usage).unwrap(), 6);
    }
}

#[test]
fn proxy_pinned_contract_snapshot_matches_normalization() {
    let snapshot: Value = serde_json::from_str(include_str!(
        "../../../docs/fixtures/i07-provider-contracts.json"
    ))
    .unwrap();
    for fixture in snapshot["fixtures"].as_array().unwrap() {
        let provider: Provider = serde_json::from_value(fixture["provider"].clone()).unwrap();
        let endpoint: Endpoint = serde_json::from_value(fixture["endpoint"].clone()).unwrap();
        let cache: CacheMode = serde_json::from_value(fixture["cache_mode"].clone()).unwrap();
        let (profile, _) = setup(provider, cache);
        let result = proxy::normalize_usage(endpoint, &profile, &fixture["usage"]);
        if fixture["expected_counts"].is_null() {
            assert!(result.is_err(), "{}", fixture["name"]);
        } else {
            let counts: Vec<String> = result.unwrap().into_iter().map(|u| u.count).collect();
            assert_eq!(
                serde_json::to_value(counts).unwrap(),
                fixture["expected_counts"]
            );
        }
    }
}

#[test]
fn proxy_sse_every_byte_boundary_terminal_and_cumulative_usage() {
    for (provider, cache, endpoint) in [
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::Responses,
        ),
        (
            Provider::Anthropic,
            CacheMode::AnthropicSplit,
            Endpoint::Messages,
        ),
        (
            Provider::Openrouter,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
    ] {
        let (profile, _) = setup(provider, cache);
        let wire = sse(endpoint);
        for split in 1..wire.len() {
            let mut meter = SseMeter::new(endpoint, profile.clone());
            let mut output = meter.push(&wire.as_bytes()[..split]).unwrap();
            output.extend(meter.push(&wire.as_bytes()[split..]).unwrap());
            assert_eq!(output.concat(), wire.as_bytes());
            let (usage, id) = meter.finish().unwrap();
            assert!(id.is_some());
            assert_eq!(usage.last().unwrap().count, "3");
        }
        let mut meter = SseMeter::new(endpoint, profile.clone());
        meter.push(&wire.as_bytes()[..wire.len() / 2]).unwrap();
        assert!(meter.finish().is_err());
        let mut meter = SseMeter::new(endpoint, profile);
        assert!(meter
            .push(b"event: error\ndata: {\"error\":{\"message\":\"SECRET_ECHO\"}}\n\n")
            .is_err());
    }
}

#[test]
fn proxy_anthropic_sse_nullable_deltas_preserve_observed_input_and_cache() {
    let (profile, _) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    let start =
        json!({"type":"message_start","message":{"id":"msg-nullable","usage":anthropic_usage()}});
    let cumulative = json!({"type":"message_delta","usage":{"input_tokens":8,"cache_read_input_tokens":5,"cache_creation_input_tokens":6,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":3},"output_tokens":4}});
    let delta = json!({"type":"message_delta","usage":{"output_tokens":5,"input_tokens":null,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"server_tool_use":null}});
    let wire = format!("data: {start}\n\ndata: {cumulative}\n\ndata: {delta}\n\ndata: {{\"type\":\"message_stop\"}}\n\n");
    let mut meter = SseMeter::new(Endpoint::Messages, profile);
    meter.push(wire.as_bytes()).unwrap();
    let (usage, _) = meter.finish().unwrap();
    assert_eq!(
        usage.iter().map(|u| u.count.as_str()).collect::<Vec<_>>(),
        ["5", "3", "3", "8", "5"]
    );
}

#[test]
fn proxy_anthropic_sse_rejects_decreasing_cumulative_input_and_cache() {
    let (profile, _) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
    for delta_usage in [
        json!({"input_tokens":5,"output_tokens":4}),
        json!({"cache_read_input_tokens":3,"output_tokens":4}),
        json!({"cache_creation_input_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":1,"ephemeral_1h_input_tokens":3},"output_tokens":4}),
        json!({"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":1,"ephemeral_1h_input_tokens":4},"output_tokens":4}),
    ] {
        let start = json!({"type":"message_start","message":{"id":"msg-decreasing","usage":anthropic_usage()}});
        let delta = json!({"type":"message_delta","usage":delta_usage});
        let wire =
            format!("data: {start}\n\ndata: {delta}\n\ndata: {{\"type\":\"message_stop\"}}\n\n");
        let mut meter = SseMeter::new(Endpoint::Messages, profile.clone());
        assert!(
            meter.push(wire.as_bytes()).is_err() || meter.finish().is_err(),
            "contradictory cumulative usage was accepted: {delta_usage}"
        );
    }
}

#[derive(Clone)]
struct Fixture {
    response: Arc<Vec<Vec<u8>>>,
    content_type: &'static str,
    status: u16,
    delay: Duration,
    count: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
}
async fn upstream(State(f): State<Fixture>, req: Request) -> Response {
    f.count.fetch_add(1, Ordering::SeqCst);
    let path = req.uri().path().to_owned();
    let headers = req.headers().clone();
    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024)
        .await
        .unwrap();
    f.seen
        .lock()
        .await
        .push((path, headers, serde_json::from_slice(&body).unwrap()));
    let chunks = f.response.clone();
    let delay = f.delay;
    let body = Body::from_stream(stream::unfold(
        (chunks, 0usize),
        move |(chunks, i)| async move {
            if i == chunks.len() {
                return None;
            }
            tokio::time::sleep(delay).await;
            Some((
                Ok::<_, Infallible>(Bytes::from(chunks[i].clone())),
                (chunks, i + 1),
            ))
        },
    ));
    Response::builder()
        .status(f.status)
        .header("content-type", f.content_type)
        .header("x-request-id", "request-fixture")
        .header("request-id", "request-fixture")
        .header("location", "http://127.0.0.1:1/redirect-must-not-follow")
        .body(body)
        .unwrap()
}
async fn fixture(
    response: Vec<Vec<u8>>,
    ctype: &'static str,
    status: u16,
    delay: Duration,
) -> (String, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture {
        response: Arc::new(response),
        content_type: ctype,
        status,
        delay,
        count: Arc::new(AtomicUsize::new(0)),
        seen: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().fallback(post(upstream)).with_state(f.clone());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), f, handle)
}

#[tokio::test]
async fn proxy_http_native_routes_credentials_usage_and_count_tokens() {
    for (provider, cache, endpoint) in [
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
        (
            Provider::Openai,
            CacheMode::InclusiveRead,
            Endpoint::Responses,
        ),
        (
            Provider::Openrouter,
            CacheMode::InclusiveRead,
            Endpoint::ChatCompletions,
        ),
        (
            Provider::Anthropic,
            CacheMode::AnthropicSplit,
            Endpoint::Messages,
        ),
        (
            Provider::Anthropic,
            CacheMode::AnthropicSplit,
            Endpoint::CountTokens,
        ),
    ] {
        let (profile, tariff) = setup(provider.clone(), cache);
        let response = match endpoint {
            Endpoint::ChatCompletions => {
                json!({"id":"chat-http","choices":[{"message":{"role":"assistant","content":"reply"}}],"usage":openai_usage()})
            }
            // Successful native Responses objects include the nullable error
            // field. Its presence alone must not discard valid final usage.
            Endpoint::Responses => {
                json!({"id":"resp-http","status":"completed","error":null,"output":[],"usage":responses_usage()})
            }
            Endpoint::Messages => {
                json!({"id":"msg-http","content":[{"type":"text","text":"reply"}],"usage":anthropic_usage()})
            }
            Endpoint::CountTokens => json!({"input_tokens":88}),
        };
        let (origin, f, server) = fixture(
            vec![serde_json::to_vec(&response).unwrap()],
            "application/json",
            200,
            Duration::ZERO,
        )
        .await;
        let adapter = HttpAdapter::local_fixture(
            provider.clone(),
            &origin,
            ServiceCredential::new("SERVICE_KEY_CANARY_I07".into()).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        let prepared = proxy::validate(
            endpoint,
            &serde_json::to_vec(&request(endpoint, false)).unwrap(),
            &profile,
            &tariff,
        )
        .unwrap();
        if endpoint == Endpoint::CountTokens {
            assert_eq!(prepared.reservation_nano, 0);
        }
        let (tx, mut rx) = mpsc::channel(16);
        let obs = adapter.dispatch_once(prepared, Some(tx)).await;
        assert!(obs.usage.is_some());
        assert!(obs.evidence_digest.is_some());
        assert_eq!(obs.provider_request_id.as_deref(), Some("request-fixture"));
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
        let seen = f.seen.lock().await;
        let (path, headers, body) = &seen[0];
        assert_eq!(
            path,
            &if provider == Provider::Openrouter {
                format!("/api{}", endpoint.path())
            } else {
                endpoint.path().into()
            }
        );
        if provider == Provider::Anthropic {
            assert_eq!(headers["x-api-key"], "SERVICE_KEY_CANARY_I07");
            assert_eq!(headers["anthropic-version"], "2023-06-01");
            assert!(!headers.contains_key("authorization"));
        } else {
            assert_eq!(headers["authorization"], "Bearer SERVICE_KEY_CANARY_I07");
            assert!(!headers.contains_key("x-api-key"));
        }
        assert!(!headers.contains_key("cookie"));
        assert!(!headers.contains_key("forwarded"));
        assert_eq!(body["model"], "fixture-model");
        let mut output = Vec::new();
        while let Some(event) = rx.recv().await {
            if let RelayEvent::Data(b) = event {
                output.extend_from_slice(&b);
            }
        }
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), response);
        if endpoint == Endpoint::CountTokens {
            assert!(obs.usage.unwrap().iter().all(|u| u.count == "0"));
        }
        server.abort();
    }
}

#[tokio::test]
async fn proxy_openrouter_http_json_and_sse_zero_image_usage_and_fail_closed_variants() {
    let (profile, tariff) = setup(Provider::Openrouter, CacheMode::InclusiveRead);
    for streaming in [false, true] {
        for (case, details, accepted) in [
            (
                "zero",
                json!({"reasoning_tokens":0,"audio_tokens":0,"image_tokens":0}),
                true,
            ),
            (
                "absent",
                json!({"reasoning_tokens":0,"audio_tokens":0}),
                true,
            ),
            ("positive", json!({"image_tokens":1}), false),
            ("null", json!({"image_tokens":null}), false),
            (
                "unknown",
                json!({"image_tokens":0,"unpriced_tokens":0}),
                false,
            ),
        ] {
            let mut usage = openrouter_zero_image_usage();
            usage["completion_tokens_details"] = details;
            let wire = if streaming {
                openrouter_sse(&usage).into_bytes()
            } else {
                serde_json::to_vec(&json!({"id":"router-fixture","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"service_tier":"default","usage":usage})).unwrap()
            };
            let (origin, f, server) = fixture(
                wire.chunks(37).map(<[u8]>::to_vec).collect(),
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                200,
                Duration::ZERO,
            )
            .await;
            let adapter = HttpAdapter::local_fixture(
                Provider::Openrouter,
                &origin,
                ServiceCredential::new("LOCAL_FIXTURE_KEY".into()).unwrap(),
                Duration::from_secs(2),
            )
            .unwrap();
            let prepared = proxy::validate(
                Endpoint::ChatCompletions,
                &serde_json::to_vec(&request(Endpoint::ChatCompletions, streaming)).unwrap(),
                &profile,
                &tariff,
            )
            .unwrap();
            let (tx, mut rx) = mpsc::channel(16);
            let forward = async {
                let mut bytes = Vec::new();
                while let Some(event) = rx.recv().await {
                    if let RelayEvent::Data(chunk) = event {
                        bytes.extend_from_slice(&chunk);
                    }
                }
                bytes
            };
            let (observed, forwarded) =
                tokio::join!(adapter.dispatch_once(prepared, Some(tx)), forward);
            server.abort();
            assert_eq!(
                f.count.load(Ordering::SeqCst),
                1,
                "{case} streaming={streaming}"
            );
            assert_eq!(observed.http_status, Some(200));
            assert_eq!(
                observed.provider_request_id.as_deref(),
                Some("request-fixture")
            );
            assert_eq!(
                observed.usage.is_some(),
                accepted,
                "{case} streaming={streaming}"
            );
            assert_eq!(observed.evidence_digest.is_some(), accepted);
            if accepted {
                let units = observed.usage.unwrap();
                assert_eq!(
                    units
                        .iter()
                        .map(|u| (u.unit.as_str(), u.count.as_str()))
                        .collect::<Vec<_>>(),
                    [
                        ("cache_read_tokens", "0"),
                        ("input_tokens", "14"),
                        ("output_tokens", "2")
                    ]
                );
                assert_eq!(profile.calculate_charge(&tariff, &units).unwrap(), 6);
                assert_eq!(forwarded, wire);
            } else {
                let text = String::from_utf8(forwarded).unwrap();
                assert!(text.contains("operation status"));
                assert!(!text.contains("unpriced_tokens"));
                assert!(!text.contains("LOCAL_FIXTURE_KEY"));
            }
            let seen = f.seen.lock().await;
            assert_eq!(seen[0].0, "/api/v1/chat/completions");
            assert_eq!(seen[0].2["stream"], streaming);
            assert_eq!(seen[0].2["store"], false);
        }
    }
}

#[tokio::test]
async fn proxy_http_sse_disconnect_and_slow_consumer_still_drain_final_usage() {
    for disconnect in [true, false] {
        let (profile, tariff) = setup(Provider::Anthropic, CacheMode::AnthropicSplit);
        let wire = sse(Endpoint::Messages);
        let (origin, f, server) = fixture(
            wire.as_bytes().chunks(17).map(<[u8]>::to_vec).collect(),
            "text/event-stream",
            200,
            Duration::from_millis(1),
        )
        .await;
        let adapter = HttpAdapter::local_fixture(
            Provider::Anthropic,
            &origin,
            ServiceCredential::new("key".into()).unwrap(),
            Duration::from_secs(3),
        )
        .unwrap();
        let prepared = proxy::validate(
            Endpoint::Messages,
            &serde_json::to_vec(&request(Endpoint::Messages, true)).unwrap(),
            &profile,
            &tariff,
        )
        .unwrap();
        let (tx, rx) = mpsc::channel(1);
        let task = tokio::spawn(async move { adapter.dispatch_once(prepared, Some(tx)).await });
        if disconnect {
            drop(rx);
        } else {
            tokio::time::sleep(Duration::from_millis(120)).await;
            drop(rx);
        }
        let obs = task.await.unwrap();
        assert!(obs.downstream_dropped);
        assert_eq!(obs.usage.unwrap().last().unwrap().count, "3");
        assert!(obs.evidence_digest.is_some());
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
        server.abort();
    }
}

#[tokio::test]
async fn proxy_http_sse_burst_larger_than_relay_queue_preserves_every_frame() {
    let (profile, tariff) = setup(Provider::Openai, CacheMode::InclusiveRead);
    let mut wire = String::new();
    for _ in 0..100 {
        wire.push_str(
            "data: {\"id\":\"chat-fixture\",\"choices\":[{\"delta\":{\"content\":\"burst\"}}]}\n\n",
        );
    }
    wire.push_str(&sse(Endpoint::ChatCompletions));
    let (origin, _, server) = fixture(
        vec![wire.as_bytes().to_vec()],
        "text/event-stream",
        200,
        Duration::ZERO,
    )
    .await;
    let adapter = HttpAdapter::local_fixture(
        Provider::Openai,
        &origin,
        ServiceCredential::new("key".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap();
    let prepared = proxy::validate(
        Endpoint::ChatCompletions,
        &serde_json::to_vec(&request(Endpoint::ChatCompletions, true)).unwrap(),
        &profile,
        &tariff,
    )
    .unwrap();
    let (tx, mut rx) = mpsc::channel(8);
    let forward = async {
        let mut bytes = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                RelayEvent::Head { .. } => tokio::time::sleep(Duration::from_millis(10)).await,
                RelayEvent::Data(chunk) => bytes.extend_from_slice(&chunk),
            }
        }
        bytes
    };
    let (observation, forwarded) = tokio::join!(adapter.dispatch_once(prepared, Some(tx)), forward);
    assert!(observation.usage.is_some());
    assert!(!observation.downstream_dropped);
    assert_eq!(forwarded, wire.as_bytes());
    server.abort();
}

#[tokio::test]
async fn proxy_http_timeout_missing_usage_redirect_and_error_never_retry_or_echo() {
    for (status, response, delay) in [
        (
            503,
            json!({"error":{"message":"SERVICE_KEY_CANARY_I07 PROMPT_CANARY_I07"}}),
            Duration::ZERO,
        ),
        (302, json!({"error":"redirect"}), Duration::ZERO),
        (
            200,
            json!({"id":"chat-failed","error":{"message":"SERVICE_KEY_CANARY_I07"},"usage":openai_usage()}),
            Duration::ZERO,
        ),
        (
            200,
            json!({"id":"chat-missing","choices":[]}),
            Duration::ZERO,
        ),
        (
            200,
            json!({"id":"chat-delayed","usage":openai_usage()}),
            Duration::from_millis(100),
        ),
    ] {
        let (origin, f, server) = fixture(
            vec![serde_json::to_vec(&response).unwrap()],
            "application/json",
            status,
            delay,
        )
        .await;
        let (profile, tariff) = setup(Provider::Openai, CacheMode::InclusiveRead);
        let adapter = HttpAdapter::local_fixture(
            Provider::Openai,
            &origin,
            ServiceCredential::new("key".into()).unwrap(),
            Duration::from_millis(50),
        )
        .unwrap();
        let prepared = proxy::validate(
            Endpoint::ChatCompletions,
            &serde_json::to_vec(&request(Endpoint::ChatCompletions, false)).unwrap(),
            &profile,
            &tariff,
        )
        .unwrap();
        let (tx, mut rx) = mpsc::channel(8);
        let obs = adapter.dispatch_once(prepared, Some(tx)).await;
        assert!(obs.usage.is_none());
        assert!(obs.evidence_digest.is_none());
        assert_eq!(f.count.load(Ordering::SeqCst), 1);
        let mut output = Vec::new();
        while let Some(e) = rx.recv().await {
            if let RelayEvent::Data(bytes) = e {
                output.extend_from_slice(&bytes);
            }
        }
        let output = String::from_utf8(output).unwrap();
        assert!(!output.contains("CANARY"));
        assert!(output.contains("operation status"));
        server.abort();
    }
    for origin in [
        "http://localhost:10",
        "http://169.254.169.254",
        "http://127.0.0.1/route",
        "http://127.0.0.1?redirect=https://external",
        "https://127.0.0.1",
    ] {
        assert!(HttpAdapter::local_fixture(
            Provider::Openai,
            origin,
            ServiceCredential::new("key".into()).unwrap(),
            Duration::from_secs(1)
        )
        .is_err());
    }
}
