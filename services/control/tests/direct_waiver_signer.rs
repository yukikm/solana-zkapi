//! Real proof, isolated PostgreSQL and retained signer-journal acceptance.
//! No provider requests, runtime keys, funded notes, or wallet actions are used.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::json;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    direct::{Checkpoint, IssueIntent, RecoveryStatus},
    direct_waiver::{self, SignedApproval},
    ledger::{Ledger, NewSession, PoolIdentity, QuoteRecord, SettlementTarget},
    quote,
    receipts::{Receipt, ReceiptBody},
    signer::{self, PublicKey, SignTarget, Signer, SignerConfig},
    wire::{self, Mode, Provider, QuoteRequest, Tariff},
};
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
        let mut url = reqwest::Url::parse(base)?;
        url.set_path(&format!("/{name}"));
        Ok(url.to_string())
    } else {
        Ok(format!("{base} dbname={name}"))
    }
}
fn config() -> SignerConfig {
    let authorization = support::local_binding();
    SignerConfig {
        public_devnet_profile: None,
        pool: wire::pubkey(&authorization.pool).unwrap(),
        binding: *authorization.vault_binding.as_bytes(),
        authorization,
        state_key: PublicKey::from_wire(
            &CompactSigner::from_seed(&Felt252::from_u64(31)).public_key(),
        ),
        clearance_key: PublicKey::from_wire(
            &CompactSigner::from_seed(&Felt252::from_u64(37)).public_key(),
        ),
        receipt_key: SigningKey::from_bytes(&[83; 32]).verifying_key().to_bytes(),
    }
}
async fn open(config: &SignerConfig, url: &str, path: &std::path::Path) -> Result<Signer> {
    Signer::open(
        config.clone(),
        url,
        path,
        Felt252::from_u64(31).0,
        Felt252::from_u64(37).0,
    )
    .await
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL via ZKAPI_TEST_DATABASE_URL"]
async fn direct_unknown_waiver_is_bound_to_approval_and_signs_once_across_restart() -> Result<()> {
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
    let admin = connect(&base).await?;
    let name = format!("zkapi_signer_waiver_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await?;
    let url = db_url(&base, &name)?;
    zkapi_control::ledger::migrate(&url).await?;
    let mut db = connect(&url).await?;
    let config = config();
    let ledger = Ledger::connect(
        &url,
        &PoolIdentity {
            pool: config.pool,
            deployment_id: config.authorization.deployment_id.clone(),
            manifest_hash: [77; 32],
            authorization_config: json!({"signer": config}),
        },
    )
    .await?;
    ledger.set_accepting(true).await?;
    let mut tariff = Tariff {
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
    tariff.tariff_hash = quote::tariff_hash(&tariff)?;
    ledger
        .store_tariff(
            wire::hash(&tariff.tariff_hash)?,
            &serde_jcs::to_vec(&quote::tariff_body(&tariff)?)?,
        )
        .await?;
    let now: i64 = db
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint",
            &[],
        )
        .await?
        .get(0);
    let quoted = quote::issue_quote(
        &QuoteRequest {
            api: None,
            mode: Mode::DirectOpenrouter,
            provider: Provider::Openrouter,
            models: vec!["*".into()],
            session_ttl_seconds: Some("60".into()),
        },
        &tariff,
        &config.authorization,
        u64::try_from(now)?,
        &SigningKey::from_bytes(&[11; 32]),
    )?;
    let (mut authorization, token) = support::authorization(&quoted);
    authorization.mode = Mode::DirectOpenrouter;
    authorization.proxy_secret_hash = None;
    let request = support::bound_request(authorization, quoted.clone(), support::genesis_state());
    let accepted = quote::validate_binding(
        &request,
        &wire::parse_control_token(&token)?,
        &config.authorization,
    )?;
    let request_id = accepted.request_id;
    let quote_id = wire::uuid(&quoted.body.quote_id)?;
    ledger
        .store_quote(&QuoteRecord {
            quote_id,
            quote_hash: accepted.quote_hash,
            canonical_body: accepted.quote_body,
            signature: wire::base64_exact::<64>(&quoted.signature)?.to_vec(),
            tariff_hash: wire::hash(&tariff.tariff_hash)?,
            expires_at: i64::try_from(wire::uint(&quoted.body.expires_at)?)?,
        })
        .await?;
    ledger
        .reserve_session(
            &NewSession {
                request_id,
                nullifier: *accepted.nullifier.as_bytes(),
                quote_id,
                request_digest: accepted.digest,
                request_transcript: accepted.transcript,
                control_secret_hash: accepted.control_hash,
                proxy_secret_hash: None,
                mode: "direct_openrouter".into(),
                provider: "openrouter".into(),
                cap_micro: config.authorization.cap.get(),
                max_concurrency: 4,
            },
            || async { Ok(()) },
        )
        .await?;
    // Historical issuance clock is synthetic; eligibility does not establish
    // provider revocation, non-issuance, or observed zero usage.
    let checkpoint = serde_json::to_value(Checkpoint {
        intent: IssueIntent {
            request_id,
            cap_micro: config.authorization.cap.get(),
            ttl_seconds: 60,
            requested_at: (now - 600) as u64,
        },
        reference: None,
        disabled_at: None,
        observation: None,
        usage: None,
        deleted: false,
        recovery: Some(RecoveryStatus::unknown()),
    })?;
    ledger
        .save_direct_checkpoint(request_id, None, &checkpoint)
        .await?;
    let attempt = ledger
        .begin_direct_issuance(request_id, Uuid::new_v4(), || async { Ok(()) })
        .await?;
    ledger.claim_dispatch(&attempt).await?;
    ledger.mark_issuance_unknown(request_id).await?;
    ledger.finish_attempt(&attempt, [79; 32]).await?;
    ledger.close(request_id).await?;

    let receipt_key = SigningKey::from_bytes(&[83; 32]);
    let tx = db.build_transaction().read_only(true).start().await?;
    let approval = SignedApproval::sign(
        direct_waiver::prepare(&tx, config.pool, request_id, 300, [80; 32]).await?,
        &receipt_key,
    )?;
    tx.commit().await?;
    ledger
        .apply_direct_unknown_waiver(&approval, &receipt_key)
        .await
        .context("first apply direct waiver")?;
    ledger
        .apply_direct_unknown_waiver(&approval, &receipt_key)
        .await?;
    let original_receipt = ledger.receipts(request_id, None, 100).await?;
    assert_eq!(original_receipt.len(), 1);
    let original_body: ReceiptBody = wire::strict_parse(&original_receipt[0].canonical_body)?;
    assert_eq!(original_body.reason, "waived_unknown");
    assert!(original_body.observed_nano_usdc.is_none());
    assert!(original_body.provider_reported_usd.is_none());

    let draft = signer::prepare_settlement(
        config.binding,
        *accepted.nullifier.as_bytes(),
        *request.public_inputs[10].as_bytes(),
        *request.public_inputs[11].as_bytes(),
        0,
    )?;
    let settlement = SettlementTarget {
        charge_micro: draft.charge_micro,
        next_anchor: draft.next_anchor,
        next_commitment_x: draft.next_commitment_x,
        next_commitment_y: draft.next_commitment_y,
        blind_delta: draft.blind_delta,
        anchor_randomness: draft.anchor_randomness,
        signature_message: draft.signature_message,
        message_digest: draft.message_digest,
    };
    ledger.prepare_settlement(request_id, &settlement).await?;
    let dir = tempfile::tempdir()?;
    let journal = dir.path().join("journal");
    Signer::initialize_journal(&journal, &config)?;
    let initial_journal = std::fs::read(&journal)?;
    let mut signer = open(&config, &url, &journal).await?;
    let target = SignTarget::Settlement { request_id };

    // Simulate a privileged inconsistent restore. The signer must independently
    // reject it even when the database's normal immutable triggers are bypassed.
    db.batch_execute("SET session_replication_role=replica")
        .await?;
    for (mutation, restoration) in [
        (
            "direct_stop_evidence=decode(repeat('01',32),'hex')",
            "direct_stop_evidence=NULL".to_string(),
        ),
        (
            "provider_key_ref='unproven-key'",
            "provider_key_ref=NULL".to_string(),
        ),
        (
            "direct_waiver_evidence=NULL",
            format!(
                "direct_waiver_evidence=decode('{}','hex')",
                approval.approval_hash
            ),
        ),
        (
            "direct_waiver_evidence=NULL,direct_stop_evidence=decode(repeat('01',32),'hex')",
            format!(
                "direct_waiver_evidence=decode('{}','hex'),direct_stop_evidence=NULL",
                approval.approval_hash
            ),
        ),
        (
            "activated_at=1,expires_at=2",
            "activated_at=NULL,expires_at=NULL".to_string(),
        ),
    ] {
        db.execute(
            &format!("UPDATE sessions SET {mutation} WHERE request_id=$1"),
            &[&request_id],
        )
        .await?;
        assert!(
            signer.sign(target.clone()).await.is_err(),
            "accepted {mutation}"
        );
        assert_eq!(std::fs::read(&journal)?, initial_journal);
        db.execute(
            &format!("UPDATE sessions SET {restoration} WHERE request_id=$1"),
            &[&request_id],
        )
        .await?;
    }
    db.execute("UPDATE direct_unknown_waivers SET approval_signature=decode(repeat('00',64),'hex') WHERE request_id=$1", &[&request_id]).await?;
    assert!(signer.sign(target.clone()).await.is_err());
    db.execute(
        "UPDATE direct_unknown_waivers SET approval_signature=$2 WHERE request_id=$1",
        &[&request_id, &STANDARD.decode(&approval.signature)?],
    )
    .await?;
    let mut modified_checkpoint = checkpoint.clone();
    modified_checkpoint["intent"]["requested_at"] = json!(now - 601);
    db.execute("UPDATE outbox SET metadata=$2 WHERE event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$1", &[&request_id.to_string(), &modified_checkpoint]).await?;
    assert!(signer.sign(target.clone()).await.is_err());
    db.execute("UPDATE outbox SET metadata=$2 WHERE event_type='DIRECT_RECOVERY_CHECKPOINT' AND metadata->'intent'->>'request_id'=$1", &[&request_id.to_string(), &checkpoint]).await?;
    let finished: String = db
        .query_one(
            "SELECT finished_at::text FROM dispatch_attempts WHERE attempt_id=$1",
            &[&attempt.attempt_id],
        )
        .await?
        .get(0);
    db.execute("UPDATE dispatch_attempts SET finished_at=NULL,finish_evidence_digest=NULL WHERE attempt_id=$1", &[&attempt.attempt_id]).await?;
    assert!(signer.sign(target.clone()).await.is_err());
    db.execute("UPDATE dispatch_attempts SET finished_at=$2::text::timestamptz,finish_evidence_digest=$3::bytea WHERE attempt_id=$1", &[&attempt.attempt_id, &finished, &&[79u8;32][..]]).await?;
    let mut false_body = original_body.clone();
    false_body.provider_request_id = Some("invented-key-reference".into());
    let false_receipt = Receipt::sign(false_body, &receipt_key)?;
    replace_receipt(&db, request_id, &false_receipt).await?;
    assert!(signer.sign(target.clone()).await.is_err());
    replace_receipt(
        &db,
        request_id,
        &Receipt::sign(original_body.clone(), &receipt_key)?,
    )
    .await?;
    db.batch_execute("SET session_replication_role=origin")
        .await?;
    assert_eq!(std::fs::read(&journal)?, initial_journal);

    let signature = signer.sign(target.clone()).await?;
    signer::verify_signature(&config.state_key, draft.signature_message, &signature)?;
    assert_eq!(signer.sign(target.clone()).await?, signature);
    assert_ne!(std::fs::read(&journal)?, initial_journal);
    ledger
        .save_settlement_signature(request_id, &signature)
        .await?;
    drop(signer);
    let mut signer = open(&config, &url, &journal).await?;
    signer.reconcile().await?;
    assert_eq!(signer.sign(target.clone()).await?, signature);
    assert_eq!(
        ledger.settlement(request_id).await?.state_signature,
        Some(signature)
    );
    assert_eq!(ledger.session(request_id).await?.state, "SETTLED");
    assert_eq!(ledger.session(request_id).await?.charged_nano, 0);
    // A different, correctly signed approval with identical accounting cannot
    // replace the exact approval pinned before signing, including after restart.
    let mut alternative_body = approval.body.clone();
    alternative_body.review_evidence_sha256 = hex::encode([81; 32]);
    let alternative = SignedApproval::sign(alternative_body, &receipt_key)?;
    let mut alternative_receipt = original_body.clone();
    alternative_receipt.provider_evidence_digest = Some(alternative.approval_hash.clone());
    db.batch_execute("SET session_replication_role=replica")
        .await?;
    replace_approval(&db, request_id, &alternative).await?;
    replace_receipt(
        &db,
        request_id,
        &Receipt::sign(alternative_receipt, &receipt_key)?,
    )
    .await?;
    db.batch_execute("SET session_replication_role=origin")
        .await?;
    // Its signature and snapshot remain valid; only the journal's exact prior
    // approval binding makes this replacement unacceptable.
    let tx = db.build_transaction().read_only(true).start().await?;
    direct_waiver::load_and_verify(
        &tx,
        config.receipt_key,
        config.pool,
        request_id,
        wire::hash(&alternative.approval_hash)?,
    )
    .await?;
    tx.commit().await?;
    assert!(signer.sign(target.clone()).await.is_err());
    drop(signer);
    assert!(open(&config, &url, &journal).await.is_err());
    db.batch_execute("SET session_replication_role=replica")
        .await?;
    replace_approval(&db, request_id, &approval).await?;
    replace_receipt(
        &db,
        request_id,
        &Receipt::sign(original_body, &receipt_key)?,
    )
    .await?;
    db.batch_execute("SET session_replication_role=origin")
        .await?;
    let mut signer = open(&config, &url, &journal).await?;
    signer.reconcile().await?;
    assert!(signer.sign(target).await.is_ok());
    drop(signer);
    drop(ledger);
    drop(db);
    admin
        .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .await?;
    Ok(())
}

async fn replace_receipt(db: &Client, request_id: Uuid, receipt: &Receipt) -> Result<()> {
    db.execute(
        "UPDATE receipts SET canonical_body=$2,receipt_hash=$3::bytea,signature=$4 WHERE request_id=$1",
        &[
            &request_id,
            &receipt.body.canonical_bytes()?,
            &&wire::hash(&receipt.receipt_hash)?[..],
            &STANDARD.decode(&receipt.signature)?,
        ],
    )
    .await?;
    Ok(())
}
async fn replace_approval(db: &Client, request_id: Uuid, approval: &SignedApproval) -> Result<()> {
    let digest = wire::hash(&approval.approval_hash)?;
    db.execute("UPDATE direct_unknown_waivers SET approval_body=$2,approval_hash=$3::bytea,approval_signature=$4 WHERE request_id=$1", &[&request_id, &serde_jcs::to_vec(&approval.body)?, &&digest[..], &STANDARD.decode(&approval.signature)?]).await?;
    db.execute(
        "UPDATE sessions SET direct_waiver_evidence=$2::bytea WHERE request_id=$1",
        &[&request_id, &&digest[..]],
    )
    .await?;
    Ok(())
}
