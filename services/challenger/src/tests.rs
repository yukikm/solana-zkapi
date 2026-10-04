//! Real, fixed RP/tree verification inside a synthetic archived envelope and
//! state-machine tests. No test here claims a new live transaction or provider.
use super::*;
use crate::{journal::*, scan::FinalizedView};
use ark_serialize::CanonicalDeserialize;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::collections::BTreeMap;
use zkapi_control::wire::{Authorization, Mode, Proof, Provider, Quote, QuoteBody};
use zkapi_indexer::{tree::Tree, ChainState, Note, Pending, Position};
use zkapi_solana_types::FieldElement;

fn fixture(name: &str) -> Value {
    serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../tests/fixtures/vault/{name}.json")),
        )
        .unwrap(),
    )
    .unwrap()
}
fn h(v: &Value) -> Hash {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}
fn f(v: &Value) -> FieldElement {
    FieldElement::from_bytes(h(v)).unwrap()
}
fn b58(v: &Value) -> String {
    zkapi_indexer::snapshot::key(h(v))
}
fn trust_and_manifest() -> (Trust, Value) {
    let a = fixture("a");
    let p = &a["auth"]["request"]["public_inputs"];
    let mut m: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    for (key, value) in json!({
        "program_id": b58(&a["program_id"]), "pool":b58(&a["pool"]), "genesis_hash":b58(&a["genesis"]),
        "mint":b58(&a["mint"]), "token_program":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "vault_binding":p[2], "state_key":{"x":p[4],"y":p[5]},
        "clearance_key":{"x":a["auth"]["escape"]["public_inputs"][6],"y":a["auth"]["escape"]["public_inputs"][7]},
        "cap_micro_usdc":"1000000", "note_ttl_seconds":"2592000", "challenge_seconds":"86400",
        "decimals":6, "deployment_environment":"local", "transaction_formats":["v0_buffer"],
        "deployment_id":"challenger-test"
    }).as_object().unwrap() { m[key] = value.clone(); }
    let digest = sha(&serde_jcs::to_vec(&m).unwrap());
    m["manifest_hash"] = hex::encode(digest).into();
    (Trust::from_pinned_manifest(&m, digest).unwrap(), m)
}
fn evidence(trust: &Trust) -> Evidence {
    let a = fixture("a");
    let request_id = uuid::Uuid::from_u128(0x12345678_1234_4000_8000_000000000001);
    let request = SessionCreate {
        authorization: Authorization {
            version: "1".into(),
            deployment_id: trust.deployment.clone(),
            pool: trust.pool.pool.clone(),
            request_id: request_id.to_string(),
            quote_hash: "00".repeat(32),
            mode: Mode::Proxy,
            control_secret_hash: "11".repeat(32),
            proxy_secret_hash: Some("22".repeat(32)),
        },
        quote: Quote {
            body: QuoteBody {
                quote_id: request_id.to_string(),
                deployment_id: trust.deployment.clone(),
                pool: trust.pool.pool.clone(),
                mode: Mode::Proxy,
                provider: Provider::Openai,
                models: vec!["fixture".into()],
                tariff_hash: "33".repeat(32),
                cap_micro_usdc: "1000000".parse().unwrap(),
                issued_at: "1".into(),
                expires_at: "2".into(),
                session_ttl_seconds: "60".into(),
                max_concurrency: "1".into(),
                control_api_origin: "http://127.0.0.1".into(),
                inference_api_origin: "http://127.0.0.1".into(),
            },
            quote_hash: "00".repeat(32),
            signature: STANDARD.encode([0; 64]),
        },
        public_inputs: std::array::from_fn(|i| f(&a["auth"]["request"]["public_inputs"][i])),
        proof: Proof {
            backend: "groth16_bn254".into(),
            proof: STANDARD.encode(
                hex::decode(a["auth"]["request"]["proof_wire_hex"].as_str().unwrap()).unwrap(),
            ),
        },
    };
    let transcript = wire::jcs(&request).unwrap();
    Evidence {
        pool: trust.pool(),
        request_id,
        nullifier: *request.public_inputs[8].as_bytes(),
        transcript_digest: sha(&transcript),
        transcript,
    }
}
fn checkpoint(sequence: u64) -> Checkpoint {
    Checkpoint {
        position: Position {
            slot: 20 + sequence,
            transaction_index: 0,
            signature: format!("tx-{sequence}"),
            outer_instruction: 2,
            invocation_index: 1,
        },
        blockhash: [sequence as u8; 32],
        tree_sequence: sequence,
    }
}
fn view(trust: Trust, evidence: &Evidence) -> FinalizedView {
    let a = fixture("a");
    let b = fixture("b-with-a");
    let note = |v: &Value| Note {
        id: v["id"].as_u64().unwrap() as u32,
        commitment: h(&v["commitment"]),
        deposit: v["deposit"].as_u64().unwrap(),
        expiry: v["expiry"].as_u64().unwrap(),
    };
    let b = note(&b);
    let a = note(&a);
    let mut tree = Tree::new();
    tree.update(b.id, b.leaf().unwrap()).unwrap();
    let pending = Pending {
        note: a,
        old_root: zkapi_layout2::integer(987),
        nullifier: evidence.nullifier,
        balance: 4_900_000,
        destination_owner: [7; 32],
        deadline: 3_000_086_400,
    };
    FinalizedView {
        trust,
        state: ChainState {
            slot: 23,
            blockhash: [3; 32],
            root: tree.root(),
            sequence: 3,
            next_note_id: 2,
            outstanding_deposits: 10_000_000,
            active: BTreeMap::from([(b.id, b)]),
            pending: BTreeMap::from([(0, pending)]),
        },
        generations: BTreeMap::from([(0, checkpoint(3))]),
        tree,
        now: 3_000_000_001,
        paused: true,
    }
}
fn payload(prepared: &PreparedChallenge, trust: &Trust) -> Vec<u8> {
    let a = fixture("a-with-b");
    let t = &a["trees"][2];
    let update = TreeUpdate {
        public: std::array::from_fn(|i| h(&t["public_inputs"][i])),
        proof: hex::decode(t["proof_wire_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap(),
    };
    let mut bytes = &include_bytes!("../../../tests/fixtures/layout2/test-tree.vk")[..];
    let vk = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(&mut bytes).unwrap();
    prepared.assemble_verified(trust, &update, &vk).unwrap()
}
#[test]
fn real_historical_rp_and_current_tree_verify_while_paused_and_quote_expired() {
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let request = e.verify(&trust).unwrap();
    assert_ne!(*request.public_inputs[3].as_bytes(), v.state.root);
    assert_ne!(
        *request.public_inputs[3].as_bytes(),
        v.state.pending[&0].old_root
    );
    let prepared = PreparedChallenge::from_finalized(&v, 0, e).unwrap();
    assert!(zkapi_tree_prover::satisfied(&prepared.circuit));
    let bytes = payload(&prepared, &trust);
    assert_eq!(bytes.len(), 1252);
}
#[test]
fn evidence_tampering_deadline_equality_and_wrong_pending_rejected() {
    let (trust, mut m) = trust_and_manifest();
    let e = evidence(&trust);
    m["deployment_id"] = "changed".into();
    assert!(Trust::from_pinned_manifest(&m, trust.manifest_hash).is_err());
    let mut corrupt = e.clone();
    corrupt.transcript[0] ^= 1;
    assert!(corrupt.verify(&trust).is_err());
    let mut corrupt = e.clone();
    let mut r: SessionCreate = wire::strict_parse(&e.transcript).unwrap();
    r.public_inputs[3] = FieldElement::from_bytes(zkapi_layout2::integer(4)).unwrap();
    corrupt.transcript = wire::jcs(&r).unwrap();
    corrupt.transcript_digest = sha(&corrupt.transcript);
    assert!(corrupt.verify(&trust).is_err());
    let mut v = view(trust.clone(), &e);
    v.now = v.state.pending[&0].deadline;
    assert!(PreparedChallenge::from_finalized(&v, 0, e.clone()).is_err());
    let mut v = view(trust, &e);
    v.state.pending.get_mut(&0).unwrap().nullifier = [0; 32];
    assert!(PreparedChallenge::from_finalized(&v, 0, e).is_err());
}
#[test]
fn durable_unknown_attempt_reopens_without_resigning_and_completes_only_finalized() {
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let prepared = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&prepared, &trust);
    let identity = prepared.job;
    let id = identity.id();
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(dir.path(), trust.pool()).unwrap();
    assert!(Journal::open(dir.path(), trust.pool()).is_err());
    journal
        .enqueue_cut(checkpoint(3), vec![(identity, e)], 10)
        .unwrap();
    let payload = Payload {
        digest: sha(&bytes),
        bytes,
        buffer: [9; 32],
        checkpoint: checkpoint(3),
    };
    journal.save_payload(&id, payload.clone()).unwrap();
    let a = Attempt {
        signature: "signed-execute".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Execute,
        payload_digest: payload.digest,
        buffer: payload.buffer,
        outcome: Outcome::Unknown,
    };
    journal.save_signed_attempt(&id, a.clone()).unwrap();
    drop(journal);
    let mut journal = Journal::open(dir.path(), trust.pool()).unwrap();
    assert_eq!(
        journal.jobs().next().unwrap().1.attempts.as_slice(),
        std::slice::from_ref(&a)
    );
    assert!(journal.save_payload(&id, payload.clone()).is_err());
    let mut another = a.clone();
    another.signature = "new-blockhash".into();
    assert!(journal.save_signed_attempt(&id, another).is_err());
    journal.save_signed_attempt(&id, a).unwrap(); // byte-identical resend only
    assert!(!journal.jobs().next().unwrap().1.complete);
    journal
        .resolve_finalized(
            &id,
            "signed-execute",
            Outcome::FinalizedSuccess {
                slot: 40,
                blockhash: [40; 32],
            },
        )
        .unwrap();
    drop(journal);
    let journal = Journal::open(dir.path(), trust.pool()).unwrap();
    assert!(journal.jobs().next().unwrap().1.complete);
    assert_eq!(
        alert(journal.jobs().next().unwrap().1, u64::MAX),
        Alert::None
    );
}
#[test]
fn definite_failure_allows_new_tree_only_and_alerts_escalate() {
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&p, &trust);
    let id = p.job.id();
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::initialize(dir.path(), trust.pool()).unwrap();
    j.enqueue_cut(checkpoint(3), vec![(p.job, e)], 1000)
        .unwrap();
    let payload = Payload {
        digest: sha(&bytes),
        bytes,
        buffer: [9; 32],
        checkpoint: checkpoint(3),
    };
    j.save_payload(&id, payload.clone()).unwrap();
    j.save_signed_attempt(
        &id,
        Attempt {
            signature: "failed".into(),
            signed_bytes: vec![4],
            stage: Stage::Execute,
            payload_digest: payload.digest,
            buffer: payload.buffer,
            outcome: Outcome::Unknown,
        },
    )
    .unwrap();
    j.resolve_finalized(
        &id,
        "failed",
        Outcome::FinalizedFailure {
            slot: 30,
            blockhash: [30; 32],
            error: "stale root".into(),
        },
    )
    .unwrap();
    let mut next = payload.clone();
    next.buffer = [10; 32];
    next.checkpoint = checkpoint(4);
    j.save_payload(&id, next.clone()).unwrap();
    let mut without_failure = next.clone();
    without_failure.buffer = [11; 32];
    assert!(j.save_payload(&id, without_failure).is_err());
    next.bytes[4 + 8 * 32] ^= 1;
    next.digest = sha(&next.bytes);
    assert!(j.save_payload(&id, next).is_err());
    let job = j.jobs().next().unwrap().1;
    assert_eq!(alert(job, 1059), Alert::None);
    assert_eq!(alert(job, 1060), Alert::Warning);
    assert_eq!(alert(job, 1300), Alert::Page);
    assert_eq!(alert(job, job.identity.deadline - 3600), Alert::Emergency);
    assert!(j.enqueue_cut(checkpoint(2), vec![], 2000).is_err());
}
#[test]
fn journal_missing_corrupt_or_other_pool_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Journal::open(dir.path(), [1; 32]).is_err());
    drop(Journal::initialize(dir.path(), [1; 32]).unwrap());
    assert!(Journal::open(dir.path(), [2; 32]).is_err());
    std::fs::write(dir.path().join("journal.json"), b"truncated").unwrap();
    assert!(Journal::open(dir.path(), [1; 32]).is_err());
}

