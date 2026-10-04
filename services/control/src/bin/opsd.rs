#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("operations startup or validation refused");
        std::process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    use anyhow::Context;
    let mut args = std::env::args().skip(1);
    let mode = args.next().context("mode")?;
    let path = args.next().context("config")?;
    zkapi_control::egress::private_file(std::path::Path::new(&path))?;
    if mode == "collect" || mode == "watch" {
        let config = serde_json::from_slice(&std::fs::read(path)?)?;
        return zkapi_control::monitoring::run(config, mode == "watch").await;
    }
    if mode == "monitor" {
        let sample: zkapi_control::operations::HealthSample =
            serde_json::from_slice(&std::fs::read(&path)?)?;
        let previous = args
            .next()
            .map(std::fs::read)
            .transpose()?
            .map(|v| serde_json::from_slice::<zkapi_control::operations::HealthSample>(&v))
            .transpose()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        println!(
            "{}",
            serde_json::to_string(&zkapi_control::operations::evaluate_health(
                &sample,
                previous.as_ref(),
                now
            )?)?
        );
        return Ok(());
    }
    let config: zkapi_control::operations::AdminConfig =
        serde_json::from_slice(&std::fs::read(path)?)?;
    match mode.as_str() {
        "serve" => {
            let address = config.listen;
            let dashboard = zkapi_control::operations::Dashboard::connect(config).await?;
            let listener = tokio::net::TcpListener::bind(address).await?;
            axum::serve(
                listener,
                dashboard
                    .router()
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await?;
        }
        "checkpoint" | "verify-restore" => {
            let output = args.next().context("witness path")?;
            let mut db = zkapi_control::operations::readonly(&config.database_url).await?;
            if mode == "checkpoint" {
                zkapi_control::operations::capture(&mut db, config.pool)
                    .await?
                    .save(std::path::Path::new(&output))?;
            } else {
                let witness: zkapi_control::operations::RecoveryWitness =
                    serde_json::from_slice(&std::fs::read(output)?)?;
                anyhow::ensure!(witness.pool == config.pool, "restore witness pool mismatch");
                zkapi_control::operations::verify_restore(&mut db, &witness).await?;
                println!("acknowledged rows verified; signer reconciliation and old infrastructure fencing still required before admission");
            }
        }
        _ => anyhow::bail!("mode"),
    };
    Ok(())
}
