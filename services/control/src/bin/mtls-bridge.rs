#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("mutual TLS configuration or runtime refused");
        std::process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("configuration required"))?;
    zkapi_control::egress::private_file(std::path::Path::new(&path))?;
    let config: zkapi_control::mtls::Config = serde_json::from_slice(&std::fs::read(path)?)?;
    config.run().await
}