#[test]
fn pending_identity_cannot_be_rekeyed_around_an_unknown_attempt() {
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&p, &trust);
    let identity = p.job;
    let id = identity.id();
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(dir.path(), trust.pool()).unwrap();
    journal
        .enqueue_cut(checkpoint(3), vec![(identity.clone(), e.clone())], 10)
        .unwrap();
    let digest = sha(&bytes);
    journal
        .save_payload(
            &id,
            Payload {
                bytes,
                digest,
                buffer: [9; 32],
                checkpoint: checkpoint(3),
            },
        )
        .unwrap();
    journal
        .save_signed_attempt(
            &id,
            Attempt {
                signature: "unresolved".into(),
                signed_bytes: vec![1],
                stage: Stage::Execute,
                payload_digest: digest,
                buffer: [9; 32],
                outcome: Outcome::Unknown,
            },
        )
        .unwrap();
    // Changing a deadline, note or generation must not create another journal
    // entry for the same permanent N and thereby authorize a new signature.
    for changed in [
        JobIdentity {
            deadline: identity.deadline + 1,
            ..identity.clone()
        },
        JobIdentity {
            note_id: 1,
            ..identity.clone()
        },
        JobIdentity {
            generation: checkpoint(4),
            ..identity.clone()
        },
    ] {
        assert!(journal
            .enqueue_cut(checkpoint(4), vec![(changed, e.clone())], 11)
            .is_err());
    }
    // Nor may the same chain transition be rebound to a different N.
    let mut another = e.clone();
    another.nullifier = zkapi_layout2::integer(42);
    let changed = JobIdentity {
        nullifier: another.nullifier,
        ..identity.clone()
    };
    assert!(journal
        .enqueue_cut(checkpoint(4), vec![(changed, another)], 11)
        .is_err());
    assert_eq!(journal.jobs().count(), 1);
    assert_eq!(journal.checkpoint(), Some(&checkpoint(3)));
    drop(journal);
    let mut journal = Journal::open(dir.path(), trust.pool()).unwrap();
    journal
        .enqueue_cut(checkpoint(4), vec![(identity, e)], 12)
        .unwrap();
    assert_eq!(journal.jobs().count(), 1);
}

