//! Bounded I10 delayed-finality/restart stress over the existing real-proof,
//! signed-v0 challenger. RPC outcomes are synthetic; actual Vault execution is
//! covered independently by the I09 SBF runner. This is one job, not queue load.
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncBufReadExt, BufReader};
use zkapi_challenger::{
    journal::{Alert, Journal, Outcome, Stage},
    runtime::{self, Config, Runtime},
    sha, PreparedChallenge,
};

#[derive(Clone)]
struct FaultProxy {
    client: reqwest::Client,
    upstream: String,
    unavailable: Arc<AtomicBool>,
    rejected_status_calls: Arc<AtomicUsize>,
}

async fn forward(
    State(state): State<FaultProxy>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    if body["method"] == "getSignatureStatuses" && state.unavailable.load(Ordering::SeqCst) {
        state.rejected_status_calls.fetch_add(1, Ordering::SeqCst);
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let response = state
        .client
        .post(&state.upstream)
        .json(&body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .error_for_status()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(
        response.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?,
    ))
}

async fn recover_process(config_file: &Path) {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_challengerd"))
            .arg("recover")
            .arg(config_file)
            .env_clear()
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("bounded native recovery process")
    .expect("launch native recovery process");
    assert!(
        output.status.success(),
        "native recovery must retain unresolved finality: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires fresh I09 library-test manifest/archive/proof artifacts; run scripts/run_i09_challenger.py"]
async fn repeated_status_outages_and_process_restarts_preserve_unknown_execute() {
    let started = std::time::Instant::now();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let source_config = root.join("target/i09-challenger/cli-state/config.json");
    let mut config: Config =
        serde_json::from_slice(&std::fs::read(&source_config).unwrap()).unwrap();
    let trust = config.trust().unwrap();
    // Reuse the historical, fixed real RP envelope emitted by the preceding
    // I09 library test. This does not re-run financial admission or fabricate
    // distinct nullifiers to call one fixture a multi-job workload.
    let source = Journal::open(&config.journal_directory, trust.pool()).unwrap();
    let source_job = source.jobs().next().unwrap().1;
    assert!(source_job.complete);
    let evidence = source_job.evidence.clone();
    evidence.verify(&trust).unwrap();
    drop(source);

    let mut server = tokio::process::Command::new(&config.node)
        .arg(root.join("packages/sdk/test/challenger-rpc.ts"))
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        BufReader::new(server.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let port: Value = serde_json::from_str(&line).unwrap();
    let upstream = format!("http://127.0.0.1:{}", port["port"]);
    let rpc = zkapi_indexer::runtime::ArchiveRpc::new(upstream.clone()).unwrap();
    let unavailable = Arc::new(AtomicBool::new(false));
    let rejected_status_calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/", post(forward))
        .with_state(FaultProxy {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap(),
            upstream,
            unavailable: unavailable.clone(),
            rejected_status_calls: rejected_status_calls.clone(),
        });
    let proxy = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    config.rpc_url = format!("http://{address}");
    config.journal_directory = directory.path().join("journal");
    config.alert_sink_directory = Some(directory.path().join("alerts"));
    config.database_dsn_file = directory.path().join("unused-dsn");
    config.fee_key_file = directory.path().join("fee.json");
    let keypair = tokio::process::Command::new(&config.node)
        .args(["--input-type=module", "-e", "import {Keypair} from '@solana/web3.js';process.stdout.write(JSON.stringify([...Keypair.fromSeed(new Uint8Array(32).fill(10)).secretKey]))"])
        .current_dir(&root)
        .env_clear()
        .output()
        .await
        .unwrap();
    assert!(keypair.status.success());
    std::fs::write(&config.fee_key_file, keypair.stdout).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config.fee_key_file, std::fs::Permissions::from_mode(0o600))
            .unwrap();
    }
    let config_file = directory.path().join("config.json");
    std::fs::write(&config_file, serde_json::to_vec(&config).unwrap()).unwrap();

    let mut daemon = Runtime::open(config.clone(), true).unwrap();
    let view = daemon.scan().await.unwrap();
    let prepared = PreparedChallenge::from_finalized(&view, 0, evidence.clone()).unwrap();
    let job_id = prepared.job.id();
    // Virtual discovery age selects the real page alert without a five-minute
    // sleep. The runtime, persistence and subprocess recoveries use wall time.
    daemon
        .journal
        .enqueue_cut(
            daemon.checkpoint(&view),
            vec![(prepared.job, evidence)],
            runtime::now().saturating_sub(301),
        )
        .unwrap();
    assert_eq!(daemon.prove(&view).await.unwrap(), 1);
    for _ in 0..16 {
        assert_eq!(daemon.prepare_next(&view).await.unwrap(), 1);
        let stage = daemon
            .journal
            .jobs()
            .next()
            .unwrap()
            .1
            .attempts
            .last()
            .unwrap()
            .stage
            .clone();
        if stage == Stage::Execute {
            break;
        }
        daemon.recover().await.unwrap();
        daemon.recover().await.unwrap();
    }
    let execute = daemon
        .journal
        .jobs()
        .next()
        .unwrap()
        .1
        .attempts
        .last()
        .unwrap()
        .clone();
    assert_eq!(execute.stage, Stage::Execute);
    assert_eq!(execute.outcome, Outcome::Unknown);
    rpc.call("testSetMode", json!(["confirmed"])).await.unwrap();
    let before_send = rpc.call("testStats", json!([])).await.unwrap();
    daemon.recover().await.unwrap();
    let unchanged_stats = rpc.call("testStats", json!([])).await.unwrap();
    assert_eq!(
        unchanged_stats["sends"].as_u64().unwrap(),
        before_send["sends"].as_u64().unwrap() + 1
    );
    let saved_job = daemon.journal.jobs().next().unwrap().1.clone();
    let saved_transport = daemon
        .journal
        .transport(&execute.signature)
        .unwrap()
        .clone();
    assert_eq!(saved_job.identity.id(), job_id);
    assert!(!saved_job.complete);
    assert_eq!(saved_job.payloads.len(), 1);
    assert_eq!(saved_job.attempts.last().unwrap(), &execute);
    assert_eq!(
        saved_transport["wireHex"],
        hex::encode(&execute.signed_bytes)
    );
    drop(daemon);
    std::fs::remove_file(&config.fee_key_file).unwrap();

    let mut process_steps = 0;
    for round in 0..16 {
        let status_outage = round % 2 == 0;
        unavailable.store(status_outage, Ordering::SeqCst);
        recover_process(&config_file).await;
        process_steps += 1;
        let daemon = Runtime::open(config.clone(), false).unwrap();
        let jobs: Vec<_> = daemon.journal.jobs().collect();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].1, &saved_job);
        assert_eq!(
            daemon.journal.transport(&execute.signature),
            Some(&saved_transport)
        );
        assert_eq!(
            rpc.call("testStats", json!([])).await.unwrap(),
            unchanged_stats,
            "unresolved status must not cause a replacement or resend"
        );
        assert_eq!(
            daemon
                .journal
                .alerts()
                .filter(|event| event.severity == Alert::Page && event.delivered)
                .count(),
            1
        );
    }
    assert_eq!(rejected_status_calls.load(Ordering::SeqCst), 8);
    assert_eq!(
        std::fs::read_dir(config.alert_sink_directory.as_ref().unwrap())
            .unwrap()
            .count(),
        1,
        "restarts must not duplicate the durable page event"
    );

    unavailable.store(false, Ordering::SeqCst);
    rpc.call("testSetMode", json!(["normal"])).await.unwrap();
    recover_process(&config_file).await;
    process_steps += 1;
    let daemon = Runtime::open(config.clone(), false).unwrap();
    let final_job = daemon.journal.jobs().next().unwrap().1;
    assert!(final_job.complete);
    assert_eq!(final_job.identity, saved_job.identity);
    assert_eq!(final_job.evidence, saved_job.evidence);
    assert_eq!(final_job.payloads, saved_job.payloads);
    assert_eq!(final_job.attempts.len(), saved_job.attempts.len());
    let final_execute = final_job.attempts.last().unwrap();
    assert_eq!(final_execute.signature, execute.signature);
    assert_eq!(final_execute.signed_bytes, execute.signed_bytes);
    assert!(matches!(
        final_execute.outcome,
        Outcome::FinalizedSuccess { .. }
    ));
    assert_eq!(
        daemon.journal.transport(&execute.signature),
        Some(&saved_transport)
    );
    assert_eq!(
        rpc.call("testStats", json!([])).await.unwrap(),
        unchanged_stats
    );
    let report = json!({
        "schema": 1,
        "passed": true,
        "scope": "One real-RP/tree-proof job, real signed v0, 17 fresh challengerd processes; synthetic finalized RPC outcomes and virtual discovery age; separate I09 actual Vault SBF acceptance",
        "jobs": 1,
        "fresh_process_recoveries": process_steps,
        "injected_status_503": rejected_status_calls.load(Ordering::SeqCst),
        "confirmed_only_restarts": 8,
        "fee_key_removed_before_restarts": true,
        "exact_execute_preserved": true,
        "extra_sends_during_outage_and_finality_recovery": 0,
        "proof_regenerations": 0,
        "durable_page_events_during_delay": 1,
        "finalized_without_fee_key": final_job.complete,
        "execute_bytes": execute.signed_bytes.len(),
        "execute_sha256": hex::encode(sha(&execute.signed_bytes)),
        "input_manifest_sha256": hex::encode(sha(&std::fs::read(&config.manifest).unwrap())),
        "elapsed_seconds": started.elapsed().as_secs_f64(),
        "live_rpc": false,
        "multi_job_load": false,
        "five_minute_production_slo_verified": false
    });
    std::fs::write(
        root.join("target/i09-challenger/i10-restart-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    proxy.abort();
    server.kill().await.unwrap();
}
