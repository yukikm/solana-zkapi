//! Bounded, secret-free HTTP-attempt counters. No network, retries or billing.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

static INSTANCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
pub enum Component {
    Archive,
    ControlPrimary,
    ControlSecondary,
    Readiness,
    Monitoring,
    StateSync,
}
impl Component {
    fn label(self) -> &'static str {
        match self {
            Self::Archive => "archive",
            Self::ControlPrimary => "control_primary",
            Self::ControlSecondary => "control_secondary",
            Self::Readiness => "readiness",
            Self::Monitoring => "monitoring",
            Self::StateSync => "state_sync",
        }
    }
}

struct State {
    started: Instant,
    reported: Instant,
    counts: BTreeMap<&'static str, u64>,
    response_bytes: u64,
}
struct Inner {
    component: Component,
    instance: u64,
    state: Mutex<State>,
}

/// Clones share counters. Each record means an HTTP send was attempted, even
/// if transport fails or the caller cancels. Provider-billed credits may differ.
#[derive(Clone)]
pub struct RpcUsage(Arc<Inner>);
impl RpcUsage {
    pub fn new(component: Component) -> Self {
        let now = Instant::now();
        Self(Arc::new(Inner {
            component,
            instance: INSTANCE.fetch_add(1, Ordering::Relaxed),
            state: Mutex::new(State {
                started: now,
                reported: now,
                counts: BTreeMap::new(),
                response_bytes: 0,
            }),
        }))
    }
    fn label(method: &str, full_block: bool) -> &'static str {
        match method {
            "getBlock" if full_block => "getBlock_full",
            "getBlock" => "getBlock_anchor",
            "getBlocks" => "getBlocks",
            "getSlot" => "getSlot",
            "getGenesisHash" => "getGenesisHash",
            "getMultipleAccounts" => "getMultipleAccounts",
            "getAccountInfo" => "getAccountInfo",
            "getBalance" => "getBalance",
            _ => "other",
        }
    }
    pub fn record(&self, method: &str, full_block: bool) {
        self.record_at(method, full_block, Instant::now());
    }
    pub fn record_response_bytes(&self, bytes: usize) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.response_bytes = state.response_bytes.saturating_add(bytes as u64);
    }
    fn record_at(&self, method: &str, full_block: bool, now: Instant) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let count = state
            .counts
            .entry(Self::label(method, full_block))
            .or_default();
        *count = count.saturating_add(1);
        if now.duration_since(state.reported) >= Duration::from_secs(60) {
            // Only fixed labels and numeric counts enter this diagnostic.
            // Diagnostic output must not fail a chain read if stderr is closed.
            let _ = writeln!(std::io::stderr().lock(), "{}", self.value(&state, now));
            state.reported = now;
        }
    }
    fn value(&self, state: &State, now: Instant) -> Value {
        json!({"event":"rpc_usage", "version":1,
            "component":self.0.component.label(), "pid":std::process::id(),
            "instance":self.0.instance,
            "elapsed_ms":now.duration_since(state.started).as_millis().min(u64::MAX as u128) as u64,
            "attempts":state.counts, "response_bytes":state.response_bytes})
    }
    pub fn snapshot(&self) -> Value {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        self.value(&state, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clones_count_every_attempt_without_caller_controlled_labels() {
        let usage = RpcUsage::new(Component::Archive);
        let clone = usage.clone();
        usage.record("getBlock", true);
        clone.record("getBlock", false);
        clone.record("https://private.example/API_KEY", false);
        let sample = usage.snapshot();
        assert_eq!(
            sample["attempts"],
            json!({"getBlock_full":1,"getBlock_anchor":1,"other":1})
        );
        assert!(!sample.to_string().contains("API_KEY"));
        assert_eq!(sample["instance"], clone.snapshot()["instance"]);
        assert_ne!(
            sample["instance"],
            RpcUsage::new(Component::Archive).snapshot()["instance"]
        );
    }
    #[test]
    fn reporting_is_bounded_and_never_resets_total_counts() {
        let usage = RpcUsage::new(Component::ControlPrimary);
        let start = usage.0.state.lock().unwrap().started;
        for _ in 0..100 {
            usage.record_at("getAccountInfo", false, start + Duration::from_secs(59));
        }
        assert_eq!(usage.0.state.lock().unwrap().reported, start);
        usage.record_at("getAccountInfo", false, start + Duration::from_secs(60));
        assert_eq!(usage.0.state.lock().unwrap().counts["getAccountInfo"], 101);
        assert_eq!(
            usage.0.state.lock().unwrap().reported,
            start + Duration::from_secs(60)
        );
    }
}
