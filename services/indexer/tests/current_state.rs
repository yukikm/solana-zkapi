#[path = "support/current.rs"]
mod support;
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use support::*;
use zkapi_indexer::{
    current_state::{self as cs, service, StateRpc},
    runtime::{ArchiveRpc, Config as LegacyConfig},
    snapshot::ReadView,
};

fn verified(f: &Fixture, c: cs::Capture) -> cs::Result<cs::VerifiedPoolState> {
    let dir = tempfile::tempdir().unwrap();
    cs::verify(
        &f.trusted,
        f.deployment(),
        &f.settings(dir.path()),
        c,
        f.time,
        30_000,
    )
}
#[test]
fn real_sbf_account_cuts_equal_full_replay_without_history_input() {
    for (scenario, cut) in [
        ("close", "deposit"),
        ("close", "mutual_close"),
        ("challenge", "deposit-2"),
        ("challenge", "initiate_escape"),
        ("challenge", "challenge_escape"),
        ("finalize", "initiate_escape"),
        ("finalize", "finalize_escape"),
        ("expiry", "claim_expired"),
    ] {
        let f = Fixture::load(scenario, cut);
        let s = verified(&f, f.capture(4096)).unwrap();
        assert_eq!(s.chain(), &f.expected, "{scenario}/{cut}");
        let view = ReadView::from_current(&s);
        for id in 0..f.expected.next_note_id as u32 {
            if !f.expected.active.contains_key(&id) && !f.expected.pending.contains_key(&id) {
                continue;
            }
            let path = if f.expected.active.contains_key(&id) {
                view.path(id)
            } else {
                view.zero_path(id)
            }
            .unwrap();
            assert_eq!(path.snapshot.root, view.root().unwrap().root);
        }
    }
}
#[test]
fn completeness_metadata_clock_and_root_are_checked_independently() {
    let f = Fixture::load("challenge", "initiate_escape");
    for case in 0..10 {
        let mut c = f.capture(4096);
        match case {
            0 => c.batches[0].values[5] = Value::Null, // Pending has zero leaf, root unchanged.
            1 => c.batches[0].values[4] = Value::Null,
            2 => c.batches[0].values[4]["owner"] = json!(b58([8; 32])),
            3 => {
                let mut b = bytes(&c.batches[0].values[4]);
                b[10] ^= 1;
                replace(&mut c.batches[0].values[4], b);
            }
            4 => {
                let mut b = bytes(&c.batches[0].values[1]);
                b[58] ^= 1;
                replace(&mut c.batches[0].values[1], b);
            }
            5 => {
                let mut b = bytes(&c.batches[0].values[2]);
                b[64..72].copy_from_slice(&0u64.to_le_bytes());
                replace(&mut c.batches[0].values[2], b);
            }
            6 => c.header.block_time += 1,
            7 => c.batches[0].values[8] = c.batches[0].values[4].clone(), // unallocated lookahead
            8 => c.boot = [42; 32],
            9 => c.started_ms = service::monotonic_ms().unwrap().saturating_sub(31_000),
            _ => unreachable!(),
        }
        c.digest = c.digest().unwrap();
        assert!(verified(&f, c).is_err(), "mutation {case}");
    }
}
#[test]
fn empty_pool_and_unchanged_root_finalize_do_not_require_events() {
    let f = Fixture::load("finalize", "initiate_escape");
    let g = Fixture::load("finalize", "finalize_escape");
    let a = verified(&f, f.capture(4096)).unwrap();
    let b = verified(&g, g.capture(4096)).unwrap();
    assert_eq!(a.chain().root, b.chain().root);
    assert!(b.chain().sequence > a.chain().sequence);
    assert!(b.chain().pending.is_empty() && b.follows(&a));
    let mut c = g.capture(4096);
    let mut tree = bytes(&c.batches[0].values[1]);
    tree[42..66].fill(0);
    replace(&mut c.batches[0].values[1], tree);
    for v in &mut c.batches[0].values[4..] {
        *v = Value::Null;
    }
    c.digest = c.digest().unwrap();
    assert_eq!(verified(&g, c).unwrap().chain().next_note_id, 0);
}
#[test]
fn immutable_pool_and_all_financial_records_must_follow_the_previous_view() {
    let f = Fixture::load("finalize", "finalize_escape");
    let original = verified(&f, f.capture(4096)).unwrap();
    for case in 0..4 {
        let mut c = f.capture(4096);
        match case {
            0 => {
                // Closed Notes are absent from both maps and have zero leaves.
                let mut note = bytes(&c.batches[0].values[4]);
                assert_eq!(note[62], 3);
                let expiry = u64::from_le_bytes(note[54..62].try_into().unwrap());
                note[54..62].copy_from_slice(&(expiry + 1).to_le_bytes());
                replace(&mut c.batches[0].values[4], note);
            }
            1 => {
                // A retained record is absent from the live Pending map.
                let mut pending = bytes(&c.batches[0].values[5]);
                assert_eq!(pending[10], 0);
                let deadline = u64::from_le_bytes(pending[115..123].try_into().unwrap());
                pending[115..123].copy_from_slice(&(deadline + 1).to_le_bytes());
                replace(&mut c.batches[0].values[5], pending);
            }
            2 => {
                let mut pool = bytes(&c.batches[0].values[0]);
                pool[139..171].fill(9); // Admin cannot change in the pinned program.
                replace(&mut c.batches[0].values[0], pool);
                let mut tree = bytes(&c.batches[0].values[1]);
                let sequence = u64::from_le_bytes(tree[50..58].try_into().unwrap());
                tree[50..58].copy_from_slice(&(sequence + 1).to_le_bytes());
                replace(&mut c.batches[0].values[1], tree);
            }
            3 => {
                // Pause/treasury remain current and can change without sequence.
                let mut pool = bytes(&c.batches[0].values[0]);
                pool[171..203].fill(9);
                pool[355] = 1;
                replace(&mut c.batches[0].values[0], pool);
            }
            _ => unreachable!(),
        }
        c.batches[0].slot += 1;
        c.header.slot += 1;
        let mut clock = bytes(&c.batches[0].values[3]);
        clock[..8].copy_from_slice(&c.header.slot.to_le_bytes());
        replace(&mut c.batches[0].values[3], clock);
        c.digest = c.digest().unwrap();
        let next = verified(&f, c).unwrap();
        assert_eq!(next.follows(&original), case == 3, "mutation {case}");
    }
}
#[test]
fn default_roles_and_malformed_retained_pending_are_rejected() {
    let f = Fixture::load("finalize", "finalize_escape");
    for case in 0..4 {
        let mut c = f.capture(4096);
        let (index, range) = match case {
            0 => (0, 139..171),
            1 => (0, 171..203),
            2 => (5, 83..115),
            3 => (5, 115..123),
            _ => unreachable!(),
        };
        let mut raw = bytes(&c.batches[0].values[index]);
        raw[range].fill(0);
        replace(&mut c.batches[0].values[index], raw);
        c.digest = c.digest().unwrap();
        assert!(verified(&f, c).is_err(), "mutation {case}");
    }
}
#[test]
fn oversized_capture_is_rejected_before_digest_copies_evidence() {
    let f = Fixture::load("close", "mutual_close");
    let mut c = f.capture(4096);
    c.batches[0].values[0]["unexpected"] = json!("x".repeat(cs::MAX_CAPTURE));
    assert!(c.digest().is_err());
    assert!(verified(&f, c).is_err());
}
#[tokio::test]
async fn aggregate_capture_limit_stops_acquisition_before_the_header() {
    let mut f = Fixture::load("close", "mutual_close");
    f.wall_now();
    let keys = cs::addresses(&f.trusted, 0, 1).unwrap();
    let mut tree = bytes(&f.accounts[&keys[1]]);
    tree[42..50].copy_from_slice(&97u64.to_le_bytes());
    replace(&mut f.accounts[&keys[1]], tree);
    let template = f.accounts[&keys[4]].clone();
    let program = solana_pubkey::Pubkey::new_from_array(key(&f.trusted.program_id));
    for id in 0..97u32 {
        let address = cs::addresses(&f.trusted, id, 1).unwrap()[4].clone();
        let mut value = template.clone();
        let mut note = bytes(&value);
        assert_eq!(note[62], 3);
        note[9] = solana_pubkey::Pubkey::find_program_address(
            &[b"note", &key(&f.trusted.pool), &id.to_le_bytes()],
            &program,
        )
        .1;
        note[10..14].copy_from_slice(&id.to_le_bytes());
        replace(&mut value, note);
        f.accounts[&address] = value;
    }
    // Each valid account response fits the 16 MiB response bound, but retaining
    // all three would exceed the 32 MiB complete capture/cache bound.
    f.accounts[&keys[0]]["additionalMetadata"] = json!("x".repeat(12 * 1024 * 1024));
    let handler = f.clone();
    let m = mock(move |q| success(&q, handler.rpc_result(&q))).await;
    let rpc = StateRpc::new(m.url.clone(), 16 * 1024 * 1024).unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert!(rpc
        .capture(&f.trusted, f.deployment(), &f.settings(dir.path()), 0)
        .await
        .is_err());
    let calls = m.calls.lock().unwrap();
    assert_eq!(calls.len(), 9, "three bounded attempts of three batches");
    assert!(calls.iter().all(|q| q["method"] == "getMultipleAccounts"));
}
#[test]
fn stable_multi_batch_capture_checks_every_id_and_mutable_maximum_slot() {
    let f = Fixture::load("close", "mutual_close");
    let mut c = f.capture(4096);
    let program = solana_pubkey::Pubkey::new_from_array(key(&f.trusted.program_id));
    let mut template = bytes(&c.batches[0].values[4]);
    let mut tree = bytes(&c.batches[0].values[1]);
    tree[42..50].copy_from_slice(&49u64.to_le_bytes());
    replace(&mut c.batches[0].values[1], tree);
    let mut fill = |id: u32| {
        template[9] = solana_pubkey::Pubkey::find_program_address(
            &[b"note", &key(&f.trusted.pool), &id.to_le_bytes()],
            &program,
        )
        .1;
        template[10..14].copy_from_slice(&id.to_le_bytes());
        let mut value = f.accounts[cs::addresses(&f.trusted, 0, 1).unwrap()[4].clone()].clone();
        replace(&mut value, template.clone());
        value
    };
    for id in 0..48 {
        c.batches[0].values[4 + id as usize * 2] = fill(id);
    }
    let mut second = c.batches[0].clone();
    second.first_id = 48;
    second.pairs = 1;
    second.slot += 1;
    second.values.truncate(6);
    second.values[4] = fill(48);
    let mut clock = bytes(&second.values[3]);
    clock[..8].copy_from_slice(&second.slot.to_le_bytes());
    replace(&mut second.values[3], clock);
    let mut pool = bytes(&second.values[0]);
    pool[355] = 1;
    pool[171..203].fill(9);
    replace(&mut second.values[0], pool);
    c.header.slot = second.slot;
    c.batches.push(second);
    c.digest = c.digest().unwrap();
    assert!(verified(&f, c.clone()).unwrap().paused());
    let mut incomplete = c.clone();
    incomplete.batches[1].values[4] = Value::Null;
    incomplete.digest = incomplete.digest().unwrap();
    assert!(verified(&f, incomplete).is_err());
    let mut changed = bytes(&c.batches[1].values[1]);
    changed[50] ^= 1;
    replace(&mut c.batches[1].values[1], changed);
    c.digest = c.digest().unwrap();
    assert!(verified(&f, c).is_err());
}
#[tokio::test]
async fn cold_restart_and_long_downtime_use_two_calls_and_beat_full_reader() {
    let mut f = Fixture::load("challenge", "challenge_escape");
    f.wall_now();
    let handler = f.clone();
    let m = mock(move |q| success(&q, handler.rpc_result(&q))).await;
    let dir = tempfile::tempdir().unwrap();
    for _ in 0..2 {
        let rpc = StateRpc::new(m.url.clone(), 16 * 1024 * 1024).unwrap();
        let state = rpc
            .capture(&f.trusted, f.deployment(), &f.settings(dir.path()), 0)
            .await
            .unwrap();
        assert_eq!(state.chain(), &f.expected);
    }
    let requests = m.calls.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert!(requests
        .iter()
        .all(|q| q["method"] == "getMultipleAccounts" || q["method"] == "getBlock"));
    // Compare actual method calls against the retained full reader on the same
    // financial workload, rather than against an invented block-rate formula.
    let old = f.clone();
    let legacy = mock(move |q| {
        let result = match q["method"].as_str().unwrap() {
            "getSlot" => json!(old.expected.slot),
            "getBlocks" => json!(old
                .blocks
                .iter()
                .filter(|b| b["slot"].as_u64() >= q["params"][0].as_u64()
                    && b["slot"].as_u64() <= q["params"][1].as_u64())
                .map(|b| b["slot"].clone())
                .collect::<Vec<_>>()),
            "getBlock" if q["params"][1]["transactionDetails"] == "full" => old
                .blocks
                .iter()
                .find(|b| b["slot"] == q["params"][0])
                .unwrap()["block"]
                .clone(),
            _ => old.rpc_result(&q),
        };
        success(&q, result)
    })
    .await;
    let cfg = LegacyConfig {
        rpc_url: legacy.url.clone(),
        program_id: f.trusted.program_id.clone(),
        pool: f.trusted.pool.clone(),
        genesis_hash: f.trusted.genesis_hash.clone(),
        circuit_profile_hash: f.trusted.circuit_profile_hash.clone(),
        start_slot: 1,
        listen: String::new(),
        public_origin: String::new(),
        snapshots_directory: dir.path().into(),
        poll_seconds: 10,
    };
    let mut index = zkapi_indexer::Indexer::new(key(&cfg.program_id), key(&cfg.pool));
    ArchiveRpc::new(legacy.url.clone())
        .unwrap()
        .refresh(&cfg, &mut index, &mut 1)
        .await
        .unwrap();
    let old_calls = legacy.calls.lock().unwrap().clone();
    assert!(old_calls.len() > requests.len());
    let cost = |calls: &[Value]| {
        calls
            .iter()
            .map(|q| if q["method"] == "getBlock" { 10 } else { 1 })
            .sum::<u64>()
    };
    assert!(cost(&old_calls) > cost(&requests[..2]));
    println!("same SBF cut: legacy {} calls / {} weighted units, current 2 calls / {} weighted units; restart 2 calls",
        old_calls.len(),cost(&old_calls),cost(&requests[..2]));
    let rpc = StateRpc::new(m.url.clone(), 1024).unwrap();
    assert!(rpc.call("getBlocks", json!([])).await.is_err());
    assert!(rpc
        .call("getBlock", json!([1,{"transactionDetails":"full"}]))
        .await
        .is_err());
    for options in [
        json!({"commitment":"confirmed","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":1}),
        json!({"commitment":"finalized","transactionDetails":"none","rewards":true,"maxSupportedTransactionVersion":1}),
        json!({"commitment":"finalized","transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":2}),
    ] {
        assert!(rpc.call("getBlock", json!([1, options])).await.is_err());
    }
    assert_eq!(m.calls.lock().unwrap().len(), 4);
    // Rate projection uses the tested two-call capture and configured cadence;
    // this is not an observation of a month of public-provider billing.
    let month = 31 * 24 * 60 * 60u64;
    let sync_calls = month / f.settings(dir.path()).poll_idle_seconds * 2 + month / 60;
    assert_eq!(sync_calls, 580_320);
    assert!(sync_calls < 600_000);
}

