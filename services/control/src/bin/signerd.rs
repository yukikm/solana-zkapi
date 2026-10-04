//! Local I05 signer harness over an owner-only Unix socket. Production deployment
//! requires mTLS/KMS/fencing provisioning and is deliberately not enabled here.
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};
use zkapi_control::signer::{SignCheckpoint, SignTarget, Signer, SignerConfig};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Rpc {
    Reconcile,
    Health,
    Settlement { request_id: uuid::Uuid },
    Clearance { nullifier: [u8; 32] },
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut config = None;
    let mut journal = None;
    let mut socket = None;
    let mut state_seed = None;
    let mut clearance_seed = None;
    let mut local = false;
    let mut custody_config = None;
    let mut initialize = false;
    let mut crash = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--local-test" => local = true,
            "--custody-config" => {
                custody_config = Some(PathBuf::from(args.next().context("custody config")?))
            }
            "--config" => config = Some(PathBuf::from(args.next().context("config path")?)),
            "--journal" => journal = Some(PathBuf::from(args.next().context("journal path")?)),
            "--socket" => socket = Some(PathBuf::from(args.next().context("socket path")?)),
            "--state-seed-file" => {
                state_seed = Some(PathBuf::from(args.next().context("state seed path")?))
            }
            "--clearance-seed-file" => {
                clearance_seed = Some(PathBuf::from(args.next().context("clearance seed path")?))
            }
            "--initialize-journal" => initialize = true,
            "--crash-at" => {
                crash = Some(match args.next().context("checkpoint")?.as_str() {
                    "intent" => SignCheckpoint::IntentSynced,
                    "signature" => SignCheckpoint::SignatureCreated,
                    "synced" => SignCheckpoint::SignatureSynced,
                    _ => bail!("invalid checkpoint"),
                })
            }
            _ => bail!("unsupported option"),
        }
    }
    ensure!(local,"only explicit --local-test is available; production signer provisioning is not implemented");
    let config: SignerConfig =
        serde_json::from_slice(&std::fs::read(config.context("--config required")?)?)?;
    let config_digest = hex::encode(config.digest()?);
    let journal = journal.context("--journal required")?;
    if initialize {
        Signer::initialize_journal(&journal, &config)?;
        return Ok(());
    }
    let (state, clearance) = if let Some(path) = custody_config {
        ensure!(
            state_seed.is_none() && clearance_seed.is_none(),
            "choose envelope custody or local seed files"
        );
        zkapi_control::egress::private_file(&path)?;
        let custody: zkapi_control::custody::Config =
            serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            custody.pool == config.pool && custody.deployment == config.authorization.deployment_id,
            "custody deployment mismatch"
        );
        (
            *custody.load("state").await?,
            *custody.load("clearance").await?,
        )
    } else {
        (
            read_seed(state_seed.context("--state-seed-file required")?)?,
            read_seed(clearance_seed.context("--clearance-seed-file required")?)?,
        )
    };
    let primary =
        std::env::var("ZKAPI_SIGNER_DATABASE_URL").context("ZKAPI_SIGNER_DATABASE_URL required")?;
    let mut signer = Signer::open(config, &primary, journal, state, clearance).await?;
    let socket = socket.context("--socket required")?;
    // A dedicated owner-only directory also prevents socket substitution. The
    // runtime does not delete a preexisting socket or infer a dead owner.
    let parent = socket.parent().context("socket directory required")?;
    ensure!(
        std::fs::metadata(parent)?.permissions().mode() & 0o077 == 0,
        "socket parent must have permissions 0700"
    );
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let instance_id = uuid::Uuid::new_v4();
    let mut refused_requests = 0u64;
    loop {
        let (stream, _) = listener.accept().await?;
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        // Bounded read prevents arbitrary message/body storage and resource abuse.
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            read_request(&mut reader, &mut line),
        )
        .await;
        let result: Result<serde_json::Value> = match read {
            Ok(Ok(())) => match serde_json::from_slice::<Rpc>(&line) {
                Ok(Rpc::Reconcile) => signer
                    .reconcile()
                    .await
                    .map(|()| serde_json::json!({"reconciled":true,"config_digest":config_digest})),
                Ok(Rpc::Health) => Ok(serde_json::json!({
                    "reconciled":signer.reconcile().await.is_ok(),
                    "config_digest":config_digest,
                    "instance_id":instance_id,
                    "refused_requests_total":refused_requests.to_string()
                })),
                Ok(request) => {
                    let target = match request {
                        Rpc::Settlement { request_id } => SignTarget::Settlement { request_id },
                        Rpc::Clearance { nullifier } => SignTarget::Clearance { nullifier },
                        Rpc::Reconcile | Rpc::Health => unreachable!(),
                    };
                    let signed = signer
                        .sign_with_checkpoint(target, |point| {
                            if crash == Some(point) {
                                std::process::exit(86);
                            }
                        })
                        .await
                        .map(|signature| serde_json::json!({"signature":hex::encode(signature)}));
                    if signed.is_err() {
                        // Includes conflicting messages, journal/primary mismatch,
                        // and invalid targets. No target or secret is exported.
                        refused_requests = refused_requests.saturating_add(1);
                    }
                    signed
                }
                Err(_) => Err(anyhow::anyhow!("invalid target")),
            },
            _ => Err(anyhow::anyhow!("invalid target")),
        };
        // Errors deliberately do not expose DB URLs, input bodies, or secrets.
        let response = result.unwrap_or_else(|_| serde_json::json!({"error":"signing_refused"}));
        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        let _ = reader.get_mut().write_all(&bytes).await;
    }
}
fn read_seed(path: PathBuf) -> Result<[u8; 32]> {
    ensure!(
        std::fs::metadata(&path)?.permissions().mode() & 0o077 == 0,
        "seed file must be owner-only"
    );
    let mut bytes = std::fs::read(path)?;
    ensure!(bytes.len() == 32, "seed file must contain exactly 32 bytes");
    let result = bytes.as_slice().try_into().unwrap();
    bytes.fill(0);
    Ok(result)
}
async fn read_request(
    reader: &mut BufReader<tokio::net::UnixStream>,
    out: &mut Vec<u8>,
) -> Result<()> {
    loop {
        let data = reader.fill_buf().await?;
        ensure!(!data.is_empty(), "incomplete target");
        let n = data
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(data.len());
        ensure!(out.len() + n <= 1024, "oversized target");
        let done = data[n - 1] == b'\n';
        out.extend_from_slice(&data[..n]);
        reader.consume(n);
        if done {
            return Ok(());
        }
    }
}
