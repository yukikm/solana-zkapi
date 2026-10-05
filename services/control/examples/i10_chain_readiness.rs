//! Read-only diagnosis using the same validated chain client as controld.
//! Prints only static validation categories, never config or transport errors.
use zkapi_control::{chain::ChainClient, config::RuntimeConfig};

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        println!("configuration unavailable; private details withheld");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("config"))?;
    let config: RuntimeConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    let config = config.validate()?;
    let chain = ChainClient::new(
        config.runtime.primary_rpc.clone(),
        config.runtime.secondary_rpc.clone(),
        config.runtime.indexer_origin.clone(),
        config.trusted.clone(),
    )?;
    for _ in 0..3 {
        let result = chain.startup().await;
        // ValidationError contains only static strings, never a reqwest error.
        println!(
            "{}",
            serde_json::json!({"chain_startup_ready": result.is_ok(),
            "category": result.err().map(|error| error.to_string())})
        );
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Ok(())
}
