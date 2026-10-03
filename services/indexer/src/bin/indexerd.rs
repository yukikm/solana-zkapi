//! The config file is a trusted deployment input, not an unsigned network manifest.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: indexerd CONFIG.json")?;
    let config = serde_json::from_slice(&std::fs::read(path)?)?;
    zkapi_indexer::runtime::serve(config).await
}
