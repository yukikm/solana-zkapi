//! Dedicated provider process boundary. Secrets are loaded only by `dispatcherd`.
//! A claimed immutable ledger attempt and a durable exclusive file precede egress.
//! Process exit plus the retained claim prevent the same attempt from ever restarting.
use crate::{direct, ledger::DispatchAttempt, proxy, wire};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientConfig {
    pub binary: PathBuf,
    pub binary_sha256: String,
    pub config_file: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceConfig {
    pub local_test_only: bool,
    pub database_url: String,
    pub pool: [u8; 32],
    pub claims_directory: PathBuf,
    pub providers: crate::provider_runtime::ProviderConfig,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Proxy {
        attempt: DispatchAttempt,
        endpoint: proxy::Endpoint,
        profile: proxy::ModelProfile,
        streaming: bool,
        reservation_nano: String,
        body: Vec<u8>,
    },
    Create {
        attempt: DispatchAttempt,
        intent: direct::IssueIntent,
    },
    Verify {
        reference: direct::KeyReference,
        runtime_key: String,
        inference_base: String,
        verification: Option<serde_json::Value>,
        deliverable: bool,
    },
    Recover {
        intent: direct::IssueIntent,
    },
    Disable {
        reference: direct::KeyReference,
    },
    Usage {
        intent: direct::IssueIntent,
        reference: direct::KeyReference,
        disabled_at: u64,
        now: u64,
    },
    Delete {
        reference: direct::KeyReference,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub provider: wire::Provider,
    pub action: Action,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Head {
        status: u16,
        reference: Option<String>,
        sse: bool,
    },
    Data {
        bytes: Vec<u8>,
    },
    Result {
        value: serde_json::Value,
    },
}

pub fn private_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let m = std::fs::symlink_metadata(path)?;
    ensure!(
        m.is_file() && m.permissions().mode() & 0o077 == 0,
        "private regular file required"
    );
    Ok(())
}
impl ClientConfig {
    pub fn validate(&self) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::symlink_metadata(&self.binary)?;
        ensure!(
            m.is_file() && m.permissions().mode() & 0o022 == 0,
            "immutable dispatcher binary required"
        );
        ensure!(
            hex::encode(wire::sha256(&std::fs::read(&self.binary)?)) == self.binary_sha256,
            "dispatcher binary pin mismatch"
        );
        private_file(&self.config_file)?;
        Ok(())
    }
    /// Only transient authenticated pipes carry prompt/response or one-time keys.
    /// Errors discard all child diagnostics. No retry exists on this channel.
    pub async fn call(
        &self,
        request: Request,
        mut relay: Option<mpsc::Sender<proxy::RelayEvent>>,
    ) -> Result<serde_json::Value> {
        self.validate()?;
        let mut child = Command::new(&self.binary)
            .arg(&self.config_file)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut input = serde_json::to_vec(&request)?;
        input.push(b'\n');
        ensure!(input.len() <= 8 * 1024 * 1024, "dispatcher input limit");
        let mut stdin = child.stdin.take().context("dispatcher input")?;
        let mut output = BufReader::new(child.stdout.take().context("dispatcher output")?);
        let operation = async {
            stdin.write_all(&input).await?;
            drop(stdin);
            input.fill(0);
            let result = loop {
                let mut line = Vec::new();
                read_line(&mut output, &mut line, 8 * 1024 * 1024).await?;
                let event: Event = serde_json::from_slice(&line)?;
                match event {
                    Event::Result { value } => {
                        break value;
                    }
                    Event::Head {
                        status,
                        reference,
                        sse,
                    } => {
                        send(
                            &mut relay,
                            proxy::RelayEvent::Head {
                                status,
                                provider_request_id: reference,
                                content_type: if sse {
                                    "text/event-stream"
                                } else {
                                    "application/json"
                                },
                            },
                        )
                        .await;
                    }
                    Event::Data { bytes } => {
                        send(&mut relay, proxy::RelayEvent::Data(bytes.into())).await
                    }
                }
            };
            ensure!(child.wait().await?.success(), "dispatcher refused request");
            Ok(result)
        };
        let outcome = tokio::time::timeout(Duration::from_secs(610), operation).await;
        // Complete kernel-observed process termination even for truncated output.
        // Returning an error before this point could let settlement race egress.
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        let _status = child.wait().await?;
        match outcome {
            Ok(result) => result,
            Err(_) => anyhow::bail!("dispatcher timed out"),
        }
    }
    pub async fn proxy(
        &self,
        provider: wire::Provider,
        attempt: DispatchAttempt,
        request: proxy::PreparedRequest,
        relay: Option<mpsc::Sender<proxy::RelayEvent>>,
    ) -> Result<proxy::DispatchObservation> {
        let value = self
            .call(
                Request {
                    provider,
                    action: Action::Proxy {
                        attempt,
                        endpoint: request.endpoint,
                        profile: request.profile,
                        streaming: request.streaming,
                        reservation_nano: request.reservation_nano.to_string(),
                        body: request.upstream_body,
                    },
                },
                relay,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }
}
async fn send(relay: &mut Option<mpsc::Sender<proxy::RelayEvent>>, event: proxy::RelayEvent) {
    if let Some(sender) = relay {
        if !matches!(
            tokio::time::timeout(Duration::from_millis(250), sender.send(event)).await,
            Ok(Ok(()))
        ) {
            *relay = None;
        }
    }
}
pub async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    r: &mut R,
    out: &mut Vec<u8>,
    limit: usize,
) -> Result<()> {
    loop {
        let bytes = r.fill_buf().await?;
        ensure!(!bytes.is_empty(), "dispatcher response lost");
        let n = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map(|x| x + 1)
            .unwrap_or(bytes.len());
        ensure!(out.len() + n <= limit, "dispatcher frame limit");
        let done = bytes[n - 1] == b'\n';
        out.extend_from_slice(&bytes[..n]);
        r.consume(n);
        if done {
            return Ok(());
        }
    }
}
async fn emit(event: Event) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut v = serde_json::to_vec(&event)?;
    v.push(b'\n');
    tokio::io::stdout().write_all(&v).await?;
    Ok(())
}

