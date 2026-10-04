//! KMS envelope boundary. The trusted helper unwraps a data key, never signs
//! Baby-JubJub messages. Only an authenticated AES-256-GCM role envelope is opened.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use zeroize::Zeroizing;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u32,
    pub deployment: String,
    pub pool: [u8; 32],
    pub role: String,
    pub kms_key_ref: String,
    pub wrapped_data_key: String,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
}
impl Envelope {
    pub fn aad(&self) -> Result<Vec<u8>> {
        Ok(serde_jcs::to_vec(
            &serde_json::json!({"version":self.version,"deployment":self.deployment,"pool":self.pool,"role":self.role,"kms_key_ref":self.kms_key_ref}),
        )?)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub helper: PathBuf,
    pub helper_sha256: String,
    pub deployment: String,
    pub pool: [u8; 32],
    pub envelopes: BTreeMap<String, PathBuf>,
}
impl Config {
    pub async fn load(&self, role: &str) -> Result<Zeroizing<[u8; 32]>> {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            matches!(role, "state" | "clearance" | "quote" | "receipt"),
            "unknown signing role"
        );
        let path = self.envelopes.get(role).context("role envelope required")?;
        crate::egress::private_file(path)?;
        let envelope: Envelope = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            envelope.version == 1
                && envelope.deployment == self.deployment
                && envelope.pool == self.pool
                && envelope.role == role
                && !envelope.kms_key_ref.is_empty()
                && !envelope.wrapped_data_key.is_empty(),
            "envelope context mismatch"
        );
        let m = std::fs::symlink_metadata(&self.helper)?;
        ensure!(
            m.is_file()
                && m.permissions().mode() & 0o022 == 0
                && hex::encode(crate::wire::sha256(&std::fs::read(&self.helper)?))
                    == self.helper_sha256,
            "trusted KMS helper required"
        );
        let mut child = Command::new(&self.helper)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = serde_jcs::to_vec(
            &serde_json::json!({"operation":"unwrap_aes256_key","key_ref":envelope.kms_key_ref,"wrapped_data_key":envelope.wrapped_data_key,"encryption_context":{"deployment":self.deployment,"pool":hex::encode(self.pool),"role":role}}),
        )?;
        let mut stdin = child.stdin.take().context("KMS input")?;
        let mut stdout = child.stdout.take().context("KMS output")?;
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            stdin.write_all(&input).await?;
            drop(stdin);
            let mut key = Zeroizing::new([0u8; 32]);
            stdout.read_exact(key.as_mut()).await?;
            let mut extra = [0u8; 1];
            ensure!(stdout.read(&mut extra).await? == 0, "KMS key length");
            ensure!(child.wait().await?.success(), "KMS refused unwrap");
            Ok::<_, anyhow::Error>(key)
        })
        .await;
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        let _ = child.wait().await?;
        let key = result??;
        let nonce: [u8; 12] = hex::decode(envelope.nonce_hex.clone())?
            .try_into()
            .map_err(|_| anyhow::anyhow!("nonce length"))?;
        let mut ciphertext = Zeroizing::new(hex::decode(&envelope.ciphertext_hex)?);
        ensure!(ciphertext.len() == 48, "seed envelope length");
        let aead = ring::aead::LessSafeKey::new(
            ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, key.as_ref())
                .map_err(|_| anyhow::anyhow!("envelope key"))?,
        );
        let plaintext = aead
            .open_in_place(
                ring::aead::Nonce::assume_unique_for_key(nonce),
                ring::aead::Aad::from(envelope.aad()?),
                ciphertext.as_mut(),
            )
            .map_err(|_| anyhow::anyhow!("envelope authentication failed"))?;
        ensure!(plaintext.len() == 32, "seed length");
        let mut seed = Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(plaintext);
        Ok(seed)
    }
}
