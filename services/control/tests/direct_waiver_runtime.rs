//! Real isolated PostgreSQL tests of operator-loss approval and ledger invariants.
//! AUTH bytes are synthetic here; the signer suite separately verifies a real proof.
use ed25519_dalek::SigningKey;
use serde_json::json;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    direct::{Checkpoint, IssueIntent},
    direct_waiver::{self, SignedApproval},
    ledger::*,
    wire::{self, Provider, Tariff},
};

fn key() -> SigningKey {
    SigningKey::from_bytes(&[73; 32])
}
async fn client(url: &str) -> Client {
    let (c, conn) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}
struct Fixture {
    ledger: Ledger,
    admin: Client,
    url: String,
    identity: PoolIdentity,
    id: Uuid,
    cp: serde_json::Value,
    attempt: DispatchAttempt,
}
async fn fixture(age: u64, finish: bool) -> Fixture {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL").expect("isolated PostgreSQL required");
    let admin = client(&base).await;
    let name = format!("zkapi_direct_waiver_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let config: tokio_postgres::Config = base.parse().unwrap();
    let host = match &config.get_hosts()[0] {
        tokio_postgres::config::Host::Tcp(s) => s.clone(),
        tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
    };
    let url = format!(
        "host={host} port={} user={} dbname={name}",
        config.get_ports().first().unwrap_or(&5432),
        config.get_user().unwrap()
    );
    migrate(&url).await.unwrap();
    migrate(&url).await.unwrap();
    let admin = client(&url).await;
    let identity = PoolIdentity {
        pool: [71; 32],
        deployment_id: format!("waiver-local-{}", Uuid::new_v4()),
        manifest_hash: [72; 32],
        authorization_config: json!({"signer":{"receipt_key":key().verifying_key().to_bytes()}}),
    };
    let ledger = Ledger::connect(&url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    let mut t = Tariff {
        api: None,
        tariff_hash: String::new(),
        version: "1".into(),
        provider: Provider::Openrouter,
        model: "*".into(),
        pricing_basis: "provider_reported_usd".into(),
        valid_from: "0".into(),
        valid_until: "4102444800".into(),
        rates: vec![],
        operator_fee_micro_usdc: "0".into(),
    };
    t.tariff_hash = zkapi_control::quote::tariff_hash(&t).unwrap();
    let body = serde_jcs::to_vec(&zkapi_control::quote::tariff_body(&t).unwrap()).unwrap();
    let hash = wire::sha256(&body);
    ledger.store_tariff(hash, &body).await.unwrap();
    let now: i64 = admin
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let qid = Uuid::new_v4();
    let quoted = wire::QuoteBody {
        quote_id: qid.to_string(),
        deployment_id: identity.deployment_id.clone(),
        pool: bs58::encode(identity.pool).into_string(),
        mode: wire::Mode::DirectOpenrouter,
        provider: Provider::Openrouter,
        models: vec!["*".into()],
        api: None,
        tariff_hash: hex::encode(hash),
        cap_micro_usdc: zkapi_solana_types::MicroUsdc::new(1000).unwrap(),
        issued_at: now.to_string(),
        expires_at: (now + 120).to_string(),
        session_ttl_seconds: "30".into(),
        max_concurrency: "1".into(),
        control_api_origin: "http://127.0.0.1:8788".into(),
        inference_api_origin: "http://127.0.0.1:8789".into(),
    };
    let quote_body = serde_jcs::to_vec(&quoted).unwrap();
    let q = QuoteRecord {
        quote_id: qid,
        quote_hash: wire::sha256(&quote_body),
        canonical_body: quote_body,
        signature: vec![3; 64],
        tariff_hash: hash,
        expires_at: now + 120,
    };
    ledger.store_quote(&q).await.unwrap();
    let id = Uuid::new_v4();
    let request = wire::SessionCreate {
        authorization: wire::Authorization {
            version: "1".into(),
            deployment_id: identity.deployment_id.clone(),
            pool: bs58::encode(identity.pool).into_string(),
            request_id: id.to_string(),
            quote_hash: hex::encode(q.quote_hash),
            mode: wire::Mode::DirectOpenrouter,
            control_secret_hash: hex::encode([4; 32]),
            proxy_secret_hash: None,
        },
        quote: wire::Quote {
            body: quoted,
            quote_hash: hex::encode(q.quote_hash),
            signature: String::new(),
        },
        public_inputs: [ark_bn254::Fr::from(0).into(); 12],
        proof: wire::Proof {
            backend: "groth16_bn254".into(),
            proof: "synthetic".into(),
        },
    };
    let transcript = serde_jcs::to_vec(&request).unwrap();
    let n = NewSession {
        request_id: id,
        nullifier: wire::sha256(id.as_bytes()),
        quote_id: q.quote_id,
        request_digest: wire::sha256(&transcript),
        request_transcript: transcript,
        control_secret_hash: [4; 32],
        proxy_secret_hash: None,
        mode: "direct_openrouter".into(),
        provider: "openrouter".into(),
        cap_micro: 1000,
        max_concurrency: 1,
    };
    ledger
        .reserve_session(&n, || async { Ok(()) })
        .await
        .unwrap();
    let cp = serde_json::to_value(Checkpoint {
        intent: IssueIntent {
            request_id: id,
            cap_micro: 1000,
            ttl_seconds: 30,
            requested_at: now as u64 - age,
        },
        reference: None,
        disabled_at: None,
        observation: None,
        usage: None,
        deleted: false,
        recovery: None,
    })
    .unwrap();
    ledger.save_direct_checkpoint(id, None, &cp).await.unwrap();
    let attempt = ledger
        .begin_direct_issuance(id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    ledger.claim_dispatch(&attempt).await.unwrap();
    ledger.mark_issuance_unknown(id).await.unwrap();
    if finish {
        ledger.finish_attempt(&attempt, [8; 32]).await.unwrap();
    }
    Fixture {
        ledger,
        admin,
        url,
        identity,
        id,
        cp,
        attempt,
    }
}
async fn approval(f: &mut Fixture) -> anyhow::Result<SignedApproval> {
    let tx = f
        .admin
        .build_transaction()
        .read_only(true)
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .start()
        .await?;
    let body = direct_waiver::prepare(&tx, f.identity.pool, f.id, 300, [9; 32]).await?;
    let result = SignedApproval::sign(body, &key())?;
    // Exercise the exact private file serialization and apply parser used by CLI.
    let file = tempfile::NamedTempFile::new()?;
    std::fs::write(file.path(), serde_jcs::to_vec(&result)?)?;
    let parsed = SignedApproval::from_canonical_bytes(&std::fs::read(file.path())?)?;
    tx.commit().await?;
    Ok(parsed)
}
async fn empty(f: &Fixture) {
    let row=f.admin.query_one("SELECT (SELECT count(*) FROM receipts),(SELECT count(*) FROM direct_unknown_waivers),(SELECT count(*) FROM settlements)",&[]).await.unwrap();
    assert_eq!(
        (
            row.get::<_, i64>(0),
            row.get::<_, i64>(1),
            row.get::<_, i64>(2)
        ),
        (0, 0, 0)
    );
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_waiver_preserves_unknown_evidence_and_is_idempotent_after_restart() {
    let mut f = fixture(1000, true).await;
    let original = f.ledger.direct_checkpoint(f.id).await.unwrap();
    let a = approval(&mut f).await.unwrap();
    let s = f
        .ledger
        .apply_direct_unknown_waiver(&a, &key())
        .await
        .unwrap();
    assert_eq!(s.state, "RECONCILING");
    assert_eq!(s.charged_nano, 0);
    assert_eq!(
        s.direct_waiver_evidence,
        Some(wire::hash(&a.approval_hash).unwrap())
    );
    assert!(s.provider_key_ref.is_none());
    assert!(s.activated_at.is_none());
    assert_eq!(f.ledger.direct_checkpoint(f.id).await.unwrap(), original);
    let receipts = f.ledger.receipts(f.id, None, 10).await.unwrap();
    assert_eq!(receipts.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&receipts[0].canonical_body).unwrap();
    assert_eq!(body["reason"], "waived_unknown");
    assert_eq!(body["evidence_kind"], "UNKNOWN_OPERATOR_LOSS");
    assert_eq!(body["charged_nano_usdc"], "0");
    for field in [
        "observed_nano_usdc",
        "operator_loss_nano_usdc",
        "provider_reported_usd",
        "provider_request_id",
    ] {
        assert!(body[field].is_null());
    }
    assert_eq!(body["provider_evidence_digest"], a.approval_hash);
    assert_eq!(
        f.ledger
            .dispatch_attempts_for_session(f.id)
            .await
            .unwrap()
            .len(),
        1
    );
    let tx = f.admin.transaction().await.unwrap();
    let verified = direct_waiver::load_and_verify(
        &tx,
        key().verifying_key().to_bytes(),
        f.identity.pool,
        f.id,
        wire::hash(&a.approval_hash).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(verified, a.body);
    tx.commit().await.unwrap();
    assert!(f
        .ledger
        .save_direct_checkpoint(f.id, original.as_ref(), &f.cp)
        .await
        .is_err());
    assert!(f
        .ledger
        .begin_direct_issuance(f.id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .is_err());
    assert!(f.ledger.claim_dispatch(&f.attempt).await.is_err());
    assert!(f
        .admin
        .execute(
            "UPDATE direct_unknown_waivers SET approval_body=$1",
            &[&b"changed".to_vec()]
        )
        .await
        .is_err());
    assert!(f
        .admin
        .execute(
            "UPDATE sessions SET direct_waiver_evidence=NULL WHERE request_id=$1",
            &[&f.id]
        )
        .await
        .is_err());
    assert!(f
        .admin
        .execute(
            "UPDATE sessions SET direct_stop_evidence=$1::bytea WHERE request_id=$2",
            &[&&[5u8; 32][..], &f.id]
        )
        .await
        .is_err());
    assert!(f.admin.execute("UPDATE outbox SET metadata=metadata || '{\"deleted\":true}'::jsonb WHERE event_type='DIRECT_RECOVERY_CHECKPOINT'",&[]).await.is_err());
    assert!(f.admin.execute("UPDATE dispatch_attempts SET fenced_at=clock_timestamp(),fence_evidence_digest=$1::bytea WHERE request_id=$2",&[&&[7u8;32][..],&f.id]).await.is_err());
    let reserved: i64 = f
        .admin
        .query_one(
            "SELECT count(*) FROM nullifier_reservations WHERE kind='AUTH'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(reserved, 1);
    let same = f
        .ledger
        .apply_direct_unknown_waiver(&a, &key())
        .await
        .unwrap();
    assert_eq!(same.state, "RECONCILING");
    let mut other = a.body.clone();
    other.review_evidence_sha256 = hex::encode([10; 32]);
    let other = SignedApproval::sign(other, &key()).unwrap();
    assert!(f
        .ledger
        .apply_direct_unknown_waiver(&other, &key())
        .await
        .is_err());
    drop(f.ledger);
    tokio::task::yield_now().await;
    let restarted = Ledger::connect(&f.url, &f.identity).await.unwrap();
    restarted
        .apply_direct_unknown_waiver(&a, &key())
        .await
        .unwrap();
    assert_eq!(restarted.receipts(f.id, None, 10).await.unwrap().len(), 1);
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_waiver_refuses_pending_lease_and_unquiesced_attempt() {
    let mut live = fixture(30, true).await;
    assert!(approval(&mut live)
        .await
        .unwrap_err()
        .to_string()
        .contains("expired"));
    empty(&live).await;
    let mut sending = fixture(1000, false).await;
    assert!(approval(&mut sending)
        .await
        .unwrap_err()
        .to_string()
        .contains("quiesced"));
    empty(&sending).await;
}
#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn direct_waiver_rejects_stale_changed_or_forged_approvals_atomically() {
    let mut f = fixture(3000, true).await;
    let good = approval(&mut f).await.unwrap();
    for field in [
        "request_digest",
        "checkpoint_hash",
        "attempts_hash",
        "manifest_hash",
        "pool",
    ] {
        let mut v = serde_json::to_value(&good.body).unwrap();
        v[field] = json!(hex::encode([55; 32]));
        let changed = SignedApproval::sign(serde_json::from_value(v).unwrap(), &key()).unwrap();
        assert!(
            f.ledger
                .apply_direct_unknown_waiver(&changed, &key())
                .await
                .is_err(),
            "{field}"
        );
        empty(&f).await;
    }
    let mut stale = good.body.clone();
    stale.approved_at -= 901;
    let stale = SignedApproval::sign(stale, &key()).unwrap();
    assert!(f
        .ledger
        .apply_direct_unknown_waiver(&stale, &key())
        .await
        .is_err());
    empty(&f).await;
    let forged =
        SignedApproval::sign(good.body.clone(), &SigningKey::from_bytes(&[54; 32])).unwrap();
    assert!(f
        .ledger
        .apply_direct_unknown_waiver(&forged, &key())
        .await
        .is_err());
    empty(&f).await;
    let mut future = good.body.clone();
    future.approved_at += 60;
    let future = SignedApproval::sign(future, &key()).unwrap();
    assert!(f
        .ledger
        .apply_direct_unknown_waiver(&future, &key())
        .await
        .is_err());
    empty(&f).await;
    f.ledger
        .apply_direct_unknown_waiver(&good, &key())
        .await
        .unwrap();
}
