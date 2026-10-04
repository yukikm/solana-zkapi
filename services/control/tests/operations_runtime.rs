//! Real-process dispatcher / private administration / acknowledged restore tests.
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::json;
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{egress, ledger::*, operations::*, proxy, wire};
async fn client(url: &str) -> Client {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
async fn database() -> (String, Client, PoolIdentity, Ledger) {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")
        .expect("isolated PostgreSQL test database required");
    let admin = client(&base).await;
    let name = format!("zkapi_provider_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let config: tokio_postgres::Config = base.parse().unwrap();
    let url = format!(
        "host={} port={} user={} dbname={name}",
        match config.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(host) => host.clone(),
            tokio_postgres::config::Host::Unix(path) => path.display().to_string(),
        },
        config.get_ports().first().copied().unwrap_or(5432),
        config.get_user().unwrap()
    );
    migrate(&url).await.unwrap();
    let client = client(&url).await;
    let identity = PoolIdentity {
        pool: [1; 32],
        deployment_id: format!("provider-test-{name}"),
        manifest_hash: [2; 32],
        authorization_config: json!({"signer":{"receipt_key":SigningKey::from_bytes(&[31;32]).verifying_key().to_bytes()}}),
    };
    let ledger = Ledger::connect(&url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    (url, client, identity, ledger)
}
fn tariff_bytes(provider: &str) -> Vec<u8> {
    serde_jcs::to_vec(&json!({"version":"1","provider":provider,"model":"provider-test","pricing_basis":"fixed_usage_rates","valid_from":"0","valid_until":"4000000000","operator_fee_micro_usdc":"0","rates":[{"unit":"cache_read_tokens","nano_usdc_numerator":"1","unit_denominator":"1"},{"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"1"},{"unit":"output_tokens","nano_usdc_numerator":"1","unit_denominator":"1"}]})).unwrap()
}
async fn session(ledger: &Ledger, provider: &str, mode: &str, marker: u8) -> NewSession {
    let body = tariff_bytes(provider);
    let tariff = wire::sha256(&body);
    ledger.store_tariff(tariff, &body).await.unwrap();
    let body = serde_json::to_vec(&json!({"quote_id":Uuid::new_v4(), "models":["provider-test"]}))
        .unwrap();
    let quote = QuoteRecord {
        quote_id: Uuid::new_v4(),
        quote_hash: wire::sha256(&body),
        canonical_body: body,
        signature: vec![0; 64],
        tariff_hash: tariff,
        expires_at: 4_000_000_000,
    };
    ledger.store_quote(&quote).await.unwrap();
    let id = Uuid::new_v4();
    let transcript = id.as_bytes().to_vec();
    let session = NewSession {
        request_id: id,
        nullifier: [marker; 32],
        quote_id: quote.quote_id,
        request_digest: wire::sha256(&transcript),
        request_transcript: transcript,
        control_secret_hash: [3; 32],
        proxy_secret_hash: (mode == "proxy").then_some([4; 32]),
        mode: mode.into(),
        provider: provider.into(),
        cap_micro: 1_000_000,
        max_concurrency: 4,
    };
    ledger
        .reserve_session(&session, || async { Ok(()) })
        .await
        .unwrap();
    session
}
fn operation(id: Uuid, endpoint: &str) -> NewOperation {
    NewOperation {
        request_id: id,
        operation_id: Uuid::new_v4(),
        request_hmac: [8; 32],
        endpoint: endpoint.into(),
        model: "provider-test".into(),
        reservation_nano: 0,
    }
}

fn private(path: &std::path::Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
#[test]
fn local_transport_and_fence_certificate_are_fail_closed() {
    for value in [
        "host=127.0.0.1 hostaddr=8.8.8.8",
        "host=example.org",
        "host=localhost",
        "host=127.0.0.1,8.8.8.8",
    ] {
        assert!(local_database(value).is_err());
    }
    assert!(local_database("host=/tmp").is_ok());
    let key = SigningKey::from_bytes(&[72; 32]);
    let mut cert = FenceCertificate {
        pool: [1; 32],
        attempt_id: Uuid::new_v4(),
        owner_instance: Uuid::new_v4(),
        writer_epoch: 1,
        controller: "test-independent-supervisor".into(),
        resource_uid: "cgroup-unit-instance-1".into(),
        process_terminated: true,
        restart_denied: true,
        egress_revoked: true,
        observed_at: 100,
        signature: String::new(),
    };
    cert.signature = hex::encode(key.sign(&cert.signed_bytes().unwrap()).to_bytes());
    assert!(cert.verify(key.verifying_key().to_bytes(), 101).is_ok());
    assert!(cert.verify([1; 32], 101).is_err());
    assert!(cert.verify(key.verifying_key().to_bytes(), 401).is_err());
    cert.egress_revoked = false;
    assert!(cert.verify(key.verifying_key().to_bytes(), 101).is_err());
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn dispatcher_one_shot_process_and_restart_fencing() {
    let (url, sql, identity, ledger) = database().await;
    let s = session(&ledger, "openai", "proxy", 66).await;
    ledger
        .activate_proxy(s.request_id, 300, || async { Ok(()) })
        .await
        .unwrap();
    let mut op = operation(s.request_id, "/v1/chat/completions");
    op.reservation_nano = 101;
    ledger.reserve_operation(&op).await.unwrap();
    let attempt = ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.claim_dispatch(&attempt).await.unwrap();
    let counter = Arc::new(AtomicUsize::new(0));
    let observed = counter.clone();
    let app=axum::Router::new().route("/v1/chat/completions",axum::routing::post(move |headers:axum::http::HeaderMap|{let observed=observed.clone();async move {assert_eq!(headers["authorization"],"Bearer I09_PROVIDER_SECRET");if observed.fetch_add(1,Ordering::SeqCst)>0 {tokio::time::sleep(std::time::Duration::from_secs(5)).await;}axum::Json(json!({"id":"i09-request","choices":[{"message":{"content":"I09_RESPONSE_CANARY"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let credential = dir.path().join("secret");
    private(&credential, b"I09_PROVIDER_SECRET");
    let profile = proxy::ModelProfile {
        provider: wire::Provider::Openai,
        model: "provider-test".into(),
        endpoints: vec![proxy::Endpoint::ChatCompletions],
        context_tokens: 100,
        max_output_tokens: 10,
        cache_mode: proxy::CacheMode::InclusiveRead,
    };
    let role = format!("i09_read_{}", Uuid::new_v4().simple());
    sql.batch_execute(&format!(
        "CREATE ROLE {role} LOGIN; GRANT zkapi_control_reader TO {role}"
    ))
    .await
    .unwrap();
    let cfg = egress::ServiceConfig {
        local_test_only: true,
        database_url: format!("{url} user={role}"),
        pool: identity.pool,
        claims_directory: dir.path().into(),
        providers: zkapi_control::provider_runtime::ProviderConfig {
            dispatcher: None,
            direct: vec![],
            proxy: vec![zkapi_control::provider_runtime::ProxyProviderConfig {
                provider: wire::Provider::Openai,
                credential_file: credential,
                local_test_base: Some(origin),
                models: vec![profile.clone()],
            }],
        },
    };
    let path = dir.path().join("config");
    private(&path, &serde_json::to_vec(&cfg).unwrap());
    let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_dispatcherd"));
    let remote = egress::ClientConfig {
        binary_sha256: hex::encode(wire::sha256(&std::fs::read(&binary).unwrap())),
        binary,
        config_file: path,
    };
    let request = || {
        egress::Request{provider:wire::Provider::Openai,action:egress::Action::Proxy{attempt:attempt.clone(),endpoint:proxy::Endpoint::ChatCompletions,profile:profile.clone(),streaming:false,reservation_nano:"101".into(),body:br#"{"model":"provider-test","messages":[{"role":"user","content":"I09_PRIVATE_PROMPT_CANARY"}],"max_tokens":1}"#.to_vec()}}
    };
    let observation = remote.call(request(), None).await.unwrap();
    assert_eq!(observation["http_status"], 200);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    // A new child with the same attempt fails before external send, even if the
    // parent loses its response and old database flags still appear live.
    assert!(remote.call(request(), None).await.is_err());
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    let saved = std::fs::read(dir.path().join(attempt.attempt_id.to_string())).unwrap();
    let text = String::from_utf8(saved).unwrap();
    assert!(!text.contains("CANARY") && !text.contains("SECRET"));
    ledger
        .finish_attempt(
            &attempt,
            wire::sha256(b"child process exited; permanent claim retained"),
        )
        .await
        .unwrap();
    assert!(remote.call(request(), None).await.is_err());
    // Suspend a real egress owner after its request reaches the provider. A
    // replacement writer cannot invent completion. Stop/restart denial precedes
    // the independently authenticated fence and unknown waiver.
    let mut op2 = operation(s.request_id, "/v1/chat/completions");
    op2.reservation_nano = 101;
    ledger.reserve_operation(&op2).await.unwrap();
    let a2 = ledger
        .begin_dispatch(s.request_id, op2.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.claim_dispatch(&a2).await.unwrap();
    let mut body = serde_json::to_value(request()).unwrap();
    body["action"]["attempt"] = serde_json::to_value(&a2).unwrap();
    // Action is internally tagged and nested under the request's action field.
    let mut child = tokio::process::Command::new(&remote.binary)
        .arg(&remote.config_file)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    use tokio::io::AsyncWriteExt;
    let mut input = child.stdin.take().unwrap();
    let mut bytes = serde_json::to_vec(&body).unwrap();
    bytes.push(b'\n');
    input.write_all(&bytes).await.unwrap();
    drop(input);
    for _ in 0..200 {
        if counter.load(Ordering::SeqCst) == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(counter.load(Ordering::SeqCst), 2);
    let pid = child.id().unwrap().to_string();
    assert!(std::process::Command::new("kill")
        .args(["-STOP", &pid])
        .status()
        .unwrap()
        .success());
    ledger
        .mark_operation_unknown(s.request_id, op2.operation_id)
        .await
        .unwrap();
    assert!(!ledger
        .dispatch_attempts_for_session(s.request_id)
        .await
        .unwrap()
        .iter()
        .find(|r| r.attempt.attempt_id == a2.attempt_id)
        .unwrap()
        .quiesced());
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    let key = SigningKey::from_bytes(&[72; 32]);
    let mut certificate = FenceCertificate {
        pool: identity.pool,
        attempt_id: a2.attempt_id,
        owner_instance: a2.owner_instance,
        writer_epoch: a2.writer_epoch,
        controller: "test-process-supervisor".into(),
        resource_uid: format!("child-{pid}"),
        process_terminated: true,
        restart_denied: true,
        egress_revoked: true,
        observed_at: 100,
        signature: String::new(),
    };
    certificate.signature = hex::encode(key.sign(&certificate.signed_bytes().unwrap()).to_bytes());
    let evidence = certificate
        .verify(key.verifying_key().to_bytes(), 101)
        .unwrap();
    ledger.fence_attempt(&a2, &evidence).await.unwrap();
    assert!(!std::process::Command::new("kill")
        .args(["-CONT", &pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());
    assert!(remote
        .call(serde_json::from_value(body).unwrap(), None)
        .await
        .is_err());
    assert_eq!(counter.load(Ordering::SeqCst), 2);
    drop(ledger);
    let replacement = Ledger::connect(&url, &identity).await.unwrap();
    assert!(replacement.claim_dispatch(&attempt).await.is_err());
    server.abort();
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn dashboard_acl_redaction_and_restore_witness() {
    use tower::ServiceExt;
    let (url, mut sql, identity, ledger) = database().await;
    let s = session(&ledger, "openai", "proxy", 77).await;
    assert!(Ledger::connect(&url, &identity).await.is_err());
    let dir = tempfile::tempdir().unwrap();
    let token = "Abcd1234Abcd1234Abcd1234Abcd1234Abcd1234";
    let key = dir.path().join("admin-token");
    private(&key, token.as_bytes());
    let health_path = dir.path().join("health.json");
    let health = json!({"schema":1,"pool":bs58::encode(identity.pool).into_string(),
        "sample":{"observed_at":zkapi_control::monitoring::now().unwrap(),"measurements":{"root_slot_lag":"7"}},
        "sources":{"chain":"ready"},"source_instances":{},"alerts":[]});
    private(&health_path, &serde_json::to_vec(&health).unwrap());
    let config = AdminConfig {
        local_test_only: true,
        listen: "127.0.0.1:0".parse().unwrap(),
        database_url: url.clone(),
        pool: identity.pool,
        bearer_file: key,
        allowed_peers: vec!["127.0.0.1".parse().unwrap()],
        health_file: Some(health_path.clone()),
    };
    let app = Dashboard::connect(config.clone()).await.unwrap().router();
    for (auth, peer, origin, expected) in [
        (false, "127.0.0.1:1", false, 401),
        (true, "127.0.0.2:1", false, 401),
        (true, "127.0.0.1:1", true, 401),
        (true, "127.0.0.1:1", false, 200),
    ] {
        for path in [
            "/admin/v1/dashboard/summary",
            "/admin/v1/dashboard/recent",
            "/admin/v1/dashboard/events",
        ] {
            let mut req = axum::http::Request::builder().uri(path);
            if auth {
                req = req.header("authorization", format!("Bearer {token}"));
            }
            if origin {
                req = req.header("origin", "https://evil.invalid");
            }
            let mut req = req.body(axum::body::Body::empty()).unwrap();
            req.extensions_mut().insert(axum::extract::ConnectInfo(
                peer.parse::<std::net::SocketAddr>().unwrap(),
            ));
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status().as_u16(), expected);
            let body = axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap();
            let text = String::from_utf8(body.to_vec()).unwrap();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            let contract: serde_json::Value =
                serde_json::from_str(include_str!("../../../docs/contracts/openapi.json")).unwrap();
            let schema = if expected != 200 {
                "Error"
            } else if path.ends_with("summary") {
                "DashboardSummary"
            } else {
                "DashboardEvents"
            };
            let shape = &contract["components"]["schemas"][schema];
            for field in shape["required"].as_array().unwrap() {
                assert!(value.get(field.as_str().unwrap()).is_some());
            }
            for field in value.as_object().unwrap().keys() {
                assert!(
                    shape["properties"].get(field).is_some(),
                    "unexpected contract field: {field}"
                );
            }
            if expected == 200 && path.ends_with("summary") {
                assert_eq!(value["root_lag_slots"], "7");
                for amount in value.as_object().unwrap().values() {
                    assert!(wire::uint(amount.as_str().expect("dashboard integer string")).is_ok());
                }
            }
            if let Some(events) = value["events"].as_array() {
                let shape = &contract["components"]["schemas"]["DashboardEvent"];
                for event in events {
                    for field in shape["required"].as_array().unwrap() {
                        assert!(event.get(field.as_str().unwrap()).is_some());
                    }
                    for field in event.as_object().unwrap().keys() {
                        assert!(shape["properties"].get(field).is_some());
                    }
                }
            }
            for forbidden in [
                "request_transcript",
                "control_secret_hash",
                "proxy_secret_hash",
                "nullifier",
                token,
            ] {
                assert!(!text.contains(forbidden));
            }
        }
    }
    // Missing chain observations cannot be reported as healthy zero lag.
    std::fs::remove_file(&health_path).unwrap();
    let request = |path: &str| {
        let mut req = axum::http::Request::builder()
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo(
            "127.0.0.1:1".parse::<std::net::SocketAddr>().unwrap(),
        ));
        req
    };
    assert_eq!(
        app.clone()
            .oneshot(request("/admin/v1/dashboard/summary"))
            .await
            .unwrap()
            .status(),
        503
    );
    let mut stale = health.clone();
    stale["sample"]["observed_at"] = 1.into();
    private(&health_path, &serde_json::to_vec(&stale).unwrap());
    assert_eq!(
        app.clone()
            .oneshot(request("/admin/v1/dashboard/summary"))
            .await
            .unwrap()
            .status(),
        503
    );
    private(&health_path, &serde_json::to_vec(&health).unwrap());
    for i in 0..51 {
        sql.execute("INSERT INTO outbox(pool,dedup_key,event_type,metadata) VALUES($1::bytea,$2,'REVIEW_EVENT',$3)", &[&&identity.pool[..], &format!("review-event-{i}"), &json!({"secret":"PRIVATE_EVENT_CANARY"})]).await.unwrap();
    }
    let first = app
        .clone()
        .oneshot(request("/admin/v1/dashboard/events"))
        .await
        .unwrap();
    let first: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(first.into_body(), 65536)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["events"].as_array().unwrap().len(), 50);
    assert!(!first.to_string().contains("PRIVATE_EVENT_CANARY"));
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = app
        .clone()
        .oneshot(request(&format!(
            "/admin/v1/dashboard/events?cursor={cursor}"
        )))
        .await
        .unwrap();
    let second: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(second.into_body(), 65536)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["events"].as_array().unwrap().len(), 1);
    assert!(second["next_cursor"].is_null());
    for suffix in ["events?cursor=00", "recent?cursor=invalid"] {
        assert_eq!(
            app.clone()
                .oneshot(request(&format!("/admin/v1/dashboard/{suffix}")))
                .await
                .unwrap()
                .status(),
            400
        );
    }
    assert!(capture(&mut sql, identity.pool).await.is_err());
    ledger.set_accepting(false).await.unwrap();
    sql.batch_execute("SET TIME ZONE 'UTC'").await.unwrap();
    let checkpoint = capture(&mut sql, identity.pool).await.unwrap();
    checkpoint.save(&dir.path().join("witness")).unwrap();
    assert!(verify_restore(&mut sql, &checkpoint).await.is_ok());
    // A retained cut must not depend on the observer's session timezone.
    sql.batch_execute("SET TIME ZONE 'Asia/Tokyo'")
        .await
        .unwrap();
    assert!(verify_restore(&mut sql, &checkpoint).await.is_ok());
    sql.batch_execute("SET TIME ZONE 'UTC'").await.unwrap();
    // The CLI must bind the independently retained witness to the configured pool.
    let mut other_pool = config.clone();
    other_pool.pool = [9; 32];
    let config_path = dir.path().join("admin.json");
    private(&config_path, &serde_json::to_vec(&other_pool).unwrap());
    assert!(!tokio::process::Command::new(env!("CARGO_BIN_EXE_opsd"))
        .arg("verify-restore")
        .arg(&config_path)
        .arg(dir.path().join("witness"))
        .output()
        .await
        .unwrap()
        .status
        .success());
    let reseal = |w: &mut RecoveryWitness| {
        let mut value = serde_json::to_value(&*w).unwrap();
        value.as_object_mut().unwrap().remove("digest");
        w.digest = hex::encode(wire::sha256(&serde_jcs::to_vec(&value).unwrap()));
    };
    let mut ahead = checkpoint.clone();
    ahead.version = 1;
    reseal(&mut ahead);
    assert!(verify_restore(&mut sql, &ahead).await.is_err());
    let mut ahead = checkpoint.clone();
    ahead.wal_flush_lsn = "FFFFFFFF/FFFFFFFF".into();
    reseal(&mut ahead);
    assert!(verify_restore(&mut sql, &ahead).await.is_err());
    let mut foreign = checkpoint.clone();
    foreign.database_system_id = "1".into();
    reseal(&mut foreign);
    assert!(verify_restore(&mut sql, &foreign).await.is_err());

    let mut altered = checkpoint.clone();
    altered
        .rows
        .insert("nullifiers/missing-acknowledged".into(), "bad".into());
    assert!(altered.verify().is_err());
    // Simulate a trusted old snapshot that lacks an acknowledged reservation in an
    // isolated database, never mutate production or bypass runtime writer policy.
    let mut restored = checkpoint.clone();
    restored.rows.retain(|key, _| !key.starts_with("sessions/"));
    assert_ne!(checkpoint.rows, restored.rows);
    sql.batch_execute("ALTER TABLE sessions DISABLE TRIGGER ALL; DELETE FROM sessions; ALTER TABLE sessions ENABLE TRIGGER ALL").await.unwrap();
    assert!(verify_restore(&mut sql, &checkpoint).await.is_err());
    assert!(ledger.session(s.request_id).await.is_err());
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn restore_witness_covers_pool_tariff_provider_and_chain_state() {
    let (_, mut sql, identity, ledger) = database().await;
    let s = session(&ledger, "openai", "proxy", 78).await;
    sql.execute("INSERT INTO provider_evidence(evidence_id,pool,request_id,kind,digest,encrypted_record) VALUES($1,$2::bytea,$3,'PROXY_USAGE',$4::bytea,$5)", &[&Uuid::new_v4(), &&identity.pool[..], &s.request_id, &&[4u8;32][..], &&[1u8;16][..]]).await.unwrap();
    sql.execute("INSERT INTO chain_checkpoints(pool,finalized_slot,blockhash,tree_sequence,root,snapshot_hash) VALUES($1::bytea,1,$2::bytea,1,$2::bytea,$2::bytea)", &[&&identity.pool[..], &&[5u8;32][..]]).await.unwrap();
    sql.execute("INSERT INTO chain_events(pool,signature,instruction_index,event_index,slot,event_body) VALUES($1::bytea,$2,0,0,1,'{}')", &[&&identity.pool[..], &&[6u8;64][..]]).await.unwrap();
    sql.execute("INSERT INTO chain_transactions(pool,operation_id,payload_hash,state) VALUES($1::bytea,$2,$3::bytea,'UNKNOWN')", &[&&identity.pool[..], &Uuid::new_v4(), &&[7u8;32][..]]).await.unwrap();
    ledger.set_accepting(false).await.unwrap();
    sql.batch_execute("SET TIME ZONE 'UTC'").await.unwrap();
    let checkpoint = capture(&mut sql, identity.pool).await.unwrap();
    for (table, mutation, restore) in [
        ("pools", "ALTER TABLE pools DISABLE TRIGGER ALL; UPDATE pools SET authorization_config='{}'; ALTER TABLE pools ENABLE TRIGGER ALL", "ALTER TABLE pools DISABLE TRIGGER ALL"),
        ("tariffs", "ALTER TABLE tariffs DISABLE TRIGGER ALL; UPDATE tariffs SET canonical_body='altered'; ALTER TABLE tariffs ENABLE TRIGGER ALL", "ALTER TABLE tariffs DISABLE TRIGGER ALL"),
        ("provider_evidence", "DELETE FROM provider_evidence", ""),
        ("chain_checkpoints", "DELETE FROM chain_checkpoints", ""),
        ("chain_events", "DELETE FROM chain_events", ""),
        ("chain_transactions", "DELETE FROM chain_transactions", ""),
    ] {
        // Isolated superuser corruption simulates an incomplete restore, never a
        // supported financial mutation. Retain and restore the original bytes.
        let original: serde_json::Value = sql.query_one(&format!("SELECT jsonb_agg(to_jsonb(t)) FROM {table} t"), &[]).await.unwrap().get(0);
        sql.batch_execute(mutation).await.unwrap();
        assert!(verify_restore(&mut sql, &checkpoint).await.is_err(), "unwitnessed restore change: {table}");
        sql.batch_execute(restore).await.unwrap();
        let restore_sql = match table {
            "pools" => "UPDATE pools SET authorization_config=(SELECT authorization_config FROM jsonb_populate_recordset(NULL::pools,$1))".into(),
            "tariffs" => "UPDATE tariffs SET canonical_body=(SELECT canonical_body FROM jsonb_populate_recordset(NULL::tariffs,$1))".into(),
            _ => format!("INSERT INTO {table} SELECT * FROM jsonb_populate_recordset(NULL::{table},$1)"),
        };
        sql.execute(&restore_sql, &[&original]).await.unwrap();
        if !restore.is_empty() {
            sql.batch_execute(&format!("ALTER TABLE {table} ENABLE TRIGGER ALL")).await.unwrap();
        }
        assert!(verify_restore(&mut sql, &checkpoint).await.is_ok());
    }
}

#[tokio::test]
async fn envelope_authenticates_role_and_kms_failure_has_no_plaintext_fallback() {
    use zkapi_control::custody::{Config, Envelope};
    let dir = tempfile::tempdir().unwrap();
    let helper = dir.path().join("test-kms");
    private(&helper,b"#!/usr/bin/python3\nimport json,sys\nr=json.load(sys.stdin)\nassert r['operation']=='unwrap_aes256_key' and r['key_ref']=='local-fixture-kms-key' and r['encryption_context']['role']=='state'\nsys.stdout.buffer.write(bytes([73])*32)\n");
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut e = Envelope {
        version: 1,
        deployment: "local-acceptance".into(),
        pool: [1; 32],
        role: "state".into(),
        kms_key_ref: "local-fixture-kms-key".into(),
        wrapped_data_key: "opaque-fixture-data-key".into(),
        nonce_hex: hex::encode([3; 12]),
        ciphertext_hex: String::new(),
    };
    let aead = ring::aead::LessSafeKey::new(
        ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, &[73; 32]).unwrap(),
    );
    let mut cipher = vec![42; 32];
    aead.seal_in_place_append_tag(
        ring::aead::Nonce::assume_unique_for_key([3; 12]),
        ring::aead::Aad::from(e.aad().unwrap()),
        &mut cipher,
    )
    .unwrap();
    e.ciphertext_hex = hex::encode(cipher);
    let path = dir.path().join("state.envelope");
    private(&path, &serde_json::to_vec(&e).unwrap());
    let mut config = Config {
        helper_sha256: hex::encode(wire::sha256(&std::fs::read(&helper).unwrap())),
        helper,
        deployment: e.deployment.clone(),
        pool: e.pool,
        envelopes: std::collections::BTreeMap::from([("state".into(), path.clone())]),
    };
    assert_eq!(*config.load("state").await.unwrap(), [42; 32]);
    e.role = "clearance".into();
    private(&path, &serde_json::to_vec(&e).unwrap());
    assert!(config.load("state").await.is_err());
    e.role = "state".into();
    e.ciphertext_hex.replace_range(0..2, "ff");
    private(&path, &serde_json::to_vec(&e).unwrap());
    assert!(config.load("state").await.is_err());
    config.helper_sha256 = hex::encode([0; 32]);
    assert!(config.load("state").await.is_err());
}

#[tokio::test]
async fn mutual_tls_bridge_rejects_an_unpinned_client_and_plaintext() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use zkapi_control::mtls::Config;
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let run = |args: Vec<String>| {
        let out = std::process::Command::new("openssl")
            .args(args)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "certificate fixture failed");
    };
    run([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-subj",
        "/CN=I09-local-ca",
        "-days",
        "1",
    ]
    .iter()
    .map(|x| x.to_string())
    .collect());
    for name in ["server", "client", "wrong"] {
        run(vec![
            "req".into(),
            "-newkey".into(),
            "rsa:2048".into(),
            "-nodes".into(),
            "-keyout".into(),
            format!("{name}.key"),
            "-out".into(),
            format!("{name}.csr"),
            "-subj".into(),
            format!("/CN={name}"),
        ]);
        std::fs::write(
            dir.path().join("extensions"),
            "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n",
        )
        .unwrap();
        run(vec![
            "x509".into(),
            "-req".into(),
            "-in".into(),
            format!("{name}.csr"),
            "-CA".into(),
            "ca.pem".into(),
            "-CAkey".into(),
            "ca.key".into(),
            "-CAcreateserial".into(),
            "-out".into(),
            format!("{name}.pem"),
            "-days".into(),
            "1".into(),
            "-extfile".into(),
            "extensions".into(),
        ]);
        run(vec![
            "x509".into(),
            "-in".into(),
            format!("{name}.pem"),
            "-outform".into(),
            "DER".into(),
            "-out".into(),
            format!("{name}.der"),
        ]);
        run(vec![
            "pkcs8".into(),
            "-topk8".into(),
            "-nocrypt".into(),
            "-in".into(),
            format!("{name}.key"),
            "-outform".into(),
            "DER".into(),
            "-out".into(),
            format!("{name}-key.der"),
        ]);
        std::fs::set_permissions(
            dir.path().join(format!("{name}-key.der")),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    run(
        ["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"]
            .iter()
            .map(|x| x.to_string())
            .collect(),
    );
    let backend_path = dir.path().join("backend.sock");
    let backend = tokio::net::UnixListener::bind(&backend_path).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let backend_task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = backend.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut bytes = [0; 4];
                if socket.read_exact(&mut bytes).await.is_ok() {
                    seen.fetch_add(1, Ordering::SeqCst);
                    socket.write_all(&bytes).await.unwrap();
                }
            });
        }
    });
    let reserve = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reserve.local_addr().unwrap();
    drop(reserve);
    let pin = |name: &str| {
        hex::encode(wire::sha256(
            &std::fs::read(dir.path().join(format!("{name}.der"))).unwrap(),
        ))
    };
    let server = Config {
        mode: "server".into(),
        listen: address,
        remote: address,
        server_name: "localhost".into(),
        unix_socket: backend_path,
        ca_der: dir.path().join("ca.der"),
        certificate_der: dir.path().join("server.der"),
        private_key_der: dir.path().join("server-key.der"),
        peer_certificate_sha256: pin("client"),
    };
    let server_task = tokio::spawn(server.clone().run());
    let mut good = server.clone();
    good.mode = "client".into();
    good.unix_socket = dir.path().join("good.sock");
    good.certificate_der = dir.path().join("client.der");
    good.private_key_der = dir.path().join("client-key.der");
    good.peer_certificate_sha256 = pin("server");
    let good_task = tokio::spawn(good.clone().run());
    let mut bad = good.clone();
    bad.unix_socket = dir.path().join("bad.sock");
    bad.certificate_der = dir.path().join("wrong.der");
    bad.private_key_der = dir.path().join("wrong-key.der");
    let bad_task = tokio::spawn(bad.clone().run());
    for _ in 0..100 {
        if good.unix_socket.exists() && bad.unix_socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let mut valid = tokio::net::UnixStream::connect(&good.unix_socket)
        .await
        .unwrap();
    valid.write_all(b"PING").await.unwrap();
    let mut result = [0; 4];
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        valid.read_exact(&mut result),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&result, b"PING");
    let mut invalid = tokio::net::UnixStream::connect(&bad.unix_socket)
        .await
        .unwrap();
    invalid.write_all(b"PING").await.unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_secs(3),
        invalid.read_exact(&mut result)
    )
    .await
    .unwrap()
    .is_err());
    let mut clear = tokio::net::TcpStream::connect(address).await.unwrap();
    clear.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    let plaintext_result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        clear.read_exact(&mut result),
    )
    .await
    .unwrap();
    assert!(plaintext_result.is_err() || result[0] == 21); // TLS fatal alert, never HTTP.
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    good_task.abort();
    bad_task.abort();
    server_task.abort();
    backend_task.abort();
}

#[test]
fn monitoring_missing_stale_unknown_and_counter_rollback_are_never_healthy() {
    let empty = HealthSample {
        observed_at: 100,
        measurements: Default::default(),
    };
    assert!(evaluate_health(&empty, None, 100)
        .unwrap()
        .iter()
        .all(|a| a.reason == "missing_measurement"));
    assert!(evaluate_health(&empty, None, 161)
        .unwrap()
        .iter()
        .all(|a| a.reason == "stale_measurement"));
    let mut current = empty.clone();
    current
        .measurements
        .insert("usage_unknown".into(), "3".into());
    current
        .measurements
        .insert("signer_refused_requests_total".into(), "1".into());
    assert!(evaluate_health(&current, None, 100)
        .unwrap()
        .iter()
        .any(|a| a.metric == "usage_unknown" && a.severity == "warn"));
    let mut past = current.clone();
    past.measurements
        .insert("signer_refused_requests_total".into(), "2".into());
    assert!(evaluate_health(&current, Some(&past), 100)
        .unwrap()
        .iter()
        .any(|a| a.reason == "counter_rollback"));
    current
        .measurements
        .insert("usage_unknown".into(), "03".into());
    assert!(evaluate_health(&current, None, 100).is_err());
}

#[test]
fn postgres_lsn_order_and_malformed_boundaries() {
    assert!(parse_lsn("1/0").unwrap() > parse_lsn("0/FFFFFFFF").unwrap());
    for bad in [
        "1",
        "-1/0",
        "0/-1",
        "0/100000000",
        "100000000/0",
        "0/1/2",
        "00/1",
        "0/abc",
        "0/",
    ] {
        assert!(parse_lsn(bad).is_err(), "{bad}");
    }
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn provider_breaker_reset_requires_terminal_work_and_updates_the_running_runtime() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use zkapi_control::{
        provider_runtime::{ProviderConfig, ProviderRuntime},
        receipts::{Receipt, ReceiptBody},
    };
    let (url, sql, identity, mut ledger) = database().await;
    let runtime = ProviderRuntime::connect(&ProviderConfig::default(), true)
        .await
        .unwrap();
    let provider = wire::Provider::Openai;
    let session = session(&ledger, "openai", "proxy", 83).await;
    ledger
        .activate_proxy(session.request_id, 300, || async { Ok(()) })
        .await
        .unwrap();
    assert!(runtime.available(&ledger, &provider).await);

    for cycle in 0..2 {
        for index in 0..3 {
            let operation = operation(session.request_id, "/v1/chat/completions");
            ledger.reserve_operation(&operation).await.unwrap();
            assert!(matches!(
                ledger.reset_provider_admission("openai", [6; 32]).await,
                Err(LedgerError::Unavailable("provider_reconciliation_pending"))
            ));
            let attempt = ledger
                .begin_dispatch(
                    session.request_id,
                    operation.operation_id,
                    Uuid::new_v4(),
                    || async { Ok(()) },
                )
                .await
                .unwrap();
            assert!(ledger
                .reset_provider_admission("openai", [6; 32])
                .await
                .is_err());
            ledger.claim_dispatch(&attempt).await.unwrap();
            ledger
                .mark_streaming(session.request_id, operation.operation_id)
                .await
                .unwrap();
            assert!(ledger
                .reset_provider_admission("openai", [6; 32])
                .await
                .is_err());
            ledger
                .mark_operation_unknown(session.request_id, operation.operation_id)
                .await
                .unwrap();
            assert!(ledger
                .reset_provider_admission("openai", [6; 32])
                .await
                .is_err());
            ledger.finish_attempt(&attempt, [7; 32]).await.unwrap();

            let receipt_id = Uuid::new_v4();
            let signed = Receipt::sign(
                ReceiptBody {
                    version: "1".into(),
                    receipt_id: receipt_id.to_string(),
                    deployment_id: identity.deployment_id.clone(),
                    pool: bs58::encode(identity.pool).into_string(),
                    request_id: session.request_id.to_string(),
                    operation_id: Some(operation.operation_id.to_string()),
                    billing_effect: "charge".into(),
                    related_receipt_hash: None,
                    observed_at: "1".into(),
                    evidence_kind: "UNKNOWN_OPERATOR_LOSS".into(),
                    provider_request_id: None,
                    provider_evidence_digest: None,
                    tariff_hash: hex::encode(wire::sha256(&tariff_bytes("openai"))),
                    usage: vec![],
                    provider_reported_usd: None,
                    reservation_nano_usdc: "0".into(),
                    observed_nano_usdc: None,
                    charged_nano_usdc: "0".into(),
                    operator_loss_nano_usdc: None,
                    reason: "waived_unknown".into(),
                },
                &SigningKey::from_bytes(&[31; 32]),
            )
            .unwrap();
            let receipt = ReceiptRecord {
                sequence: 0,
                receipt_id,
                request_id: session.request_id,
                operation_id: Some(operation.operation_id),
                billing_effect: "charge".into(),
                canonical_body: signed.body.canonical_bytes().unwrap(),
                receipt_hash: wire::hash(&signed.receipt_hash).unwrap(),
                signature: Some(STANDARD.decode(signed.signature).unwrap()),
            };
            ledger
                .complete_operation(
                    session.request_id,
                    operation.operation_id,
                    OperationOutcome::UnknownWaived,
                    &receipt,
                )
                .await
                .unwrap();
            assert_eq!(runtime.available(&ledger, &provider).await, index < 2);
        }
        // Restart alone cannot clear the durable breaker. Keep the runtime
        // object alive to exercise immediate admission after the audited reset.
        drop(ledger);
        ledger = Ledger::connect(&url, &identity).await.unwrap();
        ledger.set_accepting(true).await.unwrap();
        assert!(!runtime.available(&ledger, &provider).await);
        ledger
            .reset_provider_admission("openai", [8; 32])
            .await
            .unwrap();
        assert!(runtime.available(&ledger, &provider).await);
        let resets: i64 = sql
            .query_one(
                "SELECT count(*) FROM outbox WHERE event_type='PROVIDER_ADMISSION_RESET'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(resets, cycle + 1);
        // Next cycle adds work to the same pre-reset session; those new unknown
        // operations must trip the breaker again instead of being exempted.
    }
}
