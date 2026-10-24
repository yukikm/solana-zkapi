//! Real request proof, PostgreSQL and independent signer checks for nonissuance.
//! Provider I/O is deliberately absent; dispatcher process boundaries are tested
//! separately by provider_http_runtime with loopback provider fixtures.
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::json;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use zkapi_control::{
    ledger::{
        DirectOutcome, DispatchAttempt, Ledger, LedgerError, NewSession, PoolIdentity, QuoteRecord,
        ReceiptRecord, SettlementTarget,
    },
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

struct Fixture {
    admin: Client,
    database: String,
    url: String,
    db: Client,
    ledger: Ledger,
    config: SignerConfig,
    request_id: Uuid,
    attempt: DispatchAttempt,
    receipt: ReceiptRecord,
    settlement: SettlementTarget,
}

impl Fixture {
    async fn new() -> Result<Self> {
        let base = std::env::var("ZKAPI_TEST_DATABASE_URL")?;
        let admin = connect(&base).await?;
        let database = format!("zkapi_unsent_{}", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE DATABASE {database}"))
            .await?;
        let url = if base.starts_with("postgres://") || base.starts_with("postgresql://") {
            let mut url = reqwest::Url::parse(&base)?;
            url.set_path(&format!("/{database}"));
            url.to_string()
        } else {
            format!("{base} dbname={database}")
        };
        zkapi_control::ledger::migrate(&url).await?;
        let db = connect(&url).await?;
        let authorization = support::local_binding();
        let receipt_key = SigningKey::from_bytes(&[83; 32]);
        let config = SignerConfig {
            public_devnet_profile: None,
            pool: wire::pubkey(&authorization.pool)?,
            binding: *authorization.vault_binding.as_bytes(),
            authorization,
            state_key: PublicKey::from_wire(
                &CompactSigner::from_seed(&Felt252::from_u64(31)).public_key(),
            ),
            clearance_key: PublicKey::from_wire(
                &CompactSigner::from_seed(&Felt252::from_u64(37)).public_key(),
            ),
            receipt_key: receipt_key.verifying_key().to_bytes(),
        };
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
            now as u64,
            &SigningKey::from_bytes(&[11; 32]),
        )?;
        let (mut authorization, token) = support::authorization(&quoted);
        authorization.mode = Mode::DirectOpenrouter;
        authorization.proxy_secret_hash = None;
        let request =
            support::bound_request(authorization, quoted.clone(), support::genesis_state());
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
        let attempt = ledger
            .begin_direct_issuance(request_id, Uuid::new_v4(), || async { Ok(()) })
            .await?;
        let receipt_id = Uuid::new_v4();
        let signed = Receipt::sign(
            ReceiptBody {
                gateway: None,
                version: "1".into(),
                receipt_id: receipt_id.to_string(),
                deployment_id: config.authorization.deployment_id.clone(),
                pool: config.authorization.pool.clone(),
                request_id: request_id.to_string(),
                operation_id: None,
                billing_effect: "charge".into(),
                related_receipt_hash: None,
                observed_at: now.to_string(),
                evidence_kind: "NOT_DISPATCHED".into(),
                provider_request_id: None,
                provider_evidence_digest: None,
                tariff_hash: tariff.tariff_hash,
                usage: vec![],
                provider_reported_usd: None,
                reservation_nano_usdc: config.authorization.cap.as_nano().to_string(),
                observed_nano_usdc: Some("0".into()),
                charged_nano_usdc: "0".into(),
                operator_loss_nano_usdc: Some("0".into()),
                reason: "not_dispatched".into(),
            },
            &receipt_key,
        )?;
        let receipt = ReceiptRecord {
            sequence: 0,
            receipt_id,
            request_id,
            operation_id: None,
            billing_effect: "charge".into(),
            canonical_body: signed.body.canonical_bytes()?,
            receipt_hash: wire::hash(&signed.receipt_hash)?,
            signature: Some(STANDARD.decode(signed.signature)?),
        };
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
        Ok(Self {
            admin,
            database,
            url,
            db,
            ledger,
            config,
            request_id,
            attempt,
            receipt,
            settlement,
        })
    }

    async fn complete(&self) -> zkapi_control::ledger::Result<()> {
        self.ledger
            .complete_direct(
                self.request_id,
                DirectOutcome::ConfirmedNotIssued,
                wire::sha256(b"local fixture: original owner exited before send permission"),
                &self.receipt,
            )
            .await?;
        Ok(())
    }

    async fn signer(&self, journal: &std::path::Path) -> Result<Signer> {
        Signer::open(
            self.config.clone(),
            &self.url,
            journal,
            Felt252::from_u64(31).0,
            Felt252::from_u64(37).0,
        )
        .await
    }

    async fn cleanup(self) -> Result<()> {
        drop(self.ledger);
        drop(self.db);
        self.admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.database))
            .await?;
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL via ZKAPI_TEST_DATABASE_URL"]
async fn ledger_rejects_nonissuance_after_send_permission_even_without_a_key() -> Result<()> {
    let f = Fixture::new().await?;
    f.ledger.claim_dispatch(&f.attempt).await?;
    f.ledger.mark_issuance_unknown(f.request_id).await?;
    f.ledger.finish_attempt(&f.attempt, [79; 32]).await?;
    f.ledger.close(f.request_id).await?;
    assert!(matches!(
        f.complete().await,
        Err(LedgerError::Conflict("direct_nonissuance_not_proven"))
    ));
    let session = f.ledger.session(f.request_id).await?;
    assert_eq!(session.state, "ISSUANCE_UNKNOWN");
    assert!(session.provider_key_ref.is_none());
    assert!(session.activated_at.is_none());
    assert!(f.ledger.receipts(f.request_id, None, 100).await?.is_empty());
    f.cleanup().await
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL via ZKAPI_TEST_DATABASE_URL"]
async fn unsent_direct_settlement_requires_stopped_owner_and_signer_rechecks_attempts() -> Result<()>
{
    let f = Fixture::new().await?;
    f.ledger.close(f.request_id).await?;
    assert!(matches!(
        f.complete().await,
        Err(LedgerError::Conflict("dispatch_not_quiesced"))
    ));
    assert!(f.ledger.receipts(f.request_id, None, 100).await?.is_empty());
    f.ledger.finish_attempt(&f.attempt, [79; 32]).await?;
    f.complete().await?;
    f.ledger
        .prepare_settlement(f.request_id, &f.settlement)
        .await?;
    let directory = tempfile::tempdir()?;
    let journal = directory.path().join("journal");
    Signer::initialize_journal(&journal, &f.config)?;
    let initial_journal = std::fs::read(&journal)?;
    let mut signer = f.signer(&journal).await?;
    let target = SignTarget::Settlement {
        request_id: f.request_id,
    };

    // A signed zero receipt and arbitrary stop digest do not excuse evidence
    // that the original owner could send. Simulate a privileged bad restore,
    // bypassing normal immutable triggers, to exercise the signer itself.
    f.db.batch_execute("SET session_replication_role=replica")
        .await?;
    f.db.execute(
        "UPDATE dispatch_attempts SET send_claimed_at=clock_timestamp() WHERE attempt_id=$1",
        &[&f.attempt.attempt_id],
    )
    .await?;
    let error = signer.sign(target.clone()).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("direct nonissuance is not proven"));
    assert_eq!(std::fs::read(&journal)?, initial_journal);
    f.db.execute(
        "UPDATE dispatch_attempts SET send_claimed_at=NULL WHERE attempt_id=$1",
        &[&f.attempt.attempt_id],
    )
    .await?;
    let finished: String =
        f.db.query_one(
            "SELECT finished_at::text FROM dispatch_attempts WHERE attempt_id=$1",
            &[&f.attempt.attempt_id],
        )
        .await?
        .get(0);
    f.db.execute(
        "UPDATE dispatch_attempts SET finished_at=NULL,finish_evidence_digest=NULL WHERE attempt_id=$1",
        &[&f.attempt.attempt_id],
    )
    .await?;
    assert!(signer.sign(target.clone()).await.is_err());
    assert_eq!(std::fs::read(&journal)?, initial_journal);
    f.db.execute(
        "UPDATE dispatch_attempts SET finished_at=$2::text::timestamptz,finish_evidence_digest=$3::bytea WHERE attempt_id=$1",
        &[&f.attempt.attempt_id, &finished, &&[79u8; 32][..]],
    )
    .await?;
    for (mutation, restoration) in [
        ("provider_key_ref='unproven-key'", "provider_key_ref=NULL"),
        (
            "activated_at=1,expires_at=2",
            "activated_at=NULL,expires_at=NULL",
        ),
    ] {
        f.db.execute(
            &format!("UPDATE sessions SET {mutation} WHERE request_id=$1"),
            &[&f.request_id],
        )
        .await?;
        assert!(signer.sign(target.clone()).await.is_err());
        assert_eq!(std::fs::read(&journal)?, initial_journal);
        f.db.execute(
            &format!("UPDATE sessions SET {restoration} WHERE request_id=$1"),
            &[&f.request_id],
        )
        .await?;
    }
    f.db.batch_execute("SET session_replication_role=origin")
        .await?;

    let signature = signer.sign(target.clone()).await?;
    signer::verify_signature(
        &f.config.state_key,
        f.settlement.signature_message,
        &signature,
    )?;
    assert_eq!(signer.sign(target.clone()).await?, signature);
    f.ledger
        .save_settlement_signature(f.request_id, &signature)
        .await?;
    drop(signer);
    let mut signer = f.signer(&journal).await?;
    signer.reconcile().await?;
    assert_eq!(signer.sign(target).await?, signature);
    assert_eq!(f.ledger.session(f.request_id).await?.state, "SETTLED");
    assert_eq!(f.ledger.session(f.request_id).await?.charged_nano, 0);
    assert_eq!(f.ledger.receipts(f.request_id, None, 100).await?.len(), 1);
    drop(signer);

    // The same independent predicate still applies during startup reconciliation
    // after a signature was returned; restoration cannot rewrite send history.
    f.db.batch_execute("SET session_replication_role=replica")
        .await?;
    f.db.execute(
        "UPDATE dispatch_attempts SET send_claimed_at=clock_timestamp() WHERE attempt_id=$1",
        &[&f.attempt.attempt_id],
    )
    .await?;
    assert!(f.signer(&journal).await.is_err());
    f.cleanup().await
}
