//! Bounded shadow meters. Payload bytes are never rewritten or persisted.
use super::*;
use crate::proxy::{CacheMode, Endpoint, ModelProfile};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
fn depth(value: &Value, n: usize) -> Result<()> {
    ensure!(n <= 64, "JSON nesting limit");
    match value {
        Value::Array(v) => {
            for v in v {
                depth(v, n + 1)?
            }
        }
        Value::Object(v) => {
            for v in v.values() {
                depth(v, n + 1)?
            }
        }
        _ => {}
    }
    Ok(())
}
fn parse(raw: &[u8], limit: usize) -> Result<Value> {
    let value = crate::proxy::parse_json(raw, limit)?;
    depth(&value, 0)?;
    Ok(value)
}
fn private_handles(v: &Value) -> bool {
    match v {
        Value::Object(m) => {
            m.get("type").and_then(Value::as_str) == Some("item_reference")
                || m.iter().any(|(k, v)| {
                    matches!(
                        k.as_str(),
                        "previous_response_id"
                            | "conversation"
                            | "file_id"
                            | "vector_store_ids"
                            | "container_id"
                    ) || k == "container" && !v.is_null()
                        || private_handles(v)
                })
        }
        Value::Array(v) => v.iter().any(private_handles),
        _ => false,
    }
}
pub(super) fn validate_request(api: &ApiBindingV2, body: &[u8]) -> Result<()> {
    if api.meter.adapter.id == "fixed_http" {
        return Ok(());
    }
    validate_config(api)?;
    let value = parse(body, number(&api.limits.parser_bytes)?)?;
    ensure!(value.is_object(), "LLM object required");
    let resource = api.meter.resource.as_ref().context("LLM resource")?;
    ensure!(
        value["model"].as_str() == Some(resource.model.as_str()),
        "LLM model selection"
    );
    ensure!(
        !private_handles(&value),
        "provider private resources unsupported"
    );
    let config: &Value = &api.meter.config;
    let maximum = wire::uint(
        config["output_max_tokens"]
            .as_str()
            .context("output maximum")?,
    )?;
    let openai = api.meter.adapter.id == "openai_responses";
    let output = if openai {
        "max_output_tokens"
    } else {
        "max_tokens"
    };
    if let Some(limit) = value.get(output) {
        ensure!(
            limit.as_u64().is_some_and(|n| n > 0 && n <= maximum),
            "output limit"
        );
    }
    let default_tier = "auto";
    ensure!(
        value
            .get("service_tier")
            .map(|v| v.as_str())
            .unwrap_or(Some(default_tier))
            == config["service_tier"].as_str(),
        "service tier"
    );
    if openai {
        ensure!(
            value.get("store") == Some(&Value::Bool(false))
                && value
                    .get("background")
                    .is_none_or(|v| v == &Value::Bool(false))
                && value.get("prompt").is_none_or(Value::is_null),
            "stateless Responses required"
        );
    }
    if config["extra_cost_policy"] == "reject_unclassified" {
        if let Some(tools) = value.get("tools") {
            for tool in tools.as_array().context("tools")? {
                let kind = tool.get("type").and_then(Value::as_str);
                ensure!(
                    if openai {
                        matches!(kind, Some("function" | "custom"))
                    } else {
                        kind.is_none() || matches!(kind, Some("custom"))
                    },
                    "unpriced hosted tool"
                );
            }
        }
        ensure!(
            value
                .get("modalities")
                .is_none_or(|v| v == &serde_json::json!(["text"]))
                && value.get("audio").is_none(),
            "unpriced media"
        );
    }
    Ok(())
}
fn profile(api: &ApiBindingV2) -> Result<ModelProfile> {
    let resource = api.meter.resource.as_ref().context("meter resource")?;
    Ok(ModelProfile {
        provider: if resource.provider == "openai" {
            wire::Provider::Openai
        } else {
            wire::Provider::Anthropic
        },
        model: resource.model.clone(),
        endpoints: vec![],
        context_tokens: wire::uint(
            api.meter.config["context_max_tokens"]
                .as_str()
                .context("context maximum")?,
        )?,
        max_output_tokens: wire::uint(
            api.meter.config["output_max_tokens"]
                .as_str()
                .context("output maximum")?,
        )?,
        cache_mode: if resource.provider == "openai" {
            CacheMode::InclusiveRead
        } else {
            CacheMode::AnthropicSplit
        },
    })
}
pub(super) fn validate_config(api: &ApiBindingV2) -> Result<()> {
    if api.meter.adapter.id == "fixed_http" {
        return Ok(());
    }
    let tier = api.meter.config["service_tier"]
        .as_str()
        .context("request tier")?;
    ensure!(
        if api.meter.adapter.id == "openai_responses" {
            matches!(tier, "auto" | "default" | "flex" | "priority")
        } else {
            matches!(tier, "auto" | "standard_only")
        },
        "unsupported pinned request tier"
    );
    ensure!(
        tier != "auto" || api.meter.config["extra_cost_policy"] == "operator_absorbs_unpriced",
        "automatic tier exposure requires operator absorption"
    );
    Ok(())
}
fn observed_tier(api: &ApiBindingV2, tier: &str) -> bool {
    match (
        api.meter.adapter.id.as_str(),
        api.meter.config["service_tier"].as_str(),
    ) {
        ("openai_responses", Some("auto")) => {
            matches!(tier, "default" | "flex" | "priority" | "scale")
        }
        ("anthropic_messages", Some("auto")) => matches!(tier, "standard" | "priority"),
        ("anthropic_messages", Some("standard_only")) => tier == "standard",
        (_, Some(selected)) => tier == selected,
        _ => false,
    }
}
fn resource_evidence(api: &ApiBindingV2, value: &Value) -> Result<()> {
    if let Some(model) = value.get("model") {
        ensure!(
            model.as_str() == api.meter.resource.as_ref().map(|r| r.model.as_str()),
            "observed model mismatch"
        );
    }
    if let Some(tier) = value.get("service_tier") {
        ensure!(
            tier.as_str().is_some_and(|t| observed_tier(api, t)),
            "observed service tier mismatch"
        );
    }
    Ok(())
}
fn normalized(api: &ApiBindingV2, value: &Value) -> Result<Vec<Usage>> {
    let mut value = value.clone();
    let openai = api.meter.adapter.id == "openai_responses";
    if !openai && api.meter.config["extra_cost_policy"] == "operator_absorbs_unpriced" {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("server_tool_use");
            obj.remove("inference_geo");
        }
    }
    if !openai {
        if let Some(tier) = value.get("service_tier") {
            ensure!(
                tier.as_str().is_some_and(|t| observed_tier(api, t)),
                "observed service tier"
            );
        }
        value
            .as_object_mut()
            .context("usage object")?
            .remove("service_tier");
    }
    Ok(crate::proxy::normalize_usage(
        if openai {
            Endpoint::Responses
        } else {
            Endpoint::Messages
        },
        &profile(api)?,
        &value,
    )?)
}
fn nondecreasing(previous: &Value, next: &Value) -> Result<()> {
    if let Some(old) = previous.as_u64() {
        ensure!(
            next.as_u64().is_some_and(|new| new >= old),
            "decreasing usage"
        );
    } else if let Some(old) = previous.as_object() {
        let new = next.as_object().context("usage object changed type")?;
        // The caller replaces this cumulative object; omission must not erase
        // an observed counter before a later snapshot reintroduces it at zero.
        for (key, previous) in old {
            nondecreasing(previous, new.get(key).context("usage counter disappeared")?)?;
        }
    }
    Ok(())
}
fn output_details(usage: &Value) -> Result<()> {
    if let Some(details) = usage.get("output_tokens_details").filter(|v| !v.is_null()) {
        let details = details.as_object().context("output details")?;
        let thinking = details
            .get("thinking_tokens")
            .and_then(Value::as_u64)
            .context("thinking tokens")?;
        let output = usage["output_tokens"].as_u64().context("output tokens")?;
        ensure!(
            details.len() == 1 && thinking <= output && output <= i64::MAX as u64,
            "invalid output details"
        );
    }
    Ok(())
}
struct Meter<'a> {
    api: &'a ApiBindingV2,
    sse: bool,
    buffer: Vec<u8>,
    usage: Option<Value>,
    terminal: bool,
    started: bool,
    output: bool,
    terminal_kind: Option<String>,
}
pub(super) struct Measured {
    pub usage: Vec<Usage>,
    pub succeeded: bool,
}
impl<'a> Meter<'a> {
    fn new(api: &'a ApiBindingV2, sse: bool) -> Self {
        Self {
            api,
            sse,
            buffer: vec![],
            usage: None,
            terminal: false,
            started: false,
            output: false,
            terminal_kind: None,
        }
    }
    fn push(&mut self, bytes: &[u8]) -> Result<()> {
        let limit = number(&self.api.limits.parser_bytes)?;
        for byte in bytes {
            self.buffer.push(*byte);
            ensure!(self.buffer.len() <= limit, "shadow parser limit");
            if self.sse && (self.buffer.ends_with(b"\n\n") || self.buffer.ends_with(b"\r\n\r\n")) {
                let frame = std::mem::take(&mut self.buffer);
                let text = std::str::from_utf8(&frame)?;
                let data = text
                    .lines()
                    .filter_map(|l| {
                        l.strip_prefix("data:")
                            .map(|v| v.strip_prefix(' ').unwrap_or(v))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !data.is_empty() {
                    let value = parse(data.as_bytes(), limit)?;
                    self.event(&value)?;
                }
            }
        }
        Ok(())
    }
    fn final_usage(&mut self, usage: &Value, terminal_kind: &str) -> Result<()> {
        normalized(self.api, usage)?;
        ensure!(
            self.usage.as_ref().is_none_or(|old| old == usage)
                && self
                    .terminal_kind
                    .as_deref()
                    .is_none_or(|old| old == terminal_kind),
            "conflicting final usage"
        );
        self.usage = Some(usage.clone());
        self.terminal_kind = Some(terminal_kind.into());
        self.terminal = true;
        Ok(())
    }
    fn event(&mut self, event: &Value) -> Result<()> {
        let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
        if self.api.meter.adapter.id == "openai_responses" {
            if matches!(
                ty,
                "response.completed" | "response.incomplete" | "response.failed"
            ) {
                let response = event.get("response").context("terminal response")?;
                resource_evidence(self.api, response)?;
                if let Some(status) = response.get("status") {
                    ensure!(
                        status.as_str() == ty.strip_prefix("response."),
                        "terminal event/status mismatch"
                    );
                }
                self.final_usage(response.get("usage").context("terminal usage")?, ty)?;
            } else if ty == "error" {
                anyhow::bail!("unknown provider usage");
            }
        } else {
            match ty {
                "message_start" => {
                    ensure!(!self.started && !self.terminal, "duplicate message start");
                    resource_evidence(self.api, &event["message"])?;
                    output_details(&event["message"]["usage"])?;
                    self.usage = Some(event["message"]["usage"].clone());
                    self.started = true;
                }
                "message_delta" => {
                    ensure!(self.started && !self.terminal, "message delta order");
                    if let Some(reason) = event["delta"].get("stop_reason").filter(|v| !v.is_null())
                    {
                        let reason = reason.as_str().context("message stop reason")?;
                        ensure!(
                            self.terminal_kind
                                .as_deref()
                                .is_none_or(|old| old == reason),
                            "conflicting stop reason"
                        );
                        self.terminal_kind = Some(reason.into());
                    }
                    let delta = event["usage"].as_object().context("delta usage")?;
                    let usage = self
                        .usage
                        .as_mut()
                        .and_then(Value::as_object_mut)
                        .context("start usage")?;
                    for (key, value) in delta {
                        if value.is_null() {
                            continue;
                        }
                        if let Some(old) = usage.get(key) {
                            nondecreasing(old, value)?;
                        }
                        if key == "output_tokens" {
                            self.output = true;
                        }
                        usage.insert(key.clone(), value.clone());
                    }
                    output_details(self.usage.as_ref().context("usage")?)?;
                }
                "message_stop" => {
                    ensure!(self.started && self.output, "terminal usage missing");
                    normalized(self.api, self.usage.as_ref().context("usage")?)?;
                    self.terminal = true;
                }
                "error" => anyhow::bail!("unknown provider usage"),
                _ => {}
            }
        }
        Ok(())
    }
    fn finish(mut self) -> Result<Measured> {
        if self.sse {
            ensure!(
                self.buffer.iter().all(u8::is_ascii_whitespace) && self.terminal,
                "missing terminal usage"
            );
        } else {
            let value = parse(&self.buffer, number(&self.api.limits.parser_bytes)?)?;
            resource_evidence(self.api, &value)?;
            if self.api.meter.adapter.id == "openai_responses" {
                ensure!(
                    matches!(
                        value["status"].as_str(),
                        Some("completed" | "incomplete" | "failed")
                    ),
                    "response terminal status"
                );
                self.terminal_kind =
                    Some(format!("response.{}", value["status"].as_str().unwrap()));
            } else {
                ensure!(
                    value["type"] == "message" && !value["stop_reason"].is_null(),
                    "message terminal"
                );
                self.terminal_kind = Some(
                    value["stop_reason"]
                        .as_str()
                        .context("message stop reason")?
                        .into(),
                );
            }
            self.usage = Some(value.get("usage").context("final usage")?.clone());
        }
        Ok(Measured {
            usage: normalized(self.api, self.usage.as_ref().context("usage")?)?,
            // Accounting can be complete even when generation failed or was
            // interrupted. Only successful terminal outcomes permit automatic
            // progress to another invocation; measured usage is still billed.
            succeeded: if self.api.meter.adapter.id == "openai_responses" {
                self.terminal_kind.as_deref() == Some("response.completed")
            } else {
                matches!(
                    self.terminal_kind.as_deref(),
                    Some("end_turn" | "stop_sequence" | "tool_use")
                )
            },
        })
    }
}
async fn read_meter<R: AsyncRead + Unpin>(
    reader: &mut R,
    api: &ApiBindingV2,
    sse: bool,
    raw: &AtomicUsize,
) -> Result<Measured> {
    let mut meter = Meter::new(api, sse);
    let mut decoded = 0usize;
    let mut bytes = vec![0; 8192.min(number(&api.limits.relay_buffer_bytes)?)];
    loop {
        let count = reader.read(&mut bytes).await?;
        if count == 0 {
            break;
        }
        decoded = decoded.checked_add(count).context("decoded size")?;
        ensure!(
            decoded <= number(&api.limits.decoded_response_bytes)?
                && decoded
                    <= raw
                        .load(Ordering::Relaxed)
                        .max(1)
                        .saturating_mul(number(&api.limits.decode_ratio)?),
            "decoded response bound"
        );
        meter.push(&bytes[..count])?;
    }
    meter.finish()
}
pub(super) async fn observe<R: AsyncRead + Unpin>(
    reader: R,
    api: &ApiBindingV2,
    encoding: &str,
    sse: bool,
    raw: Arc<AtomicUsize>,
) -> Result<Measured> {
    use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
    let reader = BufReader::new(reader);
    macro_rules! decode {
        ($kind:ident) => {{
            let mut decoder = $kind::new(reader);
            let usage = read_meter(&mut decoder, api, sse, &raw).await?;
            let mut reader = decoder.into_inner();
            let mut extra = [0];
            ensure!(
                reader.read(&mut extra).await? == 0,
                "trailing compressed bytes"
            );
            Ok(usage)
        }};
    }
    match encoding {
        "gzip" => decode!(GzipDecoder),
        "deflate" => decode!(ZlibDecoder),
        "br" => decode!(BrotliDecoder),
        "identity" => {
            let mut reader = reader;
            read_meter(&mut reader, api, sse, &raw).await
        }
        _ => anyhow::bail!("unsupported response encoding"),
    }
}
