//! OS-process recovery of the actual control HTTP server, isolated signer,
//! durable PostgreSQL ledger, and quote-bound request proof. RPC is local data
//! exported from the real Vault SBF fixture; no live cluster/provider claim.
mod support;
use anyhow::{ensure, Context, Result};
use axum::{
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use support::*;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    config::RuntimeConfig,
    ledger::{migrate, Ledger, PoolIdentity},
    quote,
    signer::{self, Signer},
    wire,
};

async fn db(url: &str) -> Result<Client> {
    let (c, conn) = tokio_postgres::connect(url, NoTls).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(c)
}
fn write_private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
fn database_url(base: &str, name: &str) -> Result<String> {
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
    socket: Option<PathBuf>,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(path) = &self.socket {
            let _ = std::fs::remove_file(path);
        }
    }
}
async fn start_signer(dir: &Path, url: &str) -> Result<Process> {
    let socket = dir.join("signer.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_signerd"))
        .arg("--local-test")
        .arg("--config")
        .arg(dir.join("signer.json"))
        .arg("--journal")
        .arg(dir.join("journal"))
        .arg("--socket")
        .arg(&socket)
        .arg("--state-seed-file")
        .arg(dir.join("state.seed"))
        .arg("--clearance-seed-file")
        .arg(dir.join("clearance.seed"))
        .env("ZKAPI_SIGNER_DATABASE_URL", url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut process = Process {
        child,
        socket: Some(socket.clone()),
    };
    for _ in 0..200 {
        if socket.exists() {
            return Ok(process);
        }
        ensure!(
            process.child.try_wait()?.is_none(),
            "signer process startup failed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    anyhow::bail!("signer readiness timeout")
}
async fn start_control(
    dir: &Path,
    url: &str,
    origin: &str,
    checkpoint: Option<&str>,
    client: &reqwest::Client,
) -> Result<Process> {
    let log_name = format!("controld-{}.log", checkpoint.unwrap_or("recovered"));
    let log = std::fs::File::create(dir.join(log_name))?;
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_controld"));
    cmd.arg("serve")
        .arg(dir.join("control.json"))
        .env("ZKAPI_DATABASE_URL", url)
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    if let Some(point) = checkpoint {
        cmd.env("ZKAPI_LOCAL_CRASH_AT", point);
    } else {
        cmd.env_remove("ZKAPI_LOCAL_CRASH_AT");
    }
    let mut process = Process {
        child: cmd.spawn()?,
        socket: None,
    };
    for _ in 0..250 {
        if let Ok(r) = client.get(format!("{origin}/zkapi/v1/config")).send().await {
            if r.status().is_success() {
                return Ok(process);
            }
        }
        if let Some(status) = process.child.try_wait()? {
            let log = std::fs::read_to_string(dir.join(format!(
                "controld-{}.log",
                checkpoint.unwrap_or("recovered")
            )))?;
            anyhow::bail!("control startup failed {status}: {log}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    anyhow::bail!("control readiness timeout")
}
async fn serve(router: Router) -> Result<(String, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Ok((origin, task))
}
async fn response(request: reqwest::RequestBuilder, expected: u16) -> Result<Value> {
    let r = request.send().await?;
    let status = r.status().as_u16();
    let text = r.text().await?;
    ensure!(status == expected, "HTTP {status}: {text}");
    Ok(serde_json::from_str(&text)?)
}
async fn frozen(db: &Client, id: Uuid) -> Result<Option<Value>> {
    Ok(db.query_opt("SELECT charge_micro,next_anchor,next_commitment_x,next_commitment_y,blind_delta,anchor_randomness,signature_message,message_digest,state_signature FROM settlements WHERE request_id=$1",&[&id]).await?.map(|r|json!({"charge":r.get::<_,i64>(0),"anchor":r.get::<_,Vec<u8>>(1),"x":r.get::<_,Vec<u8>>(2),"y":r.get::<_,Vec<u8>>(3),"delta":r.get::<_,Vec<u8>>(4),"randomness":r.get::<_,Vec<u8>>(5),"message":r.get::<_,Vec<u8>>(6),"digest":r.get::<_,Vec<u8>>(7),"signature":r.get::<_,Option<Vec<u8>>>(8)})))
}
fn local_config(dir: &Path, primary: String, secondary: String, indexer: String) -> RuntimeConfig {
    let f = fixture();
    let mut profile: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    let p = &f["auth"]["withdrawal"]["public_inputs"];
    let qk = SigningKey::from_bytes(&[11; 32]);
    let rk = SigningKey::from_bytes(&[12; 32]);
    let mut tariff = tariff();
    tariff.model = "i05-local-only".into();
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    let mut manifest = json!({"deployment_id":"i05-local","genesis_hash":bs58::encode([0;32]).into_string(),"program_id":bs58::encode([43;32]).into_string(),"pool":local_binding().pool,"mint":bs58::encode([4;32]).into_string(),"token_program":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","decimals":6,"vault_binding":p[2],"state_key":{"x":p[4],"y":p[5]},"clearance_key":{"x":p[6],"y":p[7]},"quote_public_key":bs58::encode(qk.verifying_key().to_bytes()).into_string(),"receipt_public_key":bs58::encode(rk.verifying_key().to_bytes()).into_string(),"deployment_environment":"local","transaction_formats":["v0_buffer"],"cap_micro_usdc":"1000000","note_ttl_seconds":"2592000","challenge_seconds":"86400","control_api_origin":"http://127.0.0.1:8788","inference_api_origin":"http://127.0.0.1:8789","db_schema_version":"2","tariff_hashes":[tariff.tariff_hash],"manifest_signature":"local trusted hash fixture","api_endpoints":[],"artifact_digests":{},"proving_keys_base_url":"http://127.0.0.1:8788/keys","idl_hash":wire::sha256(include_bytes!("../../../docs/contracts/zkapi_vault.json")).map(|_|0)});
    manifest["idl_hash"] = hex::encode(wire::sha256(include_bytes!(
        "../../../docs/contracts/zkapi_vault.json"
    )))
    .into();
    for name in [
        "protocol_layout_version",
        "tree_backend",
        "tree_tag_policy",
        "circuit_id",
        "request_pk_hash",
        "request_vk_hash",
        "withdrawal_pk_hash",
        "withdrawal_vk_hash",
        "tree_proof_artifacts",
        "setup_profile",
        "setup_transcript_hashes",
        "circuit_profile_hash",
    ] {
        manifest[name] = profile.as_object_mut().unwrap().remove(name).unwrap();
    }
    let mut manifest_body = manifest.clone();
    manifest_body
        .as_object_mut()
        .unwrap()
        .remove("manifest_signature");
    let hash = hex::encode(wire::digest(&manifest_body).unwrap());
    manifest["manifest_hash"] = hash.clone().into();
    complete_local_manifest(&mut manifest);
    let hash = manifest["manifest_hash"].as_str().unwrap().to_owned();
    write_private(&dir.join("quote.seed"), &[11; 32]);
    write_private(&dir.join("receipt.seed"), &[12; 32]);
    RuntimeConfig {
        devnet: None,
        local_test_only: true,
        listen: "127.0.0.1:0".parse().unwrap(),
        manifest,
        trusted_manifest_hash: hash,
        primary_rpc: primary,
        secondary_rpc: secondary,
        indexer_origin: indexer,
        signer_socket: dir.join("signer.sock"),
        quote_seed_file: dir.join("quote.seed"),
        receipt_seed_file: dir.join("receipt.seed"),
        enable_local_adapter: true,
        providers: Default::default(),
        tariffs: vec![tariff],
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and SBF chain fixture; scripts/run_i05.sh"]
async fn control_process_crashes_never_replace_reserved_nullifier_or_frozen_successor() -> Result<()>
{
    let base =
        std::env::var("ZKAPI_TEST_DATABASE_URL").context("ZKAPI_TEST_DATABASE_URL required")?;
    let admin = db(&base).await?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let chain: Value = serde_json::from_slice(&std::fs::read(root.join("target/i05/chain.json"))?)?;
    let mut tasks = Vec::new();
    let mut rpc = Vec::new();
    for _ in 0..2 {
        let c = chain.clone();
        let router=Router::new().route("/",post(move|Json(r):Json<Value>|{let c=c.clone();async move{let result=if r["method"]=="getGenesisHash"{json!(bs58::encode([0;32]).into_string())}else{json!({"context":{"slot":100},"value":if r["params"][0]==c["pool"]{c["pool_account"].clone()}else{Value::Null}})};Json(json!({"jsonrpc":"2.0","id":1,"result":result}))}}));
        let (origin, task) = serve(router).await?;
        rpc.push(origin);
        tasks.push(task);
    }
    let c = chain.clone();
    let (indexer, task) = serve(Router::new().route(
        "/zkapi/v1/tree/root",
        get(move || {
            let c = c.clone();
            async move { Json(c["root"].clone()) }
        }),
    ))
    .await?;
    tasks.push(task);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let mut results = Vec::new();
    for checkpoint in ["reserved", "sign_pending", "signature", "settled"] {
        let name = format!("zkapi_control_process_{}", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await?;
        let url = database_url(&base, &name)?;
        migrate(&url).await?;
        let sql = db(&url).await?;
        let dir = tempfile::Builder::new()
            .prefix("i05-control-process-")
            .tempdir_in("/tmp")?;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        let mut config = local_config(dir.path(), rpc[0].clone(), rpc[1].clone(), indexer.clone());
        let reserve = std::net::TcpListener::bind("127.0.0.1:0")?;
        config.listen = reserve.local_addr()?;
        let origin = format!("http://{}", config.listen);
        drop(reserve);
        let validated = config.clone().validate()?;
        let identity = PoolIdentity {
            pool: validated.signer.pool,
            deployment_id: validated.binding.deployment_id.clone(),
            manifest_hash: wire::hash(&config.trusted_manifest_hash)?,
            authorization_config: json!({"signer":validated.signer}),
        };
        let provision = Ledger::connect(&url, &identity).await?;
        drop(provision);
        tokio::time::sleep(Duration::from_millis(50)).await;
        write_private(
            &dir.path().join("control.json"),
            &serde_json::to_vec(&config)?,
        );
        write_private(
            &dir.path().join("signer.json"),
            &serde_json::to_vec(&validated.signer)?,
        );
        write_private(
            &dir.path().join("state.seed"),
            &zkapi_types::Felt252::from_u64(31).0,
        );
        write_private(
            &dir.path().join("clearance.seed"),
            &zkapi_types::Felt252::from_u64(37).0,
        );
        Signer::initialize_journal(dir.path().join("journal"), &validated.signer)?;
        let signer_process = start_signer(dir.path(), &url).await?;
        let mut control =
            start_control(dir.path(), &url, &origin, Some(checkpoint), &client).await?;
        let quote:wire::Quote=serde_json::from_value(response(client.post(format!("{origin}/zkapi/v1/quotes")).json(&json!({"mode":"proxy","provider":"openai","models":["i05-local-only"],"session_ttl_seconds":"300"})),200).await?)?;
        let (auth, token) = authorization(&quote);
        let request = bound_request(auth, quote, genesis_state());
        let id = wire::uuid(&request.authorization.request_id)?;
        let sessions = format!("{origin}/zkapi/v1/sessions");
        let status = format!("{sessions}/{id}");
        let epoch_before: i64 = sql
            .query_one(
                "SELECT writer_epoch FROM pools WHERE pool=$1",
                &[&&identity.pool[..]],
            )
            .await?
            .get(0);
        if checkpoint == "reserved" {
            assert!(client
                .post(&sessions)
                .header("authorization", &token)
                .json(&request)
                .send()
                .await
                .is_err());
        } else {
            response(
                client
                    .post(&sessions)
                    .header("authorization", &token)
                    .json(&request),
                201,
            )
            .await?;
            assert!(client
                .post(format!("{status}/close"))
                .header("authorization", &token)
                .send()
                .await
                .is_err());
        }
        let exit = control.child.wait()?;
        ensure!(exit.code() == Some(86), "unexpected crash status {exit}");
        drop(control);
        let state: String = sql
            .query_one("SELECT state FROM sessions WHERE request_id=$1", &[&id])
            .await?
            .get(0);
        ensure!(
            state
                == match checkpoint {
                    "reserved" => "RESERVED",
                    "settled" => "SETTLED",
                    _ => "SIGN_PENDING",
                },
            "unexpected durable state {state} at {checkpoint}"
        );
        let before = frozen(&sql, id).await?;
        if checkpoint == "reserved" {
            assert!(before.is_none());
        } else {
            let b = before.as_ref().unwrap();
            assert_eq!(b["charge"], 0);
            assert_eq!(!b["signature"].is_null(), checkpoint == "settled");
        }
        let journal_before = std::fs::read_to_string(dir.path().join("journal"))?;
        let expected_events = if matches!(checkpoint, "signature" | "settled") {
            3
        } else {
            1
        };
        assert_eq!(journal_before.lines().count(), expected_events);
        // Same config, fresh process, higher writer epoch. Accepted request retry
        // must resolve the saved request; it never consumes another N or quote.
        let control = start_control(dir.path(), &url, &origin, None, &client).await?;
        let recovered = response(
            client
                .post(&sessions)
                .header("authorization", &token)
                .json(&request),
            200,
        )
        .await?;
        assert_eq!(recovered["request_id"], id.to_string());
        response(
            client
                .post(format!("{status}/close"))
                .header("authorization", &token),
            202,
        )
        .await?;
        let mut settled = None;
        for _ in 0..100 {
            let body = response(client.get(&status).header("authorization", &token), 200).await?;
            if body["state"] == "SETTLED" {
                settled = Some(body);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let settled = settled.context("recovery failed to settle")?;
        assert_eq!(settled["settlement"]["charge_micro_usdc"], "0");
        let after = frozen(&sql, id).await?.unwrap();
        let saved_signature: Vec<u8> = serde_json::from_value(after["signature"].clone())?;
        let message: Vec<u8> = serde_json::from_value(after["message"].clone())?;
        signer::verify_signature(
            &validated.signer.state_key,
            message.try_into().unwrap(),
            &saved_signature,
        )?;
        if let Some(mut prior) = before {
            let prior_sig = prior.as_object_mut().unwrap().remove("signature").unwrap();
            let mut successor = after.clone();
            successor.as_object_mut().unwrap().remove("signature");
            assert_eq!(
                prior, successor,
                "frozen successor changed after {checkpoint}"
            );
            if !prior_sig.is_null() {
                assert_eq!(prior_sig, after["signature"]);
            }
        }
        let replay = response(
            client
                .post(&sessions)
                .header("authorization", &token)
                .json(&request),
            200,
        )
        .await?;
        assert_eq!(replay, settled);
        assert_eq!(
            response(
                client
                    .post(format!("{status}/close"))
                    .header("authorization", &token),
                202
            )
            .await?,
            settled
        );
        let counts=sql.query_one("SELECT (SELECT count(*) FROM sessions),(SELECT count(*) FROM nullifier_reservations),(SELECT count(*) FROM settlements),(SELECT count(*) FROM operations)",&[]).await?;
        assert_eq!(
            (
                counts.get::<_, i64>(0),
                counts.get::<_, i64>(1),
                counts.get::<_, i64>(2),
                counts.get::<_, i64>(3)
            ),
            (1, 1, 1, 0)
        );
        let epoch_after: i64 = sql
            .query_one(
                "SELECT writer_epoch FROM pools WHERE pool=$1",
                &[&&identity.pool[..]],
            )
            .await?
            .get(0);
        assert_eq!(epoch_after, epoch_before + 1);
        let journal = std::fs::read_to_string(dir.path().join("journal"))?;
        assert_eq!(journal.lines().count(), 3);
        ensure!(!journal.contains(&token), "raw token in journal");
        let stored: Vec<u8> = sql
            .query_one(
                "SELECT request_transcript FROM sessions WHERE request_id=$1",
                &[&id],
            )
            .await?
            .get(0);
        assert_eq!(stored, wire::jcs(&request)?);
        ensure!(
            !String::from_utf8_lossy(&stored).contains(&token),
            "raw token in transcript"
        );
        for name in [
            format!("controld-{checkpoint}.log"),
            "controld-recovered.log".into(),
        ] {
            let log = std::fs::read_to_string(dir.path().join(name))?;
            ensure!(!log.contains(&token), "raw token in control log");
        }
        results.push(json!({"checkpoint":checkpoint,"crash_exit_code":86,"durable_state_at_crash":state,"charge_micro":"0","writer_epoch_advanced":true,"exact_saved_successor_recovered":true,"reservation_count":1,"journal_intent_count":1,"journal_signature_count":1}));
        drop(control);
        drop(signer_process);
        drop(sql);
        admin
            .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
            .await?;
    }
    for task in tasks {
        task.abort();
    }
    std::fs::write(
        root.join("target/i05/control-process-results.json"),
        serde_json::to_vec_pretty(
            &json!({"scope":"real controld/signerd processes + PostgreSQL + real quote-bound RP; local RPC fixture only","scenarios":results}),
        )?,
    )?;
    Ok(())
}
