use super::{CacheMode, Endpoint, ModelProfile, ProxyError, Result};
use crate::wire::Usage;
use serde_json::{Map, Value};

fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or(ProxyError::UsageUnknown)
}
fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    if object(v)?.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ProxyError::UsageUnknown);
    }
    Ok(())
}
fn count(v: &Value, name: &str) -> Result<u64> {
    v.get(name)
        .and_then(Value::as_u64)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(ProxyError::UsageUnknown)
}
fn optional_zero(v: &Value, name: &str) -> Result<u64> {
    if v.get(name).is_none() {
        Ok(0)
    } else {
        count(v, name)
    }
}
fn sum(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(ProxyError::UsageUnknown)
}
fn value(units: &[(&str, u64)]) -> Vec<Usage> {
    units
        .iter()
        .map(|(u, c)| Usage {
            unit: (*u).into(),
            count: c.to_string(),
        })
        .collect()
}

fn nondecreasing(previous: &Value, next: &Value) -> Result<()> {
    if let (Some(old), Some(new)) = (previous.as_u64(), next.as_u64()) {
        if new < old {
            return Err(ProxyError::UsageUnknown);
        }
    } else if let (Some(old), Some(new)) = (previous.as_object(), next.as_object()) {
        for (key, value) in new {
            if let Some(previous) = old.get(key) {
                nondecreasing(previous, value)?;
            }
        }
    }
    Ok(())
}

/// Normalize documented *final* usage only. All rates have one integer count;
/// inclusive input subtracts cache, exclusive Anthropic input stays exclusive.
pub fn normalize_usage(
    endpoint: Endpoint,
    profile: &ModelProfile,
    usage: &Value,
) -> Result<Vec<Usage>> {
    if profile.cache_mode == CacheMode::AnthropicSplit {
        if endpoint != Endpoint::Messages {
            return Err(ProxyError::UsageUnknown);
        }
        keys(
            usage,
            &[
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "cache_creation",
                "server_tool_use",
                "service_tier",
                "inference_geo",
            ],
        )?;
        if usage
            .get("service_tier")
            .is_some_and(|v| v.as_str() != Some("standard"))
        {
            return Err(ProxyError::UsageUnknown);
        }
        if usage
            .get("inference_geo")
            .is_some_and(|v| v.as_str() != Some("global"))
        {
            return Err(ProxyError::UsageUnknown);
        }
        if let Some(tools) = usage.get("server_tool_use") {
            keys(tools, &["web_search_requests", "web_fetch_requests"])?;
            if optional_zero(tools, "web_search_requests")? != 0
                || optional_zero(tools, "web_fetch_requests")? != 0
            {
                return Err(ProxyError::UsageUnknown);
            }
        }
        let input = count(usage, "input_tokens")?;
        let output = count(usage, "output_tokens")?;
        let read = count(usage, "cache_read_input_tokens")?;
        let creation = count(usage, "cache_creation_input_tokens")?;
        let (short, long) = if let Some(c) = usage.get("cache_creation") {
            keys(
                c,
                &["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"],
            )?;
            (
                count(c, "ephemeral_5m_input_tokens")?,
                count(c, "ephemeral_1h_input_tokens")?,
            )
        } else if creation == 0 {
            (0, 0)
        } else {
            return Err(ProxyError::UsageUnknown);
        };
        if sum(short, long)? != creation {
            return Err(ProxyError::UsageUnknown);
        }
        sum(sum(input, read)?, creation)?;
        return Ok(value(&[
            ("cache_read_tokens", read),
            ("cache_write_1h_tokens", long),
            ("cache_write_5m_tokens", short),
            ("input_tokens", input),
            ("output_tokens", output),
        ]));
    }
    let (input_key, output_key, details_key, output_details_key) = match endpoint {
        Endpoint::ChatCompletions => (
            "prompt_tokens",
            "completion_tokens",
            "prompt_tokens_details",
            "completion_tokens_details",
        ),
        Endpoint::Responses => (
            "input_tokens",
            "output_tokens",
            "input_tokens_details",
            "output_tokens_details",
        ),
        _ => return Err(ProxyError::UsageUnknown),
    };
    let mut allowed = vec![
        input_key,
        output_key,
        details_key,
        output_details_key,
        "total_tokens",
    ];
    if profile.provider == crate::wire::Provider::Openrouter {
        allowed.extend(["cost", "cost_details", "is_byok"]);
    }
    keys(usage, &allowed)?;
    let input = count(usage, input_key)?;
    let output = count(usage, output_key)?;
    if usage.get("total_tokens").is_some() && count(usage, "total_tokens")? != sum(input, output)? {
        return Err(ProxyError::UsageUnknown);
    }
    let details = usage.get(details_key).ok_or(ProxyError::UsageUnknown)?;
    keys(
        details,
        &[
            "cached_tokens",
            "cache_write_tokens",
            "audio_tokens",
            "video_tokens",
        ],
    )?;
    if optional_zero(details, "audio_tokens")? != 0 || optional_zero(details, "video_tokens")? != 0
    {
        return Err(ProxyError::UsageUnknown);
    }
    let read = count(details, "cached_tokens")?;
    let write = if profile.cache_mode == CacheMode::InclusiveReadWrite {
        count(details, "cache_write_tokens")?
    } else {
        let w = optional_zero(details, "cache_write_tokens")?;
        if w != 0 {
            return Err(ProxyError::UsageUnknown);
        }
        0
    };
    if let Some(d) = usage.get(output_details_key) {
        keys(
            d,
            &[
                "reasoning_tokens",
                "audio_tokens",
                "accepted_prediction_tokens",
                "rejected_prediction_tokens",
            ],
        )?;
        if optional_zero(d, "audio_tokens")? != 0 || optional_zero(d, "reasoning_tokens")? > output
        {
            return Err(ProxyError::UsageUnknown);
        }
        // Prediction/reasoning are already within completion_tokens.
        optional_zero(d, "accepted_prediction_tokens")?;
        optional_zero(d, "rejected_prediction_tokens")?;
    }
    let ordinary = input
        .checked_sub(sum(read, write)?)
        .ok_or(ProxyError::UsageUnknown)?;
    let mut result = value(&[("cache_read_tokens", read)]);
    if profile.cache_mode == CacheMode::InclusiveReadWrite {
        result.push(Usage {
            unit: "cache_write_tokens".into(),
            count: write.to_string(),
        });
    }
    result.extend(value(&[
        ("input_tokens", ordinary),
        ("output_tokens", output),
    ]));
    Ok(result)
}

