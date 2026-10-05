//! Real HTTP + PostgreSQL + isolated signer + real request/withdrawal circuits.
mod support;
use anyhow::{ensure, Result};
use ark_bn254::{Bn254, Fr};
use ark_ed_on_bn254::{EdwardsAffine, Fr as Scalar};
use ark_ff::PrimeField;
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use rand::{rngs::StdRng, SeedableRng};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use support::*;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    api::App,
    config::RuntimeConfig,
    dispatcher::{LocalDispatchConfig, LocalOwner},
    ledger::*,
    quote,
    receipts::{Receipt, ReceiptBody, UsageUnit},
    signer::{self, Signer},
    wire,
};
use zkapi_proof::groth16::*;
use zkapi_solana_types::{field::field_bytes, FieldElement, CHAIN_NAMESPACE};

async fn db(url: &str) -> Client {
    let (c, conn) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}
fn write_private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
struct ChildGuard {
    child: Child,
    socket: PathBuf,
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}
async fn start_signer(dir: &Path, url: &str) -> ChildGuard {
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
        .spawn()
        .unwrap();
    let mut guard = ChildGuard { child, socket };
    for _ in 0..200 {
        if guard.socket.exists() {
            return guard;
        }
        if let Some(status) = guard.child.try_wait().unwrap() {
            panic!("signer startup failed {status}")
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("signer timeout")
}
async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (origin, task)
}
async fn response(req: reqwest::RequestBuilder, expected: u16) -> Value {
    let r = req.send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap();
    assert_eq!(status.as_u16(), expected, "HTTP {text}");
    serde_json::from_str(&text).unwrap()
}
fn record(receipt: Receipt) -> ReceiptRecord {
    ReceiptRecord {
        sequence: 0,
        receipt_id: wire::uuid(&receipt.body.receipt_id).unwrap(),
        request_id: wire::uuid(&receipt.body.request_id).unwrap(),
        operation_id: receipt
            .body
            .operation_id
            .as_deref()
            .map(wire::uuid)
            .transpose()
            .unwrap(),
        billing_effect: receipt.body.billing_effect.clone(),
        canonical_body: receipt.body.canonical_bytes().unwrap(),
        receipt_hash: wire::hash(&receipt.receipt_hash).unwrap(),
        signature: Some(STANDARD.decode(receipt.signature).unwrap()),
    }
}
fn receipt(
    app: &App,
    op: &NewOperation,
    reason: &str,
    observed: Option<u128>,
    count: u64,
) -> ReceiptRecord {
    let charge = observed.unwrap_or(0).min(op.reservation_nano);
    // The fixture retains expired/future tariffs around the current one.
    let tariff = &app.config.runtime.tariffs[1];
    let body = ReceiptBody {
        version: "1".into(),
        receipt_id: Uuid::new_v4().to_string(),
        deployment_id: app.config.binding.deployment_id.clone(),
        pool: app.config.binding.pool.clone(),
        request_id: op.request_id.to_string(),
        operation_id: Some(op.operation_id.to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string(),
        evidence_kind: if reason == "metered" {
            "PROXY_USAGE"
        } else if reason == "not_dispatched" {
            "NOT_DISPATCHED"
        } else {
            "UNKNOWN_OPERATOR_LOSS"
        }
        .into(),
        provider_request_id: None,
        provider_evidence_digest: None,
        tariff_hash: tariff.tariff_hash.clone(),
        usage: if reason == "metered" {
            vec![
                UsageUnit {
                    unit: "input_tokens".into(),
                    count: count.to_string(),
                },
                UsageUnit {
                    unit: "output_tokens".into(),
                    count: "0".into(),
                },
            ]
        } else {
            vec![]
        },
        provider_reported_usd: None,
        reservation_nano_usdc: op.reservation_nano.to_string(),
        observed_nano_usdc: observed.map(|v| v.to_string()),
        charged_nano_usdc: charge.to_string(),
        operator_loss_nano_usdc: observed.map(|v| (v - charge).to_string()),
        reason: reason.into(),
    };
    record(Receipt::sign(body, &app.config.receipt_key).unwrap())
}
fn sig(v: &Value) -> StateSignature {
    StateSignature {
        r: EdwardsAffine::new_unchecked(
            field(v["r_x"].as_str().unwrap()),
            field(v["r_y"].as_str().unwrap()),
        ),
        s: Scalar::from_be_bytes_mod_order(
            &hex::decode(v["s"].as_str().unwrap().trim_start_matches("0x")).unwrap(),
        ),
    }
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
    tariff.valid_from = "1".into();
    tariff.tariff_hash = quote::tariff_hash(&tariff).unwrap();
    let mut expired = tariff.clone();
    expired.valid_from = "0".into();
    expired.valid_until = "1".into();
    expired.tariff_hash = quote::tariff_hash(&expired).unwrap();
    let mut future = tariff.clone();
    future.valid_from = tariff.valid_until.clone();
    future.valid_until = "4000000120".into();
    future.tariff_hash = quote::tariff_hash(&future).unwrap();
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
    manifest["tariff_hashes"] =
        json!([expired.tariff_hash, tariff.tariff_hash, future.tariff_hash]);
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
        tariffs: vec![expired, tariff, future],
    }
}

#[test]
fn runtime_config_rejects_ambiguous_overlapping_tariffs() {
    let dir = tempfile::tempdir().unwrap();
    let config = local_config(
        dir.path(),
        "http://127.0.0.1:9001".into(),
        "http://127.0.0.1:9002".into(),
        "http://127.0.0.1:9003".into(),
    );
    config.clone().validate().unwrap();
    let mut overlapping = config;
    overlapping.tariffs.push(overlapping.tariffs[1].clone());
    assert!(overlapping.validate().is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable PostgreSQL and actual SBF export; scripts/run_i05.sh"]
async fn http_real_proof_process_signer_successor_and_vault_fixture() -> Result<()> {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let admin = db(&base).await;
    let name = format!("i05_http_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = format!("{base} dbname={name}");
    migrate(&url).await?;
    let sql = db(&url).await;
    let dir = tempfile::Builder::new()
        .prefix("i05-http-")
        .tempdir_in("/tmp")?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let chain: Value = serde_json::from_slice(&std::fs::read(root.join("target/i05/chain.json"))?)?;
    let ready = Arc::new(AtomicBool::new(true));
    let mut tasks = vec![];
    let mut rpc = vec![];
    for _ in 0..2 {
        let c = chain.clone();
        let router=Router::new().route("/",post(move|Json(r):Json<Value>|{let c=c.clone();async move{let result=if r["method"]=="getGenesisHash"{json!(bs58::encode([0;32]).into_string())}else{json!({"context":{"slot":100},"value":if r["params"][0]==c["pool"]{c["pool_account"].clone()}else{Value::Null}})};Json(json!({"jsonrpc":"2.0","id":1,"result":result}))}}));
        let (origin, task) = serve(router).await;
        rpc.push(origin);
        tasks.push(task);
    }
    let is_ready = ready.clone();
    let c = chain.clone();
    let (indexer, task) = serve(Router::new().route(
        "/zkapi/v1/tree/root",
        get(move || {
            let c = c.clone();
            let r = is_ready.clone();
            async move {
                (
                    if r.load(Ordering::SeqCst) {
                        axum::http::StatusCode::OK
                    } else {
                        axum::http::StatusCode::SERVICE_UNAVAILABLE
                    },
                    Json(c["root"].clone()),
                )
            }
        }),
    ))
    .await;
    tasks.push(task);
    let config = local_config(dir.path(), rpc[0].clone(), rpc[1].clone(), indexer);
    std::fs::write(
        root.join("target/i05/public-manifest.json"),
        serde_json::to_vec_pretty(&config.manifest)?,
    )?;
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
    let signer_process = start_signer(dir.path(), &url).await;
    let app = App::connect(config.clone().validate()?, &url).await?;
    let (origin, http_task) = serve(app.router()).await;
    tasks.push(http_task);
    let client = reqwest::Client::new();
    let quotes = format!("{origin}/zkapi/v1/quotes");
    response(
        client
            .post(&quotes)
            .json(&json!({"mode":"direct_openrouter","provider":"openrouter","models":["*"]})),
        400,
    )
    .await;
    response(
        client
            .post(&quotes)
            .header("content-type", "application/json")
            .body("{\"mode\":\"proxy\",\"mode\":\"proxy\"}"),
        400,
    )
    .await;
    let q:wire::Quote=serde_json::from_value(response(client.post(&quotes).json(&json!({"mode":"proxy","provider":"openai","models":["i05-local-only"],"session_ttl_seconds":"300"})),200).await)?;
    assert_eq!(q.body.tariff_hash, config.tariffs[1].tariff_hash);
    let catalog = response(client.get(format!("{origin}/zkapi/v1/catalog")), 200).await;
    assert_eq!(catalog["models"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["models"][0]["tariff_hash"], q.body.tariff_hash);
    let (auth, token) = authorization(&q);
    let request = bound_request(auth, q, genesis_state());
    let id = wire::uuid(&request.authorization.request_id)?;
    let sessions = format!("{origin}/zkapi/v1/sessions");
    response(client.post(&sessions).json(&request), 401).await;
    response(
        client
            .post(&sessions)
            .header("authorization", &token)
            .json(&request),
        201,
    )
    .await;
    // 100 simultaneous real-proof exact retries: one durable reservation, stable results.
    let mut retries = vec![];
    for _ in 0..100 {
        let c = client.clone();
        let u = sessions.clone();
        let t = token.clone();
        let r = request.clone();
        retries.push(tokio::spawn(async move {
            response(c.post(u).header("authorization", t).json(&r), 200).await
        }));
    }
    for t in retries {
        assert_eq!(t.await?["request_id"], id.to_string());
    }
    assert_eq!(
        sql.query_one("SELECT count(*) FROM sessions", &[])
            .await?
            .get::<_, i64>(0),
        1
    );
    let mut changed = request.clone();
    let mut proof = changed.proof.bytes()?;
    proof[0] ^= 1;
    changed.proof.proof = STANDARD.encode(proof);
    response(
        client
            .post(&sessions)
            .header("authorization", &token)
            .json(&changed),
        409,
    )
    .await;
    // Accepted recovery ignores unavailable indexer; fresh acceptance remains fail closed.
    ready.store(false, Ordering::SeqCst);
    assert!(app.recover().await.is_err());
    assert!(!sql
        .query_one("SELECT accepting FROM pools", &[])
        .await?
        .get::<_, bool>(0));
    response(
        client
            .post(&sessions)
            .header("authorization", &token)
            .json(&request),
        200,
    )
    .await;
    ready.store(true, Ordering::SeqCst);
    app.recover().await.expect("healthy chain recovery");
    let status = format!("{sessions}/{id}");
    response(
        client
            .get(&status)
            .header("authorization", token.replace("zkc1", "zkp1")),
        401,
    )
    .await;
    // Real local owner process: uncertainty cannot be waived until actual stop + wait.
    let op = NewOperation {
        request_id: id,
        operation_id: Uuid::new_v4(),
        request_hmac: wire::operation_hmac(
            &[8; 32],
            "POST",
            "/v1/chat/completions",
            "",
            b"{\"messages\":[{\"content\":\"I05_PRIVATE_PROMPT_CANARY\"}]}",
        )?,
        endpoint: "/v1/chat/completions".into(),
        model: "i05-local-only".into(),
        reservation_nano: 1000,
    };
    app.ledger.reserve_operation(&op).await?;
    let attempt = app
        .ledger
        .begin_dispatch(id, op.operation_id, Uuid::new_v4(), || async { Ok(()) })
        .await?;
    app.ledger.claim_dispatch(&attempt).await?;
    let owner_config = LocalDispatchConfig {
        local_test_only: true,
        database_url: url.clone(),
        pool: app.ledger.pool(),
        owner_instance: attempt.owner_instance,
        writer_epoch: attempt.writer_epoch,
        claims_directory: dir.path().join("claims"),
    };
    let owner_path = dir.path().join("owner.json");
    write_private(&owner_path, &serde_json::to_vec(&owner_config)?);
    let owner = LocalOwner::spawn(
        Path::new(env!("CARGO_BIN_EXE_dispatch-owner")),
        &owner_path,
        attempt.attempt_id,
    )
    .await?;
    app.ledger
        .mark_operation_unknown(id, op.operation_id)
        .await?;
    let unknown = receipt(&app, &op, "waived_unknown", None, 0);
    assert!(app
        .ledger
        .complete_operation(
            id,
            op.operation_id,
            OperationOutcome::UnknownWaived,
            &unknown
        )
        .await
        .is_err());
    let other = NewOperation {
        operation_id: Uuid::new_v4(),
        ..op.clone()
    };
    app.ledger.reserve_operation(&other).await?;
    let other_attempt = app
        .ledger
        .begin_dispatch(id, other.operation_id, Uuid::new_v4(), || async { Ok(()) })
        .await?;
    app.ledger.claim_dispatch(&other_attempt).await?;
    let other_config = LocalDispatchConfig {
        local_test_only: true,
        database_url: url.clone(),
        pool: app.ledger.pool(),
        owner_instance: other_attempt.owner_instance,
        writer_epoch: other_attempt.writer_epoch,
        claims_directory: dir.path().join("claims"),
    };
    let other_path = dir.path().join("other-owner.json");
    write_private(&other_path, &serde_json::to_vec(&other_config)?);
    let other_owner = LocalOwner::spawn(
        Path::new(env!("CARGO_BIN_EXE_dispatch-owner")),
        &other_path,
        other_attempt.attempt_id,
    )
    .await?;
    let evidence: FenceEvidence = owner.stop().await?.into();
    assert!(
        app.ledger
            .fence_attempt(&other_attempt, &evidence)
            .await
            .is_err(),
        "stopped A cannot fence live B"
    );
    let other_evidence: FenceEvidence = other_owner.stop().await?.into();
    app.ledger
        .fence_attempt(&other_attempt, &other_evidence)
        .await?;
    app.ledger
        .mark_operation_unknown(id, other.operation_id)
        .await?;
    app.ledger
        .complete_operation(
            id,
            other.operation_id,
            OperationOutcome::UnknownWaived,
            &receipt(&app, &other, "waived_unknown", None, 0),
        )
        .await?;
    app.ledger.fence_attempt(&attempt, &evidence).await?;
    assert!(LocalOwner::spawn(
        Path::new(env!("CARGO_BIN_EXE_dispatch-owner")),
        &owner_path,
        attempt.attempt_id
    )
    .await
    .is_err());
    app.ledger
        .complete_operation(
            id,
            op.operation_id,
            OperationOutcome::UnknownWaived,
            &unknown,
        )
        .await?;
    // Exact rational usage charges 1001 nano -> 2 micro once for the whole session.
    let metered = NewOperation {
        operation_id: Uuid::new_v4(),
        reservation_nano: 2000,
        ..op.clone()
    };
    app.ledger.reserve_operation(&metered).await?;
    let attempt = app
        .ledger
        .begin_dispatch(id, metered.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await?;
    app.ledger.claim_dispatch(&attempt).await?;
    app.ledger
        .finish_attempt(&attempt, wire::sha256(b"local test call completed"))
        .await?;
    let receipt = receipt(&app, &metered, "metered", Some(1001), 3001);
    app.ledger
        .complete_operation(
            id,
            metered.operation_id,
            OperationOutcome::Metered {
                observed_nano: 1001,
            },
            &receipt,
        )
        .await?;
    let page = response(
        client
            .get(format!("{status}/receipts"))
            .header("authorization", &token),
        200,
    )
    .await;
    assert_eq!(page["receipts"].as_array().unwrap().len(), 3);
    for r in page["receipts"].as_array().unwrap() {
        serde_json::from_value::<Receipt>(r.clone())?
            .verify(&app.config.receipt_key.verifying_key())?;
    }
    response(
        client
            .get(format!("{status}/operations/{}", metered.operation_id))
            .header("authorization", &token),
        200,
    )
    .await;
    // A pre-DISPATCHING crash leaves a reservation; close recovers it with signed zero charge.
    let abandoned = NewOperation {
        operation_id: Uuid::new_v4(),
        ..op.clone()
    };
    app.ledger.reserve_operation(&abandoned).await?;
    app.ledger.close(id).await?;
    ready.store(false, Ordering::SeqCst);
    assert!(app.recover().await.is_err());
    assert_eq!(app.ledger.session(id).await?.state, "SETTLED");
    let closed = response(
        client
            .post(format!("{status}/close"))
            .header("authorization", &token),
        202,
    )
    .await;
    assert_eq!(closed["state"], "SETTLED", "{closed}");
    ready.store(true, Ordering::SeqCst);
    app.recover().await.expect("healthy chain recovery");
    let abandoned_status = response(
        client
            .get(format!("{status}/operations/{}", abandoned.operation_id))
            .header("authorization", &token),
        200,
    )
    .await;
    assert_eq!(
        abandoned_status["receipt"]["body"]["reason"],
        "not_dispatched"
    );
    let settlement = &closed["settlement"];
    assert_eq!(settlement["charge_micro_usdc"], "2");
    let stored = app.ledger.settlement(id).await?;
    let frozen = stored.target.clone();
    // Distinct process restart retrieves the same journal signature and frozen randomness.
    drop(signer_process);
    let _signer_process = start_signer(dir.path(), &url).await;
    app.signer.reconcile(&app.config.signer).await?;
    let recovered = app
        .signer
        .sign(
            signer::SignTarget::Settlement { request_id: id },
            &app.config.signer.state_key,
            frozen.signature_message,
        )
        .await?;
    assert_eq!(Some(recovered), stored.state_signature);
    let delta = Scalar::from_be_bytes_mod_order(&frozen.blind_delta);
    let state = NoteState {
        balance: 4_999_998,
        blinding: Scalar::from(19u64) + Scalar::from(23u64) + delta,
        anchor: FieldElement::from_bytes(frozen.next_anchor)?.to_field(),
        genesis: false,
        signature: sig(&settlement["next_state_signature"]),
    };
    let q2: wire::Quote = serde_json::from_value(
        response(
            client
                .post(&quotes)
                .json(&json!({"mode":"proxy","provider":"openai","models":["i05-local-only"]})),
            200,
        )
        .await,
    )?;
    let (a2, _) = authorization(&q2);
    let next_request = bound_request(a2, q2, state.clone());
    assert_ne!(next_request.public_inputs[8], request.public_inputs[8]);
    let clearance_url = format!("{origin}/zkapi/v1/withdraw/clearance");
    let clear = response(
        client
            .post(&clearance_url)
            .json(&json!({"nullifier":next_request.public_inputs[8]})),
        200,
    )
    .await;
    let again = response(
        client
            .post(&clearance_url)
            .json(&json!({"nullifier":next_request.public_inputs[8]})),
        200,
    )
    .await;
    assert_eq!(clear, again);
    response(
        client
            .post(&clearance_url)
            .json(&json!({"nullifier":request.public_inputs[8]})),
        409,
    )
    .await;
    let f = fixture();
    let binding = next_request.public_inputs[2].to_field();
    let dest = zkapi_solana_types::binding::destination_binding(&[7; 32]).to_field();
    let n = next_request.public_inputs[8].to_field();
    let p = WithdrawalPublic {
        protocol_version: 2,
        chain_id: CHAIN_NAMESPACE,
        contract_address: binding,
        active_root: next_request.public_inputs[3].to_field(),
        state_signing_key: StateSigningKey::from_secret(Scalar::from(31u64)).public,
        clearance_signing_key: StateSigningKey::from_secret(Scalar::from(37u64)).public,
        note_id: 0,
        final_balance: state.balance as u128,
        destination: dest,
        withdrawal_nullifier: n,
        has_clearance: true,
        withdrawal_tag: withdrawal_tag(n, dest, state.balance as u128, true),
    };
    let circuit = WithdrawalCircuit {
        public: p,
        witness: WithdrawalWitness {
            secret: Fr::from(42u64),
            deposit_amount: 5_000_000,
            expiry: f["expiry"].as_u64().unwrap(),
            merkle_siblings: std::array::from_fn(|i| {
                zkapi_core::v2::felt_to_field(&zkapi_core::v2::zero_hashes()[i])
            }),
            final_blinding: state.blinding,
            current_anchor: state.anchor,
            is_genesis: false,
            state_signature: state.signature,
            clearance_signature: sig(&clear["signature"]),
        },
    };
    let pk = key::<ProvingKey<Bn254>>("withdrawal", "pk");
    let public = circuit.public.to_field_elements();
    let proof = prove_withdrawal(&pk, circuit, &mut StdRng::seed_from_u64(105))?;
    assert!(Groth16::<Bn254>::verify_proof(
        &prepare_verifying_key(&pk.vk),
        &proof,
        &public
    )?);
    let mut output = f;
    output["balance"] = state.balance.into();
    output["anchor"] = format!("0x{}", hex::encode(field_bytes(state.anchor))).into();
    output["is_genesis"] = false.into();
    output["auth"]["withdrawal"] = json!({"public_inputs":public.iter().map(|f|format!("0x{}",hex::encode(field_bytes(*f)))).collect::<Vec<_>>(),"proof_wire_hex":hex::encode(zkapi_solana_crypto::encode_upstream_proof(&proof))});
    std::fs::write(
        root.join("target/i05/settled-vault.json"),
        serde_json::to_vec_pretty(&output)?,
    )?;
    // No raw control/proxy token, seed, or inference body in the persistent transcript/evidence/journal.
    let records = sql
        .query("SELECT request_transcript FROM sessions", &[])
        .await?;
    for row in records {
        let bytes: Vec<u8> = row.get(0);
        ensure!(!String::from_utf8_lossy(&bytes).contains(&token));
    }
    let dump = Command::new("pg_dump")
        .arg("--dbname")
        .arg(&url)
        .arg("--data-only")
        .output()?;
    ensure!(dump.status.success(), "local database backup failed");
    let dump_text = String::from_utf8(dump.stdout)?;
    for forbidden in [
        &token,
        "I05_PRIVATE_PROMPT_CANARY",
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7; 32]),
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([8; 32]),
    ] {
        ensure!(
            !dump_text.contains(forbidden),
            "credential/body appeared in database backup"
        );
    }
    let journal = std::fs::read_to_string(dir.path().join("journal"))?;
    ensure!(!journal.contains(&token));
    // Restart during a chain outage: the API can recover durable targets while
    // admission stays disabled. A fresh RPC trust mismatch remains fatal.
    let pending_nullifier = field_bytes(Fr::from(999u64));
    let pending_message = signer::clearance_message(app.config.signer.binding, pending_nullifier)?;
    app.ledger
        .reserve_clearance(
            pending_nullifier,
            pending_message,
            wire::sha256(&pending_message),
        )
        .await?;
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    drop(app);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let recovered_app = App::connect(config.validate()?, &url).await?;
    assert!(!sql
        .query_one("SELECT accepting FROM pools", &[])
        .await?
        .get::<_, bool>(0));
    assert!(recovered_app.recover().await.is_err());
    let recovered_clearance = recovered_app
        .ledger
        .reserve_clearance(
            pending_nullifier,
            pending_message,
            wire::sha256(&pending_message),
        )
        .await?;
    signer::verify_signature(
        &recovered_app.config.signer.clearance_key,
        pending_message,
        &recovered_clearance
            .signature
            .expect("durable clearance recovered offline"),
    )?;
    std::fs::write(
        root.join("target/i05/http-results.json"),
        serde_json::to_vec_pretty(
            &json!({"scope":"real PostgreSQL/HTTP/isolated signer/real RP+WP; synthetic local usage and RPC observations","exact_retry_count":100,"charge_nano":"1001","charge_micro":"2","successor_request_verified":true,"withdrawal_proof_verified":true,"separate_signer_restart":true,"owner_killed_and_restart_rejected":true,"chain_outage_stops_admission":true,"settlement_recovers_during_chain_outage":true,"restart_recovers_clearance_without_chain":true,"catalog_and_quotes_select_current_tariff":true,"request_digest":hex::encode(wire::digest(&request)?),"settlement_message_digest":hex::encode(frozen.message_digest)}),
        )?,
    )?;
    Ok(())
}
