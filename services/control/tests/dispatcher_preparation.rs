//! Real child-process IPC checks with a pinned synthetic worker. No provider,
//! credentials or ledger writes; provider/ledger acceptance is tested separately.
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tempfile::TempDir;
use uuid::Uuid;
use zkapi_control::{direct::IssueIntent, egress::ClientConfig, ledger::DispatchAttempt, wire};

fn attempt() -> DispatchAttempt {
    DispatchAttempt {
        attempt_id: Uuid::new_v4(),
        request_id: Uuid::new_v4(),
        operation_id: None,
        owner_instance: Uuid::new_v4(),
        writer_epoch: 7,
    }
}
fn intent(a: &DispatchAttempt) -> IssueIntent {
    IssueIntent {
        request_id: a.request_id,
        cap_micro: 1_000_000,
        ttl_seconds: 60,
        requested_at: 0,
    }
}
fn fixture(first: Value, second: Option<Value>) -> (TempDir, ClientConfig) {
    let dir = tempfile::tempdir().unwrap();
    let config_file = dir.path().join("config.json");
    std::fs::write(&config_file, b"{}").unwrap();
    std::fs::set_permissions(&config_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let binary = dir.path().join("worker");
    let mut source = format!(
        "#!/bin/sh\nprintf '%s' \"$$\" > \"$1.pid\"\nIFS= read -r request || exit 10\nprintf '%s\\n' '{}'\n",
        first.to_string().replace('\'', "'\\''")
    );
    if let Some(second) = second {
        source.push_str(&format!(
            "IFS= read -r permission || exit 11\nprintf '%s' \"$permission\" > \"$1.permission\"\nprintf '%s\\n' '{}'\n",
            second.to_string().replace('\'', "'\\''")
        ));
    } else {
        // Remain blocked until the parent closes input or terminates this worker.
        source.push_str("IFS= read -r permission || exit 12\nexit 13\n");
    }
    std::fs::write(&binary, source.as_bytes()).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = ClientConfig {
        binary,
        binary_sha256: hex::encode(wire::sha256(source.as_bytes())),
        config_file,
    };
    (dir, config)
}
fn assert_exited(config: &ClientConfig) {
    let pid = std::fs::read_to_string(config.config_file.with_extension("json.pid")).unwrap();
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", "kill -0 \"$1\" 2>/dev/null", "process-check", &pid])
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "worker must have exited before call returns"
    );
}