#[test]
fn reopening_legacy_checksummed_jobs_rechecks_identity_invariants() {
    // Preserve the exact v1 field order used to checksum old journal files.
    // These fixtures model files a previous writer could have persisted, not
    // random byte corruption (which the envelope checksum already detects).
    #[derive(Clone, Serialize, Deserialize)]
    struct LegacyState {
        version: u32,
        pool: Hash,
        jobs: BTreeMap<String, Job>,
        checkpoint: Option<Checkpoint>,
    }
    #[derive(Serialize, Deserialize)]
    struct LegacyEnvelope {
        digest: Hash,
        state: LegacyState,
    }
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&p, &trust);
    let id = p.job.id();
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(dir.path(), trust.pool()).unwrap();
    journal
        .enqueue_cut(checkpoint(3), vec![(p.job, e)], 10)
        .unwrap();
    let digest = sha(&bytes);
    journal
        .save_payload(
            &id,
            Payload {
                bytes,
                digest,
                buffer: [9; 32],
                checkpoint: checkpoint(3),
            },
        )
        .unwrap();
    journal
        .save_signed_attempt(
            &id,
            Attempt {
                signature: "legacy-unresolved".into(),
                signed_bytes: vec![1],
                stage: Stage::Execute,
                payload_digest: digest,
                buffer: [9; 32],
                outcome: Outcome::Unknown,
            },
        )
        .unwrap();
    drop(journal);
    let path = dir.path().join("journal.json");
    let original: LegacyEnvelope = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        original.digest,
        sha(&serde_json::to_vec(&original.state).unwrap())
    );
    let rewrite = |state: LegacyState| {
        let envelope = LegacyEnvelope {
            digest: sha(&serde_json::to_vec(&state).unwrap()),
            state,
        };
        std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
    };
    rewrite(original.state.clone());
    drop(Journal::open(dir.path(), trust.pool()).unwrap());
    for case in [
        "same-nullifier",
        "same-sequence",
        "map-key",
        "job-pool",
        "evidence-pool",
        "evidence-nullifier",
        "transcript-digest",
        "missing-checkpoint",
        "old-checkpoint",
        "forked-checkpoint",
    ] {
        let mut state = original.state.clone();
        match case {
            "same-nullifier" | "same-sequence" => {
                let mut alias = state.jobs[&id].clone();
                if case == "same-nullifier" {
                    alias.identity.generation = checkpoint(2);
                } else {
                    alias.identity.nullifier = zkapi_layout2::integer(42);
                    alias.evidence.nullifier = alias.identity.nullifier;
                }
                state.jobs.insert(alias.identity.id(), alias);
            }
            "map-key" => {
                let job = state.jobs.remove(&id).unwrap();
                state.jobs.insert("wrong-map-key".into(), job);
            }
            "job-pool" => {
                let mut job = state.jobs.remove(&id).unwrap();
                job.identity.pool = [42; 32];
                state.jobs.insert(job.identity.id(), job);
            }
            "evidence-pool" => state.jobs.get_mut(&id).unwrap().evidence.pool = [42; 32],
            "evidence-nullifier" => state.jobs.get_mut(&id).unwrap().evidence.nullifier = [42; 32],
            "transcript-digest" => state.jobs.get_mut(&id).unwrap().evidence.transcript.push(0),
            "missing-checkpoint" => state.checkpoint = None,
            "old-checkpoint" => state.checkpoint = Some(checkpoint(2)),
            "forked-checkpoint" => state.checkpoint.as_mut().unwrap().blockhash = [42; 32],
            _ => unreachable!(),
        }
        rewrite(state);
        assert!(
            Journal::open(dir.path(), trust.pool()).is_err(),
            "accepted legacy {case}"
        );
    }
    rewrite(original.state);
    let restored = Journal::open(dir.path(), trust.pool()).unwrap();
    assert_eq!(
        restored.jobs().next().unwrap().1.attempts[0].outcome,
        Outcome::Unknown
    );
}

