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
    if let Err(_error) = run().await {
        eprintln!("control startup or runtime failed; inspect configuration and local acceptance evidence");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().context(
        "usage: controld migrate | signer-config CONFIG | provision CONFIG | serve CONFIG",
    )?;
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
    let app = App::connect(config, &url).await?;
    let worker = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
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
