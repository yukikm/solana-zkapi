//! Offline HTTP scheduling tests only. Concurrent reads retain sequential replay
//! and never establish public RPC, financial execution or release-gate evidence.
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{Barrier, Semaphore};
use zkapi_indexer::{
    discriminator, rpc::decode_finalized_block, runtime::ArchiveRpc, Bytes32, ChainState, Indexer,
};

const FIRST: u64 = 507_277_497;
const COUNT: u64 = 12;
struct RpcState {
    window: usize,
    blocks: BTreeMap<u64, Value>,
    active: AtomicUsize,
    peak: AtomicUsize,
    fault: AtomicUsize,
    rate_limited: AtomicBool,
    calls: AtomicUsize,
    reverse: AtomicBool,
    barriers: Vec<Barrier>,
    gates: Vec<Vec<Semaphore>>,
    completions: Mutex<Vec<u64>>,
    ranges: Mutex<Vec<u64>>,
}
struct Server {
    rpc: ArchiveRpc,
    state: Arc<RpcState>,
    task: tokio::task::JoinHandle<()>,
    program: Bytes32,
    pool: Bytes32,
    expected: ChainState,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn endpoint(State(state): State<Arc<RpcState>>, Json(request): Json<Value>) -> Response {
    state.calls.fetch_add(1, Ordering::SeqCst);
    let result = match request["method"].as_str().unwrap() {
        "getSlot" => json!(FIRST + COUNT - 1),
        "getBlocks" => {
            let first = request["params"][0].as_u64().unwrap();
            let last = request["params"][1].as_u64().unwrap();
            state.ranges.lock().unwrap().push(first);
            json!(state
                .blocks
                .range(first..=last)
                .map(|(slot, _)| *slot)
                .collect::<Vec<_>>())
        }
        "getBlock" => {
            assert_eq!(request["params"][1]["commitment"], "finalized");
            assert_eq!(request["params"][1]["transactionDetails"], "full");
            assert_eq!(request["params"][1]["maxSupportedTransactionVersion"], 1);
            let slot = request["params"][0].as_u64().unwrap();
            let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
            state.peak.fetch_max(active, Ordering::SeqCst);
            if state.reverse.load(Ordering::SeqCst) {
                let group = ((slot - FIRST) / state.window as u64) as usize;
                let position = ((slot - FIRST) % state.window as u64) as usize;
                state.barriers[group].wait().await;
                // Deterministically complete each four-read window backwards.
                // A sequential implementation cannot pass the four-party gate.
                if position < state.window - 1 {
                    state.gates[group][position]
                        .acquire()
                        .await
                        .unwrap()
                        .forget();
                }
                state.completions.lock().unwrap().push(slot);
                if position > 0 {
                    state.gates[group][position - 1].add_permits(1);
                }
            } else {
                state.completions.lock().unwrap().push(slot);
            }
            state.active.fetch_sub(1, Ordering::SeqCst);
            let mut block = state.blocks[&slot].clone();
            if slot == FIRST + 1 {
                match state.fault.load(Ordering::SeqCst) {
                    1 => {
                        return Json(
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"fixture transient archive error"}}),
                        ).into_response()
                    }
                    2 => block["blockTime"] = json!("invalid"),
                    3 => block["parentSlot"] = json!(FIRST - 1),
                    4 => {
                        state.rate_limited.store(true, Ordering::SeqCst);
                        return (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "1")], "limited").into_response();
                    }
                    _ => {}
                }
            }
            block
        }
        _ => panic!("unexpected fixture method"),
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
}
async fn server(fault: usize) -> Server {
    server_with_window(fault, 4).await
}
async fn server_with_window(fault: usize, window: usize) -> Server {
    let first: Value =
        serde_json::from_str(include_str!("fixtures/devnet-v1-initialize-block.json")).unwrap();
    let decoded = decode_finalized_block(FIRST, &first).unwrap();
    let init = decoded.transactions[1]
        .instructions
        .iter()
        .find(|ix| {
            ix.data
                .starts_with(&discriminator("global", "initialize_pool"))
        })
        .unwrap();
    let (program, pool) = (init.program, init.accounts[0]);
    let mut previous = first["blockhash"].clone();
    let mut blocks = BTreeMap::from([(FIRST, first)]);
    for offset in 1..COUNT {
        let blockhash = json!(bs58::encode([offset as u8; 32]).into_string());
        blocks.insert(
            FIRST + offset,
            json!({
                "blockhash":blockhash,"previousBlockhash":previous,"parentSlot":FIRST+offset-1,
                "blockTime":1_791_096_571+offset,"transactions":[],
            }),
        );
        previous = blockhash;
    }
    let mut reference = Indexer::new(program, pool);
    for (slot, block) in &blocks {
        reference
            .apply_block(&decode_finalized_block(*slot, block).unwrap())
            .unwrap();
    }
    let state = Arc::new(RpcState {
        window,
        blocks,
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        fault: AtomicUsize::new(fault),
        rate_limited: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        reverse: AtomicBool::new(true),
        barriers: (0..COUNT / window as u64)
            .map(|_| Barrier::new(window))
            .collect(),
        gates: (0..COUNT / window as u64)
            .map(|_| (0..window - 1).map(|_| Semaphore::new(0)).collect())
            .collect(),
        completions: Mutex::new(Vec::new()),
        ranges: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .route("/", post(endpoint))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = ArchiveRpc::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        rpc,
        state,
        task,
        program,
        pool,
        expected: reference.replay_state().unwrap(),
    }
}

#[tokio::test]
async fn reverse_completing_reads_apply_in_order_with_at_most_four_in_flight() {
    let server = server(0).await;
    let mut index = Indexer::new(server.program, server.pool);
    let mut next = FIRST;
    tokio::time::timeout(
        Duration::from_secs(10),
        server.rpc.catch_up(&mut index, &mut next),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(index.replay_state().unwrap(), server.expected);
    assert_eq!(next, FIRST + COUNT);
    assert_eq!(server.state.peak.load(Ordering::SeqCst), 4);
    assert_eq!(server.state.active.load(Ordering::SeqCst), 0);
    let expected: Vec<_> = (0..COUNT / 4)
        .flat_map(|group| (0..4).rev().map(move |i| FIRST + group * 4 + i))
        .collect();
    assert_eq!(*server.state.completions.lock().unwrap(), expected);
    assert!(
        !index.is_ready(),
        "archive replay still needs independent account reconciliation"
    );
}

#[tokio::test]
async fn middle_fetch_or_decode_failure_keeps_only_applied_prefix_and_retry_starts_there() {
    for fault in [1, 2] {
        let server = server(fault).await;
        let mut index = Indexer::new(server.program, server.pool);
        let mut next = FIRST;
        assert!(tokio::time::timeout(
            Duration::from_secs(10),
            server.rpc.catch_up(&mut index, &mut next)
        )
        .await
        .unwrap()
        .is_err());
        assert_eq!(index.replay_state().unwrap().slot, FIRST);
        assert_eq!(
            next,
            FIRST + 1,
            "later fetched blocks must not advance the cursor"
        );
        assert!(!index.is_ready());
        assert!(index.root().is_err());
        assert_eq!(
            *server.state.completions.lock().unwrap(),
            vec![FIRST + 3, FIRST + 2, FIRST + 1, FIRST]
        );
        assert_eq!(server.state.active.load(Ordering::SeqCst), 0);
        server.state.reverse.store(false, Ordering::SeqCst);
        server.state.fault.store(0, Ordering::SeqCst);
        tokio::time::timeout(
            Duration::from_secs(10),
            server.rpc.catch_up(&mut index, &mut next),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(*server.state.ranges.lock().unwrap(), vec![FIRST, FIRST + 1]);
        assert_eq!(index.replay_state().unwrap(), server.expected);
        assert_eq!(next, FIRST + COUNT);
        assert!(server.state.peak.load(Ordering::SeqCst) <= 4);
    }
}

#[tokio::test]
async fn invalid_parent_latches_replay_closed_despite_later_successful_fetches() {
    let server = server(3).await;
    let mut index = Indexer::new(server.program, server.pool);
    let mut next = FIRST;
    assert!(tokio::time::timeout(
        Duration::from_secs(10),
        server.rpc.catch_up(&mut index, &mut next)
    )
    .await
    .unwrap()
    .is_err());
    assert_eq!(next, FIRST + 1);
    assert!(!index.is_ready());
    assert!(index.root().is_err());
    server.state.reverse.store(false, Ordering::SeqCst);
    server.state.fault.store(0, Ordering::SeqCst);
    assert!(
        server.rpc.catch_up(&mut index, &mut next).await.is_err(),
        "fork failure still requires explicit replay recovery"
    );
    assert_eq!(next, FIRST + 1);
}

#[tokio::test]
async fn http_429_waits_then_fails_without_skipping_the_failed_slot() {
    let server = server(4).await;
    let mut index = Indexer::new(server.program, server.pool);
    let mut next = FIRST;
    let start = tokio::time::Instant::now();
    assert!(tokio::time::timeout(
        Duration::from_secs(5),
        server.rpc.catch_up(&mut index, &mut next)
    )
    .await
    .unwrap()
    .is_err());
    assert!(start.elapsed() >= Duration::from_secs(1));
    assert_eq!(next, FIRST + 1);
    assert_eq!(index.replay_state().unwrap().slot, FIRST);
    assert!(!index.is_ready());
    assert_eq!(
        server.state.calls.load(Ordering::SeqCst),
        6,
        "no automatic HTTP retry"
    );
    server.state.reverse.store(false, Ordering::SeqCst);
    server.state.fault.store(0, Ordering::SeqCst);
    server.rpc.catch_up(&mut index, &mut next).await.unwrap();
    assert_eq!(*server.state.ranges.lock().unwrap(), vec![FIRST, FIRST + 1]);
    assert_eq!(next, FIRST + COUNT);
    assert_eq!(index.replay_state().unwrap(), server.expected);
    assert!(!index.is_ready(), "account reconciliation remains required");
    assert!(server.state.peak.load(Ordering::SeqCst) <= 4);
}

#[tokio::test]
async fn cancelling_a_rate_limited_read_keeps_shared_cooldown_and_sends_no_retry() {
    let server = server(4).await;
    server.state.reverse.store(false, Ordering::SeqCst);
    assert!(tokio::time::timeout(
        Duration::from_millis(150),
        server.rpc.finalized_block_window(&[FIRST + 1])
    )
    .await
    .is_err());
    assert!(server.state.rate_limited.load(Ordering::SeqCst));
    assert_eq!(server.state.calls.load(Ordering::SeqCst), 1);
    let cloned = server.rpc.clone();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), cloned.call("getSlot", json!([])))
            .await
            .is_err()
    );
    assert_eq!(
        server.state.calls.load(Ordering::SeqCst),
        1,
        "a clone must not bypass cooldown"
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(3), cloned.call("getSlot", json!([])))
            .await
            .unwrap()
            .is_ok()
    );
    assert_eq!(
        server.state.calls.load(Ordering::SeqCst),
        2,
        "only the new explicit read was sent"
    );
}

