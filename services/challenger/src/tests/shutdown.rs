//! Real process signals, loopback RPC only. No public endpoint or user key.
use super::*;
use axum::{routing::post, Json, Router};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::{Child, Command};

fn config(dir: &Path, rpc: String) -> runtime::Config {
    let (trust, manifest) = trust_and_manifest();
    let manifest_file = dir.join("manifest.json");
    std::fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    runtime::Config {
        manifest: manifest_file,
        manifest_sha256: hex::encode(trust.manifest_hash),
        devnet: None,
        rpc_url: rpc,
        database_dsn_file: dir.join("dsn"),
        start_slot: 1,
        journal_directory: dir.join("journal"),
        tree_pk: dir.join("absent-pk"),
        node: "/bin/sh".into(),
        transport_bridge: dir.join("bridge.sh"),
        transport_bridge_sha256: hex::encode(sha(b"")),
        fee_key_file: dir.join("absent-fee-key"),
        payer: zkapi_indexer::snapshot::key([7; 32]),
        poll_seconds: 1,
        alert_sink_directory: None,
        priority_fee: None,
        archive_batch: None,
    }
}

#[tokio::test]
async fn child_entry() {
    let Some(path) = std::env::var_os("ZKAPI_SHUTDOWN_TEST_CONFIG") else {
        return;
    };
    let config = runtime::read_config(Path::new(&path)).unwrap();
    let command = std::env::var("ZKAPI_SHUTDOWN_TEST_COMMAND").unwrap();
    if command == "scan-direct" {
        // Same signal supervisor and Runtime::scan used by run; bypass only the
        // unrelated repository setup to isolate archive interruption without PG.
        let signals = crate::shutdown::Signals::install().unwrap();
        let mut daemon =
            runtime::Runtime::open_with_shutdown(config, false, Some(signals.shutdown.clone()))
                .unwrap();
        assert!(matches!(daemon.scan().await, Err(Error::Interrupted)));
        daemon.publish_health(false, runtime::now()).unwrap();
    } else {
        runtime::run(config, &command).await.unwrap();
    }
}

fn child(config: &runtime::Config, command: &str) -> Child {
    let path = config.manifest.parent().unwrap().join("config.json");
    std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::shutdown::child_entry", "--nocapture"])
        .env("ZKAPI_SHUTDOWN_TEST_CONFIG", path)
        .env("ZKAPI_SHUTDOWN_TEST_COMMAND", command)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}
async fn signal_and_join(child: &mut Child, signal: &str) {
    let start = std::time::Instant::now();
    let (signal, target) = if let Some(signal) = signal.strip_prefix("group:") {
        (signal, format!("-{}", child.id().unwrap()))
    } else {
        (signal, child.id().unwrap().to_string())
    };
    assert!(Command::new("/bin/kill")
        .args([signal, "--", &target])
        .status()
        .await
        .unwrap()
        .success());
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("shutdown must not wait for the 30-second RPC timeout")
        .unwrap();
    assert!(
        status.success(),
        "signal must drain and exit successfully: {status}"
    );
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn native_signals_interrupt_slow_rpc_without_changing_journal() {
    for signal in ["-INT", "-TERM"] {
        let dir = tempfile::tempdir().unwrap();
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let route = {
            let reached = reached.clone();
            post(move |Json(request): Json<Value>| {
                let reached = reached.clone();
                async move {
                    assert_eq!(request["method"], "getGenesisHash");
                    reached.notify_one();
                    std::future::pending::<Json<Value>>().await
                }
            })
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", route))
                .await
                .unwrap();
        });
        let config = config(dir.path(), format!("http://{address}"));
        drop(runtime::Runtime::open(config.clone(), true).unwrap());
        let path = config.journal_directory.join("journal.json");
        let before = std::fs::read(&path).unwrap();
        let mut child = child(&config, "recover");
        tokio::time::timeout(Duration::from_secs(10), reached.notified())
            .await
            .unwrap();
        signal_and_join(&mut child, signal).await;
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!config.fee_key_file.exists());
        assert!(!config.tree_pk.exists());
        server.abort();
    }
}

