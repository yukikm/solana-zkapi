#[tokio::main]
async fn main() {
    let result = async {
        let mut args = std::env::args().skip(1);
        let path = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("config required"))?;
        let attempt = uuid::Uuid::parse_str(
            &args
                .next()
                .ok_or_else(|| anyhow::anyhow!("attempt required"))?,
        )?;
        let config = serde_json::from_slice(&std::fs::read(path)?)?;
        zkapi_control::dispatcher::run_local_owner(config, attempt).await
    }
    .await;
    if result.is_err() {
        eprintln!("local dispatch refused");
        std::process::exit(1);
    }
}
