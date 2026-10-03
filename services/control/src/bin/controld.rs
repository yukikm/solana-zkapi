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
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    app.ledger.set_accepting(false).await?;
    Ok(())
}
