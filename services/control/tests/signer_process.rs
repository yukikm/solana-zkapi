//! Real Postgres and OS-process crash/restart acceptance. Run explicitly with
//! ZKAPI_TEST_DATABASE_URL pointing at a disposable PostgreSQL 16 cluster.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::signer::{clearance_message, verify_signature, PublicKey, Signer, SignerConfig};
use zkapi_proof::compact::CompactSigner;
use zkapi_types::Felt252;
mod support;

async fn connect(url: &str) -> Result<Client> {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}
fn db_url(base: &str, name: &str) -> Result<String> {
    if base.starts_with("postgres://") || base.starts_with("postgresql://") {
        let mut u = reqwest::Url::parse(base)?;
        u.set_path(&format!("/{name}"));
        Ok(u.to_string())
    } else {
        Ok(format!("{base} dbname={name}"))
    }
}
struct Process {
    child: Child,
    socket: PathBuf,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}
impl Process {
    async fn spawn(directory: &Path, url: &str, checkpoint: Option<&str>) -> Result<Self> {
        let socket = directory.join("signer.sock");
        let mut command = Command::new(env!("CARGO_BIN_EXE_signerd"));
        command
            .args(["--local-test", "--config"])
            .arg(directory.join("config.json"))
            .arg("--journal")
            .arg(directory.join("journal"))
            .arg("--socket")
            .arg(&socket)
            .arg("--state-seed-file")
            .arg(directory.join("state.seed"))
            .arg("--clearance-seed-file")
            .arg(directory.join("clearance.seed"))
            .env("ZKAPI_SIGNER_DATABASE_URL", url)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(checkpoint) = checkpoint {
            command.args(["--crash-at", checkpoint]);
        }
        let mut process = Self {
            child: command.spawn()?,
            socket,
        };
        for _ in 0..100 {
            if process.socket.exists() {
                return Ok(process);
            }
            if process.child.try_wait()?.is_some() {
                anyhow::bail!("signerd exited during startup");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        anyhow::bail!("signerd readiness timeout")
    }
    async fn rpc(&self, request: Value) -> Result<Value> {
        let mut stream = UnixStream::connect(&self.socket).await?;
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        let mut line = String::new();
        let count = BufReader::new(stream).read_line(&mut line).await?;
        anyhow::ensure!(count > 0, "signer stopped before response");
        Ok(serde_json::from_str(&line)?)
    }
}
fn config() -> SignerConfig {
    let state_key =
        PublicKey::from_wire(&CompactSigner::from_seed(&Felt252::from_u64(31)).public_key());
    SignerConfig {
        public_devnet_profile: None,
        authorization: zkapi_control::quote::BindingConfig {
            deployment_id: "signer-process-test".into(),
            pool: bs58::encode([42u8; 32]).into_string(),
            vault_binding: zkapi_solana_types::FieldElement::from_bytes(Felt252::from_u64(99).0)
                .unwrap(),
            state_key: [
                zkapi_solana_types::FieldElement::from_bytes(state_key.x).unwrap(),
                zkapi_solana_types::FieldElement::from_bytes(state_key.y).unwrap(),
            ],
            cap: zkapi_solana_types::MicroUsdc::new(1_000_000).unwrap(),
            control_api_origin: "http://127.0.0.1:8788".into(),
            inference_api_origin: "http://127.0.0.1:8789".into(),
            quote_key: ed25519_dalek::SigningKey::from_bytes(&[11; 32])
                .verifying_key()
                .to_bytes(),
        },
        pool: [42; 32],
        binding: Felt252::from_u64(99).0,
        state_key: PublicKey::from_wire(
            &CompactSigner::from_seed(&Felt252::from_u64(31)).public_key(),
        ),
        clearance_key: PublicKey::from_wire(
            &CompactSigner::from_seed(&Felt252::from_u64(37)).public_key(),
        ),
        receipt_key: ed25519_dalek::SigningKey::from_bytes(&[83; 32])
            .verifying_key()
            .to_bytes(),
    }
}
async fn add_clearance(client: &Client, config: &SignerConfig, n: [u8; 32]) -> Result<[u8; 32]> {
    let message = clearance_message(config.binding, n)?;
    let digest: [u8; 32] = Sha256::digest(message).into();
    client
        .execute(
            "INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'CLEARANCE')",
            &[&&config.pool[..], &&n[..]],
        )
        .await?;
    client.execute("INSERT INTO clearances(pool,nullifier,message_digest,signature_message) VALUES($1::bytea,$2::bytea,$3::bytea,$4::bytea)",&[&&config.pool[..],&&n[..],&&digest[..],&&message[..]]).await?;
    Ok(message)
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL; run scripts/run_i05.py"]
async fn signer_process_crashes_restore_audit_and_exact_response_recovery() -> Result<()> {
    let base =
        std::env::var("ZKAPI_TEST_DATABASE_URL").context("ZKAPI_TEST_DATABASE_URL is required")?;
    let admin = connect(&base).await?;
    let name = format!("zkapi_signer_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = db_url(&base, &name)?;
    let db = connect(&url).await?;
    zkapi_control::ledger::migrate(&url).await?;
    let reader_role = format!("zkapi_signer_reader_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!(
            "CREATE ROLE {reader_role} LOGIN; GRANT zkapi_control_reader TO {reader_role}"
        ))
        .await?;
    let reader_url = if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        let mut parsed = reqwest::Url::parse(&url)?;
        parsed
            .set_username(&reader_role)
            .map_err(|_| anyhow::anyhow!("reader URL"))?;
        parsed.to_string()
    } else {
        format!("{url} user={reader_role}")
    };
    let reader = connect(&reader_url).await?;
    assert!(reader
        .batch_execute("UPDATE pools SET accepting=true")
        .await
        .is_err());
    assert!(reader
        .batch_execute("DELETE FROM nullifier_reservations")
        .await
        .is_err());
    drop(reader);
    let config = config();
    let pool_config = json!({"signer":config});
    db.execute("INSERT INTO pools(pool,deployment_id,manifest_hash,authorization_config) VALUES($1::bytea,'signer-process-test',$2::bytea,$3)",&[&&config.pool[..],&&[77u8;32][..],&pool_config]).await?;
    let dir = tempfile::tempdir()?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(dir.path().join("config.json"), serde_json::to_vec(&config)?)?;
    for (name, seed) in [("state.seed", 31), ("clearance.seed", 37)] {
        let path = dir.path().join(name);
        std::fs::write(&path, Felt252::from_u64(seed).0)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Signer::initialize_journal(dir.path().join("journal"), &config)?;
    let mut saved = None;
    for (i, checkpoint) in ["intent", "signature", "synced"].into_iter().enumerate() {
        let n = Felt252::from_u64(100 + i as u64).0;
        let message = add_clearance(&db, &config, n).await?;
        let request = json!({"kind":"clearance","nullifier":n});
        let mut process = Process::spawn(dir.path(), &reader_url, Some(checkpoint)).await?;
        assert!(process.rpc(request.clone()).await.is_err());
        let status = process.child.wait()?;
        assert_eq!(status.code(), Some(86));
        drop(process);
        let process = Process::spawn(dir.path(), &reader_url, None).await?;
        let audit = process.rpc(json!({"kind":"reconcile"})).await?;
        assert_eq!(audit["reconciled"], true);
        assert_eq!(audit["config_digest"], hex::encode(config.digest()?));
        let response = process.rpc(request.clone()).await?;
        let signature = hex::decode(
            response["signature"]
                .as_str()
                .context("signature missing")?,
        )?;
        verify_signature(&config.clearance_key, message, &signature)?;
        assert_eq!(process.rpc(request.clone()).await?, response);
        assert_eq!(
            process
                .rpc(json!({"kind":"clearance","nullifier":n,"message":[0,1,2]}))
                .await?["error"],
            "signing_refused"
        );
        db.execute(
            "UPDATE clearances SET signature=$3 WHERE pool=$1 AND nullifier=$2",
            &[&&config.pool[..], &&n[..], &signature],
        )
        .await?;
        drop(process);
        let process = Process::spawn(dir.path(), &reader_url, None).await?;
        assert_eq!(process.rpc(request.clone()).await?, response);
        drop(process);
        saved = Some((n, message, signature));
    }
    let (n, message, signature) = saved.unwrap();
    // A journal lost after acknowledgement cannot be silently provisioned by startup.
    assert!(Signer::open(
        config.clone(),
        &reader_url,
        dir.path().join("missing"),
        Felt252::from_u64(31).0,
        Felt252::from_u64(37).0
    )
    .await
    .is_err());
    let empty = dir.path().join("empty");
    Signer::initialize_journal(&empty, &config)?;
    assert!(Signer::open(
        config.clone(),
        &reader_url,
        &empty,
        Felt252::from_u64(31).0,
        Felt252::from_u64(37).0
    )
    .await
    .is_err());
    // Simulate operator restore privileges, not application privileges. The
    // independent journal survives the restored ledger losing an accepted row.
    db.batch_execute("SET session_replication_role=replica")
        .await?;
    db.execute(
        "DELETE FROM clearances WHERE pool=$1 AND nullifier=$2",
        &[&&config.pool[..], &&n[..]],
    )
    .await?;
    db.batch_execute("SET session_replication_role=origin")
        .await?;
    assert!(Signer::open(
        config.clone(),
        &reader_url,
        dir.path().join("journal"),
        Felt252::from_u64(31).0,
        Felt252::from_u64(37).0
    )
    .await
    .is_err());
    let digest: [u8; 32] = Sha256::digest(message).into();
    db.execute("INSERT INTO clearances(pool,nullifier,message_digest,signature_message,signature) VALUES($1::bytea,$2::bytea,$3::bytea,$4::bytea,$5)",&[&&config.pool[..],&&n[..],&&digest[..],&&message[..],&signature]).await?;
    let process = Process::spawn(dir.path(), &reader_url, None).await?;
    db.batch_execute("SET session_replication_role=replica")
        .await?;
    db.execute(
        "UPDATE clearances SET message_digest=$3::bytea WHERE pool=$1 AND nullifier=$2",
        &[&&config.pool[..], &&n[..], &&[0u8; 32][..]],
    )
    .await?;
    db.batch_execute("SET session_replication_role=origin")
        .await?;
    assert_eq!(
        process.rpc(json!({"kind":"reconcile"})).await?["error"],
        "signing_refused"
    );
    let other = Felt252::from_u64(999).0;
    add_clearance(&db, &config, other).await?;
    assert_eq!(
        process
            .rpc(json!({"kind":"clearance","nullifier":other}))
            .await?["error"],
        "signing_refused"
    );
    drop(process);
    drop(db);
    admin
        .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .await?;
    admin
        .batch_execute(&format!("DROP ROLE {reader_role}"))
        .await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; run scripts/run_i05.py"]
async fn signer_rejects_ledger_tariff_substitution_before_signing_and_on_recovery() -> Result<()> {
    use zkapi_control::{
        ledger::{Ledger, NewSession, PoolIdentity, QuoteRecord, SettlementTarget},
        quote, signer, wire,
    };
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let admin = connect(&base).await?;
    let name = format!("zkapi_signer_tariff_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = db_url(&base, &name)?;
    zkapi_control::ledger::migrate(&url).await?;
    let db = connect(&url).await?;
    let mut config = config();
    config.authorization = support::local_binding();
    config.pool = wire::pubkey(&config.authorization.pool)?;
    config.binding = *config.authorization.vault_binding.as_bytes();
    let ledger = Ledger::connect(
        &url,
        &PoolIdentity {
            pool: config.pool,
            deployment_id: config.authorization.deployment_id.clone(),
            manifest_hash: [77; 32],
            authorization_config: json!({"signer":config}),
        },
    )
    .await?;
    ledger.set_accepting(true).await?;
    let tariff = support::tariff();
    let mut substituted = tariff.clone();
    substituted.rates[0].nano_usdc_numerator = "300".into();
    substituted.tariff_hash = quote::tariff_hash(&substituted)?;
    for item in [&tariff, &substituted] {
        ledger
            .store_tariff(
                wire::hash(&item.tariff_hash)?,
                &serde_jcs::to_vec(&quote::tariff_body(item)?)?,
            )
            .await?;
    }
    let now: i64 = db
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await?
        .get(0);
    let quote = support::signed_quote(u64::try_from(now)?);
    let (authorization, token) = support::authorization(&quote);
    let request = support::bound_request(authorization, quote.clone(), support::genesis_state());
    let credential = wire::parse_control_token(&token)?;
    let accepted = quote::validate_binding(&request, &credential, &config.authorization)?;
    let quote_id = wire::uuid(&quote.body.quote_id)?;
    ledger
        .store_quote(&QuoteRecord {
            quote_id,
            quote_hash: accepted.quote_hash,
            canonical_body: accepted.quote_body,
            signature: wire::base64_exact::<64>(&quote.signature)?.to_vec(),
            tariff_hash: wire::hash(&tariff.tariff_hash)?,
            expires_at: i64::try_from(wire::uint(&quote.body.expires_at)?)?,
        })
        .await?;
    ledger
        .reserve_session(
            &NewSession {
                request_id: accepted.request_id,
                nullifier: *accepted.nullifier.as_bytes(),
                quote_id,
                request_digest: accepted.digest,
                request_transcript: accepted.transcript,
                control_secret_hash: accepted.control_hash,
                proxy_secret_hash: accepted.proxy_hash,
                mode: "proxy".into(),
                provider: "openai".into(),
                cap_micro: config.authorization.cap.get(),
                max_concurrency: 4,
            },
            || async { Ok(()) },
        )
        .await?;
    ledger.close(accepted.request_id).await?;
    let draft = signer::prepare_settlement(
        config.binding,
        *accepted.nullifier.as_bytes(),
        *request.public_inputs[10].as_bytes(),
        *request.public_inputs[11].as_bytes(),
        0,
    )?;
    ledger
        .prepare_settlement(
            accepted.request_id,
            &SettlementTarget {
                charge_micro: draft.charge_micro,
                next_anchor: draft.next_anchor,
                next_commitment_x: draft.next_commitment_x,
                next_commitment_y: draft.next_commitment_y,
                blind_delta: draft.blind_delta,
                anchor_randomness: draft.anchor_randomness,
                signature_message: draft.signature_message,
                message_digest: draft.message_digest,
            },
        )
        .await?;
    let dir = tempfile::tempdir()?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(dir.path().join("config.json"), serde_json::to_vec(&config)?)?;
    for (name, seed) in [("state.seed", 31), ("clearance.seed", 37)] {
        let path = dir.path().join(name);
        std::fs::write(&path, Felt252::from_u64(seed).0)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Signer::initialize_journal(dir.path().join("journal"), &config)?;
    let process = Process::spawn(dir.path(), &url, None).await?;
    let target = json!({"kind":"settlement","request_id":accepted.request_id});
    // Simulate an inconsistent restored ledger using owner privileges. Both
    // tariffs are valid and share provider/model; only the signed quote pins
    // which one may govern this session. No journal intent may be committed for
    // a substituted tariff, including a zero-charge session with no receipts.
    for (tariff_hash, expected_error) in [
        (&substituted.tariff_hash, true),
        (&tariff.tariff_hash, false),
        (&substituted.tariff_hash, true),
    ] {
        db.batch_execute("SET session_replication_role=replica")
            .await?;
        db.execute(
            "UPDATE quotes SET tariff_hash=$3::bytea WHERE pool=$1 AND quote_id=$2",
            &[&&config.pool[..], &quote_id, &&wire::hash(tariff_hash)?[..]],
        )
        .await?;
        db.batch_execute("SET session_replication_role=origin")
            .await?;
        let response = process.rpc(target.clone()).await?;
        if expected_error {
            assert_eq!(response["error"], "signing_refused");
        } else {
            let signature = hex::decode(
                response["signature"]
                    .as_str()
                    .context("missing signature")?,
            )?;
            verify_signature(&config.state_key, draft.signature_message, &signature)?;
        }
    }
    assert_eq!(
        process.rpc(json!({"kind":"reconcile"})).await?["error"],
        "signing_refused"
    );
    drop(process);
    drop(ledger);
    drop(db);
    admin
        .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .await?;
    Ok(())
}
