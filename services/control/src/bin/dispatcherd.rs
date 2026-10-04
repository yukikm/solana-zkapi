//! Single-use credential-holding provider worker. Diagnostics never contain input.
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("dispatcher request refused");
        std::process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("configuration required"))?;
    zkapi_control::egress::private_file(std::path::Path::new(&path))?;
    let config = serde_json::from_slice(&std::fs::read(path)?)?;
    let mut input = Vec::new();
    zkapi_control::egress::read_line(
        &mut tokio::io::BufReader::new(tokio::io::stdin()),
        &mut input,
        8 * 1024 * 1024,
    )
    .await?;
    let request = serde_json::from_slice(&input)?;
    input.fill(0);
    zkapi_control::egress::serve(config, request).await
}
