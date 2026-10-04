use super::{CacheMode, Endpoint, ModelProfile, ProxyError, Result};
use crate::wire::{Tariff, Usage};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{Map, Value};
use std::fmt;

/// Contains transient prompt bytes. Never Debug or Serialize this value.
pub struct PreparedRequest {
    pub endpoint: Endpoint,
    pub profile: ModelProfile,
    pub streaming: bool,
    pub reservation_nano: u128,
    pub upstream_body: Vec<u8>,
}

struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Strict(n.into()))
                    .ok_or_else(|| E::custom("number"))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element::<Strict>()? {
                    v.push(x.0);
                }
                Ok(Strict(v.into()))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut v = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if k == "$serde_json::private::Number" || v.contains_key(&k) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    v.insert(k, a.next_value::<Strict>()?.0);
                }
                Ok(Strict(v.into()))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn parse_json(raw: &[u8], limit: usize) -> Result<Value> {
    if raw.len() > limit {
        return Err(ProxyError::TooLarge);
    }
    std::str::from_utf8(raw).map_err(|_| ProxyError::InvalidRequest)?;
    serde_json::from_slice::<Strict>(raw)
        .map(|v| v.0)
        .map_err(|_| ProxyError::InvalidRequest)
}

fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or(ProxyError::InvalidRequest)
}
fn fields(v: &Value, allowed: &[&str]) -> Result<()> {
    if object(v)?.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ProxyError::UnsupportedMetering);
    }
    Ok(())
}
fn text(v: &Value) -> Result<()> {
    if v.is_string() {
        Ok(())
    } else {
        Err(ProxyError::InvalidRequest)
    }
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or(ProxyError::InvalidRequest)
}
fn boolean(v: &Value, k: &str) -> Result<bool> {
    match v.get(k) {
        None => Ok(false),
        Some(v) => v.as_bool().ok_or(ProxyError::InvalidRequest),
    }
}
fn array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array().ok_or(ProxyError::InvalidRequest)
}
fn bounded_tokens(v: &Value, limit: u64) -> Result<u64> {
    v.as_u64()
        .filter(|n| *n > 0 && *n <= limit)
        .ok_or(ProxyError::UnsupportedMetering)
}
fn optional_strings(v: &Value, keys: &[&str]) -> Result<()> {
    for k in keys {
        if let Some(x) = v.get(k) {
            text(x)?;
        }
    }
    Ok(())
}
fn samples(v: &Value) -> Result<()> {
    for (key, min, max) in [
        ("temperature", 0.0, 2.0),
        ("top_p", 0.0, 1.0),
        ("frequency_penalty", -2.0, 2.0),
        ("presence_penalty", -2.0, 2.0),
    ] {
        if let Some(x) = v.get(key) {
            if !x.as_f64().is_some_and(|n| n >= min && n <= max) {
                return Err(ProxyError::InvalidRequest);
            }
        }
    }
    Ok(())
}
fn cache_control(v: &Value, profile: &ModelProfile) -> Result<()> {
    if let Some(c) = v.get("cache_control") {
        if profile.cache_mode != CacheMode::AnthropicSplit {
            return Err(ProxyError::UnsupportedMetering);
        }
        fields(c, &["type", "ttl"])?;
        if string(c, "type")? != "ephemeral"
            || c.get("ttl")
                .is_some_and(|s| !matches!(s.as_str(), Some("5m" | "1h")))
        {
            return Err(ProxyError::UnsupportedMetering);
        }
    }
    Ok(())
}
fn text_content(v: &Value, kind: Endpoint, profile: &ModelProfile) -> Result<()> {
    if v.is_string() {
        return Ok(());
    }
    for block in array(v)? {
        let allowed_type = match kind {
            Endpoint::Responses => matches!(string(block, "type")?, "input_text" | "output_text"),
            _ => string(block, "type")? == "text",
        };
        if !allowed_type {
            return Err(ProxyError::UnsupportedMetering);
        }
        fields(
            block,
            &["type", "text", "cache_control", "annotations", "logprobs"],
        )?;
        for key in ["annotations", "logprobs"] {
            if let Some(extra) = block.get(key) {
                if kind != Endpoint::Responses || !array(extra)?.is_empty() {
                    return Err(ProxyError::UnsupportedMetering);
                }
            }
        }
        text(block.get("text").ok_or(ProxyError::InvalidRequest)?)?;
        cache_control(block, profile)?;
    }
    Ok(())
}
fn chat(v: &Value, profile: &ModelProfile) -> Result<()> {
    let messages = array(v.get("messages").ok_or(ProxyError::InvalidRequest)?)?;
    if messages.is_empty() {
        return Err(ProxyError::InvalidRequest);
    }
    for m in messages {
        fields(
            m,
            &["role", "content", "name", "tool_calls", "tool_call_id"],
        )?;
        let role = string(m, "role")?;
        if !matches!(role, "system" | "developer" | "user" | "assistant" | "tool") {
            return Err(ProxyError::UnsupportedMetering);
        }
        optional_strings(m, &["name", "tool_call_id"])?;
        match m.get("content") {
            Some(Value::Null) | None if role == "assistant" && m.get("tool_calls").is_some() => {}
            Some(c) => text_content(c, Endpoint::ChatCompletions, profile)?,
            None => return Err(ProxyError::InvalidRequest),
        }
        if let Some(calls) = m.get("tool_calls") {
            if role != "assistant" {
                return Err(ProxyError::InvalidRequest);
            }
            for call in array(calls)? {
                fields(call, &["id", "type", "function"])?;
                if string(call, "type")? != "function" {
                    return Err(ProxyError::UnsupportedMetering);
                }
                string(call, "id")?;
                let f = call.get("function").ok_or(ProxyError::InvalidRequest)?;
                fields(f, &["name", "arguments"])?;
                string(f, "name")?;
                string(f, "arguments")?;
            }
        }
        if role == "tool" {
            string(m, "tool_call_id")?;
        }
    }
    Ok(())
}
fn responses(v: &Value, profile: &ModelProfile) -> Result<()> {
    let input = v.get("input").ok_or(ProxyError::InvalidRequest)?;
    if input.is_string() {
        return Ok(());
    }
    for item in array(input)? {
        match item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message")
        {
            "message" => {
                fields(item, &["type", "role", "content", "id", "status"])?;
                optional_strings(item, &["id", "status"])?;
                if !matches!(
                    string(item, "role")?,
                    "user" | "assistant" | "system" | "developer"
                ) {
                    return Err(ProxyError::InvalidRequest);
                }
                text_content(
                    item.get("content").ok_or(ProxyError::InvalidRequest)?,
                    Endpoint::Responses,
                    profile,
                )?;
            }
            "function_call" => {
                fields(
                    item,
                    &["type", "call_id", "name", "arguments", "id", "status"],
                )?;
                optional_strings(item, &["id", "status"])?;
                for k in ["call_id", "name", "arguments"] {
                    string(item, k)?;
                }
            }
            "function_call_output" => {
                fields(item, &["type", "call_id", "output", "id", "status"])?;
                optional_strings(item, &["id", "status"])?;
                string(item, "call_id")?;
                string(item, "output")?;
            }
            _ => return Err(ProxyError::UnsupportedMetering),
        }
    }
    Ok(())
}
fn anthropic(v: &Value, profile: &ModelProfile) -> Result<()> {
    if let Some(s) = v.get("system") {
        text_content(s, Endpoint::Messages, profile)?;
    }
    let messages = array(v.get("messages").ok_or(ProxyError::InvalidRequest)?)?;
    if messages.is_empty() {
        return Err(ProxyError::InvalidRequest);
    }
    for m in messages {
        fields(m, &["role", "content"])?;
        if !matches!(string(m, "role")?, "user" | "assistant") {
            return Err(ProxyError::InvalidRequest);
        }
        let content = m.get("content").ok_or(ProxyError::InvalidRequest)?;
        if content.is_string() {
            continue;
        }
        for b in array(content)? {
            match string(b, "type")? {
                "text" => {
                    fields(b, &["type", "text", "cache_control"])?;
                    string(b, "text")?;
                }
                "tool_use" => {
                    fields(b, &["type", "id", "name", "input", "cache_control"])?;
                    string(b, "id")?;
                    string(b, "name")?;
                    object(b.get("input").ok_or(ProxyError::InvalidRequest)?)?;
                }
                "tool_result" => {
                    fields(
                        b,
                        &[
                            "type",
                            "tool_use_id",
                            "content",
                            "is_error",
                            "cache_control",
                        ],
                    )?;
                    string(b, "tool_use_id")?;
                    boolean(b, "is_error")?;
                    text_content(
                        b.get("content").ok_or(ProxyError::InvalidRequest)?,
                        Endpoint::Messages,
                        profile,
                    )?;
                }
                _ => return Err(ProxyError::UnsupportedMetering),
            }
            cache_control(b, profile)?;
        }
    }
    cache_control(v, profile)?;
    Ok(())
}
fn tools(v: &Value, endpoint: Endpoint, profile: &ModelProfile) -> Result<()> {
    if let Some(items) = v.get("tools") {
        for tool in array(items)? {
            let f = match endpoint {
                Endpoint::ChatCompletions => {
                    fields(tool, &["type", "function"])?;
                    if string(tool, "type")? != "function" {
                        return Err(ProxyError::UnsupportedMetering);
                    }
                    tool.get("function").ok_or(ProxyError::InvalidRequest)?
                }
                Endpoint::Responses => {
                    fields(
                        tool,
                        &["type", "name", "description", "parameters", "strict"],
                    )?;
                    if string(tool, "type")? != "function" {
                        return Err(ProxyError::UnsupportedMetering);
                    }
                    tool
                }
                Endpoint::Messages | Endpoint::CountTokens => {
                    fields(
                        tool,
                        &["name", "description", "input_schema", "cache_control"],
                    )?;
                    tool
                }
            };
            if endpoint == Endpoint::ChatCompletions {
                fields(f, &["name", "description", "parameters", "strict"])?;
            }
            string(f, "name")?;
            optional_strings(f, &["description"])?;
            let schema = if matches!(endpoint, Endpoint::Messages | Endpoint::CountTokens) {
                "input_schema"
            } else {
                "parameters"
            };
            object(f.get(schema).ok_or(ProxyError::InvalidRequest)?)?;
            boolean(f, "strict")?;
            cache_control(tool, profile)?;
        }
    }
    if let Some(choice) = v.get("tool_choice") {
        if matches!(endpoint, Endpoint::Messages | Endpoint::CountTokens) {
            fields(choice, &["type", "name", "disable_parallel_tool_use"])?;
            boolean(choice, "disable_parallel_tool_use")?;
            match string(choice, "type")? {
                "auto" | "any" | "none" => {}
                "tool" => {
                    string(choice, "name")?;
                }
                _ => return Err(ProxyError::UnsupportedMetering),
            }
        } else if let Some(s) = choice.as_str() {
            if !matches!(s, "auto" | "none" | "required") {
                return Err(ProxyError::UnsupportedMetering);
            }
        } else if endpoint == Endpoint::ChatCompletions {
            fields(choice, &["type", "function"])?;
            if string(choice, "type")? != "function" {
                return Err(ProxyError::UnsupportedMetering);
            }
            let f = choice.get("function").ok_or(ProxyError::InvalidRequest)?;
            fields(f, &["name"])?;
            string(f, "name")?;
        } else {
            fields(choice, &["type", "name"])?;
            if string(choice, "type")? != "function" {
                return Err(ProxyError::UnsupportedMetering);
            }
            string(choice, "name")?;
        }
    }
    Ok(())
}

