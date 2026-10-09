//! Bounded repeated failures through real dispatcherd, provider wire fixtures,
//! PostgreSQL and the shared direct runtime/ledger. Authorization/chain checks
//! are fixtures; independent signer, public provider and production fencing
//! acceptance remain separate. No financial state machine is implemented here.
use anyhow::{ensure, Context, Result};
use axum::{
    body::Body,
    extract::Query,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout},
    sync::{Mutex, Notify},
};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    direct::{DirectAdapter, DirectConfig, DirectRuntime, IssueIntent},
    egress,
    ledger::*,
    operations::FenceCertificate,
    provider_runtime::{ProviderConfig, ProxyProviderConfig},
    proxy, quote,
    receipts::{Receipt, ReceiptBody, UsageUnit},
    wire::{self, Provider, Rate, Tariff},
};

const CYCLES: usize = 4;
const MODEL: &str = "i10-fault-fixture";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
async fn connect(url: &str) -> Result<Client> {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}
fn tariff(direct: bool) -> Tariff {
    let mut value = Tariff {
        tariff_hash: String::new(),
        version: "1".into(),
        provider: if direct {
            Provider::Openrouter
        } else {
            Provider::Openai
        },
        model: if direct { "*" } else { MODEL }.into(),
        pricing_basis: if direct {
            "provider_reported_usd"
        } else {
            "fixed_usage_rates"
        }
        .into(),
        valid_from: "0".into(),
        valid_until: "4102444800".into(),
        operator_fee_micro_usdc: "0".into(),
        rates: if direct {
            vec![]
        } else {
            ["cache_read_tokens", "input_tokens", "output_tokens"]
                .into_iter()
                .map(|unit| Rate {
                    unit: unit.into(),
                    nano_usdc_numerator: "1".into(),
                    unit_denominator: "1".into(),
                })
                .collect()
        },
    };
    value.tariff_hash = quote::tariff_hash(&value).unwrap();
    value
}
async fn session(ledger: &Ledger, tariff: &Tariff, direct: bool) -> Result<NewSession> {
    let body = serde_jcs::to_vec(&quote::tariff_body(tariff)?)?;
    let hash = wire::sha256(&body);
    ledger.store_tariff(hash, &body).await?;
    let quote_id = Uuid::new_v4();
    let body = serde_json::to_vec(&json!({"quote_id":quote_id,"models":[tariff.model]}))?;
    let q = QuoteRecord {
        quote_id,
        quote_hash: wire::sha256(&body),
        canonical_body: body,
        signature: vec![0; 64],
        tariff_hash: hash,
        expires_at: 4_102_444_800,
    };
    ledger.store_quote(&q).await?;
    let id = Uuid::new_v4();
    let transcript = id.as_bytes().to_vec();
    let value = NewSession {
        request_id: id,
        nullifier: wire::sha256(id.as_bytes()),
        quote_id,
        request_digest: wire::sha256(&transcript),
        request_transcript: transcript,
        control_secret_hash: [3; 32],
        proxy_secret_hash: (!direct).then_some([4; 32]),
        mode: if direct { "direct_openrouter" } else { "proxy" }.into(),
        provider: tariff.provider.as_str().into(),
        cap_micro: 10,
        max_concurrency: 4,
    };
    ledger.reserve_session(&value, || async { Ok(()) }).await?;
    if !direct {
        ledger.activate_proxy(id, 300, || async { Ok(()) }).await?;
    }
    Ok(value)
}
fn receipt(
    identity: &PoolIdentity,
    tariff: &Tariff,
    session: &NewSession,
    op: Option<&NewOperation>,
    observed: Option<u128>,
    not_dispatched: bool,
    evidence_digest: Option<String>,
) -> Result<ReceiptRecord> {
    let id = Uuid::new_v4();
    let reservation = op.map_or(u128::from(session.cap_micro) * 1000, |op| {
        op.reservation_nano
    });
    let charged = observed.unwrap_or(0).min(reservation);
    let reason = if not_dispatched {
        "not_dispatched"
    } else if observed.is_some() {
        "metered"
    } else {
        "waived_unknown"
    };
    let evidence = if not_dispatched {
        "NOT_DISPATCHED"
    } else if observed.is_none() {
        "UNKNOWN_OPERATOR_LOSS"
    } else if op.is_some() {
        "PROXY_USAGE"
    } else {
        "OPENROUTER_USAGE"
    };
    let signed = Receipt::sign(
        ReceiptBody {
            version: "1".into(),
            receipt_id: id.to_string(),
            deployment_id: identity.deployment_id.clone(),
            pool: bs58::encode(identity.pool).into_string(),
            request_id: session.request_id.to_string(),
            operation_id: op.map(|op| op.operation_id.to_string()),
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: now().to_string(),
            evidence_kind: evidence.into(),
            provider_request_id: None,
            provider_evidence_digest: evidence_digest,
            tariff_hash: tariff.tariff_hash.clone(),
            usage: if op.is_some() && observed.is_some() && !not_dispatched {
                vec![
                    UsageUnit {
                        unit: "cache_read_tokens".into(),
                        count: "0".into(),
                    },
                    UsageUnit {
                        unit: "input_tokens".into(),
                        count: observed.unwrap().saturating_sub(1).to_string(),
                    },
                    UsageUnit {
                        unit: "output_tokens".into(),
                        count: "1".into(),
                    },
                ]
            } else {
                vec![]
            },
            provider_reported_usd: op.is_none().then(|| "0.00002".into()),
            reservation_nano_usdc: reservation.to_string(),
            observed_nano_usdc: observed.map(|n| n.to_string()),
            charged_nano_usdc: charged.to_string(),
            operator_loss_nano_usdc: observed.map(|n| (n - charged).to_string()),
            reason: reason.into(),
        },
        &SigningKey::from_bytes(&[31; 32]),
    )?;
    Ok(ReceiptRecord {
        sequence: 0,
        receipt_id: id,
        request_id: session.request_id,
        operation_id: op.map(|op| op.operation_id),
        billing_effect: "charge".into(),
        canonical_body: signed.body.canonical_bytes()?,
        receipt_hash: wire::hash(&signed.receipt_hash)?,
        signature: Some(STANDARD.decode(signed.signature)?),
    })
}
struct Harness {
    url: String,
    sql: Client,
    identity: PoolIdentity,
    ledger: Ledger,
    directory: tempfile::TempDir,
    remote: egress::ClientConfig,
    service: egress::ServiceConfig,
    profile: proxy::ModelProfile,
}
impl Harness {
    async fn new(origin: &str) -> Result<Self> {
        let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
        zkapi_control::operations::local_database(&base)?;
        let admin = connect(&base).await?;
        let name = format!("i10_faults_{}", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await?;
        let admin_url = format!("{base} dbname={name}");
        migrate(&admin_url).await?;
        let sql = connect(&admin_url).await?;
        let reader = format!("i10_fault_reader_{}", Uuid::new_v4().simple());
        let writer = format!("i10_fault_writer_{}", Uuid::new_v4().simple());
        sql.batch_execute(&format!("CREATE ROLE {reader} LOGIN; GRANT zkapi_control_reader TO {reader}; CREATE ROLE {writer} LOGIN; GRANT zkapi_control_writer TO {writer}")).await?;
        let url = format!("{admin_url} user={writer}");
        let identity = PoolIdentity {
            pool: [1; 32],
            deployment_id: format!("i10-faults-{name}"),
            manifest_hash: [2; 32],
            authorization_config: json!({"signer":{"receipt_key":SigningKey::from_bytes(&[31;32]).verifying_key().to_bytes()}}),
        };
        let ledger = Ledger::connect(&url, &identity).await?;
        ledger.set_accepting(true).await?;
        let directory = tempfile::tempdir()?;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
        let credential = directory.path().join("provider.key");
        private(&credential, b"I10_FAULT_PROVIDER_SECRET")?;
        let claims = directory.path().join("claims");
        std::fs::create_dir(&claims)?;
        std::fs::set_permissions(&claims, std::fs::Permissions::from_mode(0o700))?;
        let profile = proxy::ModelProfile {
            provider: Provider::Openai,
            model: MODEL.into(),
            endpoints: vec![proxy::Endpoint::ChatCompletions],
            context_tokens: 100,
            max_output_tokens: 10,
            cache_mode: proxy::CacheMode::InclusiveRead,
        };
        let service = egress::ServiceConfig {
            local_test_only: true,
            devnet: None,
            database_url: format!("{admin_url} user={reader}"),
            pool: identity.pool,
            claims_directory: claims,
            providers: ProviderConfig {
                dispatcher: None,
                proxy: vec![ProxyProviderConfig {
                    provider: Provider::Openai,
                    credential_file: credential.clone(),
                    local_test_base: Some(origin.into()),
                    models: vec![profile.clone()],
                }],
                direct: vec![DirectConfig::Openrouter {
                    api_base: format!("{origin}/api/v1"),
                    credential_file: credential,
                    inference_base: "https://openrouter.ai/api/v1".into(),
                    settlement_grace_seconds: 0,
                }],
            },
        };
        let config_file = directory.path().join("dispatcher.json");
        private(&config_file, &serde_json::to_vec(&service)?)?;
        let binary = PathBuf::from(env!("CARGO_BIN_EXE_dispatcherd"));
        let remote = egress::ClientConfig {
            binary_sha256: hex::encode(wire::sha256(&std::fs::read(&binary)?)),
            binary,
            config_file,
        };
        Ok(Self {
            url,
            sql,
            identity,
            ledger,
            directory,
            remote,
            service,
            profile,
        })
    }
    fn origin(&mut self, origin: &str) -> Result<()> {
        self.service.providers.proxy[0].local_test_base = Some(origin.into());
        private(
            &self.remote.config_file,
            &serde_json::to_vec(&self.service)?,
        )
    }
    fn request(&self, attempt: &DispatchAttempt, streaming: bool) -> egress::Request {
        egress::Request{provider:Provider::Openai,action:egress::Action::Proxy{attempt:attempt.clone(),endpoint:proxy::Endpoint::ChatCompletions,profile:self.profile.clone(),streaming,reservation_nano:"101".into(),body:serde_json::to_vec(&json!({"model":MODEL,"messages":[{"role":"user","content":"I10_FAULT_PRIVATE_PROMPT"}],"max_tokens":1,"stream":streaming})).unwrap()}}
    }
    async fn operation(&self, session: &NewSession) -> Result<(NewOperation, DispatchAttempt)> {
        let op = NewOperation {
            request_id: session.request_id,
            operation_id: Uuid::new_v4(),
            request_hmac: [8; 32],
            endpoint: "/v1/chat/completions".into(),
            model: MODEL.into(),
            reservation_nano: 101,
        };
        self.ledger.reserve_operation(&op).await?;
        let attempt = self
            .ledger
            .begin_dispatch(op.request_id, op.operation_id, Uuid::new_v4(), || async {
                Ok(())
            })
            .await?;
        self.ledger.claim_dispatch(&attempt).await?;
        Ok((op, attempt))
    }
    async fn spawn(
        &self,
        request: &egress::Request,
    ) -> Result<(Child, BufReader<ChildStdout>, u32)> {
        self.remote.validate()?;
        let mut child = tokio::process::Command::new(&self.remote.binary)
            .arg(&self.remote.config_file)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let pid = child.id().context("dispatcher pid")?;
        let mut input = child.stdin.take().unwrap();
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        input.write_all(&bytes).await?;
        drop(input);
        let output = BufReader::new(child.stdout.take().unwrap());
        Ok((child, output, pid))
    }
    async fn restart_writer(&mut self) -> Result<()> {
        let old = self.ledger.writer_epoch();
        ensure!(
            self.sql
                .query_one(
                    "SELECT pg_terminate_backend($1)",
                    &[&self.ledger.backend_pid()]
                )
                .await?
                .get::<_, bool>(0),
            "writer not terminated"
        );
        for _ in 0..100 {
            if !self.ledger.healthy() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        ensure!(!self.ledger.healthy(), "writer still healthy");
        self.ledger = Ledger::connect(&self.url, &self.identity).await?;
        ensure!(
            self.ledger.writer_epoch() == old + 1,
            "epoch did not advance"
        );
        Ok(())
    }
    fn direct(&self) -> DirectRuntime {
        let mut config = self.service.providers.direct[0].clone();
        if let DirectConfig::Openrouter {
            credential_file, ..
        } = &mut config
        {
            *credential_file = self.directory.path().join("not-mounted-in-parent");
        }
        DirectRuntime::new(DirectAdapter::remote(config, self.remote.clone()))
    }
}
async fn frame(output: &mut BufReader<ChildStdout>) -> Result<Value> {
    let mut line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line)).await??;
    ensure!(read > 0, "dispatcher closed before terminal frame");
    Ok(serde_json::from_str(&line)?)
}
async fn terminal(output: &mut BufReader<ChildStdout>) -> Result<Value> {
    loop {
        let event = frame(output).await?;
        if event["event"] == "result" {
            return Ok(event["value"].clone());
        }
    }
}
async fn wait_count(counter: &AtomicUsize, expected: usize) -> Result<()> {
    for _ in 0..1000 {
        if counter.load(Ordering::SeqCst) >= expected {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    anyhow::bail!("provider did not observe expected request")
}
fn fence(identity: &PoolIdentity, attempt: &DispatchAttempt, pid: u32) -> Result<FenceEvidence> {
    let key = SigningKey::from_bytes(&[72; 32]);
    let mut certificate = FenceCertificate {
        pool: identity.pool,
        attempt_id: attempt.attempt_id,
        owner_instance: attempt.owner_instance,
        writer_epoch: attempt.writer_epoch,
        controller: "i10-local-child-supervisor".into(),
        resource_uid: format!("observed-exited-child-{pid}"),
        process_terminated: true,
        restart_denied: true,
        egress_revoked: true,
        observed_at: now(),
        signature: String::new(),
    };
    certificate.signature = hex::encode(key.sign(&certificate.signed_bytes()?).to_bytes());
    certificate.verify(key.verifying_key().to_bytes(), now())
}
#[derive(Default)]
struct DirectFixture {
    data: Value,
    creates: usize,
    lists: usize,
    disables: usize,
    reads: usize,
    deletes: usize,
    deleted: bool,
}
struct ProviderFixture {
    mode: AtomicUsize,
    sends: AtomicUsize,
    gate: Mutex<Arc<Notify>>,
    direct: Mutex<DirectFixture>,
}
async fn provider() -> Result<(String, Arc<ProviderFixture>, tokio::task::JoinHandle<()>)> {
    let state = Arc::new(ProviderFixture {
        mode: AtomicUsize::new(0),
        sends: AtomicUsize::new(0),
        gate: Mutex::new(Arc::new(Notify::new())),
        direct: Mutex::new(DirectFixture::default()),
    });
    let p = state.clone();
    let create = state.clone();
    let list = state.clone();
    let disable = state.clone();
    let usage = state.clone();
    let delete = state.clone();
    let router=Router::new().route("/v1/chat/completions",post(move|headers:HeaderMap,Json(body):Json<Value>|{let state=p.clone();async move {
        assert_eq!(headers["authorization"],"Bearer I10_FAULT_PROVIDER_SECRET");assert_eq!(body["messages"][0]["content"],"I10_FAULT_PRIVATE_PROMPT");
        let mode=state.mode.load(Ordering::SeqCst);let gate=state.gate.lock().await.clone();state.sends.fetch_add(1,Ordering::SeqCst);
        if mode==1 {gate.notified().await;}
        if mode==2 {
            assert_eq!(body["stream_options"]["include_usage"],true);
            let stream=futures_util::stream::unfold((0,gate),|(index,gate)|async move {
                let chunk=match index {0=>"data: {\"id\":\"fault-stream\",\"choices\":[{\"delta\":{\"content\":\"I10_FAULT_PRIVATE_RESPONSE\"}}]}\n\n",1=>{gate.notified().await;"data: {\"id\":\"fault-stream\",\"choices\":[],\"usage\":{\"prompt_tokens\":2000,\"completion_tokens\":1,\"total_tokens\":2001}}\n\ndata: [DONE]\n\n"},_=>return None};
                Some((Ok::<_,std::convert::Infallible>(chunk),(index+1,gate)))
            });
            Response::builder().header("content-type","text/event-stream").body(Body::from_stream(stream)).unwrap().into_response()
        }else {Json(json!({"id":"fault-normal","choices":[{"message":{"content":"I10_FAULT_PRIVATE_RESPONSE"}}],"usage":{"prompt_tokens":2000,"completion_tokens":1,"total_tokens":2001,"prompt_tokens_details":{"cached_tokens":0}}})).into_response()}
    }}))
    .route("/api/v1/keys",post(move|headers:HeaderMap,Json(mut body):Json<Value>|{let state=create.clone();async move {
        assert_eq!(headers["authorization"],"Bearer I10_FAULT_PROVIDER_SECRET");assert!(body["include_byok_in_limit"]==true);
        let mut d=state.direct.lock().await;d.creates+=1;body["hash"]="fault-direct-reference".into();body["disabled"]=false.into();d.data=body;
        // The key exists upstream, but the only issuance acknowledgement is lost.
        StatusCode::INTERNAL_SERVER_ERROR
    }}).get(move|Query(query):Query<BTreeMap<String,String>>|{let state=list.clone();async move {
        let mut d=state.direct.lock().await;d.lists+=1;
        Json(json!({"data":if query.get("offset").map(String::as_str)==Some("0"){vec![d.data.clone()]}else{vec![]}}))
    }}))
    .route("/api/v1/keys/fault-direct-reference",axum::routing::patch(move|Json(body):Json<Value>|{let state=disable.clone();async move {
        assert_eq!(body["disabled"],true);let mut d=state.direct.lock().await;d.disables+=1;d.data["disabled"]=true.into();
        if d.disables==1 {StatusCode::INTERNAL_SERVER_ERROR.into_response()}else{Json(json!({"data":d.data})).into_response()}
    }}).get(move||{let state=usage.clone();async move {
        let mut d=state.direct.lock().await;d.reads+=1;assert_eq!(d.data["disabled"],true);assert!(!d.deleted,"durable usage must avoid reads after deletion");
        if d.reads==1 {StatusCode::INTERNAL_SERVER_ERROR.into_response()}else{let mut data=d.data.clone();data["usage"]=serde_json::from_str("0.00002").unwrap();data["byok_usage"]=0.into();Json(json!({"data":data})).into_response()}
    }}).delete(move||{let state=delete.clone();async move {
        let mut d=state.direct.lock().await;d.deletes+=1;d.deleted=true;
        if d.deletes==1 {StatusCode::INTERNAL_SERVER_ERROR}else{StatusCode::NOT_FOUND}
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Ok((origin, state, task))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL; scripts/run_i10.py"]
async fn repeated_dispatcher_and_direct_faults_recover_without_replay_or_double_charge(
) -> Result<()> {
    let output = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/i10/fault-results.json");
    std::fs::create_dir_all(output.parent().unwrap())?;
    if output.exists() {
        std::fs::remove_file(&output)?;
    }
    let started = Instant::now();
    let (origin, provider, server) = provider().await?;
    let mut h = Harness::new(&origin).await?;
    let proxy_tariff = tariff(false);
    let direct_tariff = tariff(true);
    let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let refused_origin = format!("http://{}", unused.local_addr()?);
    drop(unused);
    let labels = [
        "connection_refused_before_provider_acceptance",
        "provider_accepted_before_headers",
        "midstream_dispatcher_killed",
        "usage_received_writer_lost_before_persistence",
    ];
    let mut cases = Vec::new();
    let mut backend_losses = 0;
    let mut expected_sends = 0;
    for cycle in 0..CYCLES {
        let s = session(&h.ledger, &proxy_tariff, false).await?;
        // Admission committed but no dispatch permission was ever issued.
        let unsent = NewOperation {
            request_id: s.request_id,
            operation_id: Uuid::new_v4(),
            request_hmac: [8; 32],
            endpoint: "/v1/chat/completions".into(),
            model: MODEL.into(),
            reservation_nano: 101,
        };
        h.ledger.reserve_operation(&unsent).await?;
        let unsent_receipt = receipt(
            &h.identity,
            &proxy_tariff,
            &s,
            Some(&unsent),
            Some(0),
            true,
            None,
        )?;
        h.ledger
            .complete_operation(
                s.request_id,
                unsent.operation_id,
                OperationOutcome::NotDispatched,
                &unsent_receipt,
            )
            .await?;
        for offset in 0..3 {
            let kind = (cycle + offset) % 4;
            let before = provider.sends.load(Ordering::SeqCst);
            let gate = Arc::new(Notify::new());
            *provider.gate.lock().await = gate.clone();
            provider.mode.store(kind, Ordering::SeqCst);
            h.origin(if kind == 0 { &refused_origin } else { &origin })?;
            ensure!(
                h.ledger.provider_available("openai").await?,
                "breaker reset did not reopen admission"
            );
            let (op, attempt) = h.operation(&s).await?;
            let request = h.request(&attempt, kind == 2);
            let (mut child, mut child_output, pid) = h.spawn(&request).await?;
            if kind == 1 || kind == 2 {
                expected_sends += 1;
                wait_count(&provider.sends, expected_sends).await?;
                if kind == 2 {
                    loop {
                        let event = frame(&mut child_output).await?;
                        if event["event"] == "data" {
                            ensure!(
                                !event["bytes"].as_array().unwrap().is_empty(),
                                "empty stream frame"
                            );
                            break;
                        }
                        ensure!(
                            event["event"] != "result",
                            "stream finished before injected fault"
                        );
                    }
                }
                child.kill().await?;
                let status = child.wait().await?;
                ensure!(!status.success(), "dispatcher was not killed");
                gate.notify_one();
            } else {
                let observation = terminal(&mut child_output).await?;
                ensure!(
                    child.wait().await?.success(),
                    "dispatcher failed before observation"
                );
                if kind == 0 {
                    ensure!(
                        observation["usage"].is_null(),
                        "refused connection returned usage"
                    );
                } else {
                    expected_sends += 1;
                    ensure!(
                        !observation["usage"].is_null(),
                        "usage was not actually received"
                    );
                }
                // Deliberately discard the terminal observation; it was never
                // committed to the financial writer and cannot support billing.
                drop(observation);
            }
            ensure!(
                provider.sends.load(Ordering::SeqCst) == before + usize::from(kind != 0),
                "unexpected inference send"
            );
            ensure!(
                h.service
                    .claims_directory
                    .join(attempt.attempt_id.to_string())
                    .exists(),
                "missing durable one-shot claim"
            );
            // Restart denial must hold before a fence is written, solely from
            // the immutable claim, including an unacknowledged terminal result.
            ensure!(
                h.remote
                    .call(h.request(&attempt, kind == 2), None)
                    .await
                    .is_err(),
                "dispatcher replayed a claimed attempt"
            );
            if kind == 3 {
                h.restart_writer().await?;
                backend_losses += 1;
                ensure!(
                    h.ledger.finish_attempt(&attempt, [9; 32]).await.is_err(),
                    "new epoch completed old owner"
                );
                ensure!(
                    h.ledger.recover_abandoned_operations(s.request_id).await? == 1,
                    "lost writer did not recover unknown"
                );
            } else {
                h.ledger
                    .mark_operation_unknown(s.request_id, op.operation_id)
                    .await?;
            }
            let waiver = receipt(&h.identity, &proxy_tariff, &s, Some(&op), None, false, None)?;
            ensure!(
                matches!(
                    h.ledger
                        .complete_operation(
                            s.request_id,
                            op.operation_id,
                            OperationOutcome::UnknownWaived,
                            &waiver
                        )
                        .await,
                    Err(LedgerError::Conflict("dispatch_not_quiesced"))
                ),
                "unfenced waiver succeeded"
            );
            ensure!(
                h.ledger.session(s.request_id).await?.reserved_nano == 101,
                "unknown reservation released early"
            );
            ensure!(
                h.ledger
                    .reset_provider_admission("openai", [10; 32])
                    .await
                    .is_err(),
                "reset accepted nonterminal work"
            );
            h.ledger
                .fence_attempt(&attempt, &fence(&h.identity, &attempt, pid)?)
                .await?;
            h.ledger
                .complete_operation(
                    s.request_id,
                    op.operation_id,
                    OperationOutcome::UnknownWaived,
                    &waiver,
                )
                .await?;
            ensure!(
                h.ledger
                    .complete_operation(
                        s.request_id,
                        op.operation_id,
                        OperationOutcome::UnknownWaived,
                        &waiver
                    )
                    .await
                    .is_err(),
                "duplicate completion charged twice"
            );
            ensure!(
                h.ledger.claim_dispatch(&attempt).await.is_err(),
                "old owner claim accepted after fence"
            );
            ensure!(
                h.ledger.finish_attempt(&attempt, [11; 32]).await.is_err(),
                "old owner finish accepted after fence"
            );
            ensure!(
                h.remote
                    .call(h.request(&attempt, kind == 2), None)
                    .await
                    .is_err(),
                "fenced owner restarted"
            );
            ensure!(
                provider.sends.load(Ordering::SeqCst) == expected_sends,
                "recovery replayed inference"
            );
            h.ledger.set_accepting(true).await?;
            let saved = h.ledger.session(s.request_id).await?;
            ensure!(
                saved.reserved_nano == 0 && saved.active_operations == 0 && saved.charged_nano == 0,
                "waiver accounting changed"
            );
            cases.push(json!({"cycle":cycle,"boundary":labels[kind],"provider_requests":usize::from(kind!=0),"restarts_denied_before_and_after_fence":true,"unknown_charge_nano_usdc":"0","claim_retained":true}));
        }
        ensure!(
            !h.ledger.provider_available("openai").await?,
            "three unknowns did not trip durable breaker"
        );
        h.restart_writer().await?;
        backend_losses += 1;
        ensure!(
            !h.ledger.provider_available("openai").await?,
            "writer restart cleared breaker"
        );
        h.ledger
            .reset_provider_admission(
                "openai",
                wire::sha256(format!("cycle-{cycle}-all-dispatchers-observed-exited").as_bytes()),
            )
            .await?;
        h.ledger.set_accepting(true).await?;
        ensure!(
            h.ledger.provider_available("openai").await?,
            "audited reset not effective"
        );
        h.origin(&origin)?;
        provider.mode.store(4, Ordering::SeqCst);
        let (op, attempt) = h.operation(&s).await?;
        let observation: proxy::DispatchObservation =
            serde_json::from_value(h.remote.call(h.request(&attempt, false), None).await?)?;
        expected_sends += 1;
        let observed = quote::calculate_charge(
            &proxy_tariff,
            observation
                .usage
                .as_ref()
                .context("healthy operation usage")?,
        )?;
        ensure!(observed == 2001, "healthy overrun fixture not measured");
        h.ledger
            .finish_attempt(
                &attempt,
                wire::sha256(b"dispatcher terminal frame and observed process exit"),
            )
            .await?;
        let record = receipt(
            &h.identity,
            &proxy_tariff,
            &s,
            Some(&op),
            Some(observed),
            false,
            observation.evidence_digest.map(hex::encode),
        )?;
        let saved = h
            .ledger
            .complete_operation(
                s.request_id,
                op.operation_id,
                OperationOutcome::Metered {
                    observed_nano: observed,
                },
                &record,
            )
            .await?;
        ensure!(
            saved.charged_nano == 101 && saved.operator_loss_nano == 1900,
            "provider overrun transferred to user"
        );
        ensure!(
            h.ledger.reserve_operation(&op).await.is_err(),
            "completed operation replayable"
        );
        h.ledger.close(s.request_id).await?;
        h.ledger.reconcile(s.request_id).await?;
        let committed_receipts = h.ledger.receipts(s.request_id, None, 100).await?;
        ensure!(
            committed_receipts.len() == 5,
            "missing or duplicated per-operation receipts"
        );
        ensure!(
            provider.sends.load(Ordering::SeqCst) == expected_sends,
            "healthy restart duplicated provider call"
        );

        // Repeated direct failures exercise the product's durable checkpoint
        // runtime, with a new runtime object at each recovery boundary.
        *provider.direct.lock().await = DirectFixture::default();
        let direct = session(&h.ledger, &direct_tariff, true).await?;
        let intent = IssueIntent {
            request_id: direct.request_id,
            cap_micro: direct.cap_micro,
            ttl_seconds: 60,
            requested_at: now(),
        };
        ensure!(
            h.direct()
                .issue(&h.ledger, intent.clone(), Uuid::new_v4(), || async {
                    Ok(())
                })
                .await?
                .is_none(),
            "uncertain issuance delivered a key"
        );
        ensure!(
            h.ledger.session(direct.request_id).await?.state == "ISSUANCE_UNKNOWN",
            "issuance uncertainty not persisted"
        );
        ensure!(
            h.direct()
                .issue(&h.ledger, intent, Uuid::new_v4(), || async {
                    panic!("recovery must not issue again")
                })
                .await?
                .is_none(),
            "issued key replayed"
        );
        ensure!(
            h.direct()
                .reconcile(&h.ledger, direct.request_id)
                .await
                .is_err(),
            "lost disable acknowledgement accepted"
        );
        let checkpoint = h
            .ledger
            .direct_checkpoint(direct.request_id)
            .await?
            .unwrap();
        ensure!(
            !checkpoint["reference"].is_null() && checkpoint["disabled_at"].is_null(),
            "disable checkpoint jumped uncertain response"
        );
        ensure!(
            h.direct()
                .reconcile(&h.ledger, direct.request_id)
                .await
                .is_err(),
            "usage outage accepted"
        );
        // The first successful post-grace sample is durably selected before
        // deletion. This call reaches the deliberately lost DELETE response;
        // recovery must reuse that sample, not require another usage read.
        ensure!(
            h.direct()
                .reconcile(&h.ledger, direct.request_id)
                .await
                .is_err(),
            "lost delete acknowledgement accepted"
        );
        let retained = h
            .ledger
            .direct_checkpoint(direct.request_id)
            .await?
            .unwrap();
        ensure!(
            retained["usage"]["observed_nano"] == "20000"
                && retained["observation"].is_null()
                && retained["deleted"] == false,
            "selected usage not durable before delete"
        );
        {
            let d = provider.direct.lock().await;
            ensure!(
                (d.creates, d.lists, d.disables, d.reads, d.deletes) == (1, 2, 2, 2, 1)
                    && d.deleted,
                "first successful usage sample did not reach the uncertain deletion"
            );
        }
        h.restart_writer().await?;
        backend_losses += 1;
        ensure!(
            h.ledger
                .direct_checkpoint(direct.request_id)
                .await?
                .as_ref()
                == Some(&retained),
            "direct retirement checkpoint changed across writer restart"
        );
        // The healthy completion committed before this backend loss. Treat its
        // acknowledgement as lost and retry the exact outcome/receipt through
        // the reopened writer: terminal state and accounting must be durable.
        ensure!(
            matches!(
                h.ledger
                    .complete_operation(
                        s.request_id,
                        op.operation_id,
                        OperationOutcome::Metered {
                            observed_nano: observed,
                        },
                        &record,
                    )
                    .await,
                Err(LedgerError::Conflict("operation_terminal"))
            ),
            "committed completion accepted again after writer restart"
        );
        let reopened_operation = h.ledger.operation(s.request_id, op.operation_id).await?;
        let reopened_session = h.ledger.session(s.request_id).await?;
        ensure!(
            reopened_operation.state == "DONE"
                && reopened_operation.charged_nano == 101
                && reopened_operation.observed_cost_nano == Some(observed)
                && reopened_operation.operator_loss_nano == 1900
                && reopened_session.charged_nano == 101
                && reopened_session.reserved_nano == 0
                && reopened_session.active_operations == 0,
            "committed completion accounting changed after writer restart"
        );
        let reopened_receipts = h.ledger.receipts(s.request_id, None, 100).await?;
        ensure!(
            reopened_receipts.len() == committed_receipts.len()
                && reopened_receipts
                    .iter()
                    .zip(&committed_receipts)
                    .all(|(a, b)| {
                        a.sequence == b.sequence
                            && a.receipt_id == b.receipt_id
                            && a.receipt_hash == b.receipt_hash
                            && a.canonical_body == b.canonical_body
                            && a.signature == b.signature
                    }),
            "signed receipts changed or duplicated after committed completion retry"
        );
        cases.push(json!({"cycle":cycle,"boundary":"completion_committed_before_writer_loss","reopened_duplicate_completion":"operation_terminal","charged_nano_usdc":"101","signed_receipts_unchanged":true}));
        let finalization = h
            .direct()
            .reconcile(&h.ledger, direct.request_id)
            .await?
            .context("direct recovery missing final usage")?;
        ensure!(
            finalization.usage.observed_nano == "20000",
            "durable direct usage changed"
        );
        let repeated = h
            .direct()
            .reconcile(&h.ledger, direct.request_id)
            .await?
            .unwrap();
        ensure!(
            repeated.stop_evidence == finalization.stop_evidence
                && repeated.usage == finalization.usage,
            "terminal recovery changed evidence"
        );
        let record = receipt(
            &h.identity,
            &direct_tariff,
            &direct,
            None,
            Some(20000),
            false,
            Some(finalization.usage.evidence_digest.clone()),
        )?;
        let saved = h
            .ledger
            .complete_direct(
                direct.request_id,
                DirectOutcome::Metered {
                    observed_nano: 20000,
                },
                finalization.stop_evidence,
                &record,
            )
            .await?;
        ensure!(saved.charged_nano == 10000, "direct cap exceeded");
        ensure!(
            h.ledger
                .complete_direct(
                    direct.request_id,
                    DirectOutcome::Metered {
                        observed_nano: 20000
                    },
                    finalization.stop_evidence,
                    &record
                )
                .await
                .is_err(),
            "direct duplicate receipt accepted"
        );
        ensure!(
            h.ledger.receipts(direct.request_id, None, 100).await?.len() == 1,
            "direct double billing"
        );
        let d = provider.direct.lock().await;
        ensure!(
            (d.creates, d.lists, d.disables, d.reads, d.deletes) == (1, 2, 2, 2, 2),
            "direct recovery unexpectedly reissued/read deleted usage/redeleted"
        );
        cases.push(json!({"cycle":cycle,"boundary":"direct_issue_disable_usage_delete_uncertainty","creates":d.creates,"recovery_list_pages":d.lists,"disable_requests":d.disables,"usage_reads":d.reads,"delete_requests":d.deletes,"charged_nano_usdc":"10000","operator_loss_nano_usdc":"10000","usage_retained_across_writer_restart":true}));
        drop(d);
        h.ledger.set_accepting(true).await?;
    }
    let counts=h.sql.query_one("SELECT (SELECT count(*) FROM sessions),(SELECT count(*) FROM operations),(SELECT count(*) FROM dispatch_attempts),(SELECT count(*) FROM receipts),(SELECT count(*) FROM dispatch_attempts WHERE finished_at IS NULL AND fenced_at IS NULL),(SELECT count(*) FROM sessions WHERE reserved_nano<>0 OR active_operations<>0 OR charged_nano>cap_micro::numeric*1000),(SELECT count(*) FROM operations WHERE charged_nano>reservation_nano),(SELECT sum(charged_nano)::text FROM sessions)",&[]).await?;
    ensure!(
        counts.get::<_, i64>(0) == (CYCLES * 2) as i64
            && counts.get::<_, i64>(1) == (CYCLES * 5) as i64
            && counts.get::<_, i64>(2) == (CYCLES * 5) as i64
            && counts.get::<_, i64>(3) == (CYCLES * 6) as i64,
        "fault lifecycle row counts"
    );
    ensure!(
        (
            counts.get::<_, i64>(4),
            counts.get::<_, i64>(5),
            counts.get::<_, i64>(6)
        ) == (0, 0, 0),
        "recovery/accounting invariant violations"
    );
    ensure!(
        counts.get::<_, String>(7) == (CYCLES * 10101).to_string(),
        "total charge mismatch"
    );
    let claims = std::fs::read_dir(&h.service.claims_directory)?.count();
    ensure!(
        claims == CYCLES * 5,
        "durable claim count differs from dispatched operations"
    );
    for table in [
        "sessions",
        "operations",
        "dispatch_attempts",
        "receipts",
        "outbox",
    ] {
        for row in h
            .sql
            .query(&format!("SELECT row_to_json(t)::text FROM {table} t"), &[])
            .await?
        {
            let data: String = row.get(0);
            for secret in [
                "I10_FAULT_PROVIDER_SECRET",
                "I10_FAULT_PRIVATE_PROMPT",
                "I10_FAULT_PRIVATE_RESPONSE",
            ] {
                ensure!(
                    !data.contains(secret) && !data.contains(&hex::encode(secret)),
                    "provider secret/content persisted"
                );
            }
        }
    }
    let report = json!({"version":1,"passed":true,"scope":"bounded repeated recovery with real PostgreSQL/dispatcherd/provider adapters/direct checkpoints; fixture authorization, provider wire and local fence controller","cycles":CYCLES,"cases":cases,"proxy_faults":CYCLES*3,"healthy_capped_proxy_operations_after_reset":CYCLES,"direct_uncertain_lifecycles":CYCLES,"provider_proxy_requests":expected_sends,"postgres_writer_backend_losses":backend_losses,"durable_dispatcher_claims":claims,"signed_receipts":CYCLES*6,"total_charged_nano_usdc":(CYCLES*10101).to_string(),"expected_total_operator_loss_nano_usdc":(CYCLES*11900).to_string(),"invariant_counters":{"unquiesced_dispatchers":counts.get::<_,i64>(4),"session_reservation_cap_violations":counts.get::<_,i64>(5),"operation_cap_violations":counts.get::<_,i64>(6)},"automatic_inference_replays":0,"release_gates_passed":[],"elapsed_milliseconds":started.elapsed().as_millis(),"unverified":["real request proofs and independent sign-once signing in this suite","real provider billing and public RPC","production OS/network egress revocation and independent controller","precise process crash in every control DB commit window","duration-based soak and production SLO"],"local_fence_scope":"each original dispatcherd exited or was killed and reaped; its persisted claim refuses a new process before and after the signed local controller fence; no production ACL claim"});
    std::fs::write(&output, serde_json::to_vec_pretty(&report)?)?;
    server.abort();
    println!("I10 repeated faults: {} proxy faults, {} direct recovery sequences, {} healthy capped operations; no replay/double charge",CYCLES*3,CYCLES,CYCLES);
    Ok(())
}
