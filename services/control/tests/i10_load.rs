//! Bounded local I10 concurrency/fault acceptance against the real PostgreSQL ledger.
//! Quotes, request proofs, chain checks, usage and saved Baby-JubJub signature bytes
//! are explicit fixtures. This does not exercise HTTP, providers, proof generation,
//! the independent signer, dispatcher egress or public-chain finality.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Barrier;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    ledger::*,
    operations::{capture, local_database, verify_restore},
    receipts::{Receipt, ReceiptBody, UsageUnit},
    wire::{Provider, Rate, Tariff},
};

const SESSIONS: usize = 12;
const ROUNDS: usize = 16;
const BURST: usize = 8;
const SLOTS: usize = 4;
const FAULT_SESSIONS: usize = 4;
const NULLIFIER_CONTENDERS: usize = 100;
const RESERVATION: u128 = 1000;
const CHARGE_PER_ROUND: u128 = 2001;
const MODEL: &str = "i10-ledger-fixture";

fn digest(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}
fn receipt_key() -> SigningKey {
    SigningKey::from_bytes(&[31; 32])
}
async fn client(url: &str) -> Client {
    let (client, connection) = tokio_postgres::connect(url, NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
fn connection_url(config: &tokio_postgres::Config, database: &str, user: &str) -> String {
    fn quoted(value: &str) -> String {
        format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
    }
    let host = match config.get_hosts().first().unwrap() {
        tokio_postgres::config::Host::Tcp(host) => host.clone(),
        tokio_postgres::config::Host::Unix(path) => path.display().to_string(),
    };
    format!(
        "host={} port={} user={} dbname={}",
        quoted(&host),
        config.get_ports().first().copied().unwrap_or(5432),
        quoted(user),
        quoted(database)
    )
}
async fn database() -> (String, Client) {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")
        .expect("use the isolated disposable PostgreSQL cluster from scripts/run_i10.py");
    local_database(&base).unwrap();
    let config: tokio_postgres::Config = base.parse().unwrap();
    assert!(
        config.get_password().is_none(),
        "requires disposable trust-auth cluster"
    );
    let admin = client(&base).await;
    let name = format!("zkapi_i10_load_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let url = connection_url(&config, &name, config.get_user().unwrap());
    migrate(&url).await.unwrap();
    migrate(&url).await.unwrap();
    let sql = client(&url).await;
    for setting in ["fsync", "full_page_writes", "synchronous_commit"] {
        let value: String = sql
            .query_one(&format!("SHOW {setting}"), &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(value, "on", "local durability setting {setting}");
    }
    let role = format!("i10_writer_{}", Uuid::new_v4().simple());
    sql.batch_execute(&format!(
        "CREATE ROLE {role} LOGIN; GRANT zkapi_control_writer TO {role}"
    ))
    .await
    .unwrap();
    (connection_url(&config, &name, &role), sql)
}
async fn tariff(ledger: &Ledger) -> Hash {
    let mut tariff = Tariff {
        tariff_hash: String::new(),
        version: "1".into(),
        provider: Provider::Openai,
        model: MODEL.into(),
        pricing_basis: "fixed_usage_rates".into(),
        valid_from: "0".into(),
        valid_until: "4102444800".into(),
        rates: ["input_tokens", "output_tokens"]
            .into_iter()
            .map(|unit| Rate {
                unit: unit.into(),
                nano_usdc_numerator: "1".into(),
                unit_denominator: "1".into(),
            })
            .collect(),
        operator_fee_micro_usdc: "0".into(),
    };
    tariff.tariff_hash = zkapi_control::quote::tariff_hash(&tariff).unwrap();
    let body = serde_jcs::to_vec(&zkapi_control::quote::tariff_body(&tariff).unwrap()).unwrap();
    let hash = digest(&body);
    ledger.store_tariff(hash, &body).await.unwrap();
    hash
}
async fn quote(ledger: &Ledger, tariff: Hash) -> QuoteRecord {
    let id = Uuid::new_v4();
    let body = serde_json::to_vec(&json!({"quote_id": id, "models": [MODEL]})).unwrap();
    let quote = QuoteRecord {
        quote_id: id,
        quote_hash: digest(&body),
        canonical_body: body,
        signature: vec![3; 64],
        tariff_hash: tariff,
        expires_at: 4_102_444_800,
    };
    ledger.store_quote(&quote).await.unwrap();
    quote
}
fn session(quote: &QuoteRecord, nullifier: Hash, cap_micro: u64) -> NewSession {
    let id = Uuid::new_v4();
    let transcript = serde_json::to_vec(&json!({
        "request_id": id, "nullifier": hex::encode(nullifier), "proof": "i10-ledger-only-fixture"
    }))
    .unwrap();
    NewSession {
        request_id: id,
        nullifier,
        quote_id: quote.quote_id,
        request_digest: digest(&transcript),
        request_transcript: transcript,
        control_secret_hash: [4; 32],
        proxy_secret_hash: Some([5; 32]),
        mode: "proxy".into(),
        provider: "openai".into(),
        cap_micro,
        max_concurrency: 4,
    }
}
async fn active(ledger: &Ledger, tariff: Hash, cap_micro: u64) -> NewSession {
    let quote = quote(ledger, tariff).await;
    let session = session(&quote, digest(Uuid::new_v4().as_bytes()), cap_micro);
    ledger
        .reserve_session(&session, || async { Ok(()) })
        .await
        .unwrap();
    ledger
        .activate_proxy(session.request_id, 300, || async { Ok(()) })
        .await
        .unwrap();
    session
}
fn operation(id: Uuid, reservation_nano: u128) -> NewOperation {
    NewOperation {
        request_id: id,
        operation_id: Uuid::new_v4(),
        request_hmac: [8; 32],
        endpoint: "/v1/chat/completions".into(),
        model: MODEL.into(),
        reservation_nano,
    }
}
fn receipt(
    identity: &PoolIdentity,
    tariff: Hash,
    op: &NewOperation,
    observed: Option<u128>,
) -> ReceiptRecord {
    let id = Uuid::new_v4();
    let charge = observed.unwrap_or(0).min(op.reservation_nano);
    let receipt = Receipt::sign(
        ReceiptBody {
            version: "1".into(),
            receipt_id: id.to_string(),
            deployment_id: identity.deployment_id.clone(),
            pool: bs58::encode(identity.pool).into_string(),
            request_id: op.request_id.to_string(),
            operation_id: Some(op.operation_id.to_string()),
            billing_effect: "charge".into(),
            related_receipt_hash: None,
            observed_at: "1".into(),
            evidence_kind: if observed.is_some() {
                "PROXY_USAGE"
            } else {
                "UNKNOWN_OPERATOR_LOSS"
            }
            .into(),
            provider_request_id: None,
            provider_evidence_digest: None,
            tariff_hash: hex::encode(tariff),
            usage: observed
                .map(|count| {
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
                })
                .unwrap_or_default(),
            provider_reported_usd: None,
            reservation_nano_usdc: op.reservation_nano.to_string(),
            observed_nano_usdc: observed.map(|n| n.to_string()),
            charged_nano_usdc: charge.to_string(),
            operator_loss_nano_usdc: observed.map(|n| (n - charge).to_string()),
            reason: if observed.is_some() {
                "metered"
            } else {
                "waived_unknown"
            }
            .into(),
        },
        &receipt_key(),
    )
    .unwrap();
    ReceiptRecord {
        sequence: 0,
        receipt_id: id,
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
fn target(id: Uuid, charge_micro: u64) -> SettlementTarget {
    let message = digest(id.as_bytes());
    SettlementTarget {
        charge_micro,
        next_anchor: [12; 32],
        next_commitment_x: [13; 32],
        next_commitment_y: [14; 32],
        blind_delta: [15; 32],
        anchor_randomness: [16; 32],
        signature_message: message,
        message_digest: digest(&message),
    }
}
fn micros(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_micros()).unwrap()
}
fn distribution(samples: &[u64]) -> Value {
    assert!(!samples.is_empty());
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    json!({
        "unit": "microseconds", "samples": samples, "sample_count": samples.len(),
        "percentile_method": "nearest_rank", "p50": sorted[(sorted.len() * 50).div_ceil(100) - 1],
        "p95": sorted[(sorted.len() * 95).div_ceil(100) - 1], "max": sorted.last().unwrap()
    })
}
async fn invariants(sql: &Client) -> BTreeMap<String, i64> {
    let queries = [
        ("session_cap_violations", "SELECT count(*) FROM sessions WHERE charged_nano+reserved_nano>cap_micro::numeric*1000"),
        ("session_concurrency_violations", "SELECT count(*) FROM sessions WHERE active_operations>max_concurrency OR active_operations>4 OR active_operations<0"),
        ("operation_charge_violations", "SELECT count(*) FROM operations WHERE charged_nano>reservation_nano OR charged_nano<0 OR (state='WAIVED_OPERATOR_LOSS' AND charged_nano<>0)"),
        ("aggregate_accounting_violations", "SELECT count(*) FROM sessions s WHERE s.charged_nano<>COALESCE((SELECT sum(charged_nano) FROM operations o WHERE o.pool=s.pool AND o.request_id=s.request_id),0) OR s.reserved_nano<>COALESCE((SELECT sum(reservation_nano) FROM operations o WHERE o.pool=s.pool AND o.request_id=s.request_id AND state NOT IN ('DONE','WAIVED_OPERATOR_LOSS')),0) OR s.active_operations<>(SELECT count(*) FROM operations o WHERE o.pool=s.pool AND o.request_id=s.request_id AND state NOT IN ('DONE','WAIVED_OPERATOR_LOSS'))"),
        ("terminal_receipt_count_violations", "SELECT count(*) FROM operations o WHERE state IN ('DONE','WAIVED_OPERATOR_LOSS') AND 1<>(SELECT count(*) FROM receipts r WHERE r.pool=o.pool AND r.request_id=o.request_id AND r.operation_id=o.operation_id AND billing_effect='charge')"),
        ("duplicate_dispatch_violations", "SELECT count(*) FROM (SELECT pool,request_id,operation_id FROM dispatch_attempts GROUP BY pool,request_id,operation_id HAVING count(*)>1) duplicates"),
        ("settlement_rounding_violations", "SELECT count(*) FROM settlements t JOIN sessions s USING(pool,request_id) WHERE t.charge_micro<>ceil(s.charged_nano/1000) OR t.charge_micro>s.cap_micro"),
        ("settled_unfenced_violations", "SELECT count(*) FROM sessions s WHERE state='SETTLED' AND EXISTS (SELECT 1 FROM dispatch_attempts d WHERE d.pool=s.pool AND d.request_id=s.request_id AND d.finished_at IS NULL AND d.fenced_at IS NULL)"),
    ];
    let mut counters = BTreeMap::new();
    for (name, query) in queries {
        let count: i64 = sql.query_one(query, &[]).await.unwrap().get(0);
        assert_eq!(count, 0, "{name}");
        counters.insert(name.into(), count);
    }
    counters
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires disposable PostgreSQL; run scripts/run_i10.py"]
async fn concurrent_ledger_load_and_writer_loss_preserve_financial_invariants() {
    let output =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/i10/load-results.json");
    std::fs::create_dir_all(output.parent().unwrap()).unwrap();
    match std::fs::remove_file(&output) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => panic!("remove old load report: {error}"),
    }
    let started = Instant::now();
    let (url, mut sql) = database().await;
    let identity = PoolIdentity {
        pool: [1; 32],
        deployment_id: format!("i10-local-load-{}", Uuid::new_v4()),
        manifest_hash: [2; 32],
        authorization_config: json!({"signer":{"receipt_key": receipt_key().verifying_key().to_bytes()}}),
    };
    let ledger = Arc::new(Ledger::connect(&url, &identity).await.unwrap());
    ledger.set_accepting(true).await.unwrap();
    let tariff = tariff(&ledger).await;
    assert!(matches!(
        Ledger::connect(&url, &identity).await,
        Err(LedgerError::Unavailable("writer_already_active"))
    ));
    let mut latencies: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
    let mut rejections: BTreeMap<&str, usize> = BTreeMap::new();

    // Distinct authorization IDs race for one permanent N, then the winning
    // authorization is retried concurrently without a second live-chain check.
    let race_quote = quote(&ledger, tariff).await;
    let nullifier = digest(b"i10-shared-nullifier");
    let barrier = Arc::new(Barrier::new(NULLIFIER_CONTENDERS + 1));
    let mut tasks = Vec::new();
    for _ in 0..NULLIFIER_CONTENDERS {
        let session = session(&race_quote, nullifier, 10);
        let (ledger, barrier) = (ledger.clone(), barrier.clone());
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let started = Instant::now();
            let result = ledger.reserve_session(&session, || async { Ok(()) }).await;
            (session, result, micros(started))
        }));
    }
    barrier.wait().await;
    let mut winner = None;
    for task in tasks {
        let (session, result, elapsed) = task.await.unwrap();
        latencies
            .entry("nullifier_reservation")
            .or_default()
            .push(elapsed);
        match result {
            Ok(_) => assert!(winner.replace(session).is_none()),
            Err(LedgerError::Conflict("nullifier_reserved")) => {
                *rejections.entry("nullifier_reserved").or_default() += 1
            }
            other => panic!("unexpected nullifier race: {other:?}"),
        }
    }
    let winner = winner.unwrap();
    assert_eq!(rejections["nullifier_reserved"], NULLIFIER_CONTENDERS - 1);
    let live_checks = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let (ledger, session, checks) = (ledger.clone(), winner.clone(), live_checks.clone());
        tasks.push(tokio::spawn(async move {
            let started = Instant::now();
            let saved = ledger
                .reserve_session(&session, || async {
                    checks.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap();
            assert_eq!(saved.request_id, session.request_id);
            micros(started)
        }));
    }
    for task in tasks {
        latencies
            .entry("session_idempotent_recovery")
            .or_default()
            .push(task.await.unwrap());
    }
    assert_eq!(live_checks.load(Ordering::SeqCst), 0);
    let mut changed = winner.clone();
    changed.request_transcript.push(b' ');
    changed.request_digest = digest(&changed.request_transcript);
    assert!(matches!(
        ledger.reserve_session(&changed, || async { Ok(()) }).await,
        Err(LedgerError::Conflict("idempotency_conflict"))
    ));
    assert!(matches!(
        ledger
            .reserve_clearance(nullifier, [21; 32], digest(&[21; 32]))
            .await,
        Err(LedgerError::Conflict("nullifier_reserved"))
    ));
    ledger
        .activate_proxy(winner.request_id, 300, || async { Ok(()) })
        .await
        .unwrap();

    // A single operation UUID has one admission and one attempt despite retries
    // racing at every boundary, including duplicate completion acknowledgements.
    let op = operation(winner.request_id, RESERVATION);
    let mut tasks = Vec::new();
    for _ in 0..32 {
        let (ledger, op) = (ledger.clone(), op.clone());
        tasks.push(tokio::spawn(
            async move { ledger.reserve_operation(&op).await },
        ));
    }
    let mut accepted = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => accepted += 1,
            Err(LedgerError::Conflict("operation_in_progress")) => {
                *rejections.entry("operation_in_progress").or_default() += 1
            }
            other => panic!("unexpected operation retry: {other:?}"),
        }
    }
    assert_eq!(accepted, 1);
    assert_eq!(rejections["operation_in_progress"], 31);
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (ledger, op) = (ledger.clone(), op.clone());
        tasks.push(tokio::spawn(async move {
            ledger
                .begin_dispatch(op.request_id, op.operation_id, Uuid::new_v4(), || async {
                    Ok(())
                })
                .await
        }));
    }
    let mut attempt = None;
    for task in tasks {
        match task.await.unwrap() {
            Ok(value) => assert!(attempt.replace(value).is_none()),
            Err(LedgerError::Conflict("dispatch_not_replayable")) => {
                *rejections.entry("dispatch_not_replayable").or_default() += 1
            }
            other => panic!("unexpected dispatch retry: {other:?}"),
        }
    }
    let attempt = attempt.unwrap();
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (ledger, attempt) = (ledger.clone(), attempt.clone());
        tasks.push(tokio::spawn(async move {
            ledger.claim_dispatch(&attempt).await
        }));
    }
    let mut claimed = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(()) => claimed += 1,
            Err(LedgerError::Conflict("dispatch_not_replayable")) => {
                *rejections.entry("duplicate_claim").or_default() += 1
            }
            other => panic!("unexpected claim retry: {other:?}"),
        }
    }
    assert_eq!(claimed, 1);
    ledger
        .finish_attempt(&attempt, digest(b"fixture-owner-finished"))
        .await
        .unwrap();
    let race_receipt = receipt(&identity, tariff, &op, Some(17));
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (ledger, op, receipt) = (ledger.clone(), op.clone(), race_receipt.clone());
        tasks.push(tokio::spawn(async move {
            ledger
                .complete_operation(
                    op.request_id,
                    op.operation_id,
                    OperationOutcome::Metered { observed_nano: 17 },
                    &receipt,
                )
                .await
        }));
    }
    let mut completed = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => completed += 1,
            Err(LedgerError::Conflict("operation_terminal")) => {
                *rejections.entry("operation_terminal").or_default() += 1
            }
            other => panic!("unexpected completion retry: {other:?}"),
        }
    }
    assert_eq!(completed, 1);
    assert_eq!(
        ledger
            .receipts(winner.request_id, None, 100)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut changed_op = op.clone();
    changed_op.request_hmac = [9; 32];
    assert!(matches!(
        ledger.reserve_operation(&changed_op).await,
        Err(LedgerError::Conflict("idempotency_conflict"))
    ));

    let cap_micro = (ROUNDS as u128 * CHARGE_PER_ROUND).div_ceil(1000) as u64 + 4;
    let mut sessions = Vec::new();
    for _ in 0..SESSIONS {
        sessions.push(active(&ledger, tariff, cap_micro).await);
    }
    let load_started = Instant::now();
    let mut invariant_snapshots = 0;
    let mut completed_operations = 0;
    for round in 0..ROUNDS {
        // With no active operation, budget exhaustion must reject independently
        // of the concurrency limit on every round, including accumulated charges.
        for session in &sessions {
            let saved = ledger.session(session.request_id).await.unwrap();
            let over = operation(
                session.request_id,
                u128::from(cap_micro) * 1000 - saved.charged_nano + 1,
            );
            assert!(matches!(
                ledger.reserve_operation(&over).await,
                Err(LedgerError::Conflict("budget_exhausted"))
            ));
            *rejections.entry("budget_exhausted").or_default() += 1;
        }
        let barrier = Arc::new(Barrier::new(SESSIONS * BURST + 1));
        let mut tasks = Vec::new();
        for session in &sessions {
            for _ in 0..BURST {
                let (ledger, barrier) = (ledger.clone(), barrier.clone());
                let op = operation(session.request_id, RESERVATION);
                tasks.push(tokio::spawn(async move {
                    barrier.wait().await;
                    let started = Instant::now();
                    let result = ledger.reserve_operation(&op).await;
                    (op, result, micros(started))
                }));
            }
        }
        barrier.wait().await;
        let mut admitted: BTreeMap<Uuid, Vec<NewOperation>> = BTreeMap::new();
        for task in tasks {
            let (op, result, elapsed) = task.await.unwrap();
            latencies
                .entry("operation_admission")
                .or_default()
                .push(elapsed);
            match result {
                Ok(_) => admitted.entry(op.request_id).or_default().push(op),
                Err(LedgerError::Conflict("concurrency_limit")) => {
                    *rejections.entry("concurrency_limit").or_default() += 1
                }
                other => panic!("unexpected burst admission: {other:?}"),
            }
        }
        assert_eq!(admitted.len(), SESSIONS);
        for session in &sessions {
            assert_eq!(admitted[&session.request_id].len(), SLOTS);
            let saved = ledger.session(session.request_id).await.unwrap();
            assert_eq!(saved.active_operations, SLOTS as i16);
            assert_eq!(saved.reserved_nano, RESERVATION * SLOTS as u128);
            assert_eq!(saved.charged_nano, round as u128 * CHARGE_PER_ROUND);
        }
        invariants(&sql).await;
        invariant_snapshots += 1;
        let mut tasks = Vec::new();
        for operations in admitted.into_values() {
            for (index, op) in operations.into_iter().enumerate() {
                let (ledger, identity) = (ledger.clone(), identity.clone());
                tasks.push(tokio::spawn(async move {
                    let started = Instant::now();
                    let attempt = ledger
                        .begin_dispatch(op.request_id, op.operation_id, Uuid::new_v4(), || async {
                            Ok(())
                        })
                        .await
                        .unwrap();
                    assert!(matches!(
                        ledger
                            .begin_dispatch(
                                op.request_id,
                                op.operation_id,
                                Uuid::new_v4(),
                                || async { Ok(()) }
                            )
                            .await,
                        Err(LedgerError::Conflict("dispatch_not_replayable"))
                    ));
                    ledger.claim_dispatch(&attempt).await.unwrap();
                    assert!(matches!(
                        ledger.claim_dispatch(&attempt).await,
                        Err(LedgerError::Conflict("dispatch_not_replayable"))
                    ));
                    ledger
                        .mark_streaming(op.request_id, op.operation_id)
                        .await
                        .unwrap();
                    ledger
                        .finish_attempt(&attempt, digest(op.operation_id.as_bytes()))
                        .await
                        .unwrap();
                    let observed = [1, 999, 1001, 1][index];
                    let receipt = receipt(&identity, tariff, &op, Some(observed));
                    let saved = ledger
                        .complete_operation(
                            op.request_id,
                            op.operation_id,
                            OperationOutcome::Metered {
                                observed_nano: observed,
                            },
                            &receipt,
                        )
                        .await
                        .unwrap();
                    assert_eq!(saved.charged_nano, observed.min(RESERVATION));
                    assert_eq!(
                        saved.operator_loss_nano,
                        observed.saturating_sub(RESERVATION)
                    );
                    assert!(matches!(
                        ledger
                            .complete_operation(
                                op.request_id,
                                op.operation_id,
                                OperationOutcome::Metered {
                                    observed_nano: observed
                                },
                                &receipt
                            )
                            .await,
                        Err(LedgerError::Conflict("operation_terminal"))
                    ));
                    assert!(matches!(
                        ledger.reserve_operation(&op).await,
                        Err(LedgerError::Conflict("response_not_replayable"))
                    ));
                    micros(started)
                }));
            }
        }
        for task in tasks {
            latencies
                .entry("dispatch_meter_complete_with_replay_checks")
                .or_default()
                .push(task.await.unwrap());
            completed_operations += 1;
        }
        for session in &sessions {
            let saved = ledger.session(session.request_id).await.unwrap();
            assert_eq!(saved.active_operations, 0);
            assert_eq!(saved.reserved_nano, 0);
            assert_eq!(saved.charged_nano, (round + 1) as u128 * CHARGE_PER_ROUND);
        }
        invariants(&sql).await;
        invariant_snapshots += 1;
    }
    let load_elapsed_us = micros(load_started);
    assert_eq!(completed_operations, SESSIONS * ROUNDS * SLOTS);
    assert_eq!(
        rejections["concurrency_limit"],
        SESSIONS * ROUNDS * (BURST - SLOTS)
    );
    assert_eq!(rejections["budget_exhausted"], SESSIONS * ROUNDS);
    *rejections.entry("dispatch_not_replayable").or_default() += completed_operations;
    *rejections.entry("duplicate_claim").or_default() += completed_operations;
    *rejections.entry("operation_terminal").or_default() += completed_operations;
    rejections.insert("response_not_replayable", completed_operations);

    // Same frozen target/signature retries converge. Conflicting bytes cannot
    // replace either, even after response loss. Signature bytes here are fixtures:
    // real Baby-JubJub signing and its independent journal are separate suites.
    sessions.push(winner.clone());
    let mut settlements = Vec::new();
    for session in &sessions {
        let started = Instant::now();
        let saved = ledger.session(session.request_id).await.unwrap();
        ledger.close(session.request_id).await.unwrap();
        ledger.reconcile(session.request_id).await.unwrap();
        let target = target(session.request_id, saved.charged_nano.div_ceil(1000) as u64);
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (ledger, target, id) = (ledger.clone(), target.clone(), session.request_id);
            tasks.push(tokio::spawn(async move {
                ledger.prepare_settlement(id, &target).await.unwrap()
            }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().target, target);
        }
        let mut conflicting = target.clone();
        conflicting.anchor_randomness[0] ^= 1;
        assert!(matches!(
            ledger
                .prepare_settlement(session.request_id, &conflicting)
                .await,
            Err(LedgerError::Conflict("settlement_target_conflict"))
        ));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (ledger, id) = (ledger.clone(), session.request_id);
            tasks.push(tokio::spawn(async move {
                ledger
                    .save_settlement_signature(id, &[36; 96])
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().state_signature, Some(vec![36; 96]));
        }
        assert!(matches!(
            ledger
                .save_settlement_signature(session.request_id, &[37; 96])
                .await,
            Err(LedgerError::Conflict("signature_conflict"))
        ));
        assert_eq!(
            ledger.session(session.request_id).await.unwrap().state,
            "SETTLED"
        );
        settlements.push((session.request_id, target));
        latencies
            .entry("settlement_with_concurrent_idempotent_recovery")
            .or_default()
            .push(micros(started));
    }
    invariants(&sql).await;
    invariant_snapshots += 1;

    // Actual writer connection loss leaves committed attempts unresolved. A new
    // writer begins closed; a newer epoch alone cannot finish/fence the old owner.
    let admission_quote = quote(&ledger, tariff).await;
    let admission = session(&admission_quote, digest(b"i10-closed-admission"), 10);
    let mut faults = Vec::new();
    for _ in 0..FAULT_SESSIONS {
        let session = active(&ledger, tariff, 10).await;
        let op = operation(session.request_id, RESERVATION);
        ledger.reserve_operation(&op).await.unwrap();
        let attempt = ledger
            .begin_dispatch(op.request_id, op.operation_id, Uuid::new_v4(), || async {
                Ok(())
            })
            .await
            .unwrap();
        ledger.claim_dispatch(&attempt).await.unwrap();
        ledger
            .mark_streaming(op.request_id, op.operation_id)
            .await
            .unwrap();
        faults.push((session, op, attempt));
    }
    let recovery_started = Instant::now();
    let old_epoch = ledger.writer_epoch();
    let killed: bool = sql
        .query_one("SELECT pg_terminate_backend($1)", &[&ledger.backend_pid()])
        .await
        .unwrap()
        .get(0);
    assert!(killed);
    for _ in 0..100 {
        if !ledger.healthy() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!ledger.healthy());
    assert!(ledger.set_accepting(true).await.is_err());
    let replacement = Ledger::connect(&url, &identity).await.unwrap();
    assert_eq!(replacement.writer_epoch(), old_epoch + 1);
    assert!(matches!(
        replacement
            .reserve_session(&admission, || async {
                panic!("closed admission reached chain")
            })
            .await,
        Err(LedgerError::Unavailable("pool_not_accepting"))
    ));
    let witness = capture(&mut sql, identity.pool).await.unwrap();
    let refused = verify_restore(&mut sql, &witness).await.err().unwrap();
    assert_eq!(
        refused.to_string(),
        "unfenced dispatcher prevents restore admission"
    );
    for (session, op, attempt) in &faults {
        assert!(matches!(
            replacement
                .reserve_operation(&operation(session.request_id, 1))
                .await,
            Err(LedgerError::Conflict("session_closed_or_expired"))
        ));
        assert!(ledger.claim_dispatch(attempt).await.is_err());
        assert!(ledger.finish_attempt(attempt, [40; 32]).await.is_err());
        assert!(matches!(
            replacement.claim_dispatch(attempt).await,
            Err(LedgerError::Conflict("dispatch_owner_fenced"))
        ));
        assert!(matches!(
            replacement.finish_attempt(attempt, [40; 32]).await,
            Err(LedgerError::Conflict("dispatch_owner_fenced"))
        ));
        assert_eq!(
            replacement
                .recover_abandoned_operations(session.request_id)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            replacement
                .recover_abandoned_operations(session.request_id)
                .await
                .unwrap(),
            0
        );
        assert!(matches!(
            replacement
                .begin_dispatch(op.request_id, op.operation_id, Uuid::new_v4(), || async {
                    Ok(())
                })
                .await,
            Err(LedgerError::Conflict("dispatch_not_replayable"))
        ));
        let waiver = receipt(&identity, tariff, op, None);
        assert!(matches!(
            replacement
                .complete_operation(
                    op.request_id,
                    op.operation_id,
                    OperationOutcome::UnknownWaived,
                    &waiver
                )
                .await,
            Err(LedgerError::Conflict("dispatch_not_quiesced"))
        ));
        replacement.close(session.request_id).await.unwrap();
        replacement.reconcile(session.request_id).await.unwrap();
        assert!(replacement
            .prepare_settlement(session.request_id, &target(session.request_id, 0))
            .await
            .is_err());
        assert!(matches!(
            replacement.settlement(session.request_id).await,
            Err(LedgerError::NotFound)
        ));
        let saved = replacement.session(session.request_id).await.unwrap();
        assert_eq!(
            (
                saved.reserved_nano,
                saved.charged_nano,
                saved.active_operations
            ),
            (RESERVATION, 0, 1)
        );
        assert_eq!(
            replacement
                .operation(op.request_id, op.operation_id)
                .await
                .unwrap()
                .state,
            "USAGE_UNKNOWN"
        );
        assert!(replacement
            .receipts(session.request_id, None, 100)
            .await
            .unwrap()
            .is_empty());
    }
    assert!(!replacement.provider_available("openai").await.unwrap());
    assert!(replacement
        .reset_provider_admission("openai", digest(b"cannot-reset-unresolved"))
        .await
        .is_err());
    for (id, target) in &settlements {
        let saved = replacement.settlement(*id).await.unwrap();
        assert_eq!(&saved.target, target);
        assert_eq!(saved.state_signature, Some(vec![36; 96]));
    }
    let recovery_elapsed_us = micros(recovery_started);
    let invariant_counters = invariants(&sql).await;
    invariant_snapshots += 1;
    let mut rows = BTreeMap::new();
    for table in [
        "sessions",
        "operations",
        "dispatch_attempts",
        "receipts",
        "settlements",
        "nullifier_reservations",
    ] {
        let count: i64 = sql
            .query_one(&format!("SELECT count(*) FROM {table}"), &[])
            .await
            .unwrap()
            .get(0);
        rows.insert(table, count);
    }
    assert_eq!(
        rows["operations"],
        (completed_operations + 1 + FAULT_SESSIONS) as i64
    );
    assert_eq!(rows["dispatch_attempts"], rows["operations"]);
    assert_eq!(rows["receipts"], (completed_operations + 1) as i64);
    assert_eq!(rows["settlements"], (SESSIONS + 1) as i64);
    assert_eq!(rows["sessions"], (SESSIONS + 1 + FAULT_SESSIONS) as i64);
    assert_eq!(rows["nullifier_reservations"], rows["sessions"]);
    let latencies: BTreeMap<_, _> = latencies
        .into_iter()
        .map(|(name, samples)| (name, distribution(&samples)))
        .collect();
    let report = json!({
        "version": 1, "passed": true, "scope": "local real PostgreSQL ledger concurrency and writer-connection-loss acceptance",
        "real_components": ["checksummed migrations", "least-privilege ledger writer", "integer accounting and immutable ledger settlement targets", "Ed25519 receipt validation", "PostgreSQL backend termination", "read-only restore admission gate"],
        "fixtures": ["authorization transcript/proof and quote signature", "chain live-check callbacks", "provider usage and owner terminal observation", "96-byte saved settlement signature (not a Baby-JubJub signing test)"],
        "unverified": ["HTTP/provider throughput", "real provider billing", "real proof/API authorization", "independent signer journal", "dispatcher process/egress fences", "public wallet/RPC", "cross-fault-domain or physical WAL failover", "production SLO and G1-G4"],
        "workload": {"sessions": SESSIONS, "rounds": ROUNDS, "contenders_per_session_round": BURST, "admitted_per_session_round": SLOTS, "concurrent_burst_contenders": SESSIONS * BURST, "unique_operation_contenders": SESSIONS * ROUNDS * BURST, "completed_metered_operations": completed_operations, "nullifier_contenders": NULLIFIER_CONTENDERS, "session_idempotent_retries": 32, "operation_idempotent_contenders": 32, "dispatch_contenders": 16, "claim_contenders": 16, "completion_contenders": 16, "per_settlement_identical_target_contenders": 8, "per_settlement_identical_signature_contenders": 8, "load_elapsed_us": load_elapsed_us, "cap_micro_usdc_per_load_session": cap_micro, "charged_nano_usdc_per_load_session": (ROUNDS as u128 * CHARGE_PER_ROUND).to_string(), "settled_micro_usdc_per_load_session": (ROUNDS as u128 * CHARGE_PER_ROUND).div_ceil(1000).to_string(), "operator_loss_nano_usdc_per_load_session": ROUNDS.to_string()},
        "latencies": latencies, "expected_rejections": rejections, "row_counts": rows,
        "invariant_snapshots": invariant_snapshots, "invariant_counters": invariant_counters,
        "faults": {"postgres_writer_backends_terminated": 1, "writer_epoch_before": old_epoch, "writer_epoch_after": replacement.writer_epoch(), "unresolved_attempts_retained": FAULT_SESSIONS, "unknown_reservation_nano_usdc_retained": (FAULT_SESSIONS as u128 * RESERVATION).to_string(), "old_owner_claims_refused": FAULT_SESSIONS, "old_owner_finishes_refused": FAULT_SESSIONS, "unfenced_waivers_refused": FAULT_SESSIONS, "unfenced_settlements_refused": FAULT_SESSIONS, "restore_admission_refused": true, "replacement_admission_stays_closed": true, "settlement_records_preserved": settlements.len(), "durable_provider_breaker_closed": true, "recovery_check_elapsed_us": recovery_elapsed_us},
        "elapsed_us": micros(started), "throughput_slo_asserted": false,
        "postgres_version": sql.query_one("SHOW server_version", &[]).await.unwrap().get::<_, String>(0),
        "durability": {"fsync": true, "full_page_writes": true, "synchronous_commit": "on", "synchronous_replica": false}
    });
    let temporary = output.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    std::fs::rename(temporary, &output).unwrap();
    println!("I10 load passed: {completed_operations} completed load operations, {} receipts, {} invariant snapshots; {}", rows["receipts"], invariant_snapshots, output.display());
}