/// Validate a native endpoint without changing provider or model. Unsupported
/// hosted tools, persistence and modalities fail before reservation or egress.
pub fn validate(
    endpoint: Endpoint,
    raw: &[u8],
    profile: &ModelProfile,
    tariff: &Tariff,
) -> Result<PreparedRequest> {
    profile.validate(tariff)?;
    if !profile.endpoints.contains(&endpoint) {
        return Err(ProxyError::UnsupportedMetering);
    }
    let mut v = parse_json(raw, 1024 * 1024)?;
    let allowed: &[&str] = match endpoint {
        Endpoint::ChatCompletions => &[
            "model",
            "messages",
            "max_tokens",
            "max_completion_tokens",
            "stream",
            "stream_options",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "frequency_penalty",
            "presence_penalty",
            "stop",
            "seed",
            "n",
            "store",
        ],
        Endpoint::Responses => &[
            "model",
            "input",
            "instructions",
            "max_output_tokens",
            "stream",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "store",
            "background",
        ],
        Endpoint::Messages => &[
            "model",
            "messages",
            "system",
            "max_tokens",
            "stream",
            "tools",
            "tool_choice",
            "temperature",
            "top_p",
            "top_k",
            "stop_sequences",
            "cache_control",
        ],
        Endpoint::CountTokens => &[
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "cache_control",
        ],
    };
    fields(&v, allowed)?;
    if string(&v, "model")? != profile.model {
        return Err(ProxyError::UnsupportedMetering);
    }
    samples(&v)?;
    let streaming = boolean(&v, "stream")?;
    if boolean(&v, "store")? || boolean(&v, "background")? {
        return Err(ProxyError::UnsupportedMetering);
    }
    boolean(&v, "parallel_tool_calls")?;
    if let Some(n) = v.get("n") {
        if n.as_u64() != Some(1) {
            return Err(ProxyError::UnsupportedMetering);
        }
    }
    if let Some(seed) = v.get("seed") {
        if seed.as_i64().is_none() {
            return Err(ProxyError::InvalidRequest);
        }
    }
    if let Some(k) = v.get("top_k") {
        if k.as_u64().is_none() {
            return Err(ProxyError::InvalidRequest);
        }
    }
    optional_strings(&v, &["instructions"])?;
    for key in ["stop", "stop_sequences"] {
        if let Some(stops) = v.get(key) {
            if !stops.is_string() || key == "stop_sequences" {
                for stop in array(stops)? {
                    text(stop)?;
                }
            }
        }
    }
    tools(&v, endpoint, profile)?;
    let output = match endpoint {
        Endpoint::ChatCompletions => {
            chat(&v, profile)?;
            if v.get("max_tokens").is_some() && v.get("max_completion_tokens").is_some() {
                return Err(ProxyError::UnsupportedMetering);
            }
            let output = bounded_tokens(
                v.get("max_completion_tokens")
                    .or_else(|| v.get("max_tokens"))
                    .ok_or(ProxyError::UnsupportedMetering)?,
                profile.max_output_tokens,
            )?;
            if let Some(options) = v.get("stream_options") {
                fields(options, &["include_usage"])?;
                boolean(options, "include_usage")?;
            }
            if streaming {
                v["stream_options"] = serde_json::json!({"include_usage":true});
            }
            v["store"] = Value::Bool(false);
            output
        }
        Endpoint::Responses => {
            responses(&v, profile)?;
            let n = bounded_tokens(
                v.get("max_output_tokens")
                    .ok_or(ProxyError::UnsupportedMetering)?,
                profile.max_output_tokens,
            )?;
            v["store"] = Value::Bool(false);
            v["background"] = Value::Bool(false);
            n
        }
        Endpoint::Messages => {
            anthropic(&v, profile)?;
            bounded_tokens(
                v.get("max_tokens").ok_or(ProxyError::UnsupportedMetering)?,
                profile.max_output_tokens,
            )?
        }
        Endpoint::CountTokens => {
            anthropic(&v, profile)?;
            0
        }
    };
    let reservation_nano = if endpoint == Endpoint::CountTokens {
        0
    } else {
        reserve_bound(profile, tariff, output)?
    };
    Ok(PreparedRequest {
        endpoint,
        profile: profile.clone(),
        streaming,
        reservation_nano,
        upstream_body: serde_json::to_vec(&v).map_err(|_| ProxyError::InvalidRequest)?,
    })
}

fn reserve_bound(profile: &ModelProfile, tariff: &Tariff, output: u64) -> Result<u128> {
    // All input categories partition context tokens. Reserve all of that public
    // maximum at the most expensive input/cache rate; no tokenizer estimate.
    let mut highest = None;
    for r in tariff.rates.iter().filter(|r| r.unit != "output_tokens") {
        let n = crate::wire::uint(&r.nano_usdc_numerator).map_err(|_| ProxyError::Configuration)?
            as u128;
        let d =
            crate::wire::uint(&r.unit_denominator).map_err(|_| ProxyError::Configuration)? as u128;
        if highest.is_none_or(|(_, hn, hd)| n * hd > hn * d) {
            highest = Some((r.unit.as_str(), n, d));
        }
    }
    let highest = highest.ok_or(ProxyError::Configuration)?.0;
    let usage: Vec<_> = tariff
        .rates
        .iter()
        .map(|r| Usage {
            unit: r.unit.clone(),
            count: if r.unit == "output_tokens" {
                output
            } else if r.unit == highest {
                profile.context_tokens
            } else {
                0
            }
            .to_string(),
        })
        .collect();
    crate::quote::calculate_charge(tariff, &usage).map_err(|_| ProxyError::UnsupportedMetering)
}
