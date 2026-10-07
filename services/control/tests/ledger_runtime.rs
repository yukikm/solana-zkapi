//! Real PostgreSQL acceptance tests. Run with ZKAPI_TEST_DATABASE_URL and --ignored.
//! Cryptographic proof and actual sender-process tests are separate integration suites.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    ledger::*,
    receipts::{Receipt, ReceiptBody, UsageUnit},
    wire::{Provider, Rate, Tariff},
};

fn digest(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}
fn receipt_key() -> SigningKey {
    SigningKey::from_bytes(&[31; 32])
}
async fn client(url: &str) -> Client {
    let (c, conn) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}
async fn database() -> (String, Client) {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")
        .expect("set ZKAPI_TEST_DATABASE_URL to an isolated PostgreSQL admin connection");
    let admin = client(&base).await;
    let name = format!("zkapi_ledger_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let mut config: tokio_postgres::Config = base.parse().unwrap();
    config.dbname(&name);
    let url = format!(
        "host={} port={} user={} dbname={name}",
        match config.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(s) => s.clone(),
            tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
        },
        config.get_ports().first().copied().unwrap_or(5432),
        config.get_user().unwrap()
    );
    migrate(&url).await.unwrap();
    migrate(&url).await.unwrap();
    let c = client(&url).await;
    (url, c)
}
fn identity() -> PoolIdentity {
    PoolIdentity {
        pool: [1; 32],
        deployment_id: format!("i05-ledger-{}", Uuid::new_v4()),
        manifest_hash: [2; 32],
        authorization_config: json!({"signer":{"receipt_key":receipt_key().verifying_key().to_bytes()}}),
    }
}
async fn runtime_writer_url(url: &str, c: &Client) -> String {
    let role = format!("ledger_runtime_{}", Uuid::new_v4().simple());
    c.batch_execute(&format!(
        "CREATE ROLE {role} LOGIN; GRANT zkapi_control_writer TO {role}"
    ))
    .await
    .unwrap();
    let mut config: tokio_postgres::Config = url.parse().unwrap();
    config.user(&role);
    format!(
        "host={} port={} user={role} dbname={}",
        match config.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(s) => s.clone(),
            tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
        },
        config.get_ports().first().copied().unwrap_or(5432),
        config.get_dbname().unwrap()
    )
}
async fn tariff(ledger: &Ledger) -> Hash {
    let mut t = Tariff {
        tariff_hash: "".into(),
        version: "1".into(),
        provider: Provider::Openai,
        model: "i05-local-only".into(),
        pricing_basis: "fixed_usage_rates".into(),
        valid_from: "0".into(),
        valid_until: "4102444800".into(),
        rates: vec![
            Rate {
                unit: "input_tokens".into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "1".into(),
            },
            Rate {
                unit: "output_tokens".into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "1".into(),
            },
        ],
        operator_fee_micro_usdc: "0".into(),
    };
    t.tariff_hash = zkapi_control::quote::tariff_hash(&t).unwrap();
    let body = serde_jcs::to_vec(&zkapi_control::quote::tariff_body(&t).unwrap()).unwrap();
    let hash = digest(&body);
    ledger.store_tariff(hash, &body).await.unwrap();
    hash
}
async fn quote(ledger: &Ledger, tariff: Hash, expires: i64) -> QuoteRecord {
    let id = Uuid::new_v4();
    let body = serde_json::to_vec(&json!({"quote_id":id,"models":["i05-local-only"]})).unwrap();
    let q = QuoteRecord {
        quote_id: id,
        quote_hash: digest(&body),
        canonical_body: body,
        signature: vec![3; 64],
        tariff_hash: tariff,
        expires_at: expires,
    };
    ledger.store_quote(&q).await.unwrap();
    q
}
fn new_session(q: &QuoteRecord, n: Hash) -> NewSession {
    let id = Uuid::new_v4();
    let transcript = serde_json::to_vec(
        &json!({"request_id":id,"nullifier":hex::encode(n),"proof":"runtime-ledger-only"}),
    )
    .unwrap();
    NewSession {
        request_id: id,
        nullifier: n,
        quote_id: q.quote_id,
        request_digest: digest(&transcript),
        request_transcript: transcript,
        control_secret_hash: [4; 32],
        proxy_secret_hash: Some([5; 32]),
        mode: "proxy".into(),
        provider: "openai".into(),
        cap_micro: 1_000_000,
        max_concurrency: 4,
    }
}
async fn now(c: &Client) -> i64 {
    c.query_one(
        "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
        &[],
    )
    .await
    .unwrap()
    .get(0)
}
async fn wait_for_database_expiry(c: &Client, expires_at: i64) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while now(c).await < expires_at {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("database clock did not reach the immutable test expiry");
}
async fn active(ledger: &Ledger, c: &Client, tariff: Hash, n: Hash) -> NewSession {
    let q = quote(ledger, tariff, now(c).await + 120).await;
    let n = new_session(&q, n);
    ledger
        .reserve_session(&n, || async { Ok(()) })
        .await
        .unwrap();
    ledger
        .activate_proxy(n.request_id, 60, || async { Ok(()) })
        .await
        .unwrap();
    n
}
fn operation(id: Uuid, reservation: u128) -> NewOperation {
    NewOperation {
        request_id: id,
        operation_id: Uuid::new_v4(),
        request_hmac: [8; 32],
        endpoint: "/v1/chat/completions".into(),
        model: "i05-local-only".into(),
        reservation_nano: reservation,
    }
}
fn receipt(
    pool: Hash,
    deployment: &str,
    tariff: Hash,
    op: &NewOperation,
    observed: Option<u128>,
    charge: u128,
    reason: &str,
) -> ReceiptRecord {
    let receipt_id = Uuid::new_v4();
    let body = ReceiptBody {
        version: "1".into(),
        receipt_id: receipt_id.to_string(),
        deployment_id: deployment.into(),
        pool: bs58::encode(pool).into_string(),
        request_id: op.request_id.to_string(),
        operation_id: Some(op.operation_id.to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1".into(),
        evidence_kind: match reason {
            "metered" => "PROXY_USAGE",
            "not_dispatched" => "NOT_DISPATCHED",
            _ => "UNKNOWN_OPERATOR_LOSS",
        }
        .into(),
        provider_request_id: None,
        provider_evidence_digest: None,
        tariff_hash: hex::encode(tariff),
        usage: if reason == "metered" {
            vec![
                UsageUnit {
                    unit: "input_tokens".into(),
                    count: observed.unwrap().to_string(),
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
        observed_nano_usdc: observed.map(|n| n.to_string()),
        charged_nano_usdc: charge.to_string(),
        operator_loss_nano_usdc: observed.map(|n| (n - charge).to_string()),
        reason: reason.into(),
    };
    let receipt = Receipt::sign(body, &receipt_key()).unwrap();
    ReceiptRecord {
        sequence: 0,
        receipt_id,
        request_id: op.request_id,
        operation_id: Some(op.operation_id),
        billing_effect: "charge".into(),
        canonical_body: receipt.body.canonical_bytes().unwrap(),
        receipt_hash: hex::decode(receipt.receipt_hash)
            .unwrap()
            .try_into()
            .unwrap(),
        signature: Some(STANDARD.decode(receipt.signature).unwrap()),
    }
}
fn target(charge: u64) -> SettlementTarget {
    let message = [11; 32];
    SettlementTarget {
        charge_micro: charge,
        next_anchor: [12; 32],
        next_commitment_x: [13; 32],
        next_commitment_y: [14; 32],
        blind_delta: [15; 32],
        anchor_randomness: [16; 32],
        signature_message: message,
        message_digest: digest(&message),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated real PostgreSQL; run scripts/run_i05.sh"]
async fn postgres_ledger_financial_and_recovery_invariants() {
    let (url, c) = database().await;
    let identity = identity();
    let runtime_url = runtime_writer_url(&url, &c).await;
    let ledger = Arc::new(Ledger::connect(&runtime_url, &identity).await.unwrap());
    ledger.set_accepting(true).await.unwrap();
    let tariff = tariff(&ledger).await;
    assert!(matches!(
        Ledger::connect(&runtime_url, &identity).await,
        Err(LedgerError::Unavailable("writer_already_active"))
    ));
    // Runtime role has only read/insert/update, cannot erase history or change schema.
    let runtime = client(&runtime_url).await;
    for sql in [
        "DELETE FROM nullifier_reservations",
        "TRUNCATE sessions CASCADE",
        "ALTER TABLE sessions ADD COLUMN illicit text",
        "DROP TABLE sessions CASCADE",
        "CREATE TABLE illicit(id int)",
        "UPDATE control_migrations SET checksum=decode(repeat('00',32),'hex')",
    ] {
        assert!(
            runtime.batch_execute(sql).await.is_err(),
            "runtime accepted {sql}"
        );
    }
    // One hundred requests sharing an N result in precisely one permanent reservation.
    let q = quote(&ledger, tariff, now(&c).await + 120).await;
    let mut tasks = vec![];
    for _ in 0..100 {
        let n = new_session(&q, [20; 32]);
        let ledger = ledger.clone();
        tasks.push(tokio::spawn(async move {
            ledger.reserve_session(&n, || async { Ok(()) }).await
        }));
    }
    let mut accepted = vec![];
    for task in tasks {
        if let Ok(s) = task.await.unwrap() {
            accepted.push(s);
        }
    }
    assert_eq!(accepted.len(), 1);
    assert_eq!(
        c.query_one(
            "SELECT count(*) FROM nullifier_reservations WHERE pool=$1 AND nullifier=$2",
            &[&&identity.pool[..], &&[20u8; 32][..]]
        )
        .await
        .unwrap()
        .get::<_, i64>(0),
        1
    );
    let session = &accepted[0];
    let recover = NewSession {
        request_id: session.request_id,
        nullifier: session.nullifier,
        quote_id: session.quote_id,
        request_digest: session.request_digest,
        request_transcript: session.request_transcript.clone(),
        control_secret_hash: session.control_secret_hash,
        proxy_secret_hash: session.proxy_secret_hash,
        mode: session.mode.clone(),
        provider: session.provider.clone(),
        cap_micro: session.cap_micro,
        max_concurrency: session.max_concurrency,
    };
    assert_eq!(
        ledger
            .reserve_session(&recover, || async {
                panic!("accepted retry rechecked live chain")
            })
            .await
            .unwrap()
            .request_id,
        session.request_id
    );
    let mut changed = recover.clone();
    changed.request_transcript.push(b' ');
    changed.request_digest = digest(&changed.request_transcript);
    assert!(matches!(
        ledger.reserve_session(&changed, || async { Ok(()) }).await,
        Err(LedgerError::Conflict("idempotency_conflict"))
    ));
    assert!(matches!(
        ledger
            .reserve_clearance([20; 32], [21; 32], digest(&[21; 32]))
            .await,
        Err(LedgerError::Conflict("nullifier_reserved"))
    ));
    // AUTH versus CLEARANCE contends on the same writer/unique primary key.
    let q = quote(&ledger, tariff, now(&c).await + 120).await;
    let n = new_session(&q, [22; 32]);
    let a = ledger.clone();
    let b = ledger.clone();
    let (auth, clear) = tokio::join!(
        a.reserve_session(&n, || async { Ok(()) }),
        b.reserve_clearance([22; 32], [23; 32], digest(&[23; 32]))
    );
    assert_ne!(auth.is_ok(), clear.is_ok());
    // Quote already expired is rejected; a newly observed expiry after async checks is rejected too.
    let q = quote(&ledger, tariff, now(&c).await).await;
    assert!(matches!(
        ledger
            .reserve_session(&new_session(&q, [24; 32]), || async { Ok(()) })
            .await,
        Err(LedgerError::Conflict("quote_expired"))
    ));
    let q = quote(&ledger, tariff, now(&c).await + 1).await;
    assert!(matches!(
        ledger
            .reserve_session(&new_session(&q, [25; 32]), || async {
                tokio::time::sleep(Duration::from_millis(1100)).await;
                Ok(())
            })
            .await,
        Err(LedgerError::Conflict("quote_expired"))
    ));
    // DB row-lock wait uses clock_timestamp after acquiring the lock, not transaction start.
    let q = quote(&ledger, tariff, now(&c).await + 1).await;
    let n = new_session(&q, [26; 32]);
    let mut blocker = client(&url).await;
    let lock = blocker.transaction().await.unwrap();
    lock.query_one(
        "SELECT 1 FROM pools WHERE pool=$1 FOR UPDATE",
        &[&&identity.pool[..]],
    )
    .await
    .unwrap();
    let l = ledger.clone();
    let task = tokio::spawn(async move { l.reserve_session(&n, || async { Ok(()) }).await });
    tokio::time::sleep(Duration::from_millis(1100)).await;
    lock.commit().await.unwrap();
    assert!(matches!(
        task.await.unwrap(),
        Err(LedgerError::Conflict("quote_expired"))
    ));
    // Four concurrent integer reservations, fifth rejected; no float accounting.
    let s = active(&ledger, &c, tariff, [30; 32]).await;
    let mut ops = vec![];
    let mut tasks = vec![];
    for _ in 0..5 {
        let op = operation(s.request_id, 250_000_000);
        let l = ledger.clone();
        let copy = op.clone();
        ops.push(op);
        tasks.push(tokio::spawn(
            async move { l.reserve_operation(&copy).await },
        ));
    }
    let mut admitted = vec![];
    for (task, op) in tasks.into_iter().zip(ops) {
        match task.await.unwrap() {
            Ok(_) => admitted.push(op),
            Err(LedgerError::Conflict("concurrency_limit")) => (),
            other => panic!("unexpected admission {other:?}"),
        }
    }
    assert_eq!(admitted.len(), 4);
    let s1 = ledger.session(s.request_id).await.unwrap();
    assert_eq!(s1.reserved_nano, 1_000_000_000);
    assert_eq!(s1.active_operations, 4);
    // Complete first without dispatch, cap an overrun on second, refuse repeated sends/UNKNOWN replay.
    let op = &admitted[0];
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        op,
        Some(0),
        0,
        "not_dispatched",
    );
    ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::NotDispatched,
            &r,
        )
        .await
        .unwrap();
    let op = &admitted[1];
    let attempt = ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.claim_dispatch(&attempt).await.unwrap();
    assert!(ledger.claim_dispatch(&attempt).await.is_err());
    assert!(ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .is_err());
    ledger
        .mark_streaming(s.request_id, op.operation_id)
        .await
        .unwrap();
    ledger.finish_attempt(&attempt, [34; 32]).await.unwrap();
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        op,
        Some(250_000_101),
        250_000_000,
        "metered",
    );
    let metered = ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::Metered {
                observed_nano: 250_000_101,
            },
            &r,
        )
        .await
        .unwrap();
    assert_eq!(metered.operator_loss_nano, 101);
    let op = &admitted[2];
    let attempt = ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.claim_dispatch(&attempt).await.unwrap();
    ledger
        .mark_operation_unknown(s.request_id, op.operation_id)
        .await
        .unwrap();
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        op,
        None,
        0,
        "waived_unknown",
    );
    assert!(matches!(
        ledger
            .complete_operation(
                s.request_id,
                op.operation_id,
                OperationOutcome::UnknownWaived,
                &r
            )
            .await,
        Err(LedgerError::Conflict("dispatch_not_quiesced"))
    ));
    // This ledger-only test injects an already-observed fence fixture via migration credentials.
    // The HTTP process suite separately exercises the opaque real-stop evidence API.
    c.execute("UPDATE dispatch_attempts SET fenced_at=clock_timestamp(),fence_evidence_digest=$2::bytea WHERE attempt_id=$1",&[&attempt.attempt_id,&&[35u8;32][..]]).await.unwrap();
    assert!(ledger.claim_dispatch(&attempt).await.is_err());
    ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::UnknownWaived,
            &r,
        )
        .await
        .unwrap();
    // Bad Ed25519 receipt fails atomically, preserving its reservation and state.
    let op = &admitted[3];
    let mut r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        op,
        Some(0),
        0,
        "not_dispatched",
    );
    r.signature = Some(vec![0; 64]);
    assert!(ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::NotDispatched,
            &r
        )
        .await
        .is_err());
    assert_eq!(
        ledger
            .operation(s.request_id, op.operation_id)
            .await
            .unwrap()
            .state,
        "RESERVED"
    );
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        op,
        Some(0),
        0,
        "not_dispatched",
    );
    ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::NotDispatched,
            &r,
        )
        .await
        .unwrap();
    ledger.close(s.request_id).await.unwrap();
    ledger.reconcile(s.request_id).await.unwrap();
    let frozen = target(250_000);
    ledger
        .prepare_settlement(s.request_id, &frozen)
        .await
        .unwrap();
    assert_eq!(
        ledger.session(s.request_id).await.unwrap().state,
        "SIGN_PENDING"
    );
    assert!(ledger
        .prepare_settlement(s.request_id, &target(250_001))
        .await
        .is_err());
    ledger
        .save_settlement_signature(s.request_id, &[36; 96])
        .await
        .unwrap();
    ledger
        .save_settlement_signature(s.request_id, &[36; 96])
        .await
        .unwrap();
    assert!(ledger
        .save_settlement_signature(s.request_id, &[37; 96])
        .await
        .is_err());
    assert_eq!(ledger.session(s.request_id).await.unwrap().state, "SETTLED");
    let receipts = ledger.receipts(s.request_id, None, 100).await.unwrap();
    assert_eq!(receipts.len(), 4);
    assert!(receipts.iter().all(|r| r.signature.is_some()));
    assert_eq!(
        ledger
            .receipts(s.request_id, Some(receipts[0].sequence), 100)
            .await
            .unwrap()
            .len(),
        3
    );
    assert!(ledger
        .receipts(s.request_id, Some(i64::MAX), 100)
        .await
        .is_err());
    // Accepted identity, quote bytes, randomness, terminal charge, and reservations cannot be changed.
    for sql in [
 format!("UPDATE sessions SET request_transcript='changed'::bytea WHERE request_id='{}'",s.request_id),
 format!("UPDATE sessions SET cap_micro=cap_micro+1 WHERE request_id='{}'",s.request_id),
 format!("UPDATE operations SET charged_nano=0 WHERE request_id='{}' AND charged_nano>0",s.request_id),
 format!("UPDATE settlements SET anchor_randomness=decode(repeat('00',32),'hex') WHERE request_id='{}'",s.request_id),
 "UPDATE quotes SET canonical_body='changed'::bytea".into(),"UPDATE nullifier_reservations SET kind='CLEARANCE' WHERE kind='AUTH'".into(),
 ] {assert!(runtime.batch_execute(&sql).await.is_err(),"mutable: {sql}");}
    // 1 + 999 + 1 nano gets one rounding at session settlement: 1001 nano -> 2 micro.
    let s = active(&ledger, &c, tariff, [40; 32]).await;
    for nano in [1, 999, 1] {
        let op = operation(s.request_id, 1000);
        ledger.reserve_operation(&op).await.unwrap();
        let a = ledger
            .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
                Ok(())
            })
            .await
            .unwrap();
        ledger.claim_dispatch(&a).await.unwrap();
        ledger.finish_attempt(&a, [41; 32]).await.unwrap();
        let r = receipt(
            identity.pool,
            &identity.deployment_id,
            tariff,
            &op,
            Some(nano),
            nano,
            "metered",
        );
        ledger
            .complete_operation(
                s.request_id,
                op.operation_id,
                OperationOutcome::Metered {
                    observed_nano: nano,
                },
                &r,
            )
            .await
            .unwrap();
    }
    ledger.close(s.request_id).await.unwrap();
    ledger.reconcile(s.request_id).await.unwrap();
    assert!(ledger
        .prepare_settlement(s.request_id, &target(3))
        .await
        .is_err());
    ledger
        .prepare_settlement(s.request_id, &target(2))
        .await
        .unwrap();
    let abandoned = active(&ledger, &c, tariff, [45; 32]).await;
    let abandoned_op = operation(abandoned.request_id, 100);
    ledger.reserve_operation(&abandoned_op).await.unwrap();
    let abandoned_attempt = ledger
        .begin_dispatch(
            abandoned.request_id,
            abandoned_op.operation_id,
            Uuid::new_v4(),
            || async { Ok(()) },
        )
        .await
        .unwrap();
    ledger.claim_dispatch(&abandoned_attempt).await.unwrap();
    // Lost writer connection is a fail-stop; replacement holds a higher epoch and starts closed.
    let epoch = ledger.writer_epoch();
    c.query_one("SELECT pg_terminate_backend($1)", &[&ledger.backend_pid()])
        .await
        .unwrap();
    for _ in 0..20 {
        if !ledger.healthy() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!ledger.healthy());
    assert!(ledger.set_accepting(true).await.is_err());
    let replacement = Ledger::connect(&runtime_url, &identity).await.unwrap();
    assert_eq!(replacement.writer_epoch(), epoch + 1);
    assert!(replacement
        .store_quote(&quote_record(tariff, now(&c).await + 120))
        .await
        .is_err());
    assert_eq!(
        replacement.settlement(s.request_id).await.unwrap().target,
        target(2)
    );
    replacement.set_accepting(true).await.unwrap();
    assert_eq!(
        replacement
            .recover_abandoned_operations(abandoned.request_id)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        replacement
            .operation(abandoned.request_id, abandoned_op.operation_id)
            .await
            .unwrap()
            .state,
        "USAGE_UNKNOWN"
    );
    assert_eq!(
        replacement
            .session(abandoned.request_id)
            .await
            .unwrap()
            .reserved_nano,
        100
    );
    assert!(replacement
        .claim_dispatch(&abandoned_attempt)
        .await
        .is_err());
    let waiver = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        &abandoned_op,
        None,
        0,
        "waived_unknown",
    );
    assert!(matches!(
        replacement
            .complete_operation(
                abandoned.request_id,
                abandoned_op.operation_id,
                OperationOutcome::UnknownWaived,
                &waiver
            )
            .await,
        Err(LedgerError::Conflict("dispatch_not_quiesced"))
    ));

    assert_eq!(
        replacement
            .reserve_session(&recover, || async { panic!("recovery callback") })
            .await
            .unwrap()
            .request_id,
        recover.request_id
    );
    println!("PASS real PostgreSQL: runtime roles, checksummed migrations, 100 N contenders, AUTH/CLEARANCE, lock-time expiry, 4 slots/cap, no repeat dispatch, unfenced waiver rejection, signed receipts, integer rounding, immutable targets, writer backend death + recovery");
}
fn quote_record(tariff: Hash, expires: i64) -> QuoteRecord {
    let body = b"{}".to_vec();
    QuoteRecord {
        quote_id: Uuid::new_v4(),
        quote_hash: digest(&body),
        canonical_body: body,
        signature: vec![1; 64],
        tariff_hash: tariff,
        expires_at: expires,
    }
}

