//! I06/I07 recovery and metadata invariants against real PostgreSQL.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    ledger::*,
    receipts::{Receipt, ReceiptBody},
    wire,
};

async fn client(url: &str) -> Client {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
async fn database() -> (String, Client, PoolIdentity, Ledger) {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")
        .expect("isolated PostgreSQL test database required");
    let admin = client(&base).await;
    let name = format!("zkapi_provider_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let config: tokio_postgres::Config = base.parse().unwrap();
    let url = format!(
        "host={} port={} user={} dbname={name}",
        match config.get_hosts().first().unwrap() {
            tokio_postgres::config::Host::Tcp(host) => host.clone(),
            tokio_postgres::config::Host::Unix(path) => path.display().to_string(),
        },
        config.get_ports().first().copied().unwrap_or(5432),
        config.get_user().unwrap()
    );
    migrate(&url).await.unwrap();
    let client = client(&url).await;
    let identity = PoolIdentity {
        pool: [1; 32],
        deployment_id: format!("provider-test-{name}"),
        manifest_hash: [2; 32],
        authorization_config: json!({"signer":{"receipt_key":SigningKey::from_bytes(&[31;32]).verifying_key().to_bytes()}}),
    };
    let ledger = Ledger::connect(&url, &identity).await.unwrap();
    ledger.set_accepting(true).await.unwrap();
    (url, client, identity, ledger)
}
fn tariff_bytes(provider: &str) -> Vec<u8> {
    serde_jcs::to_vec(&json!({"version":"1","provider":provider,"model":"provider-test","pricing_basis":"fixed_usage_rates","valid_from":"0","valid_until":"4000000000","operator_fee_micro_usdc":"0","rates":[{"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"1"},{"unit":"output_tokens","nano_usdc_numerator":"1","unit_denominator":"1"}]})).unwrap()
}
async fn session(ledger: &Ledger, provider: &str, mode: &str, marker: u8) -> NewSession {
    let body = tariff_bytes(provider);
    let tariff = wire::sha256(&body);
    ledger.store_tariff(tariff, &body).await.unwrap();
    let body = serde_json::to_vec(&json!({"quote_id":Uuid::new_v4(), "models":["provider-test"]}))
        .unwrap();
    let quote = QuoteRecord {
        quote_id: Uuid::new_v4(),
        quote_hash: wire::sha256(&body),
        canonical_body: body,
        signature: vec![0; 64],
        tariff_hash: tariff,
        expires_at: 4_000_000_000,
    };
    ledger.store_quote(&quote).await.unwrap();
    let id = Uuid::new_v4();
    let transcript = id.as_bytes().to_vec();
    let session = NewSession {
        request_id: id,
        nullifier: [marker; 32],
        quote_id: quote.quote_id,
        request_digest: wire::sha256(&transcript),
        request_transcript: transcript,
        control_secret_hash: [3; 32],
        proxy_secret_hash: (mode == "proxy").then_some([4; 32]),
        mode: mode.into(),
        provider: provider.into(),
        cap_micro: 1_000_000,
        max_concurrency: 4,
    };
    ledger
        .reserve_session(&session, || async { Ok(()) })
        .await
        .unwrap();
    session
}
fn operation(id: Uuid, endpoint: &str) -> NewOperation {
    NewOperation {
        request_id: id,
        operation_id: Uuid::new_v4(),
        request_hmac: [8; 32],
        endpoint: endpoint.into(),
        model: "provider-test".into(),
        reservation_nano: 0,
    }
}
fn undispatched_receipt(
    identity: &PoolIdentity,
    provider: &str,
    op: &NewOperation,
) -> ReceiptRecord {
    let id = Uuid::new_v4();
    let body = ReceiptBody {
        version: "1".into(),
        receipt_id: id.to_string(),
        deployment_id: identity.deployment_id.clone(),
        pool: bs58::encode(identity.pool).into_string(),
        request_id: op.request_id.to_string(),
        operation_id: Some(op.operation_id.to_string()),
        billing_effect: "charge".into(),
        related_receipt_hash: None,
        observed_at: "1".into(),
        evidence_kind: "NOT_DISPATCHED".into(),
        provider_request_id: None,
        provider_evidence_digest: None,
        tariff_hash: hex::encode(wire::sha256(&tariff_bytes(provider))),
        usage: vec![],
        provider_reported_usd: None,
        reservation_nano_usdc: "0".into(),
        observed_nano_usdc: Some("0".into()),
        charged_nano_usdc: "0".into(),
        operator_loss_nano_usdc: Some("0".into()),
        reason: "not_dispatched".into(),
    };
    let signed = Receipt::sign(body, &SigningKey::from_bytes(&[31; 32])).unwrap();
    ReceiptRecord {
        sequence: 0,
        receipt_id: id,
        request_id: op.request_id,
        operation_id: Some(op.operation_id),
        billing_effect: "charge".into(),
        canonical_body: signed.body.canonical_bytes().unwrap(),
        receipt_hash: wire::hash(&signed.receipt_hash).unwrap(),
        signature: Some(STANDARD.decode(signed.signature).unwrap()),
    }
}
fn checkpoint(id: Uuid) -> Value {
    json!({"intent":{"request_id":id,"cap_micro":1000000,"ttl_seconds":60,"requested_at":1},"reference":null,"disabled_at":null,"usage":null,"observation":null,"deleted":false})
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn direct_checkpoints_preserve_final_usage_and_reject_secret_or_mutation() {
    let (_, client, _, ledger) = database().await;
    let session = session(&ledger, "openrouter", "direct_openrouter", 7).await;
    let id = session.request_id;
    let original = checkpoint(id);
    ledger
        .save_direct_checkpoint(id, None, &original)
        .await
        .unwrap();
    let mut issued = original.clone();
    issued["reference"] = json!({"key_ref":"management-hash","expires_at":61,"station_id":null});
    ledger
        .save_direct_checkpoint(id, Some(&original), &issued)
        .await
        .unwrap();
    assert!(ledger
        .save_direct_checkpoint(id, Some(&original), &issued)
        .await
        .is_err());
    let mut stopped = issued.clone();
    stopped["disabled_at"] = 12.into();
    stopped["usage"] = json!({"provider_reported_usd":"0.0000000011","observed_nano":"2","evidence_kind":"OPENROUTER_USAGE","evidence_digest":"a".repeat(64),"key_ref":"management-hash"});
    ledger
        .save_direct_checkpoint(id, Some(&issued), &stopped)
        .await
        .unwrap();
    let mut deleted = stopped.clone();
    deleted["deleted"] = true.into();
    ledger
        .save_direct_checkpoint(id, Some(&stopped), &deleted)
        .await
        .unwrap();
    assert_eq!(
        ledger.direct_checkpoint(id).await.unwrap(),
        Some(deleted.clone())
    );
    assert!(ledger
        .save_direct_checkpoint(id, Some(&deleted), &stopped)
        .await
        .is_err());
    let mut changed = deleted.clone();
    changed["usage"]["observed_nano"] = "3".into();
    assert!(ledger
        .save_direct_checkpoint(id, Some(&deleted), &changed)
        .await
        .is_err());
    let mut changed = deleted.clone();
    changed["intent"]["requested_at"] = 2.into();
    assert!(ledger
        .save_direct_checkpoint(id, Some(&deleted), &changed)
        .await
        .is_err());
    let mut secret = deleted.clone();
    secret["runtime_key"] = "I06_SECRET_CANARY".into();
    assert!(ledger
        .save_direct_checkpoint(id, Some(&deleted), &secret)
        .await
        .is_err());
    let mut nested_secret = deleted.clone();
    nested_secret["reference"]["key"] = "I06_SECRET_CANARY".into();
    assert!(ledger
        .save_direct_checkpoint(id, Some(&deleted), &nested_secret)
        .await
        .is_err());
    let rows = client
        .query("SELECT metadata::text FROM outbox", &[])
        .await
        .unwrap();
    assert_eq!(rows.len(), 4);
    assert!(rows
        .iter()
        .all(|r| !r.get::<_, String>(0).contains("I06_SECRET_CANARY")));
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn restart_preserves_direct_and_proxy_sender_uncertainty_and_lookup_refs() {
    let (url, client, identity, old) = database().await;
    let direct = session(&old, "openrouter", "direct_openrouter", 8).await;
    let direct_attempt = old
        .begin_direct_issuance(direct.request_id, Uuid::new_v4(), || async { Ok(()) })
        .await
        .unwrap();
    old.claim_dispatch(&direct_attempt).await.unwrap();
    let proxy = session(&old, "openai", "proxy", 9).await;
    old.activate_proxy(proxy.request_id, 60, || async { Ok(()) })
        .await
        .unwrap();
    let operation = operation(proxy.request_id, "/v1/chat/completions");
    old.reserve_operation(&operation).await.unwrap();
    assert!(matches!(
        old.reserve_operation(&operation).await,
        Err(LedgerError::Conflict("operation_in_progress"))
    ));
    let proxy_attempt = old
        .begin_dispatch(
            proxy.request_id,
            operation.operation_id,
            Uuid::new_v4(),
            || async { Ok(()) },
        )
        .await
        .unwrap();
    old.claim_dispatch(&proxy_attempt).await.unwrap();
    old.record_provider_request(
        proxy.request_id,
        operation.operation_id,
        "provider-request-1",
    )
    .await
    .unwrap();
    assert!(old
        .record_provider_request(
            proxy.request_id,
            operation.operation_id,
            "provider-request-2"
        )
        .await
        .is_err());
    client
        .query_one("SELECT pg_terminate_backend($1)", &[&old.backend_pid()])
        .await
        .unwrap();
    let recovered = Ledger::connect(&url, &identity).await.unwrap();
    assert!(recovered
        .recover_abandoned_direct(direct.request_id)
        .await
        .unwrap());
    assert_eq!(
        recovered
            .recover_abandoned_operations(proxy.request_id)
            .await
            .unwrap(),
        1
    );
    let direct_state = recovered.session(direct.request_id).await.unwrap();
    assert_eq!(direct_state.state, "ISSUANCE_UNKNOWN");
    assert!(direct_state.close_requested);
    for id in [direct.request_id, proxy.request_id] {
        let records = recovered.dispatch_attempts_for_session(id).await.unwrap();
        assert_eq!(records.len(), 1);
        assert!(records[0].send_claimed);
        assert!(!records[0].quiesced());
        assert!(recovered.claim_dispatch(&records[0].attempt).await.is_err());
        assert!(matches!(
            recovered
                .finish_attempt(&records[0].attempt, wire::sha256(b"unverified old owner"))
                .await,
            Err(LedgerError::Conflict("dispatch_owner_fenced"))
        ));
        assert!(!recovered.dispatch_attempts_for_session(id).await.unwrap()[0].quiesced());
    }
    let operation = recovered
        .operation(proxy.request_id, operation.operation_id)
        .await
        .unwrap();
    assert_eq!(operation.state, "USAGE_UNKNOWN");
    assert_eq!(
        operation.provider_request_id.as_deref(),
        Some("provider-request-1")
    );
    assert_eq!(
        operation.reconcile_deadline.unwrap() - operation.dispatched_at.unwrap(),
        900
    );
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn count_tokens_is_free_bounded_and_duplicate_reservations_never_dispatch() {
    let (_, _, identity, ledger) = database().await;
    let session = session(&ledger, "anthropic", "proxy", 10).await;
    ledger
        .activate_proxy(session.request_id, 60, || async { Ok(()) })
        .await
        .unwrap();
    let mut paid = operation(session.request_id, "/v1/messages/count_tokens");
    paid.reservation_nano = 1;
    assert!(matches!(
        ledger.reserve_operation(&paid).await,
        Err(LedgerError::Invalid("count_tokens_must_be_free"))
    ));
    for _ in 0..16 {
        let operation = operation(session.request_id, "/v1/messages/count_tokens");
        ledger.reserve_operation(&operation).await.unwrap();
        assert!(matches!(
            ledger.reserve_operation(&operation).await,
            Err(LedgerError::Conflict("operation_in_progress"))
        ));
        let receipt = undispatched_receipt(&identity, "anthropic", &operation);
        ledger
            .complete_operation(
                session.request_id,
                operation.operation_id,
                OperationOutcome::NotDispatched,
                &receipt,
            )
            .await
            .unwrap();
    }
    assert!(matches!(
        ledger
            .reserve_operation(&operation(session.request_id, "/v1/messages/count_tokens"))
            .await,
        Err(LedgerError::Conflict("count_tokens_rate_limit"))
    ));
    let final_state = ledger.session(session.request_id).await.unwrap();
    assert_eq!(final_state.charged_nano, 0);
    assert_eq!(final_state.reserved_nano, 0);
    assert_eq!(final_state.active_operations, 0);
}
