//! Explicit offline migration entrypoint. Synthetic archive only; no keys,
//! signing, provider calls, finalized RPC evidence or financial acceptance.
use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use zkapi_challenger::{journal::Journal, runtime::Config, sha, Trust};
use zkapi_indexer::{snapshot::key, FinalizedBlock};

fn fixture_config(directory: &Path, rpc_url: String) -> (Config, [u8; 32]) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let a: Value =
        serde_json::from_slice(&std::fs::read(root.join("tests/fixtures/vault/a.json")).unwrap())
            .unwrap();
    let h = |v: &Value| -> [u8; 32] {
        hex::decode(v.as_str().unwrap().trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap()
    };
    let b58 = |v: &Value| key(h(v));
    let p = &a["auth"]["request"]["public_inputs"];
    let mut manifest: Value = serde_json::from_slice(
        &std::fs::read(root.join("tests/fixtures/layout2/profile.json")).unwrap(),
    )
    .unwrap();
    for (name, value) in json!({
        "program_id":b58(&a["program_id"]),"pool":b58(&a["pool"]),"genesis_hash":b58(&a["genesis"]),"mint":b58(&a["mint"]),
        "token_program":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","vault_binding":p[2],"state_key":{"x":p[4],"y":p[5]},
        "clearance_key":{"x":a["auth"]["escape"]["public_inputs"][6],"y":a["auth"]["escape"]["public_inputs"][7]},
        "cap_micro_usdc":"1000000","note_ttl_seconds":"2592000","challenge_seconds":"86400","decimals":6,
        "deployment_environment":"local","transaction_formats":["v0_buffer"],"deployment_id":"migration-cli-test"
    }).as_object().unwrap() { manifest[name]=value.clone(); }
    let pin = sha(&serde_jcs::to_vec(&manifest).unwrap());
    manifest["manifest_hash"] = hex::encode(pin).into();
    let trust = Trust::from_pinned_manifest(&manifest, pin).unwrap();
    let manifest_path = directory.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    (
        Config {
            manifest: manifest_path,
            manifest_sha256: hex::encode(pin),
            devnet: None,
            rpc_url,
            database_dsn_file: directory.join("ABSENT_DATABASE_SECRET"),
            start_slot: 1,
            journal_directory: directory.join("journal"),
            tree_pk: directory.join("ABSENT_PROVING_KEY"),
            node: directory.join("ABSENT_NODE"),
            transport_bridge: directory.join("ABSENT_BRIDGE"),
            transport_bridge_sha256: hex::encode([0; 32]),
            fee_key_file: directory.join("ABSENT_FEE_SECRET"),
            payer: key([7; 32]),
            poll_seconds: 1,
            alert_sink_directory: None,
            priority_fee: None,
            archive_batch: None,
        },
        trust.pool(),
    )
}
async fn invoke(config: &Config, command: &str) -> std::process::Output {
    let path = config
        .journal_directory
        .parent()
        .unwrap()
        .join("config.json");
    std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_challengerd"))
            .kill_on_drop(true)
            .arg(command)
            .arg(path)
            .output(),
    )
    .await
    .unwrap()
    .unwrap()
}
fn block(slot: u64) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: slot,
        transactions: vec![],
    }
}

#[tokio::test]
async fn cli_migration_is_explicit_offline_and_preserves_exact_v1_and_archive() {
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/",
                post(move || {
                    let seen = seen.clone();
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        Json(json!({"error":"fixture must never be called"}))
                    }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let directory = tempfile::tempdir().unwrap();
    let (config, pool) = fixture_config(directory.path(), format!("http://{address}"));
    drop(Journal::initialize(&config.journal_directory, pool).unwrap());
    let initial = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
    let status = invoke(&config, "status").await;
    assert!(status.status.success());
    assert_eq!(
        std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
        initial
    );
    assert!(
        !config.journal_directory.join("archive-v2").exists(),
        "ordinary open must not migrate"
    );
    let mut journal = Journal::open(&config.journal_directory, pool).unwrap();
    journal
        .append_archive_batch(vec![block(1), block(2)])
        .unwrap();
    drop(journal);
    let before = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
    let migrated = invoke(&config, "migrate-archive").await;
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    let report: Value = serde_json::from_slice(&migrated.stdout).unwrap();
    assert_eq!(report["format_version"], 2);
    assert_eq!(report["archive_blocks"], 2);
    assert_eq!(report["legacy_bytes"], before.len());
    assert_eq!(report["legacy_sha256"], json!(sha(&before)));
    assert_eq!(
        report.as_object().unwrap().len(),
        7,
        "report contains only fixed redacted metadata"
    );
    assert_eq!(
        std::fs::read(config.journal_directory.join("legacy-v1.json")).unwrap(),
        before
    );
    let journal = Journal::open(&config.journal_directory, pool).unwrap();
    let mut replayed = Vec::new();
    journal
        .replay_archive(|block| {
            replayed.push(block.clone());
            Ok(())
        })
        .unwrap();
    assert_eq!(replayed, [block(1), block(2)]);
    drop(journal);
    let after = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
    assert!(
        !invoke(&config, "migrate-archive").await.status.success(),
        "a second migration must refuse"
    );
    assert_eq!(
        std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
        after
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    server.abort();
    for path in [
        &config.database_dsn_file,
        &config.fee_key_file,
        &config.tree_pk,
        &config.node,
        &config.transport_bridge,
    ] {
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn cli_migration_refuses_owner_conflict_wrong_pool_and_existing_staging_without_replacement()
{
    for mode in ["owner", "pool", "archive-staging", "legacy-staging"] {
        let directory = tempfile::tempdir().unwrap();
        let (config, pool) = fixture_config(directory.path(), "http://127.0.0.1:1".into());
        let journal = Journal::initialize(
            &config.journal_directory,
            if mode == "pool" { [77; 32] } else { pool },
        )
        .unwrap();
        let before = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
        let owner = if mode == "owner" {
            Some(journal)
        } else {
            drop(journal);
            None
        };
        if mode == "archive-staging" {
            std::fs::create_dir(config.journal_directory.join("archive-v2")).unwrap();
            std::fs::write(
                config.journal_directory.join("archive-v2/retained-failure"),
                b"preserve partial attempt",
            )
            .unwrap();
        }
        if mode == "legacy-staging" {
            std::fs::write(
                config.journal_directory.join("legacy-v1.json"),
                b"preserve earlier bytes",
            )
            .unwrap();
        }
        assert!(!invoke(&config, "migrate-archive").await.status.success());
        assert_eq!(
            std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
            before
        );
        if mode == "archive-staging" {
            assert_eq!(
                std::fs::read(config.journal_directory.join("archive-v2/retained-failure"))
                    .unwrap(),
                b"preserve partial attempt"
            );
        }
        if mode == "legacy-staging" {
            assert_eq!(
                std::fs::read(config.journal_directory.join("legacy-v1.json")).unwrap(),
                b"preserve earlier bytes"
            );
        }
        drop(owner);
    }
}