/// No writer lock or financial writes: the dispatcher uses a SELECT-only role.
async fn authorize(
    db: &tokio_postgres::Client,
    c: &ServiceConfig,
    provider: &wire::Provider,
    a: &DispatchAttempt,
) -> Result<()> {
    let r=db.query_one("SELECT a.writer_epoch,a.owner_instance,a.request_id,a.operation_id,a.send_claimed_at IS NOT NULL AND a.finished_at IS NULL AND a.fenced_at IS NULL,p.writer_epoch,p.accepting,s.provider,s.state,s.close_requested,s.expires_at > floor(extract(epoch FROM clock_timestamp()))::bigint,COALESCE(o.state,'') FROM dispatch_attempts a JOIN pools p ON p.pool=a.pool JOIN sessions s ON s.pool=a.pool AND s.request_id=a.request_id LEFT JOIN operations o ON o.pool=a.pool AND o.request_id=a.request_id AND o.operation_id=a.operation_id WHERE a.pool=$1 AND a.attempt_id=$2",&[&&c.pool[..],&a.attempt_id]).await?;
    ensure!(
        r.get::<_, i64>(0) == a.writer_epoch
            && r.get::<_, uuid::Uuid>(1) == a.owner_instance
            && r.get::<_, uuid::Uuid>(2) == a.request_id
            && r.get::<_, Option<uuid::Uuid>>(3) == a.operation_id
            && r.get::<_, bool>(4)
            && r.get::<_, i64>(5) == a.writer_epoch
            && r.get::<_, bool>(6)
            && r.get::<_, String>(7) == provider.as_str()
            && !r.get::<_, bool>(9),
        "stale dispatcher attempt"
    );
    if a.operation_id.is_some() {
        ensure!(
            r.get::<_, String>(8) == "ACTIVE"
                && r.get::<_, bool>(10)
                && r.get::<_, String>(11) == "DISPATCHING",
            "operation no longer dispatchable"
        );
    } else {
        ensure!(
            r.get::<_, String>(8) == "ISSUING",
            "issuance no longer dispatchable"
        );
    }
    use std::{
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    ensure!(
        std::fs::symlink_metadata(&c.claims_directory)?.is_dir()
            && std::fs::metadata(&c.claims_directory)?.permissions().mode() & 0o077 == 0,
        "private claim directory required"
    );
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(c.claims_directory.join(a.attempt_id.to_string()))?;
    f.write_all(&serde_jcs::to_vec(a)?)?;
    f.sync_all()?;
    std::fs::File::open(&c.claims_directory)?.sync_all()?;
    // Recheck after the durable claim. A denied attempt still cannot be retried.
    let live:bool=db.query_one("SELECT p.writer_epoch=$3 AND p.accepting AND a.finished_at IS NULL AND a.fenced_at IS NULL FROM dispatch_attempts a JOIN pools p ON p.pool=a.pool WHERE a.pool=$1 AND a.attempt_id=$2",&[&&c.pool[..],&a.attempt_id,&a.writer_epoch]).await?.get(0);
    ensure!(live, "dispatcher fenced before egress");
    Ok(())
}
async fn checkpoint(
    db: &tokio_postgres::Client,
    c: &ServiceConfig,
    p: &wire::Provider,
    intent: Option<&direct::IssueIntent>,
    reference: Option<&direct::KeyReference>,
    allow_active: bool,
) -> Result<direct::Checkpoint> {
    let reference = reference.map(|r| r.key_ref.clone());
    let id = intent.map(|i| i.request_id.to_string());
    let rows=db.query("SELECT o.metadata,s.state,s.provider FROM outbox o JOIN sessions s ON s.pool=o.pool AND s.request_id=(o.metadata->'intent'->>'request_id')::uuid WHERE o.pool=$1 AND o.event_type='DIRECT_RECOVERY_CHECKPOINT' AND (($2::text IS NOT NULL AND o.metadata->'intent'->>'request_id'=$2) OR ($2::text IS NULL AND o.metadata->'reference'->>'key_ref'=$3)) ORDER BY o.id DESC LIMIT 1",&[&&c.pool[..],&id,&reference]).await?;
    ensure!(rows.len() == 1, "direct checkpoint required");
    let r = &rows[0];
    ensure!(
        r.get::<_, String>(2) == p.as_str(),
        "direct provider mismatch"
    );
    ensure!(
        matches!(
            r.get::<_, String>(1).as_str(),
            "ISSUING" | "ISSUANCE_UNKNOWN" | "DRAINING" | "RECONCILING"
        ) || allow_active && r.get::<_, String>(1) == "ACTIVE",
        "direct operation refused"
    );
    let cp: direct::Checkpoint = serde_json::from_value(r.get(0))?;
    ensure!(
        intent.is_none_or(|i| *i == cp.intent)
            && reference
                .as_ref()
                .is_none_or(|v| cp.reference.as_ref().is_some_and(|r| r.key_ref == *v)),
        "direct checkpoint mismatch"
    );
    Ok(cp)
}
pub async fn serve(c: ServiceConfig, request: Request) -> Result<()> {
    ensure!(
        c.local_test_only && c.providers.dispatcher.is_none(),
        "production dispatcher requires deployment validation"
    );
    crate::operations::local_database(&c.database_url)?;
    let (db, connection) = tokio_postgres::connect(&c.database_url, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    db.batch_execute("SET default_transaction_read_only=on")
        .await?;
    let p = request.provider;
    let value = match request.action {
        Action::Proxy {
            attempt,
            endpoint,
            profile,
            streaming,
            reservation_nano,
            body,
        } => {
            authorize(&db, &c, &p, &attempt).await?;
            let cfg = c
                .providers
                .proxy
                .iter()
                .find(|x| x.provider == p)
                .context("proxy unavailable")?;
            ensure!(
                cfg.models
                    .iter()
                    .any(|m| serde_json::to_value(m).ok() == serde_json::to_value(&profile).ok()),
                "proxy profile mismatch"
            );
            let op=db.query_one("SELECT endpoint,model,reservation_nano::text FROM operations WHERE pool=$1 AND request_id=$2 AND operation_id=$3",&[&&c.pool[..],&attempt.request_id,&attempt.operation_id]).await?;
            ensure!(
                op.get::<_, String>(0) == endpoint.path()
                    && op.get::<_, String>(1) == profile.model
                    && op.get::<_, String>(2) == reservation_nano,
                "proxy reservation mismatch"
            );
            let tariff_row=db.query_one("SELECT t.canonical_body,t.tariff_hash FROM sessions s JOIN quotes q ON q.pool=s.pool AND q.quote_id=s.quote_id JOIN tariffs t ON t.tariff_hash=q.tariff_hash WHERE s.pool=$1 AND s.request_id=$2",&[&&c.pool[..],&attempt.request_id]).await?;
            let raw: Vec<u8> = tariff_row.get(0);
            let hash: Vec<u8> = tariff_row.get(1);
            ensure!(
                wire::sha256(&raw).as_slice() == hash,
                "saved tariff checksum mismatch"
            );
            let mut tariff: serde_json::Value = serde_json::from_slice(&raw)?;
            tariff["tariff_hash"] = hex::encode(hash).into();
            let tariff: wire::Tariff = serde_json::from_value(tariff)?;
            let checked = proxy::validate(endpoint, &body, &profile, &tariff)?;
            ensure!(
                checked.streaming == streaming
                    && checked.reservation_nano.to_string() == reservation_nano,
                "request exceeds immutable reservation"
            );
            let credential = proxy::ServiceCredential::new(
                crate::provider_runtime::read_credential(&cfg.credential_file)?,
            )?;
            let adapter = if let Some(base) = &cfg.local_test_base {
                proxy::HttpAdapter::local_fixture(p, base, credential, Duration::from_secs(600))?
            } else {
                proxy::HttpAdapter::production(p, credential).await?
            };
            let (tx, mut rx) = mpsc::channel(32);
            let dispatch = adapter.dispatch_once(checked, Some(tx));
            let output = async {
                while let Some(event) = rx.recv().await {
                    let _ = emit(match event {
                        proxy::RelayEvent::Head {
                            status,
                            provider_request_id,
                            content_type,
                        } => Event::Head {
                            status,
                            reference: provider_request_id,
                            sse: content_type == "text/event-stream",
                        },
                        proxy::RelayEvent::Data(bytes) => Event::Data {
                            bytes: bytes.to_vec(),
                        },
                    })
                    .await;
                }
            };
            let (observation, ()) = tokio::join!(dispatch, output);
            serde_json::to_value(observation)?
        }
        action => {
            let cfg = c
                .providers
                .direct
                .iter()
                .find(|x| x.provider() == p)
                .context("direct unavailable")?
                .clone();
            let adapter = direct::DirectAdapter::new(cfg, true)?;
            match action {
                Action::Create { attempt, intent } => {
                    ensure!(
                        attempt.operation_id.is_none() && attempt.request_id == intent.request_id,
                        "issuance identity"
                    );
                    authorize(&db, &c, &p, &attempt).await?;
                    checkpoint(&db, &c, &p, Some(&intent), None, false).await?;
                    let created = adapter.create_key(&intent).await?;
                    serde_json::json!({"runtime_key":created.runtime_key,"reference":created.reference,"inference_base":created.inference_base,"verification":created.verification,"deliverable":created.deliverable})
                }
                Action::Verify {
                    reference,
                    runtime_key,
                    inference_base,
                    verification,
                    deliverable,
                } => {
                    checkpoint(&db, &c, &p, None, Some(&reference), true).await?;
                    adapter
                        .verify_created(&direct::CreatedKey {
                            runtime_key,
                            reference,
                            inference_base,
                            verification,
                            deliverable,
                        })
                        .await?;
                    serde_json::Value::Null
                }
                Action::Recover { intent } => {
                    checkpoint(&db, &c, &p, Some(&intent), None, false).await?;
                    serde_json::to_value(adapter.recover_key(&intent).await?)?
                }
                Action::Disable { reference } => {
                    checkpoint(&db, &c, &p, None, Some(&reference), false).await?;
                    adapter.disable_key(&reference).await?;
                    serde_json::Value::Null
                }
                Action::Usage {
                    intent,
                    reference,
                    disabled_at,
                    now,
                } => {
                    let cp =
                        checkpoint(&db, &c, &p, Some(&intent), Some(&reference), false).await?;
                    ensure!(
                        cp.disabled_at == Some(disabled_at),
                        "disable checkpoint required"
                    );
                    serde_json::to_value(
                        adapter
                            .read_usage(&intent, &reference, disabled_at, now)
                            .await?,
                    )?
                }
                Action::Delete { reference } => {
                    let cp = checkpoint(&db, &c, &p, None, Some(&reference), false).await?;
                    ensure!(
                        cp.usage.is_some(),
                        "saved final usage required before delete"
                    );
                    adapter.delete_key(&reference).await?;
                    serde_json::Value::Null
                }
                Action::Proxy { .. } => unreachable!(),
            }
        }
    };
    emit(Event::Result { value }).await
}
