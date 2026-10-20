use super::*;
use serde_json::json;
use std::{future::Future, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone)]
pub struct StateRpc {
    client: reqwest::Client,
    url: String,
    limit: usize,
    cooldown: Arc<Mutex<tokio::time::Instant>>,
    permits: Arc<Semaphore>,
    usage: zkapi_rpc_metrics::RpcUsage,
}
impl StateRpc {
    pub fn new(url: String, limit: usize) -> Result<Self> {
        let parsed = reqwest::Url::parse(&url)?;
        if !(1..=16 * 1024 * 1024).contains(&limit)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || !(parsed.scheme() == "https"
                || (parsed.scheme() == "http"
                    && parsed.host_str().is_some_and(|s| {
                        s.trim_matches(['[', ']'])
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                    })))
        {
            return Err("current-state RPC configuration".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url,
            limit,
            cooldown: Arc::new(Mutex::new(tokio::time::Instant::now())),
            permits: Arc::new(Semaphore::new(4)),
            usage: zkapi_rpc_metrics::RpcUsage::new(zkapi_rpc_metrics::Component::StateSync),
        })
    }
    pub fn usage(&self) -> Value {
        self.usage.snapshot()
    }
    pub async fn call(&self, method: &'static str, params: Value) -> Result<Value> {
        // Enforce this even if a future caller accidentally reaches for history.
        if !matches!(
            method,
            "getMultipleAccounts" | "getGenesisHash" | "getBlock"
        ) || (method == "getBlock"
            && (params.as_array().is_none_or(|p| p.len() != 2)
                || params[0].as_u64().is_none()
                || params[1]["commitment"] != "finalized"
                || params[1]["transactionDetails"] != "none"
                || params[1]["rewards"] != false
                || params[1]["maxSupportedTransactionVersion"] != 1))
        {
            return Err("history RPC prohibited in current-state reader".into());
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            let _permit = self
                .permits
                .acquire()
                .await
                .map_err(|_| "state RPC concurrency unavailable")?;
            loop {
                let until = *self.cooldown.lock().await;
                if until <= tokio::time::Instant::now() {
                    break;
                }
                tokio::time::sleep_until(until).await;
                // Another in-flight call may have extended Retry-After while
                // this caller was asleep. Every clone shares the latest fence.
            }
            self.usage.record(method, false);
            let mut response = self
                .client
                .post(&self.url)
                .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
                .send()
                .await
                .map_err(|_| "state RPC transport")?;
            if response.status().as_u16() == 429 {
                let delay = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(10)
                    .clamp(1, 60);
                let jitter = super::service::monotonic_ms()? % 251;
                let until =
                    tokio::time::Instant::now() + Duration::from_millis(delay * 1000 + jitter);
                let mut old = self.cooldown.lock().await;
                *old = (*old).max(until);
                return Err("state RPC rate limited".into());
            }
            if !response.status().is_success() {
                return Err("state RPC HTTP failure".into());
            }
            if response
                .content_length()
                .is_some_and(|n| n > self.limit as u64)
            {
                return Err("state RPC response limit".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "state RPC body")? {
                self.usage.record_response_bytes(chunk.len());
                if body.len().saturating_add(chunk.len()) > self.limit {
                    return Err("state RPC response limit".into());
                }
                body.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&body).map_err(|_| "state RPC JSON")?;
            if value["jsonrpc"] != "2.0" || value["id"] != 1 || value.get("error").is_some() {
                return Err("state RPC envelope".into());
            }
            value
                .get("result")
                .filter(|v| !v.is_null())
                .cloned()
                .ok_or("state RPC result".into())
        })
        .await
        .map_err(|_| "state RPC deadline")?
    }
    async fn batch(
        &self,
        trusted: &TrustedPool,
        first_id: u32,
        pairs: u32,
        minimum: u64,
    ) -> Result<Batch> {
        let value = self
            .call(
                "getMultipleAccounts",
                json!([addresses(trusted, first_id, pairs)?,
            {"encoding":"base64","commitment":"finalized","minContextSlot":minimum}]),
            )
            .await?;
        let slot = value["context"]["slot"].as_u64().ok_or("account context")?;
        if slot < minimum {
            return Err("old account context".into());
        }
        Ok(Batch {
            slot,
            first_id,
            pairs,
            values: value["value"].as_array().ok_or("account list")?.clone(),
        })
    }
    async fn capture_once(
        &self,
        trusted: &TrustedPool,
        deployment: Bytes32,
        settings: &Settings,
        minimum: u64,
    ) -> Result<VerifiedPoolState> {
        let started_ms = service::monotonic_ms()?;
        let first = self
            .batch(trusted, 0, settings.max_note_ids.min(48), minimum)
            .await?;
        let (_, tree) = base(trusted, &first)?;
        let n = u64_at(&tree, 42)?;
        if n > settings.max_note_ids as u64 {
            return Err("unsupported note capacity".into());
        }
        let mut batches = vec![first];
        let mut capture_bytes = encoded_len(&batches[0], MAX_CAPTURE)?;
        let mut next = settings.max_note_ids.min(48);
        while u64::from(next) < n {
            let mut tasks = tokio::task::JoinSet::new();
            for _ in 0..settings.rpc_concurrency {
                if u64::from(next) >= n {
                    break;
                }
                let count = (n as u32 - next).min(48);
                let (rpc, trust, id, min) = (self.clone(), trusted.clone(), next, batches[0].slot);
                tasks.spawn(async move { rpc.batch(&trust, id, count, min).await });
                next += count;
            }
            while let Some(batch) = tasks.join_next().await {
                let batch = batch??;
                capture_bytes = capture_bytes
                    .checked_add(encoded_len(&batch, MAX_CAPTURE)?)
                    .filter(|size| *size <= MAX_CAPTURE)
                    .ok_or("capture size limit")?;
                batches.push(batch);
            }
        }
        batches.sort_by_key(|b| b.first_id);
        let slot = batches
            .iter()
            .map(|b| b.slot)
            .max()
            .ok_or("empty capture")?;
        // Reject a changed sequence before spending a header call.
        for b in &batches {
            if base(trusted, b)?.1 != tree {
                return Err("financial state changed during capture".into());
            }
        }
        let block = self
            .call(
                "getBlock",
                json!([slot, {"commitment":"finalized",
            "transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":1}]),
            )
            .await?;
        let mut capture = Capture {
            schema: 1,
            policy: POLICY.into(),
            deployment,
            boot: service::boot_id()?,
            started_ms,
            batches,
            header: Header {
                slot,
                blockhash: key(block["blockhash"].as_str().ok_or("header hash")?)?,
                block_time: block["blockTime"].as_u64().ok_or("header time")?,
            },
            digest: [0; 32],
        };
        capture.digest = capture.digest()?;
        verify(
            trusted,
            deployment,
            settings,
            capture,
            service::wall_time(),
            30_000,
        )
    }
    pub async fn capture(
        &self,
        trusted: &TrustedPool,
        deployment: Bytes32,
        settings: &Settings,
        minimum: u64,
    ) -> Result<VerifiedPoolState> {
        self.capture_with_failure(trusted, deployment, settings, minimum, || async {})
            .await
    }

    /// Notify the acquisition owner before retrying a failed attempt, so its
    /// previously published view cannot remain ready during retry/backoff.
    pub async fn capture_with_failure<F, Fut>(
        &self,
        trusted: &TrustedPool,
        deployment: Bytes32,
        settings: &Settings,
        minimum: u64,
        on_failure: F,
    ) -> Result<VerifiedPoolState>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = ()>,
    {
        settings.validate()?;
        tokio::time::timeout(Duration::from_secs(30), async {
            for attempt in 0..3 {
                match tokio::time::timeout(
                    Duration::from_secs(25),
                    self.capture_once(trusted, deployment, settings, minimum),
                )
                .await
                {
                    Ok(Ok(state)) => return Ok(state),
                    // Inconsistent captures may be caused by concurrent writes. Bounded
                    // retry re-reads everything; a prior successful view is never returned.
                    _ => {
                        on_failure().await;
                        if attempt == 2 {
                            return Err("current account capture unavailable".into());
                        }
                        let jitter = service::monotonic_ms()? % 251;
                        tokio::time::sleep(Duration::from_millis((250 << attempt) + jitter)).await;
                    }
                }
            }
            unreachable!()
        })
        .await
        .map_err(|_| "current account refresh deadline")?
    }
}
