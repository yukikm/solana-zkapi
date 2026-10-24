//! Real isolated PostgreSQL tests of prospective automatic operator-loss policy.
//! AUTH bytes are synthetic here; the signer suite separately verifies a real proof.
use ed25519_dalek::SigningKey;
use serde_json::json;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    direct::{Checkpoint, IssueIntent},
    direct_auto_waiver::AutoPolicy,
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
    policy: AutoPolicy,
}
async fn fixture(age: u64, finish: bool, prospective: bool) -> Fixture {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL").expect("isolated PostgreSQL required");
    let admin = client(&base).await;
    let name = format!("zkapi_auto_waiver_{}", Uuid::new_v4().simple());
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
    let policy = AutoPolicy {
        version: "1".into(),
        applies_to_sessions_created_at_or_after: u64::try_from(now).unwrap() + 2,
        grace_seconds: 300,
        accepts_all_unknown_provider_costs: true,
    };
    ledger
        .register_direct_auto_waiver_policy(&policy)
        .await
        .unwrap();
    if prospective {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
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
        policy,
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn automatic_policy_is_pinned_and_excludes_preexisting_sessions() {
    let f = fixture(1000, true, false).await;
    f.ledger
        .register_direct_auto_waiver_policy(&f.policy)
        .await
        .unwrap();
    let mut changed = f.policy.clone();
    changed.grace_seconds += 1;
    assert!(f
        .ledger
        .register_direct_auto_waiver_policy(&changed)
        .await
        .is_err());
    changed = f.policy.clone();
    changed.applies_to_sessions_created_at_or_after -= 1;
    assert!(f
        .ledger
        .register_direct_auto_waiver_policy(&changed)
        .await
        .is_err());
    f.ledger.close(f.id).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    assert_eq!(
        f.ledger.session(f.id).await.unwrap().state,
        "ISSUANCE_UNKNOWN"
    );
    assert!(f.ledger.receipts(f.id, None, 10).await.unwrap().is_empty());
    assert_eq!(f.ledger.direct_checkpoint(f.id).await.unwrap(), Some(f.cp));
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn automatic_waiver_requires_closed_stopped_expired_unknown_issuance() {
    let f = fixture(1000, false, true).await;
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    f.ledger.close(f.id).await.unwrap();
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    f.ledger.finish_attempt(&f.attempt, [8; 32]).await.unwrap();
    // The provider's longer drain policy cannot be shortened by automatic recovery.
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 2000, &key())
        .await
        .unwrap());
    assert!(f.ledger.receipts(f.id, None, 10).await.unwrap().is_empty());
    let young = fixture(0, true, true).await;
    young.ledger.close(young.id).await.unwrap();
    assert!(!young
        .ledger
        .try_auto_waive_direct(young.id, &young.policy, 0, &key())
        .await
        .unwrap());
    assert!(young
        .ledger
        .receipts(young.id, None, 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn automatic_waiver_keeps_unknown_cost_and_exact_policy_across_restart() {
    let f = fixture(1000, true, true).await;
    f.ledger.close(f.id).await.unwrap();
    let original = f.ledger.direct_checkpoint(f.id).await.unwrap();
    assert!(f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    let session = f.ledger.session(f.id).await.unwrap();
    assert_eq!(session.state, "RECONCILING");
    assert_eq!(session.charged_nano, 0);
    assert!(session.direct_waiver_evidence.is_some());
    let receipts = f.ledger.receipts(f.id, None, 10).await.unwrap();
    assert_eq!(receipts.len(), 1);
    let receipt: serde_json::Value = serde_json::from_slice(&receipts[0].canonical_body).unwrap();
    assert_eq!(receipt["reason"], "waived_unknown");
    assert_eq!(receipt["evidence_kind"], "UNKNOWN_OPERATOR_LOSS");
    for field in [
        "observed_nano_usdc",
        "operator_loss_nano_usdc",
        "provider_reported_usd",
    ] {
        assert!(receipt[field].is_null());
    }
    let row = f.admin.query_one("SELECT w.approval_body,o.metadata FROM direct_unknown_waivers w JOIN outbox o ON o.pool=w.pool AND o.metadata->>'approval_hash'=encode(w.approval_hash,'hex') WHERE w.request_id=$1 AND o.event_type='DIRECT_AUTO_WAIVER_APPLIED'", &[&f.id]).await.unwrap();
    let body: zkapi_control::direct_waiver::ApprovalBody =
        serde_json::from_slice(&row.get::<_, Vec<u8>>(0)).unwrap();
    let audit: serde_json::Value = row.get(1);
    assert_eq!(
        audit["registered_policy"]["policy"],
        serde_json::to_value(&f.policy).unwrap()
    );
    assert_eq!(
        body.review_evidence_sha256,
        hex::encode(wire::sha256(
            &serde_jcs::to_vec(&audit["registered_policy"]).unwrap()
        ))
    );
    assert_eq!(f.ledger.direct_checkpoint(f.id).await.unwrap(), original);
    let Fixture {
        ledger,
        admin,
        url,
        identity,
        id,
        policy,
        ..
    } = f;
    drop(ledger);
    let reopened = Ledger::connect(&url, &identity).await.unwrap();
    reopened
        .register_direct_auto_waiver_policy(&policy)
        .await
        .unwrap();
    assert!(!reopened
        .try_auto_waive_direct(id, &policy, 0, &key())
        .await
        .unwrap());
    assert_eq!(reopened.receipts(id, None, 10).await.unwrap().len(), 1);
    let count: i64 = admin
        .query_one(
            "SELECT count(*) FROM outbox WHERE event_type='DIRECT_AUTO_WAIVER_APPLIED'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL"]
async fn automatic_waiver_rejects_known_reference_and_backdated_first_registration() {
    let f = fixture(1000, true, true).await;
    f.ledger.close(f.id).await.unwrap();
    let mut checkpoint = f.cp.clone();
    checkpoint["reference"] = json!({"key_ref":"known-key", "expires_at":1, "station_id":null});
    f.ledger
        .save_direct_checkpoint(f.id, Some(&f.cp), &checkpoint)
        .await
        .unwrap();
    assert!(!f
        .ledger
        .try_auto_waive_direct(f.id, &f.policy, 0, &key())
        .await
        .unwrap());
    assert!(f.ledger.receipts(f.id, None, 10).await.unwrap().is_empty());
    // A separate pool has no existing policy. Backdating must fail, not enroll history.
    let identity = PoolIdentity {
        pool: [91; 32],
        deployment_id: "unregistered-auto-policy".into(),
        manifest_hash: [92; 32],
        authorization_config: json!({"signer":{"receipt_key":key().verifying_key().to_bytes()}}),
    };
    let other = Ledger::connect(&f.url, &identity).await.unwrap();
    let mut old_policy = f.policy.clone();
    old_policy.applies_to_sessions_created_at_or_after = 1;
    assert!(other
        .register_direct_auto_waiver_policy(&old_policy)
        .await
        .is_err());
}
