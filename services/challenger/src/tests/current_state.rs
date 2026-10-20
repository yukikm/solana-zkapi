use super::*;
#[path = "../../../indexer/tests/support/current.rs"]
mod support;
use std::collections::BTreeSet;
use support::{bytes, loader_accounts, mock, replace, success, Fixture};
use zkapi_indexer::current_state::{self as cs, service};

fn current_view(f: &Fixture) -> FinalizedView {
    let dir = tempfile::tempdir().unwrap();
    let state = cs::verify(
        &f.trusted,
        f.deployment(),
        &f.settings(dir.path()),
        f.capture(4096),
        f.time,
        30_000,
    )
    .unwrap();
    let trust = Trust::from_pinned_manifest(&f.manifest, f.deployment()).unwrap();
    FinalizedView::from_current(trust, state).unwrap()
}
#[test]
fn current_view_rejects_another_genesis_even_with_matching_pool_and_manifest() {
    let f = Fixture::load("challenge", "initiate_escape");
    let mut view = current_view(&f);
    let state = view.current.take().unwrap();
    view.trust.pool.genesis_hash = support::b58([42; 32]);
    assert!(FinalizedView::from_current(view.trust, state).is_err());
}
#[test]
fn current_pending_real_proof_identity_restart_and_absence_preserve_unknown() {
    let f = Fixture::load("challenge", "initiate_escape");
    let v = current_view(&f);
    let e = evidence(&v.trust);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let payload_bytes = payload(&p, &v.trust); // verifies actual pinned RP/tree proof
    assert!(p.job.generation.is_none());
    let id = p.job.id();
    let first_cut = v.current.as_ref().unwrap().cut().clone();
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::initialize_current(dir.path(), v.trust.pool()).unwrap();
    j.enqueue_current(
        first_cut.clone(),
        vec![(p.job.clone(), e.clone())],
        1,
        BTreeSet::from([e.nullifier]),
    )
    .unwrap();
    let mut later_cut = first_cut.clone();
    later_cut.slot += 1;
    later_cut.blockhash = [67; 32];
    later_cut.sequence += 4;
    j.enqueue_current(
        later_cut.clone(),
        vec![(p.job.clone(), e.clone())],
        2,
        BTreeSet::from([e.nullifier]),
    )
    .unwrap();
    assert_eq!(j.jobs().count(), 1);
    let mut conflict = p.job.clone();
    conflict.current.as_mut().unwrap().pending.balance -= 1;
    assert_eq!(conflict.id(), id);
    assert!(j
        .enqueue_current(
            later_cut.clone(),
            vec![(conflict, e.clone())],
            2,
            BTreeSet::from([e.nullifier])
        )
        .is_err());
    let payload = Payload {
        digest: sha(&payload_bytes),
        bytes: payload_bytes,
        buffer: [9; 32],
        checkpoint: Checkpoint::Accounts(later_cut.clone()),
    };
    let mut stale_payload = payload.clone();
    let mut stale_cut = first_cut.clone();
    stale_cut.slot -= 1;
    stale_payload.checkpoint = Checkpoint::Accounts(stale_cut);
    assert!(j.save_payload(&id, stale_payload).is_err());
    j.save_payload(&id, payload.clone()).unwrap();
    let attempt = Attempt {
        signature: "synthetic-exact-attempt".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Execute,
        payload_digest: payload.digest,
        buffer: payload.buffer,
        outcome: Outcome::Unknown,
    };
    j.save_signed_attempt(&id, attempt.clone()).unwrap();
    j.enqueue_current(later_cut.clone(), vec![], 3, BTreeSet::new())
        .unwrap();
    let saved = j.jobs().next().unwrap().1;
    assert!(saved.pending_absent && !saved.complete);
    assert_eq!(saved.attempts[0], attempt);
    let metrics = runtime::metrics(&j, 100);
    assert_eq!(metrics.complete_jobs, 0);
    assert_eq!(metrics.absent_jobs, 1);
    assert_eq!(metrics.unknown_signatures, 1);
    assert_eq!(metrics.minimum_deadline_remaining_seconds, None);
    assert!(j.archive_is_empty());
    drop(j);
    let mut j = Journal::open_current(dir.path(), v.trust.pool()).unwrap();
    assert_eq!(
        j.jobs().next().unwrap().1.first_observation,
        Some(Checkpoint::Accounts(first_cut.clone()))
    );
    assert_eq!(j.jobs().next().unwrap().1.attempts, vec![attempt]);
    assert!(j.save_payload(&id, payload).is_err());
    let mut reescape = p.job.clone();
    reescape.nullifier = zkapi_layout2::integer(1234);
    reescape.current.as_mut().unwrap().pending.nullifier = reescape.nullifier;
    assert_ne!(reescape.id(), id);
    let mut older = first_cut;
    older.slot -= 1;
    assert!(j
        .enqueue_current(older, vec![], 4, BTreeSet::new())
        .is_err());
    j.resolve_finalized(
        &id,
        "synthetic-exact-attempt",
        Outcome::FinalizedFailure {
            slot: later_cut.slot,
            blockhash: later_cut.blockhash,
            error: "stale_proof".into(),
        },
    )
    .unwrap();
    let old = j.jobs().next().unwrap().1.attempts[0].clone();
    for stage in [Stage::Upload, Stage::Execute] {
        assert!(j
            .save_signed_attempt(
                &id,
                Attempt {
                    signature: "new-signature-after-absence".into(),
                    stage,
                    outcome: Outcome::Unknown,
                    ..old.clone()
                }
            )
            .is_err());
    }
    // Explicit cleanup relies on the definite failure, never on absence alone.
    j.save_signed_attempt(
        &id,
        Attempt {
            signature: "cleanup-after-definite-failure".into(),
            stage: Stage::CloseBuffer,
            outcome: Outcome::Unknown,
            ..old
        },
    )
    .unwrap();
}

