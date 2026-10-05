//! Offline HTTP scheduling tests only. Concurrent reads retain sequential replay
//! and never establish public RPC, financial execution or release-gate evidence.
use axum::{extract::State, routing::post, Json, Router};
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
    blocks: BTreeMap<u64, Value>,
    active: AtomicUsize,
    peak: AtomicUsize,
    fault: AtomicUsize,
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
async fn endpoint(State(state): State<Arc<RpcState>>, Json(request): Json<Value>) -> Json<Value> {
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
                let group = ((slot - FIRST) / 4) as usize;
                let position = ((slot - FIRST) % 4) as usize;
                state.barriers[group].wait().await;
                // Deterministically complete each four-read window backwards.
                // A sequential implementation cannot pass the four-party gate.
                if position < 3 {
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
                        )
                    }
                    2 => block["blockTime"] = json!("invalid"),
                    3 => block["parentSlot"] = json!(FIRST - 1),
                    _ => {}
                }
            }
            block
        }
        _ => panic!("unexpected fixture method"),
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
}
async fn server(fault: usize) -> Server {
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
        blocks,
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        fault: AtomicUsize::new(fault),
        reverse: AtomicBool::new(true),
        barriers: (0..COUNT / 4).map(|_| Barrier::new(4)).collect(),
        gates: (0..COUNT / 4)
            .map(|_| (0..3).map(|_| Semaphore::new(0)).collect())
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
