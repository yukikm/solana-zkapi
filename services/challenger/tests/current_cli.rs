//! New setup entry points, real local SBF pins, no history/DB/sign/send.
#[path = "../../indexer/tests/support/current.rs"]
mod support;
use serde_json::{json, Value};
use support::*;

#[tokio::test]
async fn init_and_status_use_v3_and_refuse_legacy_config_without_rpc() {
    let f = Fixture::load("close", "mutual_close");
    let dir = tempfile::tempdir().unwrap();
    let server = mock(|_| panic!("init/status must not contact RPC")).await;
    let config = f.config(dir.path(), server.url.clone());
    let path = dir.path().join("challenger.json");
    let journal = dir.path().join("journal");
    let mut value = json!({
        "config_version":2,
        "chain_state":{"mode":"account_state_poc_v1","state_socket":config.chain_state.state_socket},
        "program_identity":config.program_identity,
        "manifest":config.manifest,"manifest_sha256":config.manifest_sha256,
        "rpc_url":server.url,"database_dsn_file":dir.path().join("absent.dsn"),
        "journal_directory":journal,"tree_pk":dir.path().join("absent.pk"),
        "node":"/unused/node","transport_bridge":"/unused/bridge",
        "transport_bridge_sha256":"00".repeat(32),
        "fee_key_file":dir.path().join("absent-key"),"payer":b58([10;32])
    });
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let run = |command| {
        std::process::Command::new(env!("CARGO_BIN_EXE_challengerd"))
            .args([command, path.to_str().unwrap()])
            .output()
            .unwrap()
    };
    assert!(run("init").status.success());
    assert!(
        zkapi_challenger::journal::Journal::open_current(&journal, key(&f.trusted.pool)).is_ok()
    );
    assert!(
        !run("init").status.success(),
        "never overwrite a financial journal"
    );
    let status = run("status");
    assert!(status.status.success());
    let metrics: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(metrics["pending_jobs"], 0);
    assert_eq!(metrics["unknown_signatures"], 0);
    value.as_object_mut().unwrap().remove("config_version");
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(
        !run("status").status.success(),
        "no implicit legacy fallback"
    );
    assert!(server.calls.lock().unwrap().is_empty());
}