/// Incremental SSE framing, bounded per event. Cumulative frames replace counts;
/// they are never summed. Requires the endpoint's terminal marker.
pub struct SseMeter {
    endpoint: Endpoint,
    profile: ModelProfile,
    buffer: Vec<u8>,
    usage: Option<Value>,
    provider_id: Option<String>,
    terminal: bool,
    started: bool,
    output_observed: bool,
}
impl SseMeter {
    pub fn provider_request_id(&self) -> Option<&str> {
        self.provider_id.as_deref()
    }
    pub fn new(endpoint: Endpoint, profile: ModelProfile) -> Self {
        Self {
            endpoint,
            profile,
            buffer: Vec::new(),
            usage: None,
            provider_id: None,
            terminal: false,
            started: false,
            output_observed: false,
        }
    }
    /// Returns only complete validated frames, so an upstream error frame is
    /// never partially forwarded before its potentially sensitive text is read.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
        let mut frames = Vec::new();
        for part in bytes.chunks(64 * 1024) {
            self.buffer.extend_from_slice(part);
            loop {
                let boundary = self
                    .buffer
                    .windows(2)
                    .position(|w| w == b"\n\n")
                    .map(|i| i + 2);
                let crlf = self
                    .buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|i| i + 4);
                let end = match (boundary, crlf) {
                    (Some(a), Some(b)) => a.min(b),
                    (Some(a), None) | (None, Some(a)) => a,
                    (None, None) => break,
                };
                if end > 1024 * 1024 {
                    return Err(ProxyError::UsageUnknown);
                }
                let frame: Vec<u8> = self.buffer.drain(..end).collect();
                self.observe(&frame)?;
                frames.push(frame);
            }
            if self.buffer.len() > 1024 * 1024 {
                return Err(ProxyError::UsageUnknown);
            }
        }
        Ok(frames)
    }
    fn set_id(&mut self, v: &Value) -> Result<()> {
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            if !super::transport::valid_id(id)
                || self.provider_id.as_ref().is_some_and(|old| old != id)
            {
                return Err(ProxyError::UsageUnknown);
            }
            self.provider_id = Some(id.into());
        }
        Ok(())
    }
    fn observe(&mut self, frame: &[u8]) -> Result<()> {
        let text = std::str::from_utf8(frame).map_err(|_| ProxyError::UsageUnknown)?;
        let mut data = Vec::new();
        let mut event = "";
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("data:") {
                data.push(v.strip_prefix(' ').unwrap_or(v));
            }
            if let Some(v) = line.strip_prefix("event:") {
                event = v.trim();
            }
        }
        if data.is_empty() {
            return Ok(());
        }
        if self.terminal {
            return Err(ProxyError::UsageUnknown);
        }
        let data = data.join("\n");
        if data == "[DONE]" {
            if self.endpoint != Endpoint::ChatCompletions || self.usage.is_none() {
                return Err(ProxyError::UsageUnknown);
            }
            self.terminal = true;
            return Ok(());
        }
        let v = super::parse_json(data.as_bytes(), 1024 * 1024)
            .map_err(|_| ProxyError::UsageUnknown)?;
        if v.get("error").is_some()
            || event == "error"
            || v.get("type").and_then(Value::as_str) == Some("error")
        {
            return Err(ProxyError::UsageUnknown);
        }
        match self.endpoint {
            Endpoint::ChatCompletions => {
                self.set_id(&v)?;
                if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                    normalize_usage(self.endpoint, &self.profile, u)?;
                    if self.usage.as_ref().is_some_and(|old| old != u) {
                        return Err(ProxyError::UsageUnknown);
                    }
                    self.usage = Some(u.clone());
                }
            }
            Endpoint::Responses => {
                let ty = v.get("type").and_then(Value::as_str).unwrap_or(event);
                if matches!(ty, "response.failed" | "response.error") {
                    return Err(ProxyError::UsageUnknown);
                }
                if let Some(response) = v.get("response") {
                    self.set_id(response)?;
                }
                if matches!(ty, "response.completed" | "response.incomplete") {
                    let response = v.get("response").ok_or(ProxyError::UsageUnknown)?;
                    let u = response.get("usage").ok_or(ProxyError::UsageUnknown)?;
                    normalize_usage(self.endpoint, &self.profile, u)?;
                    self.usage = Some(u.clone());
                    self.terminal = true;
                }
            }
            Endpoint::Messages => {
                let ty = v.get("type").and_then(Value::as_str).unwrap_or(event);
                match ty {
                    "message_start" => {
                        if self.started {
                            return Err(ProxyError::UsageUnknown);
                        }
                        let m = v.get("message").ok_or(ProxyError::UsageUnknown)?;
                        self.set_id(m)?;
                        let u = m.get("usage").ok_or(ProxyError::UsageUnknown)?;
                        object(u)?;
                        self.usage = Some(u.clone());
                        self.started = true;
                    }
                    "message_delta" => {
                        if !self.started {
                            return Err(ProxyError::UsageUnknown);
                        }
                        let u = v.get("usage").ok_or(ProxyError::UsageUnknown)?;
                        let current = self
                            .usage
                            .as_mut()
                            .and_then(Value::as_object_mut)
                            .ok_or(ProxyError::UsageUnknown)?;
                        if u.get("output_tokens").is_some() {
                            let n = count(u, "output_tokens")?;
                            if current
                                .get("output_tokens")
                                .and_then(Value::as_u64)
                                .is_some_and(|old| n < old)
                            {
                                return Err(ProxyError::UsageUnknown);
                            }
                            self.output_observed = true;
                        }
                        for (k, val) in object(u)? {
                            // The native delta schema makes these fields
                            // nullable. Null reports no new observation; it
                            // must not erase the message_start counters.
                            if val.is_null()
                                && matches!(
                                    k.as_str(),
                                    "input_tokens"
                                        | "cache_read_input_tokens"
                                        | "cache_creation_input_tokens"
                                        | "server_tool_use"
                                )
                            {
                                continue;
                            }
                            if let Some(previous) = current.get(k) {
                                nondecreasing(previous, val)?;
                            }
                            current.insert(k.clone(), val.clone());
                        }
                    }
                    "message_stop" => {
                        if !self.started || !self.output_observed {
                            return Err(ProxyError::UsageUnknown);
                        }
                        self.terminal = true;
                    }
                    "content_block_start"
                    | "content_block_delta"
                    | "content_block_stop"
                    | "ping" => {}
                    _ => return Err(ProxyError::UsageUnknown),
                }
            }
            Endpoint::CountTokens => return Err(ProxyError::UsageUnknown),
        }
        Ok(())
    }
    pub fn finish(self) -> Result<(Vec<Usage>, Option<String>)> {
        if !self.terminal
            || !self.buffer.iter().all(u8::is_ascii_whitespace)
            || self.provider_id.is_none()
        {
            return Err(ProxyError::UsageUnknown);
        }
        let usage = normalize_usage(
            self.endpoint,
            &self.profile,
            self.usage.as_ref().ok_or(ProxyError::UsageUnknown)?,
        )?;
        Ok((usage, self.provider_id))
    }
}