#[test]
fn journal_rejects_forked_or_pre_pending_payload_checkpoints() {
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&p, &trust);
    let id = p.job.id();
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::initialize(dir.path(), trust.pool()).unwrap();
    journal
        .enqueue_cut(checkpoint(3), vec![(p.job, e)], 10)
        .unwrap();
    let payload = Payload {
        digest: sha(&bytes),
        bytes,
        buffer: [9; 32],
        checkpoint: checkpoint(3),
    };
    let mut stale = payload.clone();
    stale.checkpoint = checkpoint(2);
    assert!(journal.save_payload(&id, stale).is_err());
    let mut forked = payload.clone();
    forked.checkpoint.blockhash = [99; 32];
    assert!(journal.save_payload(&id, forked).is_err());
    journal.save_payload(&id, payload).unwrap();
    let mut forked = checkpoint(3);
    forked.position.signature = "zz-another-transaction-at-the-same-index".into();
    assert!(journal.enqueue_cut(forked, vec![], 11).is_err());
    let mut forked = checkpoint(3);
    forked.tree_sequence += 1;
    assert!(journal.enqueue_cut(forked, vec![], 11).is_err());
    assert_eq!(journal.checkpoint(), Some(&checkpoint(3)));
}

#[test]
fn local_db_transport_checks_the_effective_hostaddr() {
    for dsn in [
        "hostaddr=192.0.2.1 user=x",
        "host=localhost hostaddr=192.0.2.1 user=x",
        "host=/tmp hostaddr=192.0.2.1 user=x",
        "host=localhost,localhost hostaddr=127.0.0.1,192.0.2.1 user=x",
        "host=example.com user=x",
    ] {
        assert!(read_model::local_config(dsn).is_err(), "accepted {dsn}");
    }
    for dsn in [
        "host=/tmp user=x",
        "host=localhost user=x",
        "hostaddr=127.0.0.1 user=x",
        "host=localhost hostaddr=::1 user=x",
    ] {
        assert!(read_model::local_config(dsn).is_ok(), "rejected {dsn}");
    }
}