#[test]
fn absent_pending_cannot_refresh_unknown_upload() {
    let f = Fixture::load("challenge", "initiate_escape");
    let v = current_view(&f);
    let e = evidence(&v.trust);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let bytes = payload(&p, &v.trust);
    let id = p.job.id();
    let cut = v.current.as_ref().unwrap().cut().clone();
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::initialize_current(dir.path(), v.trust.pool()).unwrap();
    j.enqueue_current(
        cut.clone(),
        vec![(p.job, e.clone())],
        1,
        BTreeSet::from([e.nullifier]),
    )
    .unwrap();
    let payload = Payload {
        digest: sha(&bytes),
        bytes,
        buffer: [9; 32],
        checkpoint: Checkpoint::Accounts(cut.clone()),
    };
    j.save_payload(&id, payload.clone()).unwrap();
    let attempt = Attempt {
        signature: "expired-unknown-upload".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Upload,
        payload_digest: payload.digest,
        buffer: payload.buffer,
        outcome: Outcome::Unknown,
    };
    let record = json!({
        "signature":attempt.signature, "wireHex":"010203",
        "planDigest":hex::encode(payload.digest), "buffer":support::b58(payload.buffer),
        "kind":"append", "lastValidBlockHeight":10, "stepIndex":1,
        "plan":{"operation":"challenge_escape", "snapshotSlot":cut.slot}
    });
    j.save_v0_attempt(&id, attempt.clone(), record.clone())
        .unwrap();
    j.enqueue_current(cut.clone(), vec![], 2, BTreeSet::new())
        .unwrap();
    let replacement = Attempt {
        signature: "replacement".into(),
        ..attempt.clone()
    };
    let mut replacement_record = record;
    replacement_record["signature"] = json!(replacement.signature);
    assert!(j
        .reconcile_upload(
            &id,
            &attempt.signature,
            Outcome::UploadReconciled {
                slot: cut.slot,
                blockhash: cut.blockhash,
                finalized_height: 11,
                next_step_index: 1,
                account_bytes: vec![1],
            },
            Some((replacement, replacement_record)),
        )
        .is_err());
    assert_eq!(j.jobs().next().unwrap().1.attempts, vec![attempt.clone()]);
    drop(j);
    let j = Journal::open_current(dir.path(), v.trust.pool()).unwrap();
    assert_eq!(j.jobs().next().unwrap().1.attempts, vec![attempt]);
}
#[test]
fn current_view_generates_real_challenge_proof_without_archive() {
    let f = Fixture::load("challenge", "initiate_escape");
    let v = current_view(&f);
    let prepared = PreparedChallenge::from_finalized(&v, 0, evidence(&v.trust)).unwrap();
    // Same test-only setup as the existing proof acceptance; reusable public PK.
    let bytes = test_tree_key(&v.trust);
    let pk = v.trust.load_tree_key(&bytes).unwrap();
    assert_eq!(prepared.prove(&v.trust, &pk).unwrap().len(), 1252);
}
#[tokio::test]
async fn current_runtime_scan_restart_and_identity_fenced_unknown_recovery() {
    use std::sync::{Arc, Mutex};
    let mut f = Fixture::load("challenge", "initiate_escape");
    f.wall_now();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = f.config(dir.path(), "http://127.0.0.1:1".into());
    let identities = Arc::new(Mutex::new(loader_accounts(&f, &cfg)));
    let records = identities.clone();
    let handler = f.clone();
    let m = mock(move |q| {
        let mut result = handler.rpc_result(&q);
        if q["method"] == "getMultipleAccounts" && q["params"][0][0] == handler.trusted.program_id {
            let values: Vec<_> = q["params"][0]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| {
                    let mut v = records.lock().unwrap()[k.as_str().unwrap()].clone();
                    if q["params"][1].get("dataSlice").is_some() {
                        let raw = bytes(&v);
                        replace(&mut v, raw[..raw.len().min(45)].to_vec());
                    }
                    v
                })
                .collect();
            result = json!({"context":{"slot":handler.expected.slot},"value":values});
        }
        success(&q, result)
    })
    .await;
    cfg.rpc_url = m.url.clone();
    let (owner, worker) = service::start_owner(cfg.clone(), f.trusted.clone()).unwrap();
    let socket = service::serve_socket(&cfg.chain_state.state_socket, owner.clone()).unwrap();
    owner.read(true, false).await.unwrap();
    let marker = dir.path().join("bridge-input.json");
    let bridge = dir.path().join("bridge.mjs");
    std::fs::write(&bridge,format!("import{{writeFileSync}}from'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync({},s);const q=JSON.parse(s);process.stdout.write(JSON.stringify({{result:{{state:q.attempt?.kind==='append'?'expired_reconcile_required':'unknown'}}}}));",serde_json::to_string(&marker).unwrap())).unwrap();
    let node = std::env::var_os("ZKAPI_NODE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let output = std::process::Command::new("which")
                .arg("node")
                .output()
                .unwrap();
            assert!(output.status.success(), "put pinned Node 24.19.0 on PATH");
            std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
        });
    let common = runtime::Config {
        manifest: cfg.manifest.clone(),
        manifest_sha256: cfg.manifest_sha256.clone(),
        devnet: None,
        rpc_url: m.url.clone(),
        database_dsn_file: dir.path().join("unused-dsn"),
        start_slot: 0,
        journal_directory: dir.path().join("journal"),
        tree_pk: support::root().join("target/i09-challenger/test-tree.pk"),
        node,
        transport_bridge: bridge.clone(),
        transport_bridge_sha256: hex::encode(sha(&std::fs::read(&bridge).unwrap())),
        fee_key_file: dir.path().join("unused-key"),
        payer: support::b58([10; 32]),
        poll_seconds: 2,
        alert_sink_directory: None,
        priority_fee: None,
        archive_batch: None,
    };
    let config_file = dir.path().join("challenger.json");
    let mut current_json = serde_json::to_value(&common).unwrap();
    let fields = current_json.as_object_mut().unwrap();
    for legacy in ["start_slot", "poll_seconds", "archive_batch"] {
        fields.remove(legacy);
    }
    fields.insert("config_version".into(), json!(2));
    fields.insert(
        "chain_state".into(),
        json!({"mode":cs::POLICY, "state_socket":cfg.chain_state.state_socket}),
    );
    fields.insert(
        "program_identity".into(),
        serde_json::to_value(&cfg.program_identity).unwrap(),
    );
    std::fs::write(&config_file, serde_json::to_vec(&current_json).unwrap()).unwrap();
    let current = || runtime::read_current_config(&config_file).unwrap();
    let bad_file = dir.path().join("legacy.json");
    std::fs::write(&bad_file, serde_json::to_vec(&common).unwrap()).unwrap();
    assert!(runtime::read_current_config(&bad_file).is_err());
    for legacy in ["start_slot", "poll_seconds", "archive_batch"] {
        let mut bad_config = current_json.clone();
        bad_config[legacy] = json!(1);
        std::fs::write(&bad_file, serde_json::to_vec(&bad_config).unwrap()).unwrap();
        assert!(runtime::read_current_config(&bad_file).is_err());
    }
    let mut r = runtime::Runtime::open_current(current(), true).unwrap();
    let v = r.scan().await.unwrap();
    assert_eq!(
        m.calls.lock().unwrap().len(),
        4,
        "challenger scan must not duplicate owner RPC"
    );
    let e = evidence(&v.trust);
    let p = PreparedChallenge::from_finalized(&v, 0, e.clone()).unwrap();
    let payload_bytes = payload(&p, &v.trust);
    let id = p.job.id();
    r.journal
        .enqueue_current(
            v.current.as_ref().unwrap().cut().clone(),
            vec![(p.job, e.clone())],
            1,
            BTreeSet::from([e.nullifier]),
        )
        .unwrap();
    let payload = Payload {
        digest: sha(&payload_bytes),
        bytes: payload_bytes,
        buffer: [9; 32],
        checkpoint: r.checkpoint(&v),
    };
    r.journal.save_payload(&id, payload.clone()).unwrap();
    let attempt = Attempt {
        signature: "mock-execute".into(),
        signed_bytes: vec![1, 2, 3],
        stage: Stage::Execute,
        payload_digest: payload.digest,
        buffer: payload.buffer,
        outcome: Outcome::Unknown,
    };
    let record = json!({"signature":attempt.signature,"wireHex":"010203","planDigest":hex::encode(payload.digest),
        "buffer":support::b58(payload.buffer),"kind":"execute","plan":{"operation":"challenge_escape"}});
    r.journal
        .save_v0_attempt(&id, attempt.clone(), record)
        .unwrap();
    drop(r);
    let mut r = runtime::Runtime::open_current(current(), false).unwrap();
    r.scan().await.unwrap();
    assert_eq!(m.calls.lock().unwrap().len(), 4);
    for v in identities
        .lock()
        .unwrap()
        .values_mut()
        .filter(|v| v["executable"] == false)
    {
        let mut b = bytes(v);
        b[4] ^= 1;
        replace(v, b);
    }
    assert_eq!(r.recover().await.unwrap(), 0);
    let seen: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(seen["command"], "recover");
    assert_eq!(seen["resend"], false);
    assert_eq!(r.journal.jobs().next().unwrap().1.attempts, vec![attempt]);
    assert!(r.journal.archive_is_empty());
    assert!(m
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|q| q["method"] != "getBlocks"
            && q["method"] != "getTransaction"
            && q["method"] != "getSignaturesForAddress"
            && (q["method"] != "getBlock" || q["params"][1]["transactionDetails"] == "none")));
    drop(r);
    // A new process verifies the original pinned program, but replacement
    // signing still requires an available, fresh Pending view.
    *identities.lock().unwrap() = loader_accounts(&f, &cfg);
    let mut r = runtime::Runtime::open_current(current(), false).unwrap();
    let cut = v.current.as_ref().unwrap().cut().clone();
    r.journal
        .resolve_finalized(
            &id,
            "mock-execute",
            Outcome::FinalizedFailure {
                slot: cut.slot,
                blockhash: cut.blockhash,
                error: "stale_proof".into(),
            },
        )
        .unwrap();
    let upload = Attempt {
        signature: "expired-append".into(),
        stage: Stage::Upload,
        ..r.journal.jobs().next().unwrap().1.attempts[0].clone()
    };
    let upload = Attempt {
        outcome: Outcome::Unknown,
        ..upload
    };
    r.journal
        .save_v0_attempt(
            &id,
            upload.clone(),
            json!({"signature":upload.signature,"wireHex":"010203",
                "planDigest":hex::encode(payload.digest),"buffer":support::b58(payload.buffer),
                "kind":"append","plan":{"operation":"challenge_escape"}}),
        )
        .unwrap();
    drop(socket);
    assert_eq!(r.recover().await.unwrap(), 0);
    let seen: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(seen["command"], "recover");
    assert_eq!(seen["resend"], true);
    assert_eq!(
        r.journal.jobs().next().unwrap().1.attempts.last(),
        Some(&upload)
    );
    r.journal
        .enqueue_current(cut, vec![], 2, BTreeSet::new())
        .unwrap();
    assert_eq!(r.recover().await.unwrap(), 0);
    let seen: Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(seen["command"], "recover");
    assert_eq!(
        r.journal.jobs().next().unwrap().1.attempts.last(),
        Some(&upload)
    );
    worker.abort();
}
