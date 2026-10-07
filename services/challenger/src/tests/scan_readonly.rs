//! Native CLI dispatch with a real SELECT-only PostgreSQL repository and the
//! existing SBF archive. Signed v0 bytes are prepared locally by the SDK; neither
//! scan invocation may recover, sign, send, or change an Unknown attempt.
use super::*;
use axum::{routing::post, Json, Router};
use std::{
    os::unix::fs::PermissionsExt,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::io::AsyncWriteExt;

#[tokio::test]
#[ignore = "requires disposable ZKAPI_I09_DATABASE_URL, Node and existing I04 SBF archive"]
async fn native_scan_discovers_and_advances_archive_without_recovering_unknown_execute() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let source_dsn = std::env::var("ZKAPI_I09_DATABASE_URL").expect("disposable DB only");
    let source: tokio_postgres::Config = source_dsn.parse().unwrap();
    assert!(!source.get_hosts().is_empty());
    assert!(source
        .get_hosts()
        .iter()
        .all(|host| matches!(host, tokio_postgres::config::Host::Unix(_))));
    assert!(source.get_hostaddrs().is_empty());
    let (admin, connection) = source.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let database = format!("i10_scan_{suffix}");
    let reader = format!("i10_scan_reader_{suffix}");
    admin
        .batch_execute(&format!("CREATE DATABASE {database}"))
        .await
        .unwrap();
    admin
        .batch_execute(&format!("CREATE ROLE {reader} LOGIN"))
        .await
        .unwrap();
    let host = match &source.get_hosts()[0] {
        tokio_postgres::config::Host::Unix(path) => path.to_str().unwrap(),
        _ => unreachable!(),
    };
    let dsn = format!(
        "host={host} port={} user={} dbname={database}",
        source.get_ports().first().copied().unwrap_or(5432),
        source.get_user().unwrap()
    );
    zkapi_control::ledger::migrate(&dsn).await.unwrap();
    let (db, connection) = tokio_postgres::connect(&dsn, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let (trust, manifest) = trust_and_manifest();
    let evidence = evidence(&trust);
    let pool = trust.pool();
    let hash = [5u8; 32];
    db.execute("INSERT INTO pools(pool,deployment_id,manifest_hash,writer_epoch,accepting) VALUES($1::bytea,$2,$3::bytea,7,true)", &[&&pool[..], &trust.deployment, &&trust.manifest_hash[..]]).await.unwrap();
    db.execute(
        "INSERT INTO tariffs(tariff_hash,canonical_body) VALUES($1::bytea,$2)",
        &[&&hash[..], &vec![1u8]],
    )
    .await
    .unwrap();
    db.execute("INSERT INTO quotes(pool,quote_id,quote_hash,canonical_body,signature,tariff_hash,expires_at) VALUES($1::bytea,$2,$3::bytea,$4,$5,$3::bytea,2)", &[&&pool[..], &evidence.request_id, &&hash[..], &vec![1u8], &vec![0u8;64]]).await.unwrap();
    db.execute("INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'AUTH')", &[&&pool[..], &&evidence.nullifier[..]]).await.unwrap();
    db.execute("INSERT INTO sessions(pool,request_id,nullifier,quote_id,request_digest,request_transcript,control_secret_hash,proxy_secret_hash,mode,provider,state,cap_micro,max_concurrency,writer_epoch) VALUES($1::bytea,$2,$3::bytea,$2,$4::bytea,$5,$6::bytea,$6::bytea,'proxy','openai','SETTLED',1000000,1,7)", &[&&pool[..], &evidence.request_id, &&evidence.nullifier[..], &&evidence.transcript_digest[..], &evidence.transcript, &&hash[..]]).await.unwrap();
    db.batch_execute(&format!("GRANT USAGE ON SCHEMA public TO {reader}; GRANT SELECT ON pools,nullifier_reservations,sessions TO {reader}")).await.unwrap();
    let reader_dsn = format!(
        "host={host} port={} user={reader} dbname={database}",
        source.get_ports().first().copied().unwrap_or(5432)
    );
    let (reader_db, connection) = tokio_postgres::connect(&reader_dsn, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    assert!(reader_db
        .execute("UPDATE pools SET accepting=false", &[])
        .await
        .is_err());

    let history: Value = serde_json::from_slice(
        &std::fs::read(root.join("target/i04/sdk-svm-history.json")).unwrap(),
    )
    .unwrap();
    let scenario = history["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|scenario| scenario["name"] == "challenge")
        .unwrap()
        .clone();
    let cut = scenario["checkpoints"][2].clone();
    assert_eq!(cut["slot"], 15);
    let tip = Arc::new(AtomicU64::new(15));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let route = {
        let tip = tip.clone();
        let calls = calls.clone();
        let genesis = trust.pool.genesis_hash.clone();
        post(move |Json(request): Json<Value>| {
            let tip = tip.load(Ordering::SeqCst);
            let calls = calls.clone();
            let genesis = genesis.clone();
            let scenario = scenario.clone();
            let cut = cut.clone();
            async move {
                let method = request["method"].as_str().unwrap();
                calls.lock().unwrap().push(method.to_owned());
                let result = match method {
                    "getGenesisHash" => json!(genesis),
                    "getSlot" => json!(tip),
                    "getBlocks" => json!(scenario["blocks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b["slot"].as_u64().unwrap())
                        .filter(|s| *s >= request["params"][0].as_u64().unwrap()
                            && *s <= request["params"][1].as_u64().unwrap())
                        .collect::<Vec<_>>()),
                    "getBlock" => scenario["blocks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|b| b["slot"] == request["params"][0])
                        .unwrap()["block"]
                        .clone(),
                    "getMultipleAccounts" => {
                        json!({"context":{"slot":tip},"value":request["params"][0].as_array().unwrap().iter().map(|key| cut["accounts"][key.as_str().unwrap()].clone()).collect::<Vec<_>>()})
                    }
                    _ => {
                        return Json(
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"transport forbidden"}}),
                        )
                    }
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
    let dir = tempfile::tempdir().unwrap();
    let manifest_file = dir.path().join("manifest.json");
    std::fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let dsn_file = dir.path().join("reader-dsn");
    std::fs::write(&dsn_file, reader_dsn).unwrap();
    std::fs::set_permissions(&dsn_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let node = std::env::var_os("ZKAPI_NODE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let result = std::process::Command::new("which")
                .arg("node")
                .output()
                .unwrap();
            assert!(result.status.success());
            std::path::PathBuf::from(String::from_utf8(result.stdout).unwrap().trim())
        });
    let marker = dir.path().join("bridge-invoked");
    let bridge_file = dir.path().join("bridge-tripwire.mjs");
    std::fs::write(
        &bridge_file,
        format!(
            "import {{writeFileSync}} from 'node:fs'; writeFileSync({},'called'); process.exit(1);",
            serde_json::to_string(&marker).unwrap()
        ),
    )
    .unwrap();
    let mut config = runtime::Config {
        manifest: manifest_file,
        manifest_sha256: hex::encode(trust.manifest_hash),
        devnet: None,
        rpc_url: format!("http://{address}"),
        database_dsn_file: dsn_file,
        start_slot: 1,
        journal_directory: dir.path().join("journal"),
        tree_pk: dir.path().join("absent-pk"),
        node: node.clone(),
        transport_bridge_sha256: hex::encode(sha(&std::fs::read(&bridge_file).unwrap())),
        transport_bridge: bridge_file,
        fee_key_file: dir.path().join("absent-fee-key"),
        payer: zkapi_indexer::snapshot::key([7; 32]),
        poll_seconds: 1,
        alert_sink_directory: None,
        priority_fee: None,
        archive_batch: None,
    };
    let mut runtime = runtime::Runtime::open(config.clone(), true).unwrap();
    let view = runtime.scan().await.unwrap();
    let prepared = PreparedChallenge::from_finalized(&view, 0, evidence.clone()).unwrap();
    let bytes = payload(&prepared, &trust);
    let id = prepared.job.id();
    let checkpoint = runtime.checkpoint(&view);
    runtime
        .journal
        .enqueue_cut(
            checkpoint.clone(),
            vec![(prepared.job, evidence)],
            runtime::now(),
        )
        .unwrap();
    let input = json!({"programId":trust.pool.program_id,"pool":trust.pool.pool,"mint":trust.pool.mint,"noteId":0,"payloadHex":hex::encode(&bytes),"nonceHex":"09".repeat(32),"expires":"3000003600","slot":15,"sequence":view.state.sequence.to_string()});
    let source = "import {createKeyPairSignerFromPrivateKeyBytes,getAddressEncoder} from '@solana/kit'; import {challengePlan,signChallengeStep,challengerWallet,validateChallengeAttempt} from './packages/sdk/src/challenger.ts'; let text=''; for await(const c of process.stdin)text+=c; const input=JSON.parse(text); const seed=new Uint8Array(32).fill(10),key=await createKeyPairSignerFromPrivateKeyBytes(seed); input.payer=key.address; const plan=await challengePlan(input); const index=plan.steps.findIndex(s=>s.kind==='execute'); const a=await signChallengeStep(input,index,{blockhash:key.address,lastValidBlockHeight:100000},await challengerWallet(new Uint8Array([...seed,...getAddressEncoder().encode(key.address)]))); await validateChallengeAttempt(a); process.stdout.write(JSON.stringify(a));";
    let mut child = tokio::process::Command::new(&node)
        .args(["--input-type=module", "-e", source])
        .current_dir(&root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&input).unwrap())
        .await
        .unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "SDK preparation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let transport: Value = serde_json::from_slice(&output.stdout).unwrap();
    let buffer = zkapi_indexer::snapshot::parse_key(transport["buffer"].as_str().unwrap()).unwrap();
    let attempt = Attempt {
        signature: transport["signature"].as_str().unwrap().into(),
        signed_bytes: hex::decode(transport["wireHex"].as_str().unwrap()).unwrap(),
        stage: Stage::Execute,
        payload_digest: sha(&bytes),
        buffer,
        outcome: Outcome::Unknown,
    };
    config.payer = transport["plan"]["feePayer"].as_str().unwrap().into();
    runtime
        .journal
        .save_payload(
            &id,
            Payload {
                bytes,
                digest: attempt.payload_digest,
                buffer,
                checkpoint,
            },
        )
        .unwrap();
    runtime
        .journal
        .save_v0_attempt(&id, attempt.clone(), transport.clone())
        .unwrap();
    let before = runtime.journal.jobs().next().unwrap().1.clone();
    assert_eq!(before.first_execute_send_at, None);
    assert_eq!(runtime.journal.archive_tail().unwrap().slot, 15);
    drop(runtime);

    tip.store(16, Ordering::SeqCst);
    calls.lock().unwrap().clear();
    // Exercise the actual compiled CLI dispatch, not a predicate mirroring it.
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        runtime::run(config.clone(), "scan"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!marker.exists(), "scan invoked the SDK bridge");
    let mut journal = Journal::open(&config.journal_directory, trust.pool()).unwrap();
    assert_eq!(journal.archive_tail().unwrap().slot, 16);
    assert_eq!(
        journal.checkpoint().unwrap().position.slot,
        16,
        "discovery must checkpoint its SELECT-only evidence read"
    );
    assert_eq!(journal.jobs().next().unwrap().1, &before);
    assert_eq!(journal.transport(&attempt.signature), Some(&transport));
    journal.record_execute_send(&id, runtime::now()).unwrap();
    let previously_sent = journal.jobs().next().unwrap().1.clone();
    assert!(previously_sent.first_execute_send_at.is_some());
    drop(journal);
    runtime::run(config.clone(), "scan").await.unwrap();
    let journal = Journal::open(&config.journal_directory, trust.pool()).unwrap();
    assert_eq!(journal.jobs().next().unwrap().1, &previously_sent);
    assert_eq!(journal.transport(&attempt.signature), Some(&transport));
    assert!(!marker.exists());
    assert!(calls.lock().unwrap().iter().all(|method| [
        "getGenesisHash",
        "getSlot",
        "getBlocks",
        "getBlock",
        "getMultipleAccounts"
    ]
    .contains(&method.as_str())));
    let health: Value = serde_json::from_slice(
        &std::fs::read(config.journal_directory.join("health.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(health["ready"], true);
    let row = db
        .query_one("SELECT writer_epoch,accepting FROM pools", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, i64>(0), 7);
    assert!(row.get::<_, bool>(1));
    drop(journal);
    // Positive control: the same pinned bridge is reachable from explicit
    // recovery. Only scan is observation-only; workers retain recovery.
    assert!(runtime::run(config, "recover").await.is_err());
    assert!(marker.exists(), "recovery did not reach the armed bridge");
    server.abort();
}
