//! Local API lifecycle: real SDK/proofs, ledger, independent signer/dispatcher and Vault SBF.
//! API responses and finalized RPC/indexer envelopes are explicit local fixtures.
mod support;
use anyhow::{ensure, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_postgres::NoTls;
use uuid::Uuid;
use zkapi_control::{
    api::App,
    config::RuntimeConfig,
    egress::{ClientConfig, ServiceConfig},
    ledger::{migrate, Ledger, PoolIdentity},
    provider_runtime::ProviderConfig,
    quote,
    signer::Signer,
    wire::{self, Tariff},
};

fn private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and pinned local proof/SBF artifacts; scripts/run_general_api.py"]
async fn fixed_price_json_deposit_settle_withdraw_preserves_history() -> Result<()> {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let node = std::env::var("ZKAPI_NODE").context("pinned ZKAPI_NODE required")?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::path::PathBuf::from(std::env::var("ZKAPI_GENERAL_API_RUN_DIR")?)
        .join("e2e-results.json");
    let (admin, connection) = tokio_postgres::connect(&base, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let name = format!("general_api_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let location = base
        .strip_suffix(" dbname=postgres")
        .context("runner must provide the isolated postgres administration database")?;
    let url = format!("{location} dbname={name}");
    migrate(&url).await?;
    let (sql, connection) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let directory = std::path::PathBuf::from(std::env::var("ZKAPI_GENERAL_API_RUN_DIR")?)
        .join(format!("services-{}", Uuid::new_v4().simple()));
    std::fs::create_dir(&directory)?;
    let dir = directory.as_path();
    let socket_directory = tempfile::Builder::new()
        .prefix("zkapi-api-sock-")
        .tempdir_in("/tmp")?;
    std::fs::set_permissions(
        socket_directory.path(),
        std::fs::Permissions::from_mode(0o700),
    )?;
    let signer_socket = socket_directory.path().join("signer.sock");
    let onboarding = std::env::var("ZKAPI_ONBOARDING_VARIANT").ok();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let mut child = tokio::process::Command::new(node)
        .arg(
            std::env::var("ZKAPI_TEST_LIFECYCLE_SCRIPT")
                .unwrap_or_else(|_| "packages/sdk/test/general-api-e2e.ts".into()),
        )
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(60), lines.next_line())
            .await??
            .context("Node fixture readiness")?,
    )?;
    ensure!(ready["ready"] == true, "Node fixture readiness");
    let provider = ready["origin"]
        .as_str()
        .context("provider origin")?
        .to_owned();
    let second = ready["secondary"].as_str().context("secondary RPC")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let api = json!({"version":"1","service":"catalog","operation":"lookup","method":"POST","path":"/lookup","origin":provider,
        "request_max_bytes":"1048576","response_max_bytes":"1048576","timeout_seconds":"30","billing":"http_2xx_json"});
    let mut generic: Tariff =
        serde_json::from_value(json!({"version":"2","provider":"generic","api":api,
        "pricing_basis":"fixed_request","valid_from":"1","valid_until":"4000000000",
        "rates":[{"unit":"requests","nano_usdc_numerator":"250000","unit_denominator":"1"}],
        "operator_fee_micro_usdc":"0","tariff_hash":"00".repeat(32)}))?;
    generic.tariff_hash = quote::tariff_hash(&generic)?;
    let mut legacy: Tariff = serde_json::from_value(
        json!({"version":"1","provider":"openai","model":"legacy-fixture",
        "pricing_basis":"fixed_usage_rates","valid_from":"1","valid_until":"4000000000",
        "rates":[{"unit":"cache_read_tokens","nano_usdc_numerator":"1","unit_denominator":"1"},
                 {"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"1"},
                 {"unit":"output_tokens","nano_usdc_numerator":"1","unit_denominator":"1"}],
        "operator_fee_micro_usdc":"0","tariff_hash":"00".repeat(32)}),
    )?;
    legacy.tariff_hash = quote::tariff_hash(&legacy)?;
    let tariffs = vec![legacy, generic];
    let mut manifest = ready["manifest"].clone();
    manifest["control_api_origin"] = origin.clone().into();
    manifest["inference_api_origin"] = origin.into();
    manifest["tariff_hashes"] = json!(tariffs.iter().map(|t| &t.tariff_hash).collect::<Vec<_>>());
    let mut body = manifest.clone();
    body.as_object_mut().unwrap().remove("manifest_hash");
    body.as_object_mut().unwrap().remove("manifest_signature");
    let hash = wire::digest(&body)?;
    manifest["manifest_hash"] = hex::encode(hash).into();
    manifest["manifest_signature"] = base64::engine::general_purpose::STANDARD
        .encode(SigningKey::from_bytes(&[13; 32]).sign(&hash).to_bytes())
        .into();
    private(&dir.join("quote.seed"), &[11; 32])?;
    private(&dir.join("receipt.seed"), &[12; 32])?;
    private(&dir.join("provider.key"), b"general-api-fixture-credential")?;
    let providers: ProviderConfig = serde_json::from_value(json!({"dispatcher":null,"direct":[],
        "api":[{"api":api,"credential_file":dir.join("provider.key")}],
        "proxy":[{"provider":"openai","credential_file":dir.join("provider.key"),"local_test_base":provider,
            "models":[{"provider":"openai","model":"legacy-fixture","endpoints":["chat_completions"],
                "context_tokens":1000,"max_output_tokens":100,"cache_mode":"inclusive_read"}]}]}))?;
    let role = format!("general_api_dispatcher_{}", Uuid::new_v4().simple());
    ensure!(
        url.contains(" user=general_api_test "),
        "isolated runner user required"
    );
    let dispatcher_url = url.replacen(" user=general_api_test ", &format!(" user={role} "), 1);
    sql.batch_execute(&format!(
        "CREATE ROLE {role} LOGIN; GRANT zkapi_control_reader TO {role}"
    ))
    .await?;
    let claims = dir.join("dispatch-claims");
    std::fs::create_dir(&claims)?;
    std::fs::set_permissions(&claims, std::fs::Permissions::from_mode(0o700))?;
    let dispatcher_config = dir.join("dispatcher.json");
    private(
        &dispatcher_config,
        &serde_json::to_vec(&ServiceConfig {
            local_test_only: true,
            devnet: None,
            database_url: dispatcher_url.clone(),
            pool: wire::pubkey(manifest["pool"].as_str().unwrap())?,
            claims_directory: claims.clone(),
            providers: providers.clone(),
        })?,
    )?;
    let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_dispatcherd"));
    let mut frontend_providers = providers;
    frontend_providers.dispatcher = Some(ClientConfig {
        binary_sha256: hex::encode(wire::sha256(&std::fs::read(&binary)?)),
        binary,
        config_file: dispatcher_config,
    });
    for proxy in &mut frontend_providers.proxy {
        proxy.credential_file = dir.join("not-mounted-in-control");
    }
    for api in &mut frontend_providers.api {
        api.credential_file = dir.join("not-mounted-in-control");
    }
    let mut config = RuntimeConfig {
        devnet: None,
        local_test_only: true,
        listen: listener.local_addr()?,
        trusted_manifest_hash: hex::encode(hash),
        manifest: manifest.clone(),
        primary_rpc: format!("{provider}/rpc"),
        secondary_rpc: format!("{second}/rpc"),
        indexer_origin: provider,
        signer_socket: signer_socket.clone(),
        quote_seed_file: dir.join("quote.seed"),
        receipt_seed_file: dir.join("receipt.seed"),
        enable_local_adapter: false,
        providers: frontend_providers,
        tariffs: tariffs.clone(),
    };
    if onboarding.is_some() {
        let request = json!({"variant":onboarding,"gateway":std::env::var_os("ZKAPI_GATEWAY_TEST").is_some(),"nativeAgent":std::env::var("ZKAPI_GATEWAY_CLIENT").ok(),"directory":dir,"manifest":ready["manifest"],"provider":ready["origin"],
            "secondary":ready["secondary"],"controlOrigin":ready["controlOrigin"],"listen":listener.local_addr()?.to_string(),
            "databaseUrl":dispatcher_url,"controld":env!("CARGO_BIN_EXE_controld"),
            "dispatcherd":env!("CARGO_BIN_EXE_dispatcherd"),"signerSocket":signer_socket});
        private(
            &dir.join("preparation-input.json"),
            &serde_json::to_vec(&request)?,
        )?;
        let status = tokio::process::Command::new(std::env::var("ZKAPI_NODE")?)
            .arg("scripts/tests/general_api_local_config.ts")
            .arg(dir.join("preparation-input.json"))
            .current_dir(&root)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .await?;
        ensure!(
            status.success(),
            "local registration compiler/renderer failed"
        );
        config = serde_json::from_slice(&std::fs::read(dir.join("private/control.json"))?)?;
        manifest = config.manifest.clone();
    }
    let tariffs = config.tariffs.clone();
    let validated = config.validate()?;

    if onboarding.is_some() {
        let status = tokio::process::Command::new(env!("CARGO_BIN_EXE_controld"))
            .arg("provision")
            .arg(dir.join("private/control.json"))
            .env("ZKAPI_DATABASE_URL", &url)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .await?;
        ensure!(status.success(), "generated control provision failed");
    } else {
        drop(
            Ledger::connect(
                &url,
                &PoolIdentity {
                    pool: validated.signer.pool,
                    deployment_id: validated.binding.deployment_id.clone(),
                    manifest_hash: hash,
                    authorization_config: json!({"signer":validated.signer}),
                },
            )
            .await?,
        );
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let signer_config = if onboarding.is_some() {
        let path = dir.join("private/signer.json");
        ensure!(
            serde_json::from_slice::<Value>(&std::fs::read(&path)?)?
                == serde_json::to_value(&validated.signer)?,
            "inspection signer output differs from startup validation"
        );
        path
    } else {
        let path = dir.join("signer.json");
        private(&path, &serde_json::to_vec(&validated.signer)?)?;
        path
    };
    private(
        &dir.join("state.seed"),
        &zkapi_types::Felt252::from_u64(31).0,
    )?;
    private(
        &dir.join("clearance.seed"),
        &zkapi_types::Felt252::from_u64(37).0,
    )?;
    if onboarding.is_some() {
        let status = tokio::process::Command::new(env!("CARGO_BIN_EXE_signerd"))
            .args(["--local-test", "--initialize-journal", "--config"])
            .arg(&signer_config)
            .arg("--journal")
            .arg(dir.join("journal"))
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .await?;
        ensure!(
            status.success(),
            "generated signer journal initialization failed"
        );
    } else {
        Signer::initialize_journal(dir.join("journal"), &validated.signer)?;
    }
    let mut signer = tokio::process::Command::new(env!("CARGO_BIN_EXE_signerd"))
        .arg("--local-test")
        .arg("--config")
        .arg(&signer_config)
        .arg("--journal")
        .arg(dir.join("journal"))
        .arg("--socket")
        .arg(&signer_socket)
        .arg("--state-seed-file")
        .arg(dir.join("state.seed"))
        .arg("--clearance-seed-file")
        .arg(dir.join("clearance.seed"))
        .env("ZKAPI_SIGNER_DATABASE_URL", &url)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    for _ in 0..200 {
        if signer_socket.exists() {
            break;
        }
        ensure!(
            signer.try_wait()?.is_none(),
            "signer exited before readiness"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ensure!(signer_socket.exists(), "signer readiness timeout");
    let mut control_child = None;
    let mut local_tasks = None;
    if onboarding.is_some() {
        drop(listener);
        let mut control = tokio::process::Command::new(env!("CARGO_BIN_EXE_controld"))
            .arg("serve")
            .arg(dir.join("private/control.json"))
            .env("ZKAPI_DATABASE_URL", &url)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let listen = config_listener(&dir.join("private/control.json"))?;
        for _ in 0..300 {
            if tokio::net::TcpStream::connect(&listen).await.is_ok() {
                break;
            }
            ensure!(
                control.try_wait()?.is_none(),
                "controld exited before ready"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        control_child = Some(control);
    } else {
        let app = App::connect(validated, &url).await?;
        let router = app.router();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let worker = tokio::spawn(async move {
            loop {
                let _ = app.recover().await;
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        });
        local_tasks = Some((server, worker));
    }
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{}\n", json!({"manifest":manifest,"tariffs":tariffs,"registration":if onboarding.is_some() { Some(serde_json::from_slice::<Value>(&std::fs::read(dir.join("registration.json"))?)?) } else {None}})).as_bytes())
        .await?;
    let result = tokio::time::timeout(Duration::from_secs(1200), lines.next_line()).await;
    if let Some((server, worker)) = local_tasks {
        worker.abort();
        server.abort();
    }
    if let Some(mut control) = control_child {
        control.kill().await?;
    }
    let result = result??.context("Node lifecycle failed before report")?;
    let mut report: Value = serde_json::from_str(&result)?;
    ensure!(
        tokio::time::timeout(Duration::from_secs(15), child.wait())
            .await??
            .success(),
        "Node lifecycle process failed"
    );
    ensure!(report["passed"] == true, "Node lifecycle not passed");
    let native_agent = std::env::var("ZKAPI_GATEWAY_CLIENT").ok();
    let native_group = if native_agent.is_some() {
        let group: u8 = std::env::var("ZKAPI_GATEWAY_CLIENT_GROUP")?.parse()?;
        ensure!((1..=3).contains(&group), "native agent group");
        Some(group)
    } else {
        None
    };
    let native_count = if native_group == Some(1) { 8 } else { 3 };
    let timeout_fault = onboarding
        .as_ref()
        .is_some_and(|v| v.ends_with("upstream_timeout"));
    let single = onboarding.as_ref().is_some_and(|v| v.contains('-'));
    let row = sql.query_one("SELECT (SELECT count(*) FROM sessions WHERE state='SETTLED'),(SELECT count(*) FROM settlements WHERE state_signature IS NOT NULL),(SELECT count(*) FROM receipts WHERE signature IS NOT NULL),(SELECT sum(charge_micro)::text FROM settlements),(SELECT count(*) FROM dispatch_attempts WHERE finished_at IS NOT NULL),(SELECT count(*) FROM clearances WHERE signature IS NOT NULL)", &[]).await?;
    let (sessions, signed, receipts, charge, attempts, clearances): (
        i64,
        i64,
        i64,
        String,
        i64,
        i64,
    ) = (
        row.get(0),
        row.get(1),
        row.get(2),
        row.get(3),
        row.get(4),
        row.get(5),
    );
    ensure!(
        (sessions, signed, receipts, attempts, clearances)
            == if native_agent.is_some() {
                (native_count, native_count, native_count, native_count, 1)
            } else if single {
                (1, 1, 1, 1, 1)
            } else if onboarding.is_some() {
                (3, 3, 3, 3, 1)
            } else {
                (4, 4, 4, 4, 1)
            },
        "ledger lifecycle counts: {sessions}/{signed}/{receipts}/{attempts}/{clearances}"
    );
    ensure!(
        charge
            == if native_agent.is_some() {
                if native_group == Some(1) {
                    "10"
                } else {
                    "0"
                }
            } else if timeout_fault {
                "0"
            } else if onboarding.is_some() {
                "250"
            } else {
                "251"
            },
        "ledger/SDK/USDC charge conservation"
    );
    let claim_count = std::fs::read_dir(&claims)?.count();
    ensure!(
        claim_count
            == if native_agent.is_some() {
                native_count as usize
            } else if single {
                1
            } else if onboarding.is_some() {
                3
            } else {
                4
            },
        "one immutable claim per explicit upstream execution"
    );
    if native_agent.is_some() {
        let row = sql.query_one("SELECT (SELECT count(*) FROM operations WHERE state='WAIVED_OPERATOR_LOSS'),(SELECT count(*) FROM outbox WHERE event_type='PROVIDER_ADMISSION_RESET')", &[]).await?;
        ensure!(
            row.get::<_, i64>(0) == 3 && row.get::<_, i64>(1) == 0,
            "native groups must retain the durable provider breaker without resets"
        );
        ensure!(
            report["provider_circuit_breaker_preserved"] == true,
            "running provider admission was not suspended after three unknown operations"
        );
    }
    for case in report["cases"].as_array().context("case report")? {
        let request_id: Uuid = case["request_id"].as_str().unwrap().parse()?;
        let operation_id: Uuid = case["operation_id"].as_str().unwrap().parse()?;
        let operation=sql.query_one("SELECT state,charged_nano::text FROM operations WHERE request_id=$1 AND operation_id=$2", &[&request_id,&operation_id]).await?;
        ensure!(
            operation.get::<_, String>(0) == case["operation_state"],
            "operation terminal state differs from verified receipt"
        );
        ensure!(
            operation.get::<_, String>(1) == case["charged_nano_usdc"],
            "operation/receipt charge differs"
        );
    }
    for table in [
        "sessions",
        "operations",
        "receipts",
        "outbox",
        "provider_evidence",
    ] {
        for row in sql
            .query(&format!("SELECT row_to_json(t)::text FROM {table} t"), &[])
            .await?
        {
            let data: String = row.get(0);
            for secret in [
                "GENERAL_API_PRIVATE_QUERY",
                "GENERAL_API_PRIVATE_RESULT",
                "general-api-fixture-credential",
                "CODEX_TEXT_FIXTURE_OK",
                "CODEX_TOOL_FIXTURE_OK",
                "CLAUDE_CODE_FIXTURE_OK",
                "CLAUDE_CODE_TOOL_FIXTURE_OK",
            ] {
                ensure!(
                    !data.contains(secret) && !data.contains(&hex::encode(secret)),
                    "private API content persisted in ledger"
                );
            }
        }
    }
    report["ledger"] = json!({"settled_sessions":sessions,"signed_settlements":signed,"signed_receipts":receipts,"finished_dispatch_attempts":attempts,"signed_clearances":clearances,"dispatcher_claims":claim_count,"total_charge_micro_usdc":charge,"private_content_absent":true});
    report["separate_control_process"] = onboarding.is_some().into();
    report["separate_signer_process"] = true.into();
    report["separate_dispatcher_process"] = true.into();
    std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    signer.kill().await?;
    if let Some(variant) = onboarding {
        println!("General API {variant}: generated configuration, installed client, verified receipts/successor and actual local SBF withdrawal");
    } else {
        println!("General API legacy lifecycle: retained inference history, fixed JSON success/error/unknown, verified receipts/successor and actual local SBF withdrawal");
    }
    Ok(())
}

fn config_listener(path: &Path) -> Result<String> {
    let config: RuntimeConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    Ok(config.listen.to_string())
}
