//! Local HTTP fixtures exercise actual adapter HTTP, exact decimals and recovery.
//! No provider account or production credential is involved.
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use uuid::Uuid;
use zkapi_control::direct::*;

#[derive(Default)]
struct Fixture {
    events: Vec<String>,
    body: Option<Value>,
    disabled: bool,
    deleted: bool,
    fail_create: bool,
    fail_delete: bool,
    missing_usage: bool,
    usage_raw: Option<String>,
    bad_limit: bool,
}
type Shared = Arc<Mutex<Fixture>>;
fn key_data(s: &Fixture) -> Value {
    let body = s.body.as_ref().unwrap();
    json!({"hash":"provider-hash","name":body["name"],"limit":if s.bad_limit {json!(5000)} else {body["limit"].clone()},
        "expires_at":body["expires_at"],"include_byok_in_limit":true,"disabled":s.disabled,"usage":0,"byok_usage":0,"limit_reset":null})
}
async fn create(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Bearer management-secret"
    );
    assert_eq!(body["include_byok_in_limit"], true);
    assert_eq!(body["limit_reset"], Value::Null);
    let mut s = state.lock().unwrap();
    s.events.push("create".into());
    s.body = Some(body);
    if s.fail_create {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"provider-secret-canary"})),
        );
    }
    (
        StatusCode::CREATED,
        Json(json!({"data":key_data(&s),"key":"runtime-key-canary"})),
    )
}
async fn list(State(state): State<Shared>, uri: axum::http::Uri) -> Json<Value> {
    let mut s = state.lock().unwrap();
    s.events.push("list".into());
    assert!(uri.query().unwrap().contains("include_disabled=true"));
    Json(
        json!({"data":if uri.query().unwrap().starts_with("offset=0&") && s.body.is_some() {vec![key_data(&s)]}else{vec![]}}),
    )
}
async fn disable(
    State(state): State<Shared>,
    Path(hash): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(hash, "provider-hash");
    assert_eq!(body, json!({"disabled":true}));
    let mut s = state.lock().unwrap();
    s.events.push("disable".into());
    s.disabled = true;
    Json(json!({"data":key_data(&s)}))
}
async fn usage(State(state): State<Shared>) -> impl IntoResponse {
    let mut s = state.lock().unwrap();
    s.events.push("usage".into());
    if s.deleted {
        return (StatusCode::NOT_FOUND, "{}".into());
    }
    assert!(s.disabled);
    if let Some(raw) = &s.usage_raw {
        return (StatusCode::OK, raw.clone());
    }
    let mut data = key_data(&s);
    data["usage"] = json!(0.000000001);
    data["byok_usage"] = json!(0.0000000001);
    if s.missing_usage {
        data.as_object_mut().unwrap().remove("byok_usage");
    }
    (StatusCode::OK, json!({"data":data}).to_string())
}
async fn delete(State(state): State<Shared>) -> impl IntoResponse {
    let mut s = state.lock().unwrap();
    s.events.push("delete".into());
    assert!(s.disabled);
    if s.deleted {
        return (StatusCode::NOT_FOUND, Json(json!({})));
    }
    s.deleted = true;
    if s.fail_delete {
        return (StatusCode::BAD_GATEWAY, Json(json!({})));
    }
    (StatusCode::OK, Json(json!({"deleted":true})))
}
fn credential() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credential");
    std::fs::write(&path, "management-secret").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    (dir, path)
}
async fn openrouter_fixture(
    state: Shared,
    grace: u64,
) -> (TempDir, DirectAdapter, tokio::task::JoinHandle<()>) {
    let (dir, path) = credential();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/api/v1/keys", post(create).get(list))
        .route(
            "/api/v1/keys/{hash}",
            get(usage).patch(disable).delete(delete),
        )
        .with_state(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let adapter = DirectAdapter::new(
        DirectConfig::Openrouter {
            api_base: format!("{base}/api/v1"),
            credential_file: path,
            inference_base: format!("{base}/api/v1"),
            settlement_grace_seconds: grace,
        },
        true,
    )
    .unwrap();
    (dir, adapter, task)
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn intent() -> IssueIntent {
    IssueIntent {
        request_id: Uuid::new_v4(),
        cap_micro: 1_000_000,
        ttl_seconds: 60,
        requested_at: now(),
    }
}

#[tokio::test]
async fn openrouter_exact_decimal_lease_and_retirement_order() {
    let state = Shared::default();
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 60).await;
    let intent = intent();
    let key = adapter.create_key(&intent).await.unwrap();
    adapter.verify_created(&key).await.unwrap();
    assert_eq!(key.runtime_key, "runtime-key-canary");
    adapter.disable_key(&key.reference).await.unwrap();
    assert!(adapter
        .read_usage(&intent, &key.reference, 100, 159)
        .await
        .unwrap()
        .is_none());
    let usage = adapter
        .read_usage(&intent, &key.reference, 100, 160)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.provider_reported_usd, "0.0000000011");
    assert_eq!(usage.observed_nano, "2");
    assert_eq!(usage.evidence_kind, "OPENROUTER_USAGE");
    adapter.delete_key(&key.reference).await.unwrap();
    assert_eq!(
        state.lock().unwrap().events,
        ["create", "disable", "usage", "delete"]
    );
    task.abort();
}
#[tokio::test]
async fn openrouter_lost_issuance_is_read_only_recovery_and_usage_is_strict() {
    let state = Arc::new(Mutex::new(Fixture {
        fail_create: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let intent = intent();
    let error = adapter.create_key(&intent).await.err().unwrap();
    assert!(!error.to_string().contains("canary"));
    let reference = adapter.recover_key(&intent).await.unwrap().unwrap();
    adapter.disable_key(&reference).await.unwrap();
    state.lock().unwrap().missing_usage = true;
    assert!(adapter
        .read_usage(&intent, &reference, 0, now())
        .await
        .is_err());
    state.lock().unwrap().usage_raw=Some(r#"{"data":{"hash":"provider-hash","disabled":true,"usage":0.123456789123456789,"byok_usage":1e-18}}"#.into());
    let usage = adapter
        .read_usage(&intent, &reference, 0, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.provider_reported_usd, "0.12345678912345679");
    assert_eq!(usage.observed_nano, "123456790");
    assert_eq!(
        state
            .lock()
            .unwrap()
            .events
            .iter()
            .filter(|s| *s == "create")
            .count(),
        1
    );
    task.abort();
}
#[tokio::test]
async fn openrouter_wrong_limit_retains_handle_and_missing_key_is_unknown() {
    let state = Arc::new(Mutex::new(Fixture {
        bad_limit: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let intent = intent();
    assert!(adapter.recover_key(&intent).await.unwrap().is_none());
    let key = adapter.create_key(&intent).await.unwrap();
    assert!(adapter.verify_created(&key).await.is_err());
    assert_eq!(key.reference.key_ref, "provider-hash");
    adapter.disable_key(&key.reference).await.unwrap();
    task.abort();
}
#[test]
fn provider_config_rejects_insecure_origins_and_credentials() {
    let (_dir, path) = credential();
    for base in [
        "http://provider.example/api/v1",
        "https://user:pass@provider.example/api/v1",
        "https://provider.example/api/v1?secret=x",
        "https://provider.example/api/v1#x",
    ] {
        assert!(DirectAdapter::new(
            DirectConfig::Openrouter {
                api_base: base.into(),
                credential_file: path.clone(),
                inference_base: "https://openrouter.ai/api/v1".into(),
                settlement_grace_seconds: 60
            },
            true
        )
        .is_err());
    }
}

#[derive(Default)]
struct OaFixture {
    base: String,
    intent: Option<Value>,
    expiry: u64,
    verified: bool,
    pending: bool,
    bad_request_id: bool,
    bad_verifier: bool,
    credit_limit: Option<Value>,
    events: Vec<String>,
}
type OaState = Arc<Mutex<OaFixture>>;
async fn oa_create(
    State(state): State<OaState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(headers["authorization"], "Bearer management-secret");
    let mut s = state.lock().unwrap();
    s.events.push("create".into());
    s.intent = Some(body.clone());
    s.expiry = now() + 60;
    Json(
        json!({"source":"oa_org","key":"oa-runtime-key-canary","key_hash":"oa-hash","credit_limit":s.credit_limit.as_ref().unwrap_or(&body["credit_limit"]),"duration_minutes":body["duration_minutes"],"expires_at_unix":s.expiry,"station_id":"pinned-station","station_recently_attested":true,"station_signature":"ab".repeat(64),"org_signature":"cd".repeat(64),"verifier_url":if s.bad_verifier {"https://attacker.invalid"}else{&s.base},"openrouter_api_base":format!("{}/inference",s.base)}),
    )
}
async fn oa_verify(
    State(state): State<OaState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert!(!headers.contains_key("authorization"));
    assert_eq!(body["api_key"], "oa-runtime-key-canary");
    let mut s = state.lock().unwrap();
    s.events.push("verify".into());
    Json(json!({"status":if s.verified {"verified"}else{"rejected"}}))
}
async fn oa_usage(State(state): State<OaState>, Json(body): Json<Value>) -> Json<Value> {
    let mut s = state.lock().unwrap();
    s.events.push("usage".into());
    let id = body["client_request_id"].as_str().unwrap();
    let station_request_id = hex::encode(zkapi_control::wire::sha256(
        format!("oa-org:zkapi:v1:{id}").as_bytes(),
    ));
    Json(
        json!({"source":"oa_org","version":1,"status":if s.pending {"pending"}else{"finalized"},"client_request_id":id,"station_request_id":if s.bad_request_id {"ab".repeat(32)}else{station_request_id},"key_hash":"oa-hash","usage_credits":3,"credit_limit_credits":1_000_000,"expires_at_unix":s.expiry,"closed_at_unix":now(),"finalized_at_unix":now(),"station_id":"pinned-station","station_signature":"ab".repeat(64),"org_signature":"cd".repeat(64)}),
    )
}
async fn oa_recover(State(state): State<OaState>, Json(body): Json<Value>) -> Json<Value> {
    let mut s = state.lock().unwrap();
    s.events.push("recover".into());
    let id = body["client_request_id"].as_str().unwrap();
    Json(
        json!({"source":"oa_org","version":1,"status":"issued","client_request_id":id,"station_request_id":hex::encode(zkapi_control::wire::sha256(format!("oa-org:zkapi:v1:{id}").as_bytes())),"key_hash":"oa-hash","credit_limit":1,"credit_limit_credits":1_000_000,"duration_minutes":1,"expires_at_unix":s.expiry,"station_id":"pinned-station"}),
    )
}
async fn oa_fixture(state: OaState) -> (TempDir, DirectAdapter, tokio::task::JoinHandle<()>) {
    let (dir, path) = credential();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    state.lock().unwrap().base = base.clone();
    let app = Router::new()
        .route("/api/zkapi/request_key", post(oa_create))
        .route("/submit_key", post(oa_verify))
        .route("/api/zkapi/key_usage", post(oa_usage))
        .route("/api/zkapi/reconcile_key", post(oa_recover))
        .with_state(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let adapter = DirectAdapter::new(
        DirectConfig::Oa {
            issuer_base: base.clone(),
            credential_file: path,
            verifier_base: base.clone(),
            inference_base: format!("{base}/inference"),
            station_id: "pinned-station".into(),
        },
        true,
    )
    .unwrap();
    (dir, adapter, task)
}
#[tokio::test]
async fn oa_pinned_verifier_pending_receipt_and_request_bound_recovery() {
    let state = Arc::new(Mutex::new(OaFixture {
        verified: true,
        pending: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = oa_fixture(state.clone()).await;
    let intent = intent();
    let key = adapter.create_key(&intent).await.unwrap();
    adapter.verify_created(&key).await.unwrap();
    assert!(adapter
        .read_usage(&intent, &key.reference, 0, now())
        .await
        .unwrap()
        .is_none());
    state.lock().unwrap().pending = false;
    let usage = adapter
        .read_usage(&intent, &key.reference, 0, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.provider_reported_usd, "0.000003");
    assert_eq!(usage.observed_nano, "3000");
    assert_eq!(usage.evidence_kind, "OA_SIGNED_RECEIPT");
    assert_eq!(
        adapter.recover_key(&intent).await.unwrap().unwrap(),
        key.reference
    );
    state.lock().unwrap().bad_request_id = true;
    assert!(adapter
        .read_usage(&intent, &key.reference, 0, now())
        .await
        .is_err());
    task.abort();
}
#[tokio::test]
async fn oa_rejects_unpinned_url_and_verifier_failure_without_fallback() {
    let state = Arc::new(Mutex::new(OaFixture {
        bad_verifier: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = oa_fixture(state.clone()).await;
    let intent = intent();
    let key = adapter.create_key(&intent).await.unwrap();
    assert!(adapter.verify_created(&key).await.is_err());
    assert!(!state.lock().unwrap().events.contains(&"verify".into()));
    state.lock().unwrap().bad_verifier = false;
    let key = adapter.create_key(&intent).await.unwrap();
    assert!(adapter.verify_created(&key).await.is_err());
    task.abort();
}

#[tokio::test]
async fn oa_malformed_limit_retains_management_reference_for_retirement() {
    for limit in [json!("1"), json!(-1), Value::Null] {
        let state = Arc::new(Mutex::new(OaFixture {
            credit_limit: Some(limit),
            verified: true,
            ..Default::default()
        }));
        let (_dir, adapter, task) = oa_fixture(state.clone()).await;
        let intent = intent();
        let key = adapter.create_key(&intent).await.unwrap();
        assert_eq!(key.reference.key_ref, "oa-hash");
        assert!(adapter.verify_created(&key).await.is_err());
        assert!(!state.lock().unwrap().events.contains(&"verify".into()));
        let usage = adapter
            .read_usage(&intent, &key.reference, 0, now())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.provider_reported_usd, "0.000003");
        assert_eq!(state.lock().unwrap().events, ["create", "usage"]);
        task.abort();
    }
}

async fn db_connect(url: &str) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
async fn direct_ledger() -> (
    zkapi_control::ledger::Ledger,
    String,
    zkapi_control::ledger::PoolIdentity,
) {
    use zkapi_control::ledger::*;
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")
        .expect("use an isolated PostgreSQL admin connection");
    let admin = db_connect(&base).await;
    let name = format!("zkapi_i06_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let config: tokio_postgres::Config = base.parse().unwrap();
    let host = match config.get_hosts().first().unwrap() {
        tokio_postgres::config::Host::Tcp(s) => s.clone(),
        tokio_postgres::config::Host::Unix(s) => s.display().to_string(),
    };
    let url = format!(
        "host={host} port={} user={} dbname={name}",
        config.get_ports().first().unwrap_or(&5432),
        config.get_user().unwrap()
    );
    migrate(&url).await.unwrap();
    let identity = PoolIdentity {
        pool: [71; 32],
        deployment_id: format!("i06-{}", Uuid::new_v4()),
        manifest_hash: [72; 32],
        authorization_config: json!({"signer":{"receipt_key":ed25519_dalek::SigningKey::from_bytes(&[73;32]).verifying_key().to_bytes()}}),
    };
    let ledger = Ledger::connect(&url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    (ledger, url, identity)
}
async fn reserve_direct(ledger: &zkapi_control::ledger::Ledger) -> IssueIntent {
    use zkapi_control::ledger::*;
    let intent = intent();
    let tariff_body = b"{}";
    let tariff_hash = zkapi_control::wire::sha256(tariff_body);
    ledger.store_tariff(tariff_hash, tariff_body).await.unwrap();
    let body = serde_json::to_vec(&json!({"quote_id":Uuid::new_v4(),"models":["*"]})).unwrap();
    let quote = QuoteRecord {
        quote_id: Uuid::new_v4(),
        quote_hash: zkapi_control::wire::sha256(&body),
        canonical_body: body,
        signature: vec![3; 64],
        tariff_hash,
        expires_at: now() as i64 + 120,
    };
    ledger.store_quote(&quote).await.unwrap();
    let transcript = b"synthetic direct ledger transcript; no proof claim".to_vec();
    ledger
        .reserve_session(
            &NewSession {
                request_id: intent.request_id,
                nullifier: zkapi_control::wire::sha256(intent.request_id.as_bytes()),
                quote_id: quote.quote_id,
                request_digest: zkapi_control::wire::sha256(&transcript),
                request_transcript: transcript,
                control_secret_hash: [4; 32],
                proxy_secret_hash: None,
                mode: "direct_openrouter".into(),
                provider: "openrouter".into(),
                cap_micro: intent.cap_micro,
                max_concurrency: 1,
            },
            || async { Ok(()) },
        )
        .await
        .unwrap();
    intent
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_issuance_starts_lease_after_wait_and_preserves_recovery_intent() {
    let state = Shared::default();
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let runtime = DirectRuntime::new(adapter);
    let (ledger, _url, _identity) = direct_ledger().await;
    let mut intent = reserve_direct(&ledger).await;
    let id = intent.request_id;
    // Deterministically represent an intent constructed before a long wait for
    // another issuance to leave the provider's serial dispatch slot.
    intent.requested_at = now() - 1_000;
    let before_issue = now();
    let key = runtime
        .issue(&ledger, intent.clone(), Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap()
        .expect("queued issuance must receive a fresh bounded lease");
    let checkpoint: Checkpoint =
        serde_json::from_value(ledger.direct_checkpoint(id).await.unwrap().unwrap()).unwrap();
    assert!(checkpoint.intent.requested_at >= before_issue);
    assert!(checkpoint.intent.requested_at <= now());
    assert_eq!(key.reference.expires_at, checkpoint.intent.expires_at());
    assert!(key.reference.expires_at > now());
    assert_eq!(ledger.session(id).await.unwrap().state, "ACTIVE");

    // Replay callers may construct a different timestamp; the existing durable
    // issuance intent and its provider lease must remain exactly the original.
    intent.requested_at = now() + 100;
    assert!(runtime
        .issue(&ledger, intent, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap()
        .is_none());
    ledger.close(id).await.unwrap();
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none());
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_some());
    let recovered: Checkpoint =
        serde_json::from_value(ledger.direct_checkpoint(id).await.unwrap().unwrap()).unwrap();
    assert_eq!(recovered.intent, checkpoint.intent);
    assert_eq!(recovered.reference, checkpoint.reference);
    assert_eq!(
        state
            .lock()
            .unwrap()
            .events
            .iter()
            .filter(|event| *event == "create")
            .count(),
        1
    );
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_ledger_persists_final_usage_before_ambiguous_delete_and_restart() {
    let state = Arc::new(Mutex::new(Fixture {
        fail_delete: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let runtime = DirectRuntime::new(adapter);
    let (ledger, url, identity) = direct_ledger().await;
    let intent = reserve_direct(&ledger).await;
    let id = intent.request_id;
    assert!(runtime
        .issue(&ledger, intent.clone(), Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap()
        .is_some());
    assert!(runtime
        .issue(&ledger, intent, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap()
        .is_none());
    assert_eq!(ledger.session(id).await.unwrap().state, "ACTIVE");
    ledger.close(id).await.unwrap();
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none()); // first stable-usage observation
    assert!(runtime.reconcile(&ledger, id).await.is_err()); // provider deleted; DELETE response lost
    let checkpoint = ledger.direct_checkpoint(id).await.unwrap().unwrap();
    assert_eq!(checkpoint["usage"]["provider_reported_usd"], "0.0000000011");
    assert_eq!(checkpoint["deleted"], false);
    let dumped = checkpoint.to_string();
    assert!(!dumped.contains("runtime-key-canary"));
    assert!(!dumped.contains("management-secret"));
    let before = state.lock().unwrap().events.clone();
    drop(ledger);
    // Give the closed client connection its completion turn before obtaining its lock.
    tokio::task::yield_now().await;
    let ledger = zkapi_control::ledger::Ledger::connect(&url, &identity)
        .await
        .unwrap();
    let finalized = runtime.reconcile(&ledger, id).await.unwrap().unwrap();
    assert_eq!(finalized.usage.observed_nano, "2");
    let events = &state.lock().unwrap().events;
    assert_eq!(&events[..before.len()], before);
    assert_eq!(&events[before.len()..], ["delete"]);
    assert_eq!(events.iter().filter(|e| *e == "create").count(), 1);
    task.abort();
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_ledger_unknown_recovery_never_reissues_or_returns_plaintext() {
    let state = Arc::new(Mutex::new(Fixture {
        fail_create: true,
        ..Default::default()
    }));
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let runtime = DirectRuntime::new(adapter);
    let (ledger, _url, _identity) = direct_ledger().await;
    let intent = reserve_direct(&ledger).await;
    let id = intent.request_id;
    assert!(runtime
        .issue(&ledger, intent, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap()
        .is_none());
    assert_eq!(ledger.session(id).await.unwrap().state, "ISSUANCE_UNKNOWN");
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none());
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_some());
    assert_eq!(ledger.session(id).await.unwrap().state, "DRAINING");
    let events = &state.lock().unwrap().events;
    assert_eq!(events.iter().filter(|e| *e == "create").count(), 1);
    assert!(events.contains(&"disable".into()));
    assert!(events.contains(&"delete".into()));
    task.abort();
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_ledger_late_issuance_after_close_is_drained() {
    let state = Shared::default();
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let runtime = DirectRuntime::new(adapter);
    let (ledger, _url, _identity) = direct_ledger().await;
    let intent = reserve_direct(&ledger).await;
    let id = intent.request_id;
    let check_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // The final chain check observes an exit after the provider has issued a key.
    let result = runtime
        .issue(&ledger, intent, Uuid::new_v4(), {
            let count = check_count.clone();
            move || {
                let count = count.clone();
                async move {
                    if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        Ok(())
                    } else {
                        Err(zkapi_control::ledger::LedgerError::Unavailable(
                            "exit observed",
                        ))
                    }
                }
            }
        })
        .await;
    assert!(result.is_err());
    assert_eq!(ledger.session(id).await.unwrap().state, "DRAINING");
    assert!(ledger.provider_key_ref(id).await.unwrap().is_some());
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none());
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_some());
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_usage_growth_restarts_stabilization_and_subnano_regression_is_rejected() {
    let state = Shared::default();
    let (_dir, adapter, task) = openrouter_fixture(state.clone(), 0).await;
    let runtime = DirectRuntime::new(adapter);
    let (ledger, _url, _identity) = direct_ledger().await;
    let intent = reserve_direct(&ledger).await;
    let id = intent.request_id;
    runtime
        .issue(&ledger, intent, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    ledger.close(id).await.unwrap();
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none());
    state.lock().unwrap().usage_raw = Some(
        r#"{"data":{"hash":"provider-hash","disabled":true,"usage":0.00000000105,"byok_usage":0}}"#
            .into(),
    );
    assert!(runtime.reconcile(&ledger, id).await.is_err());
    assert!(!state.lock().unwrap().deleted);
    state.lock().unwrap().usage_raw = Some(
        r#"{"data":{"hash":"provider-hash","disabled":true,"usage":0.0000000021,"byok_usage":0}}"#
            .into(),
    );
    assert!(runtime.reconcile(&ledger, id).await.unwrap().is_none());
    assert!(!state.lock().unwrap().deleted);
    let finalization = runtime.reconcile(&ledger, id).await.unwrap().unwrap();
    assert_eq!(finalization.usage.provider_reported_usd, "0.0000000021");
    assert_eq!(finalization.usage.observed_nano, "3");
    task.abort();
}
