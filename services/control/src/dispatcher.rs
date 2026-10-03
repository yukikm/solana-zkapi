//! Local acceptance dispatcher. Real provider egress/ACL fencing is an I06/I07/I09 gate.
//! A test owner is a separate child process; only waiting for its actual exit produces evidence.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalDispatchConfig {
    pub local_test_only: bool,
    pub database_url: String,
    pub pool: [u8; 32],
    pub owner_instance: Uuid,
    pub writer_epoch: i64,
    pub claims_directory: std::path::PathBuf,
}
pub struct LocalOwner {
    child: Child,
    attempt_id: Uuid,
    pid: u32,
    pool: [u8; 32],
    owner_instance: Uuid,
    writer_epoch: i64,
}
#[derive(Clone)]
pub struct StoppedOwner {
    digest: [u8; 32],
    pool: [u8; 32],
    attempt_id: Uuid,
    owner_instance: Uuid,
    writer_epoch: i64,
}
impl StoppedOwner {
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
}
impl From<StoppedOwner> for crate::ledger::FenceEvidence {
    fn from(stopped: StoppedOwner) -> Self {
        Self::from_local_stop(
            stopped.pool,
            stopped.attempt_id,
            stopped.owner_instance,
            stopped.writer_epoch,
            stopped.digest,
        )
    }
}
impl LocalOwner {
    pub async fn spawn(binary: &Path, config: &Path, attempt_id: Uuid) -> Result<Self> {
        let ownership: LocalDispatchConfig = serde_json::from_slice(&std::fs::read(config)?)?;
        ensure!(
            ownership.local_test_only,
            "local dispatcher must be explicitly enabled"
        );
        let mut child = Command::new(binary)
            .arg(config)
            .arg(attempt_id.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow::anyhow!("owner missing pid"))?;
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            output.read_line(&mut line),
        )
        .await??;
        ensure!(
            line.trim() == "LOCAL_DISPATCH_CLAIMED",
            "owner refused dispatch"
        );
        Ok(Self {
            child,
            attempt_id,
            pid,
            pool: ownership.pool,
            owner_instance: ownership.owner_instance,
            writer_epoch: ownership.writer_epoch,
        })
    }
    pub async fn stop(mut self) -> Result<StoppedOwner> {
        self.child.start_kill()?;
        let status = self.child.wait().await?;
        let bytes = serde_jcs::to_vec(
            &serde_json::json!({"scope":"local-process-stop-only","pool":self.pool,"attempt_id":self.attempt_id,"owner_instance":self.owner_instance,"writer_epoch":self.writer_epoch,"pid":self.pid,"exit":status.to_string()}),
        )?;
        Ok(StoppedOwner {
            digest: Sha256::digest(bytes).into(),
            pool: self.pool,
            attempt_id: self.attempt_id,
            owner_instance: self.owner_instance,
            writer_epoch: self.writer_epoch,
        })
    }
}

pub async fn run_local_owner(config: LocalDispatchConfig, attempt_id: Uuid) -> Result<()> {
    ensure!(
        config.local_test_only,
        "local dispatcher must be explicitly enabled"
    );
    let (db, connection) =
        tokio_postgres::connect(&config.database_url, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let rows=db.query("SELECT a.writer_epoch,a.owner_instance,a.finished_at IS NULL AND a.fenced_at IS NULL AS live,p.writer_epoch AS current_epoch,o.state,s.state AS session_state,s.close_requested,s.expires_at > floor(extract(epoch from clock_timestamp()))::bigint AS unexpired,p.accepting FROM dispatch_attempts a JOIN pools p ON p.pool=a.pool JOIN sessions s ON s.pool=a.pool AND s.request_id=a.request_id JOIN operations o ON o.pool=a.pool AND o.request_id=a.request_id AND o.operation_id=a.operation_id WHERE a.attempt_id=$1 AND a.pool=$2",&[&attempt_id,&&config.pool[..]]).await?;
    ensure!(rows.len() == 1, "missing dispatch attempt");
    let row = &rows[0];
    ensure!(
        row.get::<_, i64>(0) == config.writer_epoch
            && row.get::<_, Uuid>(1) == config.owner_instance
            && row.get::<_, bool>(2)
            && row.get::<_, i64>(3) == config.writer_epoch
            && row.get::<_, String>(4) == "DISPATCHING"
            && row.get::<_, String>(5) == "ACTIVE"
            && !row.get::<_, bool>(6)
            && row.get::<_, bool>(7)
            && row.get::<_, bool>(8),
        "stale or fenced owner"
    );
    std::fs::create_dir_all(&config.claims_directory)?;
    // O_EXCL is the durable one-shot barrier. Crash after claiming never causes resend.
    let path = config.claims_directory.join(attempt_id.to_string());
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(config.owner_instance.to_string().as_bytes())?;
    file.sync_all()?;
    std::fs::File::open(&config.claims_directory)?.sync_all()?;
    // No provider credential or network egress exists in this local acceptance adapter.
    println!("LOCAL_DISPATCH_CLAIMED");
    std::future::pending::<()>().await;
    Ok(())
}