// Invoked in a fresh process by the test below to capture the real stderr path.
// With no fixture environment this helper performs no network operation.
#[tokio::test]
async fn rpc_diagnostic_fixture_child() {
    let Ok(raw) = std::env::var("ZKAPI_RPC_DIAGNOSTIC_FIXTURE") else {
        return;
    };
    let input: Value = serde_json::from_str(&raw).unwrap();
    let rpc = ArchiveRpc::new(input["url"].as_str().unwrap().into()).unwrap();
    let result = rpc
        .call(
            input["method"].as_str().unwrap(),
            json!(["PRIVATE_REQUEST_PARAM"]),
        )
        .await;
    assert_eq!(
        result.unwrap_err().to_string(),
        input["error"].as_str().unwrap()
    );
}

#[tokio::test]
async fn actual_rpc_failure_stderr_is_numeric_redacted_and_does_not_retry() {
    for (status, body, phase, code, expected_error) in [
        (429, "PRIVATE_HTTP_BODY", "http", None, "RPC HTTP error"),
        (503, "PRIVATE_HTTP_BODY", "http", None, "RPC HTTP error"),
        (
            200,
            "PRIVATE_INVALID_JSON",
            "body",
            None,
            "RPC invalid JSON",
        ),
        (
            200,
            r#"{"id":"PRIVATE_RESPONSE_ID","result":5}"#,
            "envelope_id",
            None,
            "RPC response error",
        ),
        (
            200,
            r#"{"id":1,"error":{"code":-32005,"message":"PRIVATE_MESSAGE","data":"PRIVATE_DATA"}}"#,
            "rpc_error",
            Some(-32005),
            "RPC response error",
        ),
        (
            200,
            r#"{"id":1,"error":{"code":"PRIVATE_CODE","message":"PRIVATE_MESSAGE"}}"#,
            "rpc_error",
            None,
            "RPC response error",
        ),
        (
            200,
            r#"{"id":1,"result":null,"PRIVATE_FIELD":"PRIVATE_VALUE"}"#,
            "result_missing",
            None,
            "RPC result unavailable",
        ),
        (0, "", "send", None, "RPC transport unavailable"),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let task = if status != 0 {
            let app = Router::new().route(
                "/PRIVATE_RPC_PATH",
                post(move || {
                    let counted = counted.clone();
                    async move {
                        counted.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::from_u16(status).unwrap(),
                            [("retry-after", "1"), ("x-private-header", "PRIVATE_HEADER")],
                            body,
                        )
                    }
                }),
            );
            Some(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            }))
        } else {
            drop(listener);
            None
        };
        let method = if phase == "result_missing" {
            "PRIVATE_METHOD"
        } else {
            "getBlock"
        };
        let fixture = json!({"url":format!("http://{address}/PRIVATE_RPC_PATH?api-key=PRIVATE_QUERY"),"method":method,"error":expected_error}).to_string();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "rpc_diagnostic_fixture_child", "--nocapture"])
                .env("ZKAPI_RPC_DIAGNOSTIC_FIXTURE", fixture)
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        if let Some(task) = task {
            task.abort();
        }
        assert!(
            output.status.success(),
            "child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            !stderr.contains("PRIVATE_")
                && !stderr.contains("http://")
                && !stderr.contains("api-key")
        );
        let records: Vec<Value> = stderr
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        assert_eq!(records.len(), 1);
        let value = &records[0];
        assert_eq!(value["event"], "archive_rpc_failure");
        assert_eq!(
            value["method"],
            if method == "PRIVATE_METHOD" {
                "other"
            } else {
                method
            }
        );
        assert_eq!(value["phase"], phase);
        assert_eq!(
            value["http_status"],
            if status == 0 {
                Value::Null
            } else {
                json!(status)
            }
        );
        assert_eq!(value["rpc_code"], json!(code));
        assert_eq!(value["timeout"], false);
        assert!(value["elapsed_ms"].as_u64().is_some());
        assert_eq!(
            value["cooldown_seconds"],
            if status == 429 { json!(1) } else { Value::Null }
        );
        assert_eq!(value.as_object().unwrap().len(), 8);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(status != 0),
            "exactly one HTTP invocation and no retry"
        );
    }
}

#[tokio::test]
async fn explicit_eight_read_window_keeps_order_errors_and_default_bound() {
    let server = server_with_window(1, 8).await;
    let slots: Vec<_> = (FIRST..FIRST + 8).collect();
    assert!(server.rpc.finalized_block_window(&slots).await.is_err());
    for bound in [0, 7, 17] {
        assert!(server
            .rpc
            .finalized_block_window_bounded(&slots, bound)
            .await
            .is_err());
    }
    assert_eq!(server.state.calls.load(Ordering::SeqCst), 0);
    let values = tokio::time::timeout(
        Duration::from_secs(10),
        server.rpc.finalized_block_window_bounded(&slots, 8),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(server.state.peak.load(Ordering::SeqCst), 8);
    assert_eq!(
        server.state.calls.load(Ordering::SeqCst),
        8,
        "no automatic read retry"
    );
    assert!(values[1].is_err());
    for (position, value) in values.into_iter().enumerate() {
        if position != 1 {
            assert_eq!(
                value.unwrap(),
                server.state.blocks[&(FIRST + position as u64)]
            );
        }
    }
    assert_eq!(
        *server.state.completions.lock().unwrap(),
        slots.into_iter().rev().collect::<Vec<_>>()
    );
}
