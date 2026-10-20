#[path = "support/current.rs"]
mod support;

use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use support::*;
use zkapi_indexer::current_state::{self as cs, service};

fn identity_result(f: &Fixture, cfg: &service::Config, q: &Value) -> Option<Value> {
    if q["method"] != "getMultipleAccounts" || q["params"][0][0] != f.trusted.program_id {
        return None;
    }
    let accounts = loader_accounts(f, cfg);
    let values: Vec<_> = q["params"][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| accounts[k.as_str().unwrap()].clone())
        .collect();
    Some(json!({"context":{"slot":f.expected.slot},"value":values}))
}

#[tokio::test]
async fn failed_verification_clears_health_before_a_stalled_retry_finishes() {
    let mut f = Fixture::load("close", "mutual_close");
    f.wall_now();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = f.config(dir.path(), "http://127.0.0.1:1".into());
    let mode = Arc::new(AtomicUsize::new(0));
    let handler_mode = mode.clone();
    let handler_f = f.clone();
    let handler_cfg = cfg.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    cfg.rpc_url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/",
        post(move |Json(q): Json<Value>| {
            let f = handler_f.clone();
            let cfg = handler_cfg.clone();
            let mode = handler_mode.clone();
            async move {
                if let Some(result) = identity_result(&f, &cfg, &q) {
                    return Json(success(&q, result));
                }
                let mut result = f.rpc_result(&q);
                if q["method"] == "getMultipleAccounts" && mode.load(Ordering::SeqCst) > 0 {
                    if mode.fetch_add(1, Ordering::SeqCst) == 1 {
                        // Omit an allocated Closed Note without changing its
                        // zero tree leaf; the complete inventory is mandatory.
                        result["value"][4] = Value::Null;
                    } else {
                        std::future::pending::<()>().await;
                    }
                }
                Json(success(&q, result))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let (owner, worker) = service::start_owner(cfg, f.trusted).unwrap();
    owner.read(true, false).await.unwrap();
    assert!(owner.health().await.ready);
    tokio::time::sleep(Duration::from_millis(cs::FRESH_MS + 50)).await;
    mode.store(1, Ordering::SeqCst);
    let reader = owner.clone();
    let read = tokio::spawn(async move { reader.read(true, false).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while mode.load(Ordering::SeqCst) < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !owner.health().await.ready,
        "the invalid capture must clear readiness before retry completion"
    );
    assert!(!read.is_finished(), "the retry is still waiting for RPC");
    worker.abort();
    read.abort();
    server.abort();
}

#[tokio::test]
async fn startup_identity_and_capture_share_the_thirty_second_refresh_budget() {
    let mut f = Fixture::load("close", "mutual_close");
    f.wall_now();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = f.config(dir.path(), "http://127.0.0.1:1".into());
    let handler_f = f.clone();
    let handler_cfg = cfg.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    cfg.rpc_url = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let router = Router::new().route(
        "/",
        post(move |Json(q): Json<Value>| {
            let f = handler_f.clone();
            let cfg = handler_cfg.clone();
            let calls = handler_calls.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                // Each RPC stays within its own ten-second budget, but startup
                // identity plus accounts and header would take 36 seconds.
                tokio::time::sleep(Duration::from_secs(9)).await;
                Json(success(
                    &q,
                    identity_result(&f, &cfg, &q).unwrap_or_else(|| f.rpc_result(&q)),
                ))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let (owner, worker) = service::start_owner(cfg, f.trusted).unwrap();
    let reader = owner.clone();
    let read = tokio::spawn(async move { reader.read(true, false).await });
    tokio::time::sleep(Duration::from_secs(31)).await;
    assert!(
        read.await.unwrap().is_err(),
        "HTTP wait remains at most 25s"
    );
    assert!(!owner.health().await.ready);
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), owner.read(false, false))
            .await
            .expect("refresh must have stopped and entered shared backoff")
            .is_err()
    );
    worker.abort();
    server.abort();
}