#[tokio::test]
async fn direct_prepare_waits_for_authorization_and_sends_one_bound_permission() -> Result<()> {
    let a = attempt();
    let (_dir, config) = fixture(
        json!({"event":"prepared", "attempt":a}),
        Some(json!({"event":"result", "value":{"accepted":true}})),
    );
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let permission = config.config_file.with_extension("json.permission");
    let checked_path = permission.clone();
    let value = config
        .create_prepared(
            wire::Provider::Openrouter,
            intent(&a),
            a.clone(),
            async move {
                assert!(!checked_path.exists(), "GO cannot precede authorization");
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await?;
    assert_eq!(value["accepted"], true);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let go: Value = serde_json::from_slice(&std::fs::read(permission)?)?;
    assert_eq!(go, json!({"command":"go", "attempt_id":a.attempt_id}));
    assert_exited(&config);
    Ok(())
}

#[tokio::test]
async fn direct_prepare_callback_refusal_closes_and_reaps_worker_without_permission() {
    let a = attempt();
    let (_dir, config) = fixture(json!({"event":"prepared", "attempt":a}), None);
    let result = config
        .create_prepared(wire::Provider::Openrouter, intent(&a), a, async {
            anyhow::bail!("synthetic writer refused authorization")
        })
        .await;
    assert!(result.is_err());
    assert!(!config
        .config_file
        .with_extension("json.permission")
        .exists());
    assert_exited(&config);
}

#[tokio::test]
async fn direct_prepare_rejects_foreign_identity_or_result_before_authorization() {
    for first in [
        json!({"event":"prepared", "attempt":attempt()}),
        json!({"event":"result", "value":{"accepted":true}}),
        json!({"event":"failure", "diagnostic":{"stage":"dispatcher", "reason_code":"claim_storage_unavailable", "issuance_certainty":"not_sent"}}),
    ] {
        let a = attempt();
        let (_dir, config) = fixture(first, None);
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let result = config
            .create_prepared(wire::Provider::Openrouter, intent(&a), a, async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(!config
            .config_file
            .with_extension("json.permission")
            .exists());
        assert_exited(&config);
    }
}

#[tokio::test]
async fn direct_prepare_duplicate_ready_cannot_reauthorize() {
    let a = attempt();
    let ready = json!({"event":"prepared", "attempt":a});
    let (_dir, config) = fixture(ready.clone(), Some(ready));
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let result = config
        .create_prepared(wire::Provider::Openrouter, intent(&a), a, async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_exited(&config);
}

struct RealFixture {
    _dir: TempDir,
    ledger: zkapi_control::ledger::Ledger,
    config: ClientConfig,
    claims: std::path::PathBuf,
    calls: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for RealFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn db(url: &str) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
impl RealFixture {
    async fn new() -> Result<Self> {
        use axum::{routing::post, Router};
        use zkapi_control::{
            direct::DirectConfig,
            egress::ServiceConfig,
            ledger::{self, PoolIdentity},
            provider_runtime::ProviderConfig,
        };
        let base = std::env::var("ZKAPI_TEST_DATABASE_URL").expect("isolated PostgreSQL required");
        let admin = db(&base).await;
        let name = format!("zkapi_prepare_{}", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await?;
        let pg: tokio_postgres::Config = base.parse()?;
        let host = match pg.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(host) => host.clone(),
            tokio_postgres::config::Host::Unix(host) => host.display().to_string(),
        };
        let url = format!(
            "host={host} port={} user={} dbname={name}",
            pg.get_ports().first().unwrap_or(&5432),
            pg.get_user().unwrap()
        );
        ledger::migrate(&url).await?;
        let identity = PoolIdentity {
            pool: [71; 32],
            deployment_id: format!("prepare-{}", Uuid::new_v4()),
            manifest_hash: [72; 32],
            authorization_config: json!({"signer":{"receipt_key":ed25519_dalek::SigningKey::from_bytes(&[73;32]).verifying_key().to_bytes()}}),
        };
        let ledger = ledger::Ledger::connect(&url, &identity).await?;
        ledger.set_accepting(true).await?;
        let calls = Arc::new(AtomicUsize::new(0));
        let received = calls.clone();
        let router = Router::new().route(
            "/keys",
            post(move || {
                let calls = received.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let dir = tempfile::tempdir()?;
        let credential = dir.path().join("fixture-credential");
        std::fs::write(&credential, "synthetic-provider-credential")?;
        std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600))?;
        let claims = dir.path().join("claims");
        std::fs::create_dir(&claims)?;
        std::fs::set_permissions(&claims, std::fs::Permissions::from_mode(0o700))?;
        let service = ServiceConfig {
            local_test_only: true,
            devnet: None,
            database_url: url,
            pool: identity.pool,
            claims_directory: claims.clone(),
            providers: ProviderConfig {
                direct: vec![DirectConfig::Openrouter {
                    api_base: origin.clone(),
                    inference_base: origin,
                    credential_file: credential,
                    settlement_grace_seconds: 0,
                }],
                ..Default::default()
            },
        };
        let config_file = dir.path().join("dispatcher.json");
        std::fs::write(&config_file, serde_json::to_vec(&service)?)?;
        std::fs::set_permissions(&config_file, std::fs::Permissions::from_mode(0o600))?;
        let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_dispatcherd"));
        let config = ClientConfig {
            binary_sha256: hex::encode(wire::sha256(&std::fs::read(&binary)?)),
            binary,
            config_file,
        };
        Ok(Self {
            _dir: dir,
            ledger,
            config,
            claims,
            calls,
            server,
        })
    }
    async fn reserve(&self) -> Result<IssueIntent> {
        use zkapi_control::ledger::{NewSession, QuoteRecord};
        let intent = IssueIntent {
            request_id: Uuid::new_v4(),
            cap_micro: 1_000_000,
            ttl_seconds: 60,
            requested_at: now(),
        };
        let tariff = b"{}";
        let tariff_hash = wire::sha256(tariff);
        self.ledger.store_tariff(tariff_hash, tariff).await?;
        let body = serde_json::to_vec(&json!({"quote_id":Uuid::new_v4(),"models":["*"]}))?;
        let quote = QuoteRecord {
            quote_id: Uuid::new_v4(),
            quote_hash: wire::sha256(&body),
            canonical_body: body,
            signature: vec![3; 64],
            tariff_hash,
            expires_at: now() as i64 + 120,
        };
        self.ledger.store_quote(&quote).await?;
        let transcript = b"synthetic direct preparation transcript; no proof claim".to_vec();
        self.ledger
            .reserve_session(
                &NewSession {
                    request_id: intent.request_id,
                    nullifier: wire::sha256(intent.request_id.as_bytes()),
                    quote_id: quote.quote_id,
                    request_digest: wire::sha256(&transcript),
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
            .await?;
        Ok(intent)
    }
    async fn prepare(&self) -> Result<(IssueIntent, DispatchAttempt)> {
        use zkapi_control::direct::Checkpoint;
        let intent = self.reserve().await?;
        let checkpoint = Checkpoint {
            intent: intent.clone(),
            reference: None,
            disabled_at: None,
            observation: None,
            usage: None,
            deleted: false,
            recovery: None,
        };
        self.ledger
            .save_direct_checkpoint(intent.request_id, None, &serde_json::to_value(checkpoint)?)
            .await?;
        let attempt = self
            .ledger
            .begin_direct_issuance(intent.request_id, Uuid::new_v4(), || async { Ok(()) })
            .await?;
        Ok((intent, attempt))
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; actual dispatcher and loopback provider"]
async fn actual_prepare_callback_refusal_and_duplicate_claim_never_send() -> Result<()> {
    let f = RealFixture::new().await?;
    let (intent, a) = f.prepare().await?;
    let claim = f.claims.join(a.attempt_id.to_string());
    let result = f
        .config
        .create_prepared(
            wire::Provider::Openrouter,
            intent.clone(),
            a.clone(),
            async {
                assert!(claim.exists(), "durable file precedes parent authorization");
                let attempts = f.ledger.dispatch_attempts_for_session(a.request_id).await?;
                assert!(!attempts[0].send_claimed);
                anyhow::bail!("synthetic authorization refusal")
            },
        )
        .await;
    assert!(result.is_err());
    let original_claim = std::fs::read(&claim)?;
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    assert!(!f.ledger.dispatch_attempts_for_session(a.request_id).await?[0].send_claimed);

    // An exclusive claim is never recreated, even when a caller tries the same
    // attempt again. This is an adversarial IPC call, not runtime retry logic.
    let callback = Arc::new(AtomicUsize::new(0));
    let count = callback.clone();
    let result = f
        .config
        .create_prepared(wire::Provider::Openrouter, intent, a.clone(), async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert_eq!(callback.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(claim)?, original_claim);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    f.ledger
        .finish_attempt(
            &a,
            wire::sha256(b"fixture observed worker return after exit"),
        )
        .await?;
    let attempts = f.ledger.dispatch_attempts_for_session(a.request_id).await?;
    assert!(attempts[0].finished && !attempts[0].send_claimed);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; actual dispatcher and loopback provider"]
async fn actual_prepare_close_and_admission_races_cannot_cross_egress() -> Result<()> {
    let f = RealFixture::new().await?;
    let (intent, a) = f.prepare().await?;
    let result = f
        .config
        .create_prepared(wire::Provider::Openrouter, intent, a.clone(), async {
            f.ledger.close(a.request_id).await?;
            f.ledger.claim_dispatch(&a).await?;
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert!(!f.ledger.dispatch_attempts_for_session(a.request_id).await?[0].send_claimed);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);

    let (intent, a) = f.prepare().await?;
    let result = f
        .config
        .create_prepared(wire::Provider::Openrouter, intent, a.clone(), async {
            f.ledger.claim_dispatch(&a).await?;
            f.ledger.set_accepting(false).await?;
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert!(
        f.ledger.dispatch_attempts_for_session(a.request_id).await?[0].send_claimed,
        "post-authorization refusal remains claimed, never relabeled as nonissuance"
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL; actual dispatcher and loopback provider"]
async fn actual_prepare_rechecks_chain_and_preserves_exit_before_send() -> Result<()> {
    use zkapi_control::{
        direct::{DirectAdapter, DirectRuntime},
        egress::ServiceConfig,
        ledger::LedgerError,
    };
    let f = RealFixture::new().await?;
    let intent = f.reserve().await?;
    let request_id = intent.request_id;
    let service: ServiceConfig = serde_json::from_slice(&std::fs::read(&f.config.config_file)?)?;
    let runtime = DirectRuntime::new(DirectAdapter::remote(
        service.providers.direct[0].clone(),
        f.config.clone(),
    ));
    let checks = AtomicUsize::new(0);
    let result = runtime
        .issue(&f.ledger, intent, Uuid::new_v4(), || async {
            if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(LedgerError::Conflict("exit_consumed"))
            }
        })
        .await;
    assert!(matches!(
        result.err().unwrap().downcast_ref::<LedgerError>(),
        Some(LedgerError::Conflict("exit_consumed"))
    ));
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    let attempts = f.ledger.dispatch_attempts_for_session(request_id).await?;
    assert_eq!(attempts.len(), 1);
    assert!(attempts[0].finished && !attempts[0].send_claimed);
    assert!(f.ledger.session(request_id).await?.close_requested);
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    Ok(())
}
