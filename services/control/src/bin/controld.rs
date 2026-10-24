//! Local test profile. Deployments with real providers/setup are explicitly gated.
use anyhow::{ensure, Context, Result};
use zkapi_control::{
    api::App,
    config::RuntimeConfig,
    ledger::{self, Ledger, PoolIdentity},
    wire,
};
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        if std::env::args()
            .nth(1)
            .is_some_and(|v| v == "plan-direct-waiver" || v == "apply-direct-waiver")
        {
            eprintln!(
                "direct waiver refused: {}",
                zkapi_control::direct_waiver::operator_error_category(&error)
            );
            std::process::exit(1);
        }
        eprintln!("control startup or runtime failed; inspect configuration and local acceptance evidence");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().context(
        "usage: controld migrate | signer-config CONFIG | provision CONFIG | serve CONFIG",
    )?;
    if mode == "inspect-config" {
        let path = args.next().context("config path required")?;
        ensure!(
            args.next().as_deref() == Some("--input-root"),
            "input root flag required"
        );
        let input = args.next().context("input root required")?;
        ensure!(
            args.next().as_deref() == Some("--target-root"),
            "target root flag required"
        );
        let target = args.next().context("target root required")?;
        ensure!(args.next().is_none(), "unexpected arguments");
        let bytes = std::fs::read(path)?;
        let config: RuntimeConfig =
            serde_json::from_value(zkapi_control::proxy::parse_json(&bytes, 4 * 1024 * 1024)?)?;
        println!(
            "{}",
            serde_json::to_string(
                &config.inspect(std::path::Path::new(&input), std::path::Path::new(&target))?
            )?
        );
        return Ok(());
    }
    let url = std::env::var("ZKAPI_DATABASE_URL").context("database environment required")?;
    if mode == "migrate" {
        ledger::migrate(&url).await?;
        return Ok(());
    }
    let config: RuntimeConfig = serde_json::from_slice(&std::fs::read(
        args.next().context("config path required")?,
    )?)?;
    let config = config.validate()?;
    config.validate_database(&url)?;
    if mode == "plan-direct-waiver" || mode == "apply-direct-waiver" {
        use std::io::Write;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        use zkapi_control::direct_waiver::{self, SignedApproval};
        let identity = PoolIdentity {
            pool: config.signer.pool,
            deployment_id: config.binding.deployment_id.clone(),
            manifest_hash: wire::hash(&config.runtime.trusted_manifest_hash)?,
            authorization_config: serde_json::json!({"signer":config.signer}),
        };
        if mode == "plan-direct-waiver" {
            let id = uuid::Uuid::parse_str(&args.next().context("request ID required")?)?;
            ensure!(
                args.next().as_deref() == Some("--review-evidence-sha256"),
                "review evidence flag required"
            );
            let review = wire::hash(&args.next().context("review evidence digest required")?)?;
            ensure!(
                args.next().as_deref() == Some("--output"),
                "output flag required"
            );
            let output = std::path::PathBuf::from(args.next().context("approval output required")?);
            ensure!(
                args.next().as_deref() == Some("--accept-operator-loss") && args.next().is_none(),
                "explicit operator loss flag required"
            );
            let grace = config
                .runtime
                .providers
                .direct
                .iter()
                .find_map(|p| match p {
                    zkapi_control::direct::DirectConfig::Openrouter {
                        settlement_grace_seconds,
                        ..
                    } => Some((*settlement_grace_seconds).max(direct_waiver::MIN_GRACE_SECONDS)),
                    _ => None,
                })
                .context("OpenRouter configuration required")?;
            let (mut client, connection) =
                tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let tx = client
                .build_transaction()
                .read_only(true)
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .start()
                .await?;
            ledger::verify_schema(&tx).await?;
            let body = direct_waiver::prepare(&tx, identity.pool, id, grace, review).await?;
            ensure!(
                body.deployment_id == identity.deployment_id
                    && body.manifest_hash == hex::encode(identity.manifest_hash),
                "approval configuration mismatch"
            );
            let approval = SignedApproval::sign(body, &config.receipt_key)?;
            let pinned: serde_json::Value = tx
                .query_one(
                    "SELECT authorization_config FROM pools WHERE pool=$1::bytea",
                    &[&&identity.pool[..]],
                )
                .await?
                .get(0);
            ensure!(
                pinned == identity.authorization_config,
                "approval configuration mismatch"
            );
            approval.verify(config.signer.receipt_key)?;
            tx.commit().await?;
            // create_new prevents overwriting an existing reviewed approval; no symlink following.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&output)?;
            ensure!(
                config.runtime.local_test_only && config.runtime.enable_local_adapter
                    || file.metadata()?.uid() == 0,
                "root-owned approval file required"
            );
            file.write_all(&serde_jcs::to_vec(&approval)?)?;
            file.sync_all()?;
            println!(
                "{}",
                serde_json::json!({"approval_hash":approval.approval_hash,"request_id":id,"receipt_id":approval.body.receipt_id,"approved_at":approval.body.approved_at,"expires_after_seconds":900,"operator_accepts_all_unknown_costs":true,"user_charge_nano":"0","provider_usage":"unknown"})
            );
        } else {
            let path = std::path::PathBuf::from(args.next().context("approval path required")?);
            ensure!(
                args.next().as_deref() == Some("--accept-operator-loss") && args.next().is_none(),
                "explicit operator loss flag required"
            );
            zkapi_control::egress::private_file(&path)?;
            ensure!(
                config.runtime.local_test_only && config.runtime.enable_local_adapter
                    || std::fs::symlink_metadata(&path)?.uid() == 0,
                "root-owned approval file required"
            );
            let bytes = std::fs::read(&path)?;
            let approval = SignedApproval::from_canonical_bytes(&bytes)?;
            let grace = config
                .runtime
                .providers
                .direct
                .iter()
                .find_map(|p| match p {
                    zkapi_control::direct::DirectConfig::Openrouter {
                        settlement_grace_seconds,
                        ..
                    } => Some((*settlement_grace_seconds).max(direct_waiver::MIN_GRACE_SECONDS)),
                    _ => None,
                })
                .context("OpenRouter configuration required")?;
            ensure!(
                approval.body.grace_seconds >= grace,
                "approval grace shorter than configured drain"
            );
            let writer = Ledger::connect(&url, &identity).await?;
            let session = writer
                .apply_direct_unknown_waiver(&approval, &config.receipt_key)
                .await?;
            println!(
                "{}",
                serde_json::json!({"approval_hash":approval.approval_hash,"request_id":session.request_id,"state":session.state,"operator_accepts_all_unknown_costs":true,"user_charge_nano":"0","provider_usage":"unknown","admission":"disabled"})
            );
        }
        return Ok(());
    }
    if mode == "signer-config" {
        println!("{}", serde_json::to_string_pretty(&config.signer)?);
        return Ok(());
    }
    if mode == "provision" {
        let identity = PoolIdentity {
            pool: config.signer.pool,
            deployment_id: config.binding.deployment_id.clone(),
            manifest_hash: wire::hash(&config.runtime.trusted_manifest_hash)?,
            authorization_config: serde_json::json!({"signer":config.signer}),
        };
        let _writer = Ledger::connect(&url, &identity).await?;
        println!("pool registered with admission disabled; initialize and start the independently stored signer journal");
        return Ok(());
    }
    if mode == "fence" {
        let certificate: zkapi_control::operations::FenceCertificate = serde_json::from_slice(
            &std::fs::read(args.next().context("supervisor certificate path")?)?,
        )?;
        let key_path = std::path::PathBuf::from(
            args.next()
                .context("independently pinned supervisor key path")?,
        );
        zkapi_control::egress::private_file(&key_path)?;
        let key: [u8; 32] = std::fs::read(key_path)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("supervisor public key length"))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let evidence = certificate.verify(key, now)?;
        let identity = PoolIdentity {
            pool: config.signer.pool,
            deployment_id: config.binding.deployment_id.clone(),
            manifest_hash: wire::hash(&config.runtime.trusted_manifest_hash)?,
            authorization_config: serde_json::json!({"signer":config.signer}),
        };
        let writer = Ledger::connect(&url, &identity).await?;
        let mut matched = false;
        for session in writer.pending_sessions().await? {
            for record in writer
                .dispatch_attempts_for_session(session.request_id)
                .await?
            {
                if record.attempt.attempt_id == certificate.attempt_id {
                    writer.fence_attempt(&record.attempt, &evidence).await?;
                    matched = true;
                }
            }
        }
        ensure!(matched, "fence attempt unavailable");
        println!(
            "verified fence saved; admission remains disabled until signer and ledger recovery"
        );
        return Ok(());
    }
    ensure!(mode == "serve", "unsupported command");
    let listen = config.runtime.listen;
    let recovery_seconds = config.runtime.background_recovery_seconds;
    let app = App::connect(config, &url).await?;
    let worker = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(recovery_seconds));
        // A slow RPC must not queue a burst of redundant recovery checks.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if worker.recover().await.is_err() {
                eprintln!("control recovery requires attention");
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(listen).await?;
    axum::serve(
        listener,
        app.router()
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    app.ledger.set_accepting(false).await?;
    Ok(())
}