#[tokio::test]
#[ignore = "requires disposable ZKAPI_I09_DATABASE_URL; run scripts/run_i09_challenger.py"]
async fn readonly_repository_reads_settled_auth_without_writer_lock_or_mutation() {
    let dsn = std::env::var("ZKAPI_I09_DATABASE_URL").expect("disposable DB only");
    zkapi_control::ledger::migrate(&dsn).await.unwrap();
    let (admin, connection) = tokio_postgres::connect(&dsn, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let pool = trust.pool();
    let hash = [5u8; 32];
    admin.execute("INSERT INTO pools(pool,deployment_id,manifest_hash,writer_epoch,accepting) VALUES($1::bytea,$2,$3::bytea,7,true)",&[&&pool[..],&trust.deployment,&&trust.manifest_hash[..]]).await.unwrap();
    admin
        .execute(
            "INSERT INTO tariffs(tariff_hash,canonical_body) VALUES($1::bytea,$2)",
            &[&&hash[..], &vec![1u8]],
        )
        .await
        .unwrap();
    admin.execute("INSERT INTO quotes(pool,quote_id,quote_hash,canonical_body,signature,tariff_hash,expires_at) VALUES($1::bytea,$2,$3::bytea,$4,$5,$3::bytea,2)",&[&&pool[..],&e.request_id,&&hash[..],&vec![1u8],&vec![0u8;64]]).await.unwrap();
    admin
        .execute(
            "INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'AUTH')",
            &[&&pool[..], &&e.nullifier[..]],
        )
        .await
        .unwrap();
    admin.execute("INSERT INTO sessions(pool,request_id,nullifier,quote_id,request_digest,request_transcript,control_secret_hash,proxy_secret_hash,mode,provider,state,cap_micro,max_concurrency,writer_epoch) VALUES($1::bytea,$2,$3::bytea,$2,$4::bytea,$5,$6::bytea,$6::bytea,'proxy','openai','SETTLED',1000000,1,7)",&[&&pool[..],&e.request_id,&&e.nullifier[..],&&e.transcript_digest[..],&e.transcript,&&hash[..]]).await.unwrap();
    let lock_digest = sha(&[b"zkapi-pool-writer-v1".as_slice(), &pool].concat());
    let lock_key = i64::from_be_bytes(lock_digest[..8].try_into().unwrap());
    admin
        .query_one("SELECT pg_advisory_lock($1)", &[&lock_key])
        .await
        .unwrap();
    admin.batch_execute("CREATE ROLE i09_reader LOGIN; GRANT USAGE ON SCHEMA public TO i09_reader; GRANT SELECT ON pools,nullifier_reservations,sessions TO i09_reader").await.unwrap();
    let mut config: tokio_postgres::Config = dsn.parse().unwrap();
    config.user("i09_reader");
    let host = match &config.get_hosts()[0] {
        tokio_postgres::config::Host::Unix(p) => p.to_str().unwrap().to_owned(),
        tokio_postgres::config::Host::Tcp(s) => s.clone(),
    };
    let read_dsn = format!(
        "host={} port={} user=i09_reader dbname={}",
        host,
        config.get_ports()[0],
        config.get_dbname().unwrap()
    );
    let mut repo = read_model::ReadRepository::connect_local(&read_dsn, trust.clone())
        .await
        .unwrap();
    assert_eq!(repo.auth(e.nullifier).await.unwrap(), Some(e.clone()));
    assert_eq!(repo.auth([0; 32]).await.unwrap(), None);
    let missing = zkapi_layout2::integer(33);
    admin
        .execute(
            "INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'AUTH')",
            &[&&pool[..], &&missing[..]],
        )
        .await
        .unwrap();
    assert!(repo.auth(missing).await.is_err());
    let clearance = zkapi_layout2::integer(34);
    admin
        .execute(
            "INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES($1::bytea,$2::bytea,'CLEARANCE')",
            &[&&pool[..], &&clearance[..]],
        )
        .await
        .unwrap();
    assert_eq!(repo.auth(clearance).await.unwrap(), None);
    let state = admin
        .query_one(
            "SELECT writer_epoch,accepting FROM pools WHERE pool=$1",
            &[&&pool[..]],
        )
        .await
        .unwrap();
    assert_eq!(state.get::<_, i64>(0), 7);
    assert!(state.get::<_, bool>(1));
    let (reader, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    assert!(reader
        .execute("UPDATE pools SET accepting=false", &[])
        .await
        .is_err());
    assert!(
        read_model::ReadRepository::connect_local("host=example.com user=x", trust)
            .await
            .is_err()
    );
}

#[test]
#[ignore = "requires I04 actual-SBF history artifact; run scripts/run_i09_challenger.py"]
fn finalized_scanner_replays_actual_sbf_archive_and_rejects_account_cut_mismatch() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/i04/sdk-svm-history.json");
    let history: Value =
        serde_json::from_slice(&std::fs::read(path).expect("generate with scripts/run_i04.sh"))
            .unwrap();
    let scenario = history["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "challenge")
        .unwrap();
    let cut = &scenario["checkpoints"][2];
    let (trust, _) = trust_and_manifest();
    let mut scan = scan::Scanner::new(trust.clone());
    let mut first = None;
    for row in scenario["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["slot"].as_u64().unwrap() <= cut["slot"].as_u64().unwrap())
    {
        let block = zkapi_indexer::rpc::decode_finalized_block(
            row["slot"].as_u64().unwrap(),
            &row["block"],
        )
        .unwrap();
        if first.is_none() {
            first = Some(block.clone());
        }
        scan.apply_finalized(&block).unwrap();
    }
    let state = scan.replay_state().unwrap();
    let pool_account = &cut["accounts"][&trust.pool.pool];
    let view = scan.reconcile(&state, pool_account).unwrap();
    assert_eq!(view.pending().count(), 1);
    let before = view.now;
    scan.apply_finalized(&first.unwrap()).unwrap();
    let view = scan.reconcile(&state, pool_account).unwrap();
    assert_eq!(view.now, before);
    let e = evidence(&trust);
    let prepared = PreparedChallenge::from_finalized(&view, 0, e).unwrap();
    assert_eq!(payload(&prepared, &trust).len(), 1252);
    assert_eq!(
        prepared.job.generation.position.slot,
        cut["slot"].as_u64().unwrap()
    );
    let mut wrong = state;
    wrong.slot += 1;
    assert!(scan.reconcile(&wrong, pool_account).is_err());
}

#[test]
fn generates_a_new_real_challenge_proof_using_pinned_test_setup() {
    use rand::SeedableRng;
    let (trust, _) = trust_and_manifest();
    let e = evidence(&trust);
    let v = view(trust.clone(), &e);
    let prepared = PreparedChallenge::from_finalized(&v, 0, e).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = root.join("target/i09-challenger");
    std::fs::create_dir_all(&out).unwrap();
    let cache = out.join("test-tree.pk");
    let pk_bytes = if cache.exists() {
        std::fs::read(&cache).unwrap()
    } else {
        // Recreate I02's same public TEST ONLY setup, never a new production key.
        let legacy: Value = serde_json::from_slice(
            &std::fs::read(root.join("tests/fixtures/tree/tree-0-0.json")).unwrap(),
        )
        .unwrap();
        let circuit = TreeCircuit {
            public: std::array::from_fn(|i| f(&legacy["public_inputs"][i]).to_field()),
            siblings: std::array::from_fn(|i| f(&legacy["siblings"][i]).to_field()),
        };
        let mut rng = rand::rngs::StdRng::seed_from_u64(0x49303254524545);
        let key = ark_groth16::Groth16::<Bn254>::generate_random_parameters_with_reduction(
            circuit, &mut rng,
        )
        .unwrap();
        let mut bytes = Vec::new();
        key.serialize_compressed(&mut bytes).unwrap();
        assert_eq!(sha(&bytes), trust.tree_pk_hash);
        std::fs::write(&cache, &bytes).unwrap();
        bytes
    };
    let pk = trust.load_tree_key(&pk_bytes).unwrap();
    let mut corrupt = pk_bytes.clone();
    corrupt[0] ^= 1;
    assert!(trust.load_tree_key(&corrupt).is_err());
    let start = std::time::Instant::now();
    let payload = prepared.prove(&trust, &pk).unwrap();
    assert_eq!(payload.len(), 1252);
    std::fs::write(out.join("generated-challenge.bin"), &payload).unwrap();
    std::fs::write(out.join("proof-generation.json"),serde_json::to_vec_pretty(&json!({"scope":"one native real tree proof, test-only pinned setup; not end-to-end latency or p50/p95","tree_pk_sha256":hex::encode(sha(&pk_bytes)),"payload_sha256":hex::encode(sha(&payload)),"payload_bytes":payload.len(),"prove_verify_ms":start.elapsed().as_millis()})).unwrap()).unwrap();
}
