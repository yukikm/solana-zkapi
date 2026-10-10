//! Local I10 lifecycle joins the actual SDK wallet/prover/control verifier to
//! this App, PostgreSQL, separate signerd/dispatcherd and the actual Vault ELF.
//! Provider HTTP, two loopback RPC envelopes and finality remain explicit fixtures.
mod support;
use anyhow::{ensure, Context, Result};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_postgres::NoTls;
use uuid::Uuid;
use zkapi_control::{
    api::App,
    config::RuntimeConfig,
    direct::DirectConfig,
    egress::{ClientConfig, ServiceConfig},
    ledger::{migrate, Ledger, PoolIdentity},
    provider_runtime::{ProviderConfig, ProxyProviderConfig},
    proxy::{CacheMode, Endpoint, ModelProfile},
    quote,
    signer::Signer,
    wire::{self, Provider, Rate, Tariff},
};

fn private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
fn tariff(provider: Provider, direct: bool) -> Tariff {
    let mut t = support::tariff();
    t.provider = provider.clone();
    t.model = if direct { "*" } else { "i10-model" }.into();
    t.valid_from = "1".into();
    t.pricing_basis = if direct {
        "provider_reported_usd"
    } else {
        "fixed_usage_rates"
    }
    .into();
    t.rates = if direct {
        vec![]
    } else {
        let units = if provider == Provider::Anthropic {
            vec![
                "cache_read_tokens",
                "cache_write_1h_tokens",
                "cache_write_5m_tokens",
                "input_tokens",
                "output_tokens",
            ]
        } else {
            vec!["cache_read_tokens", "input_tokens", "output_tokens"]
        };
        units
            .into_iter()
            .map(|unit| Rate {
                unit: unit.into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "1".into(),
            })
            .collect()
    };
    t.tariff_hash = quote::tariff_hash(&t).unwrap();
    t
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and pinned I04/I08/I09 artifacts; scripts/run_i10.py"]
async fn all_modes_deposit_infer_settle_withdraw_same_note() -> Result<()> {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let node = std::env::var("ZKAPI_NODE").context("pinned ZKAPI_NODE required")?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = root.join("target/i10/e2e-results.json");
    std::fs::create_dir_all(output.parent().unwrap())?;
    if output.exists() {
        std::fs::remove_file(&output)?;
    }
    let (admin, connection) = tokio_postgres::connect(&base, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let name = format!("i10_e2e_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = format!("{base} dbname={name}");
    migrate(&url).await?;
    let (sql, connection) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let directory = tempfile::Builder::new()
        .prefix("i10-e2e-")
        .tempdir_in("/tmp")?;
    let dir = directory.path();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let mut child = tokio::process::Command::new(node)
        .args(["--experimental-strip-types", "packages/sdk/test/i10-e2e.ts"])
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
            .context("Node fixture exited before readiness")?,
    )?;
    ensure!(ready["ready"] == true, "Node fixture readiness");
    let provider = ready["origin"]
        .as_str()
        .context("provider origin")?
        .to_owned();
    let second = ready["secondary"].as_str().context("secondary RPC")?;
    let direct_origin = ready["direct_origin"]
        .as_str()
        .context("direct TLS fixture")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let tariffs = vec![
        tariff(Provider::Openai, false),
        tariff(Provider::Anthropic, false),
        tariff(Provider::Openrouter, false),
        tariff(Provider::Oa, true),
        tariff(Provider::Openrouter, true),
    ];
    let mut manifest = ready["manifest"].clone();
    manifest["control_api_origin"] = origin.clone().into();
    manifest["inference_api_origin"] = origin.into();
    manifest["tariff_hashes"] = json!(tariffs.iter().map(|t| &t.tariff_hash).collect::<Vec<_>>());
    let mut body = manifest.clone();
    body.as_object_mut().unwrap().remove("manifest_hash");
    body.as_object_mut().unwrap().remove("manifest_signature");
    let hash = wire::digest(&body)?;
    manifest["manifest_hash"] = hex::encode(hash).into();
    use base64::Engine;
    manifest["manifest_signature"] = base64::engine::general_purpose::STANDARD
        .encode(SigningKey::from_bytes(&[13; 32]).sign(&hash).to_bytes())
        .into();
    private(&dir.join("quote.seed"), &[11; 32])?;
    private(&dir.join("receipt.seed"), &[12; 32])?;
    private(&dir.join("provider.key"), b"i10-provider-secret")?;
    let providers = ProviderConfig {
        api: vec![],
        dispatcher: None,
        direct: vec![
            DirectConfig::Oa {
                issuer_base: provider.clone(),
                credential_file: dir.join("provider.key"),
                verifier_base: provider.clone(),
                inference_base: format!("{direct_origin}/inference"),
                station_id: "i10-station".into(),
            },
            DirectConfig::Openrouter {
                api_base: format!("{provider}/api/v1"),
                credential_file: dir.join("provider.key"),
                inference_base: "https://openrouter.ai/api/v1".into(),
                settlement_grace_seconds: 0,
            },
        ],
        proxy: [Provider::Openai, Provider::Anthropic, Provider::Openrouter]
            .into_iter()
            .map(|p| ProxyProviderConfig {
                provider: p.clone(),
                credential_file: dir.join("provider.key"),
                local_test_base: Some(provider.clone()),
                models: vec![ModelProfile {
                    provider: p.clone(),
                    model: "i10-model".into(),
                    endpoints: if p == Provider::Anthropic {
                        vec![Endpoint::Messages, Endpoint::CountTokens]
                    } else if p == Provider::Openai {
                        vec![Endpoint::ChatCompletions, Endpoint::Responses]
                    } else {
                        vec![Endpoint::ChatCompletions]
                    },
                    context_tokens: 1000,
                    max_output_tokens: 100,
                    cache_mode: if p == Provider::Anthropic {
                        CacheMode::AnthropicSplit
                    } else {
                        CacheMode::InclusiveRead
                    },
                }],
            })
            .collect(),
    };
    let role = format!("i10_dispatcher_{}", Uuid::new_v4().simple());
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
            database_url: format!("{url} user={role}"),
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
    for direct in &mut frontend_providers.direct {
        match direct {
            DirectConfig::Oa {
                credential_file, ..
            }
            | DirectConfig::Openrouter {
                credential_file, ..
            } => *credential_file = dir.join("not-mounted-in-control"),
        }
    }
    let config = RuntimeConfig {
        devnet: None,
        local_test_only: true,
        listen: listener.local_addr()?,
        trusted_manifest_hash: hex::encode(hash),
        manifest: manifest.clone(),
        primary_rpc: format!("{provider}/rpc"),
        secondary_rpc: format!("{second}/rpc"),
        indexer_origin: provider,
        signer_socket: dir.join("signer.sock"),
        quote_seed_file: dir.join("quote.seed"),
        receipt_seed_file: dir.join("receipt.seed"),
        enable_local_adapter: false,
        providers: frontend_providers,
        tariffs: tariffs.clone(),
    };
    let validated = config.validate()?;
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
    tokio::time::sleep(Duration::from_millis(50)).await;
    private(
        &dir.join("signer.json"),
        &serde_json::to_vec(&validated.signer)?,
    )?;
    private(
        &dir.join("state.seed"),
        &zkapi_types::Felt252::from_u64(31).0,
    )?;
    private(
        &dir.join("clearance.seed"),
        &zkapi_types::Felt252::from_u64(37).0,
    )?;
    Signer::initialize_journal(dir.join("journal"), &validated.signer)?;
    let mut signer = tokio::process::Command::new(env!("CARGO_BIN_EXE_signerd"))
        .arg("--local-test")
        .arg("--config")
        .arg(dir.join("signer.json"))
        .arg("--journal")
        .arg(dir.join("journal"))
        .arg("--socket")
        .arg(dir.join("signer.sock"))
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
        if dir.join("signer.sock").exists() {
            break;
        }
        ensure!(
            signer.try_wait()?.is_none(),
            "signer exited before readiness"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ensure!(dir.join("signer.sock").exists(), "signer readiness timeout");
    let app = App::connect(validated, &url).await?;
    let router = app.router();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    // Same periodic recovery used by controld; no test-only state mutation.
    let worker_app = app.clone();
    let worker = tokio::spawn(async move {
        loop {
            if let Err(error) = worker_app.recover().await {
                // ApiError contains only the public HTTP status and static code.
                eprintln!("I10 recovery observation: {error:?}");
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    });
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{}\n", json!({"manifest":manifest,"tariffs":tariffs})).as_bytes())
        .await?;
    let result = tokio::time::timeout(Duration::from_secs(360), lines.next_line()).await;
    worker.abort();
    server.abort();
    let result = result??;
    if result.is_none() {
        let rows = sql.query("SELECT row_to_json(v) FROM (SELECT s.mode,s.provider,s.state,s.close_requested,p.accepting,o.state AS operation_state,a.send_claimed_at IS NOT NULL AS send_claimed,a.finished_at IS NOT NULL AS attempt_finished,a.fenced_at IS NOT NULL AS attempt_fenced FROM sessions s JOIN pools p ON p.pool=s.pool LEFT JOIN operations o ON o.pool=s.pool AND o.request_id=s.request_id LEFT JOIN dispatch_attempts a ON a.pool=s.pool AND a.request_id=s.request_id ORDER BY s.created_at) v", &[]).await?;
        let states: Vec<Value> = rows.into_iter().map(|row| row.get(0)).collect();
        eprintln!(
            "I10 failure ledger states: {}",
            json!({"states":states,"dispatcher_claims":std::fs::read_dir(&claims)?.count()})
        );
        anyhow::bail!("Node lifecycle failed before report");
    }
    let mut report: Value = serde_json::from_str(&result.unwrap())?;
    ensure!(
        tokio::time::timeout(Duration::from_secs(15), child.wait())
            .await
            .context("Node fixture cleanup timed out after report")??
            .success(),
        "Node lifecycle process failed"
    );
    ensure!(report["passed"] == true, "Node lifecycle not passed");
    let settled: i64 = sql
        .query_one("SELECT count(*) FROM sessions WHERE state='SETTLED'", &[])
        .await?
        .get(0);
    let signed: i64 = sql
        .query_one(
            "SELECT count(*) FROM settlements WHERE state_signature IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    let receipts: i64 = sql
        .query_one(
            "SELECT count(*) FROM receipts WHERE signature IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    let charge: String = sql
        .query_one("SELECT sum(charge_micro)::text FROM settlements", &[])
        .await?
        .get(0);
    let auth: i64 = sql
        .query_one(
            "SELECT count(*) FROM nullifier_reservations WHERE kind='AUTH'",
            &[],
        )
        .await?
        .get(0);
    let clearance: i64 = sql
        .query_one(
            "SELECT count(*) FROM clearances WHERE signature IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    let attempts: i64 = sql
        .query_one(
            "SELECT count(*) FROM dispatch_attempts WHERE finished_at IS NOT NULL",
            &[],
        )
        .await?
        .get(0);
    ensure!(
        (settled, signed, receipts, auth, clearance, attempts) == (6, 6, 29, 6, 1, 28),
        "ledger lifecycle counts"
    );
    ensure!(charge == "8", "ledger/SDK/USDC conservation");
    let claim_count = std::fs::read_dir(&claims)?.count();
    ensure!(claim_count == 28, "one immutable dispatcher claim per send");
    let cases = report["cases"]
        .as_array()
        .context("detailed case evidence")?;
    ensure!(cases.len() == 28, "all declared API variants must execute");
    for case in cases.iter().filter(|case| case["mode"] == "proxy") {
        let request_id: Uuid = case["request_id"].as_str().unwrap().parse()?;
        let operation_id: Uuid = case["operation_id"].as_str().unwrap().parse()?;
        let row = sql.query_one("SELECT state,charged_nano::text FROM operations WHERE request_id=$1 AND operation_id=$2", &[&request_id,&operation_id]).await?;
        ensure!(
            row.get::<_, String>(0) == case["expected_operation_state"],
            "operation terminal state differs from verified receipt"
        );
        ensure!(
            row.get::<_, String>(1) == case["charged_nano_usdc"],
            "operation/SDK receipt charge differs"
        );
    }
    let waived: i64 = sql
        .query_one(
            "SELECT count(*) FROM operations WHERE state='WAIVED_OPERATOR_LOSS' AND charged_nano=0",
            &[],
        )
        .await?
        .get(0);
    ensure!(
        waived == 5,
        "provider errors/missing final usage must be zero-charge waivers"
    );
    let race_request: Uuid = report["exit_race"]["request_id"]
        .as_str()
        .context("race request")?
        .parse()?;
    let race_operation: Uuid = report["exit_race"]["operation_id"]
        .as_str()
        .context("race operation")?
        .parse()?;
    let refused_request: Uuid = report["exit_race"]["rejected_issuance_request_id"]
        .as_str()
        .context("refused issuance")?
        .parse()?;
    let race = sql.query_one("SELECT o.state,o.charged_nano::text,(SELECT count(*) FROM dispatch_attempts a WHERE a.request_id=o.request_id),(SELECT count(*) FROM outbox b WHERE b.event_type='CHAIN_EXIT_OBSERVED' AND b.metadata->>'request_id'=$1::uuid::text),(SELECT count(*) FROM sessions s WHERE s.request_id=$3) FROM operations o WHERE o.request_id=$1 AND o.operation_id=$2", &[&race_request,&race_operation,&refused_request]).await?;
    ensure!(
        race.get::<_, String>(0) == "DONE" && race.get::<_, String>(1) == "0",
        "exit race must close a not-dispatched operation at zero charge"
    );
    ensure!(
        race.get::<_, i64>(2) == 0 && race.get::<_, i64>(3) == 1 && race.get::<_, i64>(4) == 0,
        "exit race must create challenger evidence without inference dispatch or new issuance"
    );
    report["exit_race"]["ledger_exit_outbox_verified"] = true.into();
    report["exit_race"]["ledger_no_dispatch_or_issuance_verified"] = true.into();
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
                "I10_PRIVATE_PROMPT",
                "I10_PRIVATE_RESPONSE",
                "i10-oa-runtime",
                "i10-openrouter-runtime",
            ] {
                ensure!(
                    !data.contains(secret) && !data.contains(&hex::encode(secret)),
                    "private provider data persisted in ledger"
                );
            }
        }
    }
    report["ledger"] = json!({"settled_sessions":settled,"signed_settlements":signed,"signed_receipts":receipts,"permanent_auth_nullifiers":auth,"signed_clearances":clearance,"finished_dispatch_attempts":attempts,"total_charge_micro_usdc":charge,"dispatcher_claims":claim_count,"zero_charge_unknown_waivers":waived,"all_case_operation_states_verified":true,"prompt_response_runtime_keys_absent":true});
    report["separate_signer_process"] = true.into();
    report["separate_dispatcher_process"] = true.into();
    report["scope"] = "local actual SDK/native crypto/PostgreSQL/signerd/dispatcherd/Vault SBF; fixture provider HTTP and finality RPC".into();
    std::fs::create_dir_all(output.parent().unwrap())?;
    std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    signer.kill().await?;
    println!("I10 full lifecycle: 28 API cases, actual escape/challenge race, 6 verified settlements, 8 micro-USDC charges, same-note actual SBF withdrawal");
    Ok(())
}