#[tokio::test]
async fn invalid_captures_retry_at_most_three_times_without_history_or_stale_fallback() {
    let mut f = Fixture::load("challenge", "initiate_escape");
    f.wall_now();
    let shared = Arc::new(Mutex::new(f.clone()));
    let handler = shared.clone();
    let m = mock(move |q| success(&q, handler.lock().unwrap().rpc_result(&q))).await;
    let dir = tempfile::tempdir().unwrap();
    let settings = f.settings(dir.path());
    let rpc = StateRpc::new(m.url.clone(), 16 * 1024 * 1024).unwrap();
    rpc.capture(&f.trusted, f.deployment(), &settings, 0)
        .await
        .unwrap();
    // Remove a live Pending with a zero leaf: root-only checking would miss it.
    let pending = cs::addresses(&f.trusted, 0, 1).unwrap()[5].clone();
    shared.lock().unwrap().accounts[&pending] = Value::Null;
    let failures = std::sync::atomic::AtomicUsize::new(0);
    assert!(rpc
        .capture_with_failure(&f.trusted, f.deployment(), &settings, 0, || async {
            failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .await
        .is_err());
    assert_eq!(failures.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(m.calls.lock().unwrap().len(), 2 + 3 * 2);
    // An old context is rejected before fetching even a light header.
    assert!(rpc
        .capture(&f.trusted, f.deployment(), &settings, f.expected.slot + 1)
        .await
        .is_err());
    assert_eq!(m.calls.lock().unwrap().len(), 2 + 3 * 2 + 3);
    let mut small = settings;
    small.max_note_ids = 1;
    assert!(rpc
        .capture(&f.trusted, f.deployment(), &small, 0)
        .await
        .is_err());
    assert_eq!(m.calls.lock().unwrap().len(), 2 + 3 * 2 + 3 + 3);
}

#[tokio::test]
async fn rate_limit_cooldown_is_shared_and_not_an_immediate_retry_storm() {
    use axum::{http::StatusCode, routing::post, Router};
    let times = Arc::new(Mutex::new(Vec::new()));
    let log = times.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/",
        post(move || {
            log.lock().unwrap().push(std::time::Instant::now());
            async {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", "1")],
                    "limited",
                )
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let rpc = StateRpc::new(url, 1024).unwrap();
    assert!(rpc.call("getGenesisHash", json!([])).await.is_err());
    assert!(rpc.clone().call("getGenesisHash", json!([])).await.is_err());
    let observed = times.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert!(observed[1].duration_since(observed[0]) >= Duration::from_secs(1));
    task.abort();
}
#[tokio::test]
async fn concurrent_rate_limit_extension_is_observed_by_sleeping_callers() {
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let times = Arc::new(Mutex::new(Vec::new()));
    let log = times.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/",
        post(move |Json(q): Json<Value>| {
            let barrier = barrier.clone();
            let log = log.clone();
            async move {
                let purpose = q["params"][0].as_str().unwrap();
                if purpose == "waiting" {
                    log.lock()
                        .unwrap()
                        .push(("waiting", std::time::Instant::now()));
                    return Json(success(&q, json!("ready"))).into_response();
                }
                barrier.wait().await;
                let delay = if purpose == "extension" {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    log.lock()
                        .unwrap()
                        .push(("extension", std::time::Instant::now()));
                    "2"
                } else {
                    "1"
                };
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", delay)],
                    "limited",
                )
                    .into_response()
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let rpc = StateRpc::new(url, 1024).unwrap();
    let initial = rpc.clone();
    let first =
        tokio::spawn(async move { initial.call("getGenesisHash", json!(["initial"])).await });
    let extension = rpc.clone();
    let second =
        tokio::spawn(async move { extension.call("getGenesisHash", json!(["extension"])).await });
    assert!(first.await.unwrap().is_err());
    assert_eq!(
        rpc.call("getGenesisHash", json!(["waiting"]))
            .await
            .unwrap(),
        json!("ready")
    );
    assert!(second.await.unwrap().is_err());
    let observed = times.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert_eq!((observed[0].0, observed[1].0), ("extension", "waiting"));
    assert!(observed[1].1.duration_since(observed[0].1) >= Duration::from_secs(2));
    task.abort();
}
#[tokio::test]
async fn cloned_rpc_clients_share_the_four_request_concurrency_limit() {
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let active = in_flight.clone();
    let maximum = peak.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/",
        post(move |Json(q): Json<Value>| {
            let active = active.clone();
            let maximum = maximum.clone();
            async move {
                maximum.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Json(success(&q, json!("ready")))
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let rpc = StateRpc::new(url, 1024).unwrap();
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let rpc = rpc.clone();
        requests.spawn(async move { rpc.call("getGenesisHash", json!([])).await });
    }
    while let Some(result) = requests.join_next().await {
        assert_eq!(result.unwrap().unwrap(), json!("ready"));
    }
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert_eq!(in_flight.load(Ordering::SeqCst), 0);
    task.abort();
}
#[tokio::test]
async fn owner_coalesces_consumers_and_local_health_spends_zero_rpc() {
    let mut f = Fixture::load("close", "mutual_close");
    f.wall_now();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = f.config(dir.path(), "http://127.0.0.1:1".into());
    let identity = loader_accounts(&f, &cfg);
    let handler = f.clone();
    let m = mock(move |q| {
        let mut result = handler.rpc_result(&q);
        if q["method"] == "getMultipleAccounts" && q["params"][0][0] == handler.trusted.program_id {
            let values: Vec<_> = q["params"][0]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| {
                    let mut v = identity[k.as_str().unwrap()].clone();
                    if q["params"][1].get("dataSlice").is_some() {
                        let b = bytes(&v);
                        replace(&mut v, b[..b.len().min(45)].to_vec());
                    }
                    v
                })
                .collect();
            result = json!({"context":{"slot":handler.expected.slot},"value":values});
        }
        success(&q, result)
    })
    .await;
    cfg.rpc_url = m.url.clone();
    let (owner, worker) = service::start_owner(cfg.clone(), f.trusted.clone()).unwrap();
    let _socket = service::serve_socket(&cfg.chain_state.state_socket, owner.clone()).unwrap();
    let mut joins = tokio::task::JoinSet::new();
    for _ in 0..24 {
        let owner = owner.clone();
        joins.spawn(async move { owner.read(true, false).await.unwrap() });
    }
    while let Some(r) = joins.join_next().await {
        r.unwrap();
    }
    assert_eq!(
        m.calls.lock().unwrap().len(),
        4,
        "one startup genesis/identity + one account/header capture"
    );
    assert!(
        service::serve(cfg.clone()).await.is_err(),
        "a second owner must be refused"
    );
    assert_eq!(
        m.calls.lock().unwrap().len(),
        4,
        "lock refusal precedes RPC"
    );
    for _ in 0..50 {
        assert!(owner.health().await.ready);
    }
    std::fs::create_dir_all(&cfg.snapshots_directory).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    cfg.public_origin = url.clone();
    let router = service::router(owner.clone(), cfg.clone(), f.trusted.clone());
    let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    for route in [
        "/zkapi/v1/tree/root",
        "/zkapi/v1/tree/notes/1/zero-path",
        "/zkapi/v1/tree/snapshot",
    ] {
        let response = client.get(format!("{url}{route}")).send().await.unwrap();
        assert_eq!(response.status(), 200, "{route}");
        let body: Value = response.json().await.unwrap();
        if let Some(download) = body["download_url"].as_str() {
            let bytes = client
                .get(download)
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            assert_eq!(
                hex::encode(sha2::Sha256::digest(&bytes)),
                body["sha256"].as_str().unwrap()
            );
        }
    }
    http.abort();
    let view = service::read_socket(
        &cfg.chain_state.state_socket,
        &f.trusted,
        f.deployment(),
        true,
        false,
    )
    .await
    .unwrap();
    assert_eq!(view.chain(), &f.expected);
    assert_eq!(m.calls.lock().unwrap().len(), 4);
    let health = owner.health().await;
    assert!(health.rpc["response_bytes"].as_u64().unwrap() > 0);
    assert_eq!(health.rpc["attempts"]["getMultipleAccounts"], 2);
    assert_eq!(health.rpc["attempts"]["getBlock_anchor"], 1);
    // An Unknown-recovery activity hint shortens an already scheduled idle
    // timer; it must not wait out the remaining ten-second idle interval.
    owner.read(false, true).await.unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        while m.calls.lock().unwrap().len() < 6 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    owner.read(true, false).await.unwrap();
    assert_eq!(m.calls.lock().unwrap().len(), 6);
    assert!(cfg.chain_state.cache_file.exists());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert!(!owner.health().await.ready);
    // A corrupt disposable cache is never consumed as ready data on restart.
    std::fs::write(&cfg.chain_state.cache_file, b"corrupt").unwrap();
    let (next, worker) = service::start_owner(cfg, f.trusted.clone()).unwrap();
    next.read(true, false).await.unwrap();
    assert_eq!(m.calls.lock().unwrap().len(), 10);
    worker.abort();
}
#[tokio::test]
async fn program_change_latches_send_fence_and_response_limits_hold() {
    let mut f = Fixture::load("close", "mutual_close");
    f.wall_now();
    let dir = tempfile::tempdir().unwrap();
    let cfg = f.config(dir.path(), "http://127.0.0.1:1".into());
    let records = Arc::new(Mutex::new(loader_accounts(&f, &cfg)));
    let shared = records.clone();
    let handler = f.clone();
    let m = mock(move |q| {
        if q["method"] == "getGenesisHash" {
            return success(&q, json!(handler.trusted.genesis_hash));
        }
        let values: Vec<_> = q["params"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                let mut v = shared.lock().unwrap()[k.as_str().unwrap()].clone();
                if q["params"][1].get("dataSlice").is_some() {
                    let b = bytes(&v);
                    replace(&mut v, b[..b.len().min(45)].to_vec());
                }
                v
            })
            .collect();
        success(
            &q,
            json!({"context":{"slot":handler.expected.slot},"value":values}),
        )
    })
    .await;
    let rpc = StateRpc::new(m.url.clone(), 16 * 1024 * 1024).unwrap();
    let mut guard = cs::IdentityGuard::new(
        rpc,
        f.trusted.program_id.clone(),
        f.trusted.genesis_hash.clone(),
        cfg.program_identity,
    )
    .unwrap();
    guard.ensure(0, Duration::ZERO).await.unwrap();
    for v in records
        .lock()
        .unwrap()
        .values_mut()
        .filter(|v| v["executable"] == false)
    {
        let mut b = bytes(v);
        b[4] ^= 1;
        replace(v, b);
    }
    assert!(guard.ensure(0, Duration::ZERO).await.is_err());
    let calls = m.calls.lock().unwrap().len();
    assert!(guard.ensure(0, Duration::ZERO).await.is_err());
    assert_eq!(calls, m.calls.lock().unwrap().len());
    let small = StateRpc::new(m.url.clone(), 32).unwrap();
    assert!(small.call("getGenesisHash", json!([])).await.is_err());
}
