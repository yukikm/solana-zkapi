use crate::signer::{verify_signature, PublicKey, SignTarget};
use anyhow::{ensure, Result};
use std::path::PathBuf;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
#[derive(Clone)]
pub struct SignerClient {
    pub socket: PathBuf,
}
impl SignerClient {
    pub async fn sign(
        &self,
        target: SignTarget,
        key: &PublicKey,
        message: [u8; 32],
    ) -> Result<Vec<u8>> {
        let operation = async {
            let mut stream = UnixStream::connect(&self.socket).await?;
            let mut bytes = serde_json::to_vec(&target)?;
            bytes.push(b'\n');
            stream.write_all(&bytes).await?;
            let mut response = Vec::new();
            let mut b = [0; 1];
            loop {
                ensure!(response.len() < 1024, "signer response limit");
                ensure!(stream.read(&mut b).await? == 1, "signer response lost");
                if b[0] == b'\n' {
                    break;
                }
                response.push(b[0]);
            }
            let value: serde_json::Value = serde_json::from_slice(&response)?;
            let signature = hex::decode(
                value["signature"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("signing refused"))?,
            )?;
            verify_signature(key, message, &signature)?;
            Ok::<_, anyhow::Error>(signature)
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), operation).await?
    }
}
impl SignerClient {
    pub async fn reconcile(&self, config: &crate::signer::SignerConfig) -> Result<()> {
        let mut stream = UnixStream::connect(&self.socket).await?;
        stream.write_all(b"{\"kind\":\"reconcile\"}\n").await?;
        let mut response = Vec::new();
        let mut b = [0; 1];
        let read = async {
            loop {
                ensure!(response.len() < 1024, "signer response limit");
                ensure!(stream.read(&mut b).await? == 1, "signer response lost");
                if b[0] == b'\n' {
                    break;
                }
                response.push(b[0]);
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), read).await??;
        let value: serde_json::Value = serde_json::from_slice(&response)?;
        ensure!(
            value["reconciled"] == true && value["config_digest"] == hex::encode(config.digest()?),
            "signer reconciliation refused"
        );
        Ok(())
    }
}
