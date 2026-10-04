//! I06/I07 full HTTP path with local provider wire fixtures, real PostgreSQL,
//! request proofs, signed receipts, and the isolated sign-once settlement signer.
//! No live provider credentials or public RPC are used.
mod support;
use anyhow::Result;
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use support::*;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    api::App,
    config::RuntimeConfig,
    ledger::{migrate, Ledger, PoolIdentity},
    provider_runtime::{ProviderConfig, ProxyProviderConfig},
    proxy::{CacheMode, Endpoint, ModelProfile},
    quote,
    receipts::Receipt,
    signer::Signer,
    wire,
};
async fn db(url: &str) -> Client {
    let (c, conn) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}
fn write_private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
struct ChildGuard {
    child: Child,
    socket: PathBuf,
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}
async fn start_signer(dir: &Path, url: &str) -> ChildGuard {
    let socket = dir.join("signer.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_signerd"))
        .arg("--local-test")
        .arg("--config")
        .arg(dir.join("signer.json"))
        .arg("--journal")
        .arg(dir.join("journal"))
        .arg("--socket")
        .arg(&socket)
        .arg("--state-seed-file")
        .arg(dir.join("state.seed"))
        .arg("--clearance-seed-file")
        .arg(dir.join("clearance.seed"))
        .env("ZKAPI_SIGNER_DATABASE_URL", url)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut guard = ChildGuard { child, socket };
    for _ in 0..200 {
        if guard.socket.exists() {
            return guard;
        }
        if let Some(status) = guard.child.try_wait().unwrap() {
            panic!("signer startup failed {status}")
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("signer timeout")
}
async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (origin, task)
}
async fn response(req: reqwest::RequestBuilder, expected: u16) -> Value {
    let r = req.send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap();
    assert_eq!(status.as_u16(), expected, "HTTP {text}");
    serde_json::from_str(&text).unwrap()
}
fn local_config(dir: &Path, primary: String, secondary: String, indexer: String) -> RuntimeConfig {
    let f = fixture();
    let mut profile: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    let p = &f["auth"]["withdrawal"]["public_inputs"];
    let qk = SigningKey::from_bytes(&[11; 32]);
    let rk = SigningKey::from_bytes(&[12; 32]);
    let mut tariff = tariff();
    tariff.model = "i05-local-only".into();
    tariff.valid_from = "1".into();
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    let mut expired = tariff.clone();
    expired.valid_from = "0".into();
    expired.valid_until = "1".into();
    expired.tariff_hash = quote::tariff_hash(&expired).unwrap();
    let mut future = tariff.clone();
    future.valid_from = tariff.valid_until.clone();
    future.valid_until = "4000000120".into();
    future.tariff_hash = quote::tariff_hash(&future).unwrap();
    let mut manifest = json!({"deployment_id":"i05-local","genesis_hash":bs58::encode([0;32]).into_string(),"program_id":bs58::encode([43;32]).into_string(),"pool":local_binding().pool,"mint":bs58::encode([4;32]).into_string(),"token_program":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","decimals":6,"vault_binding":p[2],"state_key":{"x":p[4],"y":p[5]},"clearance_key":{"x":p[6],"y":p[7]},"quote_public_key":bs58::encode(qk.verifying_key().to_bytes()).into_string(),"receipt_public_key":bs58::encode(rk.verifying_key().to_bytes()).into_string(),"deployment_environment":"local","transaction_formats":["v0_buffer"],"cap_micro_usdc":"1000000","note_ttl_seconds":"2592000","challenge_seconds":"86400","control_api_origin":"http://127.0.0.1:8788","inference_api_origin":"http://127.0.0.1:8789","db_schema_version":"2","tariff_hashes":[tariff.tariff_hash],"manifest_signature":"local trusted hash fixture","api_endpoints":[],"artifact_digests":{},"proving_keys_base_url":"http://127.0.0.1:8788/keys","idl_hash":wire::sha256(include_bytes!("../../../docs/contracts/zkapi_vault.json")).map(|_|0)});
    manifest["idl_hash"] = hex::encode(wire::sha256(include_bytes!(
        "../../../docs/contracts/zkapi_vault.json"
    )))
    .into();
    for name in [
        "protocol_layout_version",
        "tree_backend",
        "tree_tag_policy",
        "circuit_id",
        "request_pk_hash",
        "request_vk_hash",
        "withdrawal_pk_hash",
        "withdrawal_vk_hash",
        "tree_proof_artifacts",
        "setup_profile",
        "setup_transcript_hashes",
        "circuit_profile_hash",
    ] {
        manifest[name] = profile.as_object_mut().unwrap().remove(name).unwrap();
    }
    manifest["tariff_hashes"] =
        json!([expired.tariff_hash, tariff.tariff_hash, future.tariff_hash]);
    let mut manifest_body = manifest.clone();
    manifest_body
        .as_object_mut()
        .unwrap()
        .remove("manifest_signature");
    let hash = hex::encode(wire::digest(&manifest_body).unwrap());
    manifest["manifest_hash"] = hash.clone().into();
    complete_local_manifest(&mut manifest);
    let hash = manifest["manifest_hash"].as_str().unwrap().to_owned();
    write_private(&dir.join("quote.seed"), &[11; 32]);
    write_private(&dir.join("receipt.seed"), &[12; 32]);
    RuntimeConfig {
        local_test_only: true,
        listen: "127.0.0.1:0".parse().unwrap(),
        manifest,
        trusted_manifest_hash: hash,
        primary_rpc: primary,
        secondary_rpc: secondary,
        indexer_origin: indexer,
        signer_socket: dir.join("signer.sock"),
        quote_seed_file: dir.join("quote.seed"),
        receipt_seed_file: dir.join("receipt.seed"),
        enable_local_adapter: true,
        providers: Default::default(),
        tariffs: vec![expired, tariff, future],
    }
}

struct Fixture {
    app: Arc<App>,
    origin: String,
    sql: Client,
    _signer: ChildGuard,
    _directory: tempfile::TempDir,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
async fn fixture_app(provider_origin: &str, direct: bool) -> Result<Fixture> {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let admin = db(&base).await;
    let name = format!("i07_http_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = format!("{base} dbname={name}");
    migrate(&url).await?;
    let sql = db(&url).await;
    let directory = tempfile::Builder::new()
        .prefix("i07-http-")
        .tempdir_in("/tmp")?;
    let dir = directory.path();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let chain: Value = serde_json::from_slice(&std::fs::read(root.join("target/i05/chain.json"))?)?;
    let mut tasks = vec![];
    let mut rpc = vec![];
    for _ in 0..2 {
        let c = chain.clone();
        let (origin,task)=serve(Router::new().route("/",post(move|Json(r):Json<Value>|{let c=c.clone();async move {
            let result=if r["method"]=="getGenesisHash" {json!(bs58::encode([0;32]).into_string())}else{json!({"context":{"slot":100},"value":if r["params"][0]==c["pool"]{c["pool_account"].clone()}else{Value::Null}})};
            Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
        }}))).await;
        rpc.push(origin);
        tasks.push(task);
    }
    let c = chain.clone();
    let (indexer, task) = serve(Router::new().route(
        "/zkapi/v1/tree/root",
        get(move || {
            let c = c.clone();
            async move { Json(c["root"].clone()) }
        }),
    ))
    .await;
    tasks.push(task);
    let mut config = local_config(dir, rpc[0].clone(), rpc[1].clone(), indexer);
    config.enable_local_adapter = false;
    let mut tariff = tariff();
    tariff.model = "provider-test".into();
    tariff.rates = vec!["cache_read_tokens", "input_tokens", "output_tokens"]
        .into_iter()
        .map(|unit| wire::Rate {
            unit: unit.into(),
            nano_usdc_numerator: "1".into(),
            unit_denominator: "1".into(),
        })
        .collect();
    tariff.tariff_hash = quote::tariff_hash(&tariff)?;
    config.tariffs = vec![tariff.clone()];
    write_private(&dir.join("provider.key"), b"fixture-provider-secret");
    config.providers = ProviderConfig {
        direct: vec![],
        proxy: vec![ProxyProviderConfig {
            provider: wire::Provider::Openai,
            credential_file: dir.join("provider.key"),
            local_test_base: Some(provider_origin.into()),
            models: vec![ModelProfile {
                provider: wire::Provider::Openai,
                model: "provider-test".into(),
                endpoints: vec![Endpoint::ChatCompletions, Endpoint::Responses],
                context_tokens: 1000,
                max_output_tokens: 100,
                cache_mode: CacheMode::InclusiveRead,
            }],
        }],
    };
    if direct {
        tariff.provider = wire::Provider::Openrouter;
        tariff.model = "*".into();
        tariff.pricing_basis = "provider_reported_usd".into();
        tariff.rates.clear();
        tariff.tariff_hash = quote::tariff_hash(&tariff)?;
        config.tariffs = vec![tariff.clone()];
        config.providers = ProviderConfig {
            proxy: vec![],
            direct: vec![zkapi_control::direct::DirectConfig::Openrouter {
                api_base: format!("{provider_origin}/api/v1"),
                credential_file: dir.join("provider.key"),
                inference_base: format!("{provider_origin}/api/v1"),
                settlement_grace_seconds: 0,
            }],
        };
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    config.manifest["control_api_origin"] = origin.clone().into();
    config.manifest["inference_api_origin"] = origin.clone().into();
    config.manifest["tariff_hashes"] = json!([tariff.tariff_hash]);
    complete_local_manifest(&mut config.manifest);
    config.trusted_manifest_hash = config.manifest["manifest_hash"].as_str().unwrap().into();
    let validated = config.clone().validate()?;
    let identity = PoolIdentity {
        pool: validated.signer.pool,
        deployment_id: validated.binding.deployment_id.clone(),
        manifest_hash: wire::hash(&config.trusted_manifest_hash)?,
        authorization_config: json!({"signer":validated.signer}),
    };
    drop(Ledger::connect(&url, &identity).await?);
    tokio::time::sleep(Duration::from_millis(50)).await;
    write_private(
        &dir.join("signer.json"),
        &serde_json::to_vec(&validated.signer)?,
    );
    write_private(
        &dir.join("state.seed"),
        &zkapi_types::Felt252::from_u64(31).0,
    );
    write_private(
        &dir.join("clearance.seed"),
        &zkapi_types::Felt252::from_u64(37).0,
    );
    Signer::initialize_journal(dir.join("journal"), &validated.signer)?;
    let signer = start_signer(dir, &url).await;
    let app = App::connect(config.validate()?, &url).await?;
    let router = app.router();
    tasks.push(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    Ok(Fixture {
        app,
        origin,
        sql,
        _signer: signer,
        _directory: directory,
        tasks,
    })
}
async fn open_proxy(f: &Fixture, client: &reqwest::Client) -> Result<(Uuid, String, String)> {
    let quote:wire::Quote=serde_json::from_value(response(client.post(format!("{}/zkapi/v1/quotes",f.origin)).json(&json!({"mode":"proxy","provider":"openai","models":["provider-test"],"session_ttl_seconds":"300"})),200).await)?;
    let (auth, control) = authorization(&quote);
    let request = bound_request(auth, quote, genesis_state());
    let id = wire::uuid(&request.authorization.request_id)?;
    response(
        client
            .post(format!("{}/zkapi/v1/sessions", f.origin))
            .header("authorization", &control)
            .json(&request),
        201,
    )
    .await;
    let proxy = format!("Bearer zkp1.{id}.{}", URL_SAFE_NO_PAD.encode([8; 32]));
    Ok((id, control, proxy))
}
async fn settled(f: &Fixture, id: Uuid) -> Result<()> {
    f.app.ledger.close(id).await?;
    for _ in 0..100 {
        f.app.advance(id).await.ok();
        if f.app.ledger.session(id).await?.state == "SETTLED" {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("provider session failed to settle")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn proxy_http_metering_disconnect_unknown_and_no_replay() -> Result<()> {
    use axum::{
        body::{Body, Bytes},
        http::{HeaderMap, Response},
        response::IntoResponse,
    };
    let sends = Arc::new(AtomicUsize::new(0));
    let count = sends.clone();
    let (upstream,upstream_task)=serve(Router::new().route("/v1/chat/completions",post(move|headers:HeaderMap,Json(body):Json<Value>| {
        let count=count.clone();async move {
            assert_eq!(headers.get("authorization").unwrap(),"Bearer fixture-provider-secret");
            assert!(!headers.contains_key("cookie"));
            assert!(!headers.contains_key("x-forwarded-for"));
            count.fetch_add(1,Ordering::SeqCst);
            if body["stream"]==true {
                assert_eq!(body["stream_options"]["include_usage"],true);
                let chunks=vec![
                    "data: {\"id\":\"chat-stream\",\"choices\":[{\"delta\":{\"content\":\"I07_PRIVATE_RESPONSE_CANARY\"}}]}\n\n".to_owned(),
                    "data: {\"id\":\"chat-stream\",\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":2,\"total_tokens\":22,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\ndata: [DONE]\n\n".to_owned(),
                ];
                let stream=futures_util::stream::unfold((chunks.into_iter(),0),|(mut chunks,index)|async move {
                    let next=chunks.next()?;
                    if index>0 {tokio::time::sleep(Duration::from_millis(150)).await;}
                    Some((Ok::<_,std::convert::Infallible>(Bytes::from(next)),(chunks,index+1)))
                });
                Response::builder().header("content-type","text/event-stream").body(Body::from_stream(stream)).unwrap().into_response()
            } else if body["messages"][0]["content"]=="UNKNOWN" {
                Json(json!({"id":"chat-unknown","choices":[],"usage":{"prompt_tokens":1}})).into_response()
            } else {
                Json(json!({"id":"chat-normal","choices":[{"message":{"role":"assistant","content":"I07_PRIVATE_RESPONSE_CANARY"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":2}}})).into_response()
            }
        }
    })).route("/v1/responses",post(|headers:HeaderMap,Json(body):Json<Value>|async move {
        assert_eq!(headers.get("authorization").unwrap(),"Bearer fixture-provider-secret");
        assert_eq!(body["store"],false);
        Json(json!({"id":"resp-normal","object":"response","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":1,"total_tokens":8,"input_tokens_details":{"cached_tokens":0}}}))
    }))).await;
    let mut fixture = fixture_app(&upstream, false).await?;
    fixture.tasks.push(upstream_task);
    let client = reqwest::Client::new();
    let (id, control, proxy) = open_proxy(&fixture, &client).await?;
    let infer = format!("{}/v1/chat/completions", fixture.origin);
    let payload = json!({"model":"provider-test","messages":[{"role":"user","content":"I07_PRIVATE_PROMPT_CANARY"}],"max_completion_tokens":40});
    let operation = Uuid::new_v4();
    let first = client
        .post(&infer)
        .header("authorization", &proxy)
        .header("idempotency-key", operation.to_string())
        .header("cookie", "PRIVATE_COOKIE")
        .header("x-forwarded-for", "192.0.2.1")
        .json(&payload)
        .send()
        .await?;
    assert_eq!(first.status(), 200);
    assert_eq!(
        first.headers()["x-zkapi-operation-id"],
        operation.to_string()
    );
    assert!(first.text().await?.contains("I07_PRIVATE_RESPONSE_CANARY"));
    for _ in 0..100 {
        if fixture.app.ledger.operation(id, operation).await?.state == "DONE" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        fixture
            .app
            .ledger
            .operation(id, operation)
            .await?
            .charged_nano,
        15
    );
    let retry = client
        .post(&infer)
        .header("authorization", &proxy)
        .header("idempotency-key", operation.to_string())
        .json(&payload)
        .send()
        .await?;
    assert_eq!(retry.status(), 409);
    assert_eq!(
        retry.headers()["x-zkapi-error-code"],
        "response_not_replayable"
    );
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    let changed = client
        .post(&infer)
        .header("authorization", &proxy)
        .header("idempotency-key", operation.to_string())
        .json(&json!({"model":"provider-test","messages":[],"max_completion_tokens":40}))
        .send()
        .await?;
    assert_eq!(changed.status(), 409);
    assert_eq!(
        changed.headers()["x-zkapi-error-code"],
        "idempotency_conflict"
    );
    let unsupported=client.post(&infer).header("authorization",&proxy).header("idempotency-key",Uuid::new_v4().to_string()).json(&json!({"model":"provider-test","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://169.254.169.254"}}]}],"max_completion_tokens":40})).send().await?;
    assert_eq!(unsupported.status(), 400);
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    let responses=response(client.post(format!("{}/v1/responses",fixture.origin)).header("authorization",&proxy).header("idempotency-key",Uuid::new_v4().to_string()).json(&json!({"model":"provider-test","input":"hello","max_output_tokens":40,"store":false})),200).await;
    assert_eq!(responses["id"], "resp-normal");
    let stream_operation = Uuid::new_v4();
    let mut stream=client.post(&infer).header("authorization",&proxy).header("idempotency-key",stream_operation.to_string()).json(&json!({"model":"provider-test","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":40,"stream":true})).send().await?;
    assert_eq!(stream.status(), 200);
    let _ = stream.chunk().await?;
    drop(stream); // upstream must continue metering after the caller disconnects.
    for _ in 0..100 {
        if fixture
            .app
            .ledger
            .operation(id, stream_operation)
            .await?
            .state
            == "DONE"
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        fixture
            .app
            .ledger
            .operation(id, stream_operation)
            .await?
            .charged_nano,
        22
    );
    let unknown_operation = Uuid::new_v4();
    let unknown=client.post(&infer).header("authorization",&proxy).header("idempotency-key",unknown_operation.to_string()).json(&json!({"model":"provider-test","messages":[{"role":"user","content":"UNKNOWN"}],"max_completion_tokens":40})).send().await?;
    assert_eq!(unknown.status(), 502);
    let _ = unknown.bytes().await?;
    settled(&fixture, id).await?;
    assert_eq!(
        fixture
            .app
            .ledger
            .operation(id, unknown_operation)
            .await?
            .state,
        "WAIVED_OPERATOR_LOSS"
    );
    assert_eq!(
        fixture.app.ledger.settlement(id).await?.target.charge_micro,
        1
    );
    let page = response(
        client
            .get(format!(
                "{}/zkapi/v1/sessions/{id}/receipts",
                fixture.origin
            ))
            .header("authorization", &control),
        200,
    )
    .await;
    let receipts = page["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 4);
    for value in receipts {
        serde_json::from_value::<Receipt>(value.clone())?
            .verify(&fixture.app.config.receipt_key.verifying_key())?;
    }
    assert_eq!(sends.load(Ordering::SeqCst), 3);
    // Exhaustive small fixture DB scan: no plaintext prompt, response or credential.
    let private = fixture
        .sql
        .query("SELECT request_transcript FROM sessions", &[])
        .await?;
    for row in private {
        let bytes: Vec<u8> = row.get(0);
        let text = String::from_utf8(bytes)?;
        assert!(!text.contains("I07_PRIVATE_PROMPT_CANARY"));
    }
    let metadata = fixture
        .sql
        .query("SELECT canonical_body FROM receipts", &[])
        .await?;
    for row in metadata {
        let bytes: Vec<u8> = row.get(0);
        let text = String::from_utf8(bytes)?;
        assert!(!text.contains("I07_PRIVATE_RESPONSE_CANARY"));
        assert!(!text.contains("fixture-provider-secret"));
    }
    Ok(())
}

struct DirectFixture {
    fixture: Fixture,
    creates: Arc<AtomicUsize>,
    deletes: Arc<AtomicUsize>,
    reads: Arc<AtomicUsize>,
}
async fn direct_fixture() -> Result<DirectFixture> {
    direct_fixture_with_gate(None).await
}
async fn direct_fixture_with_gate(
    issuance_gate: Option<Arc<tokio::sync::Notify>>,
) -> Result<DirectFixture> {
    use axum::{
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::patch,
    };
    let creates = Arc::new(AtomicUsize::new(0));
    let deletes = Arc::new(AtomicUsize::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let saved = Arc::new(tokio::sync::Mutex::new(Value::Null));
    let create_count = creates.clone();
    let create_saved = saved.clone();
    let patch_saved = saved.clone();
    let read_saved = saved.clone();
    let read_count = reads.clone();
    let delete_count = deletes.clone();
    let (upstream, task) = serve(
        Router::new()
            .route(
                "/api/v1/keys",
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let saved = create_saved.clone();
                    let count = create_count.clone();
                    let gate = issuance_gate.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer fixture-provider-secret");
                        assert_eq!(body["include_byok_in_limit"], true);
                        assert!(body["limit_reset"].is_null());
                        count.fetch_add(1, Ordering::SeqCst);
                        if let Some(gate) = gate {
                            gate.notified().await;
                        }
                        let mut data = body;
                        data["hash"] = "management-reference".into();
                        data["disabled"] = false.into();
                        *saved.lock().await = data.clone();
                        Json(json!({"key":"I06_PLAINTEXT_KEY_CANARY","data":data}))
                    }
                }),
            )
            .route(
                "/api/v1/keys/management-reference",
                patch(move |Json(body): Json<Value>| {
                    let saved = patch_saved.clone();
                    async move {
                        assert_eq!(body["disabled"], true);
                        let mut saved = saved.lock().await;
                        saved["disabled"] = true.into();
                        Json(json!({"data":saved.clone()}))
                    }
                })
                .get(move || {
                    let saved = read_saved.clone();
                    let reads = read_count.clone();
                    async move {
                        reads.fetch_add(1, Ordering::SeqCst);
                        let mut data = saved.lock().await.clone();
                        assert_eq!(data["disabled"], true);
                        data["usage"] = serde_json::from_str("0.000001234").unwrap();
                        data["byok_usage"] = serde_json::from_str("0.0000000011").unwrap();
                        Json(json!({"data":data}))
                    }
                })
                .delete(move || {
                    let deletes = delete_count.clone();
                    async move {
                        if deletes.fetch_add(1, Ordering::SeqCst) == 0 {
                            StatusCode::INTERNAL_SERVER_ERROR.into_response()
                        } else {
                            StatusCode::NOT_FOUND.into_response()
                        }
                    }
                }),
            ),
    )
    .await;
    let mut fixture = fixture_app(&upstream, true).await?;
    fixture.tasks.push(task);
    Ok(DirectFixture {
        fixture,
        creates,
        deletes,
        reads,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn direct_http_one_time_key_and_durable_usage_before_lost_delete() -> Result<()> {
    let DirectFixture {
        fixture,
        creates,
        deletes,
        reads,
    } = direct_fixture().await?;
    let client = reqwest::Client::new();
    let quote:wire::Quote=serde_json::from_value(response(client.post(format!("{}/zkapi/v1/quotes",fixture.origin)).json(&json!({"mode":"direct_openrouter","provider":"openrouter","models":["*"],"session_ttl_seconds":"60"})),200).await)?;
    let (mut auth, control) = authorization(&quote);
    auth.mode = wire::Mode::DirectOpenrouter;
    auth.proxy_secret_hash = None;
    let request = bound_request(auth, quote, genesis_state());
    let id = wire::uuid(&request.authorization.request_id)?;
    let sessions = format!("{}/zkapi/v1/sessions", fixture.origin);
    let created = response(
        client
            .post(&sessions)
            .header("authorization", &control)
            .json(&request),
        201,
    )
    .await;
    assert_eq!(created["provider_key"], "I06_PLAINTEXT_KEY_CANARY");
    assert_eq!(created["state"], "ACTIVE");
    let retry = response(
        client
            .post(&sessions)
            .header("authorization", &control)
            .json(&request),
        200,
    )
    .await;
    assert!(retry.get("provider_key").is_none());
    let state = response(
        client
            .get(format!("{sessions}/{id}"))
            .header("authorization", &control),
        200,
    )
    .await;
    assert!(state.get("provider_key").is_none());
    fixture.app.ledger.close(id).await?;
    // First finalization obtains final usage and then loses deletion confirmation.
    for _ in 0..10 {
        fixture.app.advance(id).await.ok();
        if deletes.load(Ordering::SeqCst) > 0 {
            break;
        }
    }
    assert_eq!(deletes.load(Ordering::SeqCst), 1);
    let checkpoint = fixture.app.ledger.direct_checkpoint(id).await?.unwrap();
    assert_eq!(checkpoint["usage"]["provider_reported_usd"], "0.0000012351");
    assert_eq!(checkpoint["usage"]["observed_nano"], "1236");
    assert_eq!(checkpoint["deleted"], false);
    let usage_reads = reads.load(Ordering::SeqCst);
    settled(&fixture, id).await?;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        usage_reads,
        "usage must recover from durable checkpoint after delete"
    );
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    assert_eq!(deletes.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture.app.ledger.settlement(id).await?.target.charge_micro,
        2
    );
    let page = response(
        client
            .get(format!("{sessions}/{id}/receipts"))
            .header("authorization", &control),
        200,
    )
    .await;
    let receipt: Receipt = serde_json::from_value(page["receipts"][0].clone())?;
    receipt.verify(&fixture.app.config.receipt_key.verifying_key())?;
    assert_eq!(receipt.body.evidence_kind, "OPENROUTER_USAGE");
    assert_eq!(
        receipt.body.provider_reported_usd.as_deref(),
        Some("0.0000012351")
    );
    let checkpoints = fixture
        .sql
        .query("SELECT metadata::text FROM outbox", &[])
        .await?;
    assert!(checkpoints
        .iter()
        .all(|row| !row.get::<_, String>(0).contains("I06_PLAINTEXT_KEY_CANARY")));
    Ok(())
}

async fn direct_request(fixture: &Fixture) -> Result<(wire::SessionCreate, String)> {
    let client = reqwest::Client::new();
    let quote:wire::Quote=serde_json::from_value(response(client.post(format!("{}/zkapi/v1/quotes",fixture.origin)).json(&json!({"mode":"direct_openrouter","provider":"openrouter","models":["*"],"session_ttl_seconds":"60"})),200).await)?;
    let (mut auth, control) = authorization(&quote);
    auth.mode = wire::Mode::DirectOpenrouter;
    auth.proxy_secret_hash = None;
    Ok((bound_request(auth, quote, genesis_state()), control))
}
fn direct_post(
    request: &wire::SessionCreate,
    control: &str,
) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri("/zkapi/v1/sessions")
        .header("content-type", "application/json")
        .header("authorization", control)
        .body(axum::body::Body::from(serde_json::to_vec(request).unwrap()))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn unconsumed_direct_response_body_closes_and_settles_without_key_replay() -> Result<()> {
    use tower::ServiceExt;
    let DirectFixture {
        fixture, creates, ..
    } = direct_fixture().await?;
    let (request, control) = direct_request(&fixture).await?;
    let id = wire::uuid(&request.authorization.request_id)?;
    let response = fixture
        .app
        .router()
        .oneshot(direct_post(&request, &control))
        .await?;
    assert_eq!(response.status(), 201);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(fixture.app.ledger.session(id).await?.state, "ACTIVE");
    // Never poll the body. Dropping the response must persist a close request.
    drop(response);
    for _ in 0..100 {
        if fixture.app.ledger.session(id).await?.close_requested {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fixture.app.ledger.session(id).await?.close_requested);
    // This drives only ordinary recovery, with no explicit close in the test.
    for _ in 0..100 {
        fixture.app.advance(id).await.ok();
        if fixture.app.ledger.session(id).await?.state == "SETTLED" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fixture.app.ledger.session(id).await?.state, "SETTLED");
    let replay = fixture
        .app
        .router()
        .oneshot(direct_post(&request, &control))
        .await?;
    assert_eq!(replay.status(), 200);
    let bytes = axum::body::to_bytes(replay.into_body(), 16384).await?;
    let state: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(state["state"], "SETTLED");
    assert!(state.get("provider_key").is_none());
    assert!(!String::from_utf8(bytes.to_vec())?.contains("I06_PLAINTEXT_KEY_CANARY"));
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.app.ledger.receipts(id, None, 10).await?.len(), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn queued_direct_key_is_retired_when_creation_handler_is_abandoned() -> Result<()> {
    use std::task::Poll;
    use tower::ServiceExt;
    let gate = Arc::new(tokio::sync::Notify::new());
    let DirectFixture {
        fixture, creates, ..
    } = direct_fixture_with_gate(Some(gate.clone())).await?;
    let (request, control) = direct_request(&fixture).await?;
    let id = wire::uuid(&request.authorization.request_id)?;
    let mut creation = Box::pin(
        fixture
            .app
            .router()
            .oneshot(direct_post(&request, &control)),
    );
    // Stop polling the handler while the detached issuer is waiting upstream.
    // This leaves the completed result queued in its oneshot, before any HTTP
    // response body (and therefore before a body-only guard) can be constructed.
    for _ in 0..500 {
        if creates.load(Ordering::SeqCst) == 1 {
            break;
        }
        assert!(matches!(
            futures_util::poll!(creation.as_mut()),
            Poll::Pending
        ));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    gate.notify_one();
    for _ in 0..500 {
        if fixture.app.ledger.session(id).await?.state == "ACTIVE"
            && fixture
                .app
                .ledger
                .dispatch_attempts_for_session(id)
                .await?
                .iter()
                .all(|attempt| attempt.finished)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(fixture.app.ledger.session(id).await?.state, "ACTIVE");
    // The issuer completes synchronously after activation and enqueues the key;
    // allow its task to return while the handler remains deliberately unpolled.
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!fixture.app.ledger.session(id).await?.close_requested);
    drop(creation);
    for _ in 0..100 {
        if fixture.app.ledger.session(id).await?.close_requested {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fixture.app.ledger.session(id).await?.close_requested);
    for _ in 0..100 {
        fixture.app.advance(id).await.ok();
        if fixture.app.ledger.session(id).await?.state == "SETTLED" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fixture.app.ledger.session(id).await?.state, "SETTLED");
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.app.ledger.receipts(id, None, 10).await?.len(), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn concurrent_direct_creation_issues_once_without_closing_live_session() -> Result<()> {
    use tower::ServiceExt;
    let DirectFixture {
        fixture, creates, ..
    } = direct_fixture().await?;
    let (request, control) = direct_request(&fixture).await?;
    let id = wire::uuid(&request.authorization.request_id)?;
    let (first, second) = tokio::join!(
        fixture
            .app
            .router()
            .oneshot(direct_post(&request, &control)),
        fixture
            .app
            .router()
            .oneshot(direct_post(&request, &control)),
    );
    let mut delivered = 0;
    for response in [first?, second?] {
        assert!(
            matches!(response.status().as_u16(), 200 | 201),
            "concurrent authorized create failed: {}",
            response.status()
        );
        let value: Value =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 16384).await?)?;
        if value.get("provider_key").is_some() {
            delivered += 1;
            assert_eq!(value["provider_key"], "I06_PLAINTEXT_KEY_CANARY");
        }
    }
    assert_eq!(delivered, 1);
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    let session = fixture.app.ledger.session(id).await?;
    assert_eq!(session.state, "ACTIVE");
    assert!(!session.close_requested);
    settled(&fixture, id).await?;
    assert_eq!(fixture.app.ledger.receipts(id, None, 10).await?.len(), 1);
    Ok(())
}