fn scenario() -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let history: Value = serde_json::from_slice(
        &std::fs::read(root.join("target/i04/sdk-svm-history.json")).unwrap(),
    )
    .unwrap();
    history["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "challenge")
        .unwrap()
        .clone()
}

#[tokio::test]
#[ignore = "reads existing I04 SBF archive; never regenerates fixtures"]
async fn native_scan_stop_commits_validated_prefix_and_does_not_mask_write_failure() {
    for (write_failure, policy) in [
        (false, None),
        (true, None),
        (
            false,
            Some(runtime::ArchiveBatchPolicy {
                rpc_concurrency: None,
                max_blocks: 256,
                max_bytes: 32 * 1024 * 1024,
            }),
        ),
        (
            true,
            Some(runtime::ArchiveBatchPolicy {
                rpc_concurrency: None,
                max_blocks: 256,
                max_bytes: 32 * 1024 * 1024,
            }),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let scenario = scenario();
        let (trust, _) = trust_and_manifest();
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let route = {
            let reached = reached.clone();
            post(move |Json(request): Json<Value>| {
                let reached = reached.clone();
                let scenario = scenario.clone();
                let genesis = trust.pool.genesis_hash.clone();
                async move {
                    let result = match request["method"].as_str().unwrap() {
                        "getGenesisHash" => json!(genesis),
                        "getSlot" => json!(8),
                        "getBlocks" => json!([1, 2, 3, 4, 5, 6, 7, 8]),
                        "getBlock" => {
                            let slot = request["params"][0].as_u64().unwrap();
                            if slot >= 5 {
                                reached.notify_one();
                                std::future::pending::<()>().await;
                            }
                            scenario["blocks"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|b| b["slot"] == slot)
                                .unwrap()["block"]
                                .clone()
                        }
                        _ => panic!("scan should not publish a view or dispatch"),
                    };
                    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
                }
            })
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", route))
                .await
                .unwrap();
        });
        let mut config = config(dir.path(), format!("http://{address}"));
        config.archive_batch = policy;
        drop(runtime::Runtime::open(config.clone(), true).unwrap());
        let mut process = child(&config, "scan-direct");
        tokio::time::timeout(Duration::from_secs(10), reached.notified())
            .await
            .unwrap();
        // First four blocks are validated but below the 64-block batch bound.
        let before: Value = serde_json::from_slice(
            &std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
        )
        .unwrap();
        assert!(before["state"].get("archive").is_none());
        if write_failure {
            std::fs::create_dir(config.journal_directory.join("journal.next")).unwrap();
            assert!(Command::new("/bin/kill")
                .args(["-TERM", &process.id().unwrap().to_string()])
                .status()
                .await
                .unwrap()
                .success());
            let status = tokio::time::timeout(Duration::from_secs(5), process.wait())
                .await
                .unwrap()
                .unwrap();
            assert!(
                !status.success(),
                "durability failure must not become graceful success"
            );
        } else {
            signal_and_join(&mut process, "-TERM").await;
        }
        let reopened = runtime::Runtime::open(config.clone(), false).unwrap();
        assert_eq!(
            reopened.journal.archive_len(),
            if write_failure { 0 } else { 4 }
        );
        assert!(reopened.journal.jobs().next().is_none());
        if !write_failure {
            assert_eq!(reopened.journal.archive_tail().unwrap().slot, 4);
            let health: Value = serde_json::from_slice(
                &std::fs::read(config.journal_directory.join("health.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(health["ready"], false);
        }
        server.abort();
    }
}

#[tokio::test]
async fn native_run_stop_interrupts_repository_connection_before_admission() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = config(dir.path(), "http://127.0.0.1:1".into());
    std::fs::write(
        &config.database_dsn_file,
        format!("host=127.0.0.1 port={port} user=reader dbname=fixture sslmode=disable"),
    )
    .unwrap();
    drop(runtime::Runtime::open(config.clone(), true).unwrap());
    let before = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
    let mut process = child(&config, "run");
    let (_held, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    signal_and_join(&mut process, "-TERM").await;
    assert_eq!(
        std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
        before
    );
}

#[tokio::test]
#[ignore = "reads existing I04 SBF archive; synthetic bridge/attempt envelope, no real send"]
async fn native_stop_reaps_bridge_and_preserves_exact_unknown_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (trust, _) = trust_and_manifest();
    let genesis = trust.pool.genesis_hash.clone();
    let route = post(move |Json(request): Json<Value>| {
        let genesis = genesis.clone();
        async move {
            assert_eq!(request["method"], "getGenesisHash");
            Json(json!({"jsonrpc":"2.0","id":request["id"],"result":genesis}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/", route))
            .await
            .unwrap();
    });
    let mut config = config(dir.path(), format!("http://{address}"));
    // This child simulates a bridge losing its response after an already saved
    // send. Synthetic bytes are intentional; this test claims no v0 validity.
    let marker = dir.path().join("bridge.json");
    let script=format!("import json,os,sys,time\na=json.load(sys.stdin)\nassert a['command']=='recover'\nwith open({},'w') as f: json.dump({{'pid':os.getpid(),'attempt':a['attempt']}},f)\ntime.sleep(60)\n",serde_json::to_string(&marker).unwrap());
    std::fs::write(&config.transport_bridge, &script).unwrap();
    config.node = "/usr/bin/python3".into();
    config.transport_bridge_sha256 = hex::encode(sha(script.as_bytes()));
    let mut journal = Journal::initialize(&config.journal_directory, trust.pool()).unwrap();
    let scenario = scenario();
    let mut scanner = scan::Scanner::new(trust.clone());
    for block in scenario["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["slot"].as_u64().unwrap() <= 15)
    {
        let block = zkapi_indexer::rpc::decode_finalized_block(
            block["slot"].as_u64().unwrap(),
            &block["block"],
        )
        .unwrap();
        scanner.apply_finalized(&block).unwrap();
        journal.append_archive(block).unwrap();
    }
    let e = evidence(&trust);
    let prepared =
        PreparedChallenge::from_finalized(&view(trust.clone(), &e), 0, e.clone()).unwrap();
    let bytes = payload(&prepared, &trust);
    let id = prepared.job.id();
    let digest = sha(&bytes);
    let buffer = [9; 32];
    journal
        .enqueue_cut(checkpoint(3), vec![(prepared.job, e)], 10)
        .unwrap();
    journal
        .save_payload(
            &id,
            Payload {
                bytes,
                digest,
                buffer,
                checkpoint: checkpoint(3),
            },
        )
        .unwrap();
    let attempt = Attempt {
        signature: "shutdown-fixture-saved-execute".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Execute,
        payload_digest: digest,
        buffer,
        outcome: Outcome::Unknown,
    };
    let transport = json!({"signature":attempt.signature,"wireHex":"010203","planDigest":hex::encode(digest),"buffer":zkapi_indexer::snapshot::key(buffer),"kind":"execute","plan":{"operation":"challenge_escape"}});
    journal
        .save_v0_attempt(&id, attempt.clone(), transport.clone())
        .unwrap();
    drop(journal);
    let mut durable = None;
    for signal in ["-INT", "-TERM", "group:-INT", "group:-TERM"] {
        let mut process = child(&config, "recover");
        tokio::time::timeout(Duration::from_secs(10), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let recorded: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        assert_eq!(recorded["attempt"], transport);
        let before = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
        if let Some(prior) = &durable {
            assert_eq!(prior, &before);
        }
        signal_and_join(&mut process, signal).await;
        assert!(
            !Command::new("/bin/kill")
                .args(["-0", &recorded["pid"].as_u64().unwrap().to_string()])
                .stderr(Stdio::null())
                .status()
                .await
                .unwrap()
                .success(),
            "owned child must be reaped before successful exit"
        );
        assert_eq!(
            std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
            before
        );
        let reopened = Journal::open(&config.journal_directory, trust.pool()).unwrap();
        let job = reopened.jobs().next().unwrap().1;
        assert_eq!(job.attempts, vec![attempt.clone()]);
        assert!(job.first_execute_send_at.is_some());
        assert!(!job.complete);
        assert_eq!(reopened.transport(&attempt.signature), Some(&transport));
        drop(reopened);
        assert!(!config.fee_key_file.exists());
        assert!(!config.tree_pk.exists());
        durable = Some(before);
        std::fs::remove_file(&marker).unwrap();
    }
    server.abort();
}