#[tokio::test]
#[ignore = "requires isolated real PostgreSQL; run scripts/run_i05.sh"]
async fn migrations_reject_unknown_versions_and_checksum_changes() {
    let (url, c) = database().await;
    let identity = identity();
    c.execute(
        "UPDATE control_migrations SET checksum=$1 WHERE version=2",
        &[&&[99u8; 32][..]],
    )
    .await
    .unwrap();
    assert!(matches!(
        migrate(&url).await,
        Err(LedgerError::MigrationMismatch)
    ));
    assert!(matches!(
        Ledger::connect(&url, &identity).await,
        Err(LedgerError::MigrationMismatch)
    ));
    c.execute("DELETE FROM control_migrations WHERE version=2", &[])
        .await
        .unwrap();
    c.execute(
        "INSERT INTO control_migrations(version,checksum) VALUES(99,$1)",
        &[&&[99u8; 32][..]],
    )
    .await
    .unwrap();
    assert!(matches!(
        migrate(&url).await,
        Err(LedgerError::MigrationMismatch)
    ));
    assert!(matches!(
        Ledger::connect(&url, &identity).await,
        Err(LedgerError::MigrationMismatch)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated real PostgreSQL; run scripts/run_i05.sh"]
async fn admission_expiry_cursor_and_direct_dispatch_contract() {
    let (url, c) = database().await;
    let identity = identity();
    let runtime_url = runtime_writer_url(&url, &c).await;
    let ledger = Arc::new(Ledger::connect(&runtime_url, &identity).await.unwrap());
    ledger.set_accepting(true).await.unwrap();
    let tariff = tariff(&ledger).await;
    // Recovery is based on accepted transcript, never current quote time or current root.
    // A one-second integer deadline can expire during setup near a clock boundary.
    let q = quote(&ledger, tariff, now(&c).await + 5).await;
    let accepted = new_session(&q, [51; 32]);
    ledger
        .reserve_session(&accepted, || async { Ok(()) })
        .await
        .unwrap();
    wait_for_database_expiry(&c, q.expires_at).await;
    assert_eq!(
        ledger
            .reserve_session(&accepted, || async {
                panic!("accepted expiry/root recheck")
            })
            .await
            .unwrap()
            .state,
        "RESERVED"
    );
    let mut alternate = accepted.clone();
    alternate.request_id = Uuid::new_v4();
    alternate.nullifier = [52; 32];
    alternate.request_transcript =
        serde_json::to_vec(&json!({"request_id":alternate.request_id})).unwrap();
    alternate.request_digest = digest(&alternate.request_transcript);
    assert!(ledger
        .reserve_session(&alternate, || async { Ok(()) })
        .await
        .is_err());
    // A lifetime ending during the final dispatch check leaves no attempt and can be zero-finalized.
    let q = quote(&ledger, tariff, now(&c).await + 120).await;
    let n = new_session(&q, [53; 32]);
    ledger
        .reserve_session(&n, || async { Ok(()) })
        .await
        .unwrap();
    let activated = ledger
        .activate_proxy(n.request_id, 5, || async { Ok(()) })
        .await
        .unwrap();
    let op = operation(n.request_id, 100);
    ledger.reserve_operation(&op).await.unwrap();
    let mut dispatch_check_entered = false;
    assert!(matches!(
        ledger
            .begin_dispatch(n.request_id, op.operation_id, Uuid::new_v4(), || async {
                dispatch_check_entered = true;
                wait_for_database_expiry(&c, activated.expires_at.unwrap()).await;
                Ok(())
            })
            .await,
        Err(LedgerError::Conflict("session_closed_or_expired"))
    ));
    assert!(
        dispatch_check_entered,
        "expiry must occur during the final check"
    );
    assert!(ledger
        .reserve_operation(&operation(n.request_id, 1))
        .await
        .is_err());
    assert_eq!(
        c.query_one(
            "SELECT count(*) FROM dispatch_attempts WHERE request_id=$1",
            &[&n.request_id]
        )
        .await
        .unwrap()
        .get::<_, i64>(0),
        0
    );
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        &op,
        Some(0),
        0,
        "not_dispatched",
    );
    ledger
        .complete_operation(
            n.request_id,
            op.operation_id,
            OperationOutcome::NotDispatched,
            &r,
        )
        .await
        .unwrap();
    // Admission behind a database lock sees a close committed while it waited.
    let s = active(&ledger, &c, tariff, [54; 32]).await;
    let mut blocker = client(&url).await;
    let tx = blocker.transaction().await.unwrap();
    tx.query_one(
        "SELECT 1 FROM pools WHERE pool=$1 FOR UPDATE",
        &[&&identity.pool[..]],
    )
    .await
    .unwrap();
    let copy = ledger.clone();
    let new_op = operation(s.request_id, 100);
    let pending = tokio::spawn(async move { copy.reserve_operation(&new_op).await });
    tokio::time::sleep(Duration::from_millis(40)).await;
    tx.execute(
        "UPDATE sessions SET close_requested=true,state='DRAINING' WHERE pool=$1 AND request_id=$2",
        &[&&identity.pool[..], &s.request_id],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(
        pending.await.unwrap(),
        Err(LedgerError::Conflict("session_closed_or_expired"))
    ));
    // A validly signed but arithmetically false observation must not change financial rows.
    let s = active(&ledger, &c, tariff, [55; 32]).await;
    let op = operation(s.request_id, 10_000);
    ledger.reserve_operation(&op).await.unwrap();
    let a = ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.claim_dispatch(&a).await.unwrap();
    ledger.finish_attempt(&a, [56; 32]).await.unwrap();
    let mut bad = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        &op,
        Some(100),
        100,
        "metered",
    );
    let mut body: ReceiptBody = serde_json::from_slice(&bad.canonical_body).unwrap();
    body.usage[0].count = "1".into();
    let signed = Receipt::sign(body, &receipt_key()).unwrap();
    bad.canonical_body = signed.body.canonical_bytes().unwrap();
    bad.receipt_hash = digest(&bad.canonical_body);
    bad.signature = Some(STANDARD.decode(signed.signature).unwrap());
    assert!(matches!(
        ledger
            .complete_operation(
                s.request_id,
                op.operation_id,
                OperationOutcome::Metered { observed_nano: 100 },
                &bad
            )
            .await,
        Err(LedgerError::Invalid("receipt_tariff_calculation_mismatch"))
    ));
    assert_eq!(
        ledger
            .operation(s.request_id, op.operation_id)
            .await
            .unwrap()
            .state,
        "DISPATCHING"
    );
    let r = receipt(
        identity.pool,
        &identity.deployment_id,
        tariff,
        &op,
        Some(1),
        1,
        "metered",
    );
    ledger
        .complete_operation(
            s.request_id,
            op.operation_id,
            OperationOutcome::Metered { observed_nano: 1 },
            &r,
        )
        .await
        .unwrap();
    let first = ledger.receipts(s.request_id, None, 100).await.unwrap()[0].sequence;
    // Simulate a persisted unsigned publication slot. A cursor may not jump over it.
    let unsigned = Uuid::new_v4();
    let unsigned_sequence:i64=c.query_one("INSERT INTO receipts(receipt_id,pool,request_id,operation_id,billing_effect,canonical_body,receipt_hash,signature) VALUES($1,$2::bytea,$3,$4,'late_loss_observation',$5,$6::bytea,NULL) RETURNING sequence",&[&unsigned,&&identity.pool[..],&s.request_id,&op.operation_id,&&b"{}"[..],&&[57u8;32][..]]).await.unwrap().get(0);
    let mut late: ReceiptBody = serde_json::from_slice(&r.canonical_body).unwrap();
    late.receipt_id = Uuid::new_v4().to_string();
    late.billing_effect = "late_loss_observation".into();
    late.related_receipt_hash = Some(hex::encode(r.receipt_hash));
    late.charged_nano_usdc = "0".into();
    late.operator_loss_nano_usdc = Some("1".into());
    late.reason = "late_usage".into();
    let signed = Receipt::sign(late, &receipt_key()).unwrap();
    let late = ReceiptRecord {
        sequence: 0,
        receipt_id: Uuid::parse_str(&signed.body.receipt_id).unwrap(),
        request_id: s.request_id,
        operation_id: Some(op.operation_id),
        billing_effect: "late_loss_observation".into(),
        canonical_body: signed.body.canonical_bytes().unwrap(),
        receipt_hash: hex::decode(&signed.receipt_hash)
            .unwrap()
            .try_into()
            .unwrap(),
        signature: Some(STANDARD.decode(signed.signature).unwrap()),
    };
    ledger.append_late_loss_receipt(&late).await.unwrap();
    let other = operation(s.request_id, 10_000);
    ledger.reserve_operation(&other).await.unwrap();
    let mut wrong_body: ReceiptBody = serde_json::from_slice(&late.canonical_body).unwrap();
    wrong_body.operation_id = Some(other.operation_id.to_string());
    wrong_body.receipt_id = Uuid::new_v4().to_string();
    let wrong_signed = Receipt::sign(wrong_body, &receipt_key()).unwrap();
    let mut wrong = late.clone();
    wrong.receipt_id = Uuid::parse_str(&wrong_signed.body.receipt_id).unwrap();
    wrong.operation_id = Some(other.operation_id);
    wrong.canonical_body = wrong_signed.body.canonical_bytes().unwrap();
    wrong.receipt_hash = digest(&wrong.canonical_body);
    wrong.signature = Some(STANDARD.decode(wrong_signed.signature).unwrap());
    assert!(matches!(
        ledger.append_late_loss_receipt(&wrong).await,
        Err(LedgerError::Invalid("invalid_late_receipt"))
    ));

    let last: i64 = c
        .query_one(
            "SELECT sequence FROM receipts WHERE receipt_id=$1",
            &[&late.receipt_id],
        )
        .await
        .unwrap()
        .get(0);
    assert!(last > unsigned_sequence);
    assert_eq!(
        ledger
            .receipts(s.request_id, None, 100)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(ledger
        .receipts(s.request_id, Some(first), 100)
        .await
        .unwrap()
        .is_empty());
    assert!(ledger
        .receipts(s.request_id, Some(last), 100)
        .await
        .is_err());
    assert!(ledger
        .receipts(s.request_id, Some(unsigned_sequence), 100)
        .await
        .is_err());
    assert!(ledger
        .receipts(n.request_id, Some(first), 100)
        .await
        .is_err());
    // Direct issuance is a persisted single attempt. Unknown and late success never reissue/reactivate.
    let mut t = Tariff {
        tariff_hash: "".into(),
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
    let direct_tariff = digest(&body);
    ledger.store_tariff(direct_tariff, &body).await.unwrap();
    let q = quote(&ledger, direct_tariff, now(&c).await + 120).await;
    let mut n = new_session(&q, [58; 32]);
    n.mode = "direct_openrouter".into();
    n.provider = "openrouter".into();
    n.proxy_secret_hash = None;
    ledger
        .reserve_session(&n, || async { Ok(()) })
        .await
        .unwrap();
    let a = ledger
        .begin_direct_issuance(n.request_id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    ledger.claim_dispatch(&a).await.unwrap();
    ledger.mark_issuance_unknown(n.request_id).await.unwrap();
    assert!(ledger
        .begin_direct_issuance(n.request_id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .is_err());
    ledger.finish_attempt(&a, [59; 32]).await.unwrap();
    assert_eq!(
        ledger
            .resolve_direct_key(
                n.request_id,
                "management-ref-only",
                60,
                (now(&c).await + 60) as u64,
                || async { panic!("late direct key cannot activate") }
            )
            .await
            .unwrap()
            .state,
        "DRAINING"
    );
    let receipt_id = Uuid::new_v4();
    let body = ReceiptBody {
        version: "1".into(),
        receipt_id: receipt_id.to_string(),
        deployment_id: identity.deployment_id.clone(),
        pool: bs58::encode(identity.pool).into_string(),
        request_id: n.request_id.to_string(),
        operation_id: None,
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1".into(),
        evidence_kind: "OPENROUTER_USAGE".into(),
        provider_request_id: Some("management-ref-only".into()),
        provider_evidence_digest: Some(hex::encode([60; 32])),
        tariff_hash: hex::encode(direct_tariff),
        usage: vec![],
        provider_reported_usd: Some("0.000000001".into()),
        reservation_nano_usdc: "1000000000".into(),
        observed_nano_usdc: Some("1".into()),
        charged_nano_usdc: "1".into(),
        operator_loss_nano_usdc: Some("0".into()),
        reason: "metered".into(),
    };
    let signed = Receipt::sign(body, &receipt_key()).unwrap();
    let r = ReceiptRecord {
        sequence: 0,
        receipt_id,
        request_id: n.request_id,
        operation_id: None,
        billing_effect: "charge".into(),
        canonical_body: signed.body.canonical_bytes().unwrap(),
        receipt_hash: hex::decode(signed.receipt_hash)
            .unwrap()
            .try_into()
            .unwrap(),
        signature: Some(STANDARD.decode(signed.signature).unwrap()),
    };
    assert!(matches!(
        ledger
            .complete_direct(
                n.request_id,
                DirectOutcome::ConfirmedNotIssued,
                [61; 32],
                &r
            )
            .await,
        Err(LedgerError::Conflict("issued_key_requires_final_usage"))
    ));
    ledger
        .complete_direct(
            n.request_id,
            DirectOutcome::Metered { observed_nano: 1 },
            [61; 32],
            &r,
        )
        .await
        .unwrap();
    ledger
        .prepare_settlement(n.request_id, &target(1))
        .await
        .unwrap();
    // Reconstructing a public attempt with another ACTIVE session must not bypass its closed owner.
    let sa = active(&ledger, &c, tariff, [70; 32]).await;
    let sb = active(&ledger, &c, tariff, [71; 32]).await;
    let op = operation(sa.request_id, 100);
    ledger.reserve_operation(&op).await.unwrap();
    let original = ledger
        .begin_dispatch(sa.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.close(sa.request_id).await.unwrap();
    let mut forged = original.clone();
    forged.request_id = sb.request_id;
    assert!(matches!(
        ledger.claim_dispatch(&forged).await,
        Err(LedgerError::Conflict("dispatch_not_replayable"))
    ));
    assert!(matches!(
        ledger.finish_attempt(&forged, [72; 32]).await,
        Err(LedgerError::Conflict("attempt_finished_or_fenced"))
    ));
    assert!(c.query_one("SELECT send_claimed_at IS NULL AND finished_at IS NULL FROM dispatch_attempts WHERE attempt_id=$1",&[&original.attempt_id]).await.unwrap().get::<_,bool>(0));
    println!("PASS real PostgreSQL: accepted-expired recovery, expiry during dispatch, close during row-lock wait, signed false pricing rejection, unsigned cursor gap, direct one-shot unknown/late-key drain and exact USD settlement contract (no live provider)");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL admin connection"]
async fn final_dispatch_claim_and_direct_reference_recovery() {
    let (url, c) = database().await;
    let identity = identity();
    let runtime_url = runtime_writer_url(&url, &c).await;
    let ledger = Ledger::connect(&runtime_url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    let tariff = tariff(&ledger).await;

    // An intent committed while healthy is not permission to send after admission stops.
    let s = active(&ledger, &c, tariff, [81; 32]).await;
    let op = operation(s.request_id, 100);
    ledger.reserve_operation(&op).await.unwrap();
    let paused_attempt = ledger
        .begin_dispatch(s.request_id, op.operation_id, Uuid::new_v4(), || async {
            Ok(())
        })
        .await
        .unwrap();
    ledger.set_accepting(false).await.unwrap();
    assert!(matches!(
        ledger.claim_dispatch(&paused_attempt).await,
        Err(LedgerError::Conflict("dispatch_owner_fenced"))
    ));
    ledger.set_accepting(true).await.unwrap();

    // A timeout/recovery decision can precede the sender's first claim. UNKNOWN
    // never grants a new external execution even when its session is still active.
    ledger
        .mark_operation_unknown(s.request_id, op.operation_id)
        .await
        .unwrap();
    assert!(matches!(
        ledger.claim_dispatch(&paused_attempt).await,
        Err(LedgerError::Conflict("dispatch_not_replayable"))
    ));
    assert!(c
        .query_one(
            "SELECT send_claimed_at IS NULL FROM dispatch_attempts WHERE attempt_id=$1",
            &[&paused_attempt.attempt_id],
        )
        .await
        .unwrap()
        .get::<_, bool>(0));

    let q = quote(&ledger, tariff, now(&c).await + 120).await;
    let mut direct = new_session(&q, [82; 32]);
    direct.mode = "direct_openrouter".into();
    direct.provider = "openrouter".into();
    direct.proxy_secret_hash = None;
    ledger
        .reserve_session(&direct, || async { Ok(()) })
        .await
        .unwrap();
    let direct_attempt = ledger
        .begin_direct_issuance(direct.request_id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    ledger.set_accepting(false).await.unwrap();
    assert!(matches!(
        ledger.claim_dispatch(&direct_attempt).await,
        Err(LedgerError::Conflict("dispatch_owner_fenced"))
    ));
    ledger.set_accepting(true).await.unwrap();
    ledger.claim_dispatch(&direct_attempt).await.unwrap();
    assert!(matches!(
        ledger
            .resolve_direct_key(
                direct.request_id,
                "failed-check-key-ref",
                60,
                (now(&c).await + 60) as u64,
                || async { Err(LedgerError::Unavailable("chain_unavailable")) }
            )
            .await,
        Err(LedgerError::Unavailable("chain_unavailable"))
    ));
    let closed = ledger.session(direct.request_id).await.unwrap();
    assert_eq!(closed.state, "DRAINING");
    assert!(closed.close_requested);
    assert_eq!(closed.activated_at, None);
    assert_eq!(
        c.query_one(
            "SELECT provider_key_ref FROM sessions WHERE request_id=$1",
            &[&direct.request_id],
        )
        .await
        .unwrap()
        .get::<_, String>(0),
        "failed-check-key-ref"
    );

    // Cancelling during the final RPC check must retain the only management
    // reference. Retrying that stored reference drains instead of activating.
    let q = quote(&ledger, tariff, now(&c).await + 120).await;
    let mut interrupted = new_session(&q, [83; 32]);
    interrupted.mode = "direct_openrouter".into();
    interrupted.provider = "openrouter".into();
    interrupted.proxy_secret_hash = None;
    ledger
        .reserve_session(&interrupted, || async { Ok(()) })
        .await
        .unwrap();
    let attempt = ledger
        .begin_direct_issuance(interrupted.request_id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    ledger.claim_dispatch(&attempt).await.unwrap();
    let writer = ledger.clone();
    let id = interrupted.request_id;
    let provider_expires_at = (now(&c).await + 60) as u64;
    let (checking, reached_check) = tokio::sync::oneshot::channel();
    let resolving = tokio::spawn(async move {
        writer
            .resolve_direct_key(
                id,
                "interrupted-key-ref",
                60,
                provider_expires_at,
                || async {
                    checking.send(()).unwrap();
                    std::future::pending::<Result<()>>().await
                },
            )
            .await
    });
    reached_check.await.unwrap();
    resolving.abort();
    assert!(resolving.await.unwrap_err().is_cancelled());
    assert_eq!(
        c.query_one(
            "SELECT provider_key_ref FROM sessions WHERE request_id=$1",
            &[&id],
        )
        .await
        .unwrap()
        .get::<_, String>(0),
        "interrupted-key-ref"
    );
    assert_eq!(ledger.session(id).await.unwrap().state, "ISSUING");
    assert!(matches!(
        ledger
            .resolve_direct_key(
                id,
                "replacement-key-ref",
                60,
                provider_expires_at,
                || async {
                    panic!("a different provider reference cannot replace the observed key")
                }
            )
            .await,
        Err(LedgerError::Conflict("direct_key_reference_conflict"))
    ));
    let recovered = ledger
        .resolve_direct_key(
            id,
            "interrupted-key-ref",
            60,
            provider_expires_at,
            || async { panic!("a recovered key cannot be activated or delivered") },
        )
        .await
        .unwrap();
    assert_eq!(recovered.state, "DRAINING");
    assert!(recovered.close_requested);
    assert_eq!(recovered.activated_at, None);
    println!("PASS real PostgreSQL: final claim rejects paused pool and UNKNOWN operation; issued key reference survives failed or cancelled final check and retries only drain");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL admin connection"]
async fn delayed_direct_activation_caps_expiry_and_drains_expired_keys() {
    let (url, c) = database().await;
    let identity = identity();
    let runtime_url = runtime_writer_url(&url, &c).await;
    let ledger = Ledger::connect(&runtime_url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    let tariff = tariff(&ledger).await;
    for (nullifier, provider_ttl) in [(84, 60), (85, 1)] {
        let q = quote(&ledger, tariff, now(&c).await + 120).await;
        let mut direct = new_session(&q, [nullifier; 32]);
        direct.mode = "direct_oa".into();
        direct.provider = "oa".into();
        direct.proxy_secret_hash = None;
        ledger
            .reserve_session(&direct, || async { Ok(()) })
            .await
            .unwrap();
        let attempt = ledger
            .begin_direct_issuance(direct.request_id, Uuid::new_v4(), || async { Ok(()) })
            .await
            .unwrap();
        ledger.claim_dispatch(&attempt).await.unwrap();
        let before_check = now(&c).await;
        let provider_expires_at = (before_check + provider_ttl) as u64;
        let resolved = ledger
            .resolve_direct_key(
                direct.request_id,
                "delayed-provider-key",
                provider_ttl,
                provider_expires_at,
                || async {
                    // At least one database-clock second passes after the TTL
                    // was computed, reproducing a slow final chain observation.
                    tokio::time::sleep(Duration::from_millis(1_100)).await;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(
            ledger
                .provider_key_ref(direct.request_id)
                .await
                .unwrap()
                .as_deref(),
            Some("delayed-provider-key")
        );
        if provider_ttl == 60 {
            assert_eq!(resolved.state, "ACTIVE");
            assert!(resolved.activated_at.unwrap() > before_check);
            assert_eq!(resolved.expires_at, Some(provider_expires_at as i64));
            assert!(resolved.expires_at.unwrap() > resolved.activated_at.unwrap());
        } else {
            assert_eq!(resolved.state, "DRAINING");
            assert!(resolved.close_requested);
            assert_eq!(resolved.activated_at, None);
            assert_eq!(resolved.expires_at, None);
        }
    }
}
