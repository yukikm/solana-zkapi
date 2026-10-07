//! Offline public-artifact/config tests. Synthetic ELF bytes exercise hash pins,
//! not deployed SBF execution. No fee/control/provider key or public RPC is read.
use super::*;
use std::path::Path;
use zkapi_control::{
    chain::{DeploymentEnvironment, DEVNET_GENESIS, DEVNET_USDC_MINT},
    config::DevnetConfig,
};

fn repin(manifest: &mut Value) -> Hash {
    let mut body = manifest.as_object().unwrap().clone();
    body.remove("manifest_hash");
    body.remove("manifest_signature");
    let digest = sha(&serde_jcs::to_vec(&body).unwrap());
    manifest["manifest_hash"] = hex::encode(digest).into();
    digest
}
fn bind(manifest: &mut Value) {
    manifest["vault_binding"] = serde_json::to_value(zkapi_solana_types::binding::vault_binding(
        &wire::pubkey(manifest["genesis_hash"].as_str().unwrap()).unwrap(),
        &wire::pubkey(manifest["program_id"].as_str().unwrap()).unwrap(),
        &wire::pubkey(manifest["pool"].as_str().unwrap()).unwrap(),
        &wire::pubkey(manifest["token_program"].as_str().unwrap()).unwrap(),
        &wire::pubkey(manifest["mint"].as_str().unwrap()).unwrap(),
    ))
    .unwrap();
}
fn save_build(manifest: &mut Value, devnet: &mut DevnetConfig, build: &Value) {
    let bytes = serde_json::to_vec(build).unwrap();
    std::fs::write(&devnet.build_manifest_file, &bytes).unwrap();
    devnet.trusted_build_manifest_hash = hex::encode(sha(&bytes));
    manifest["artifact_digests"]["devnet_build_manifest"] =
        devnet.trusted_build_manifest_hash.clone().into();
}
fn fixture(dir: &Path) -> (Value, DevnetConfig) {
    let (_, mut manifest) = trust_and_manifest();
    manifest["deployment_environment"] = "devnet".into();
    manifest["program_id"] = zkapi_indexer::snapshot::key([71; 32]).into();
    manifest["genesis_hash"] = DEVNET_GENESIS.into();
    manifest["mint"] = DEVNET_USDC_MINT.into();
    for name in [
        "control_api_origin",
        "inference_api_origin",
        "proving_keys_base_url",
    ] {
        manifest[name] = "https://127.0.0.1:8788".into();
    }
    bind(&mut manifest);
    let mut idl: Value =
        serde_json::from_str(include_str!("../../../../docs/contracts/zkapi_vault.json")).unwrap();
    idl["address"] = manifest["program_id"].clone();
    let idl = serde_json::to_vec(&idl).unwrap();
    let program = b"\x7fELFoffline-challenger-hash-fixture";
    let mut devnet = DevnetConfig {
        public_profile_file: None,
        trusted_public_profile_hash: None,
        idl_file: dir.join("idl.json"),
        program_file: dir.join("vault.so"),
        build_manifest_file: dir.join("build.json"),
        trusted_build_manifest_hash: String::new(),
    };
    std::fs::write(&devnet.idl_file, &idl).unwrap();
    std::fs::write(&devnet.program_file, program).unwrap();
    manifest["idl_hash"] = hex::encode(sha(&idl)).into();
    manifest["artifact_digests"] = json!({"vault_program":hex::encode(sha(program))});
    let mut build = json!({"schema":1,"deployment_environment":"devnet","setup_profile":"test_only",
        "deployment_authority":zkapi_indexer::snapshot::key([73;32]),
        "idl_sha256":hex::encode(sha(&idl)),"program_sha256":hex::encode(sha(program))});
    for name in [
        "program_id",
        "genesis_hash",
        "mint",
        "token_program",
        "state_key",
        "clearance_key",
        "circuit_profile_hash",
    ] {
        build[name] = manifest[name].clone();
    }
    save_build(&mut manifest, &mut devnet, &build);
    repin(&mut manifest);
    (manifest, devnet)
}
fn runtime_config(dir: &Path, manifest: &Value, devnet: Option<DevnetConfig>) -> runtime::Config {
    let path = dir.join("manifest.json");
    std::fs::write(&path, serde_json::to_vec(manifest).unwrap()).unwrap();
    runtime::Config {
        manifest: path,
        manifest_sha256: manifest["manifest_hash"].as_str().unwrap().into(),
        devnet,
        rpc_url: "https://devnet.invalid".into(),
        database_dsn_file: dir.join("absent-dsn"),
        start_slot: 1,
        journal_directory: dir.join("journal"),
        tree_pk: dir.join("absent-tree-pk"),
        node: "/absent/node".into(),
        transport_bridge: dir.join("absent-bridge"),
        transport_bridge_sha256: "00".repeat(32),
        fee_key_file: dir.join("absent-fee-key"),
        payer: zkapi_indexer::snapshot::key([7; 32]),
        poll_seconds: 1,
        alert_sink_directory: None,
        priority_fee: None,
        archive_batch: None,
    }
}
#[test]
fn devnet_explicit_trust_and_local_default_need_no_signing_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let (mut manifest, devnet) = fixture(dir.path());
    let pin = repin(&mut manifest);
    assert!(Trust::from_pinned_manifest(&manifest, pin).is_err());
    let trust = Trust::from_pinned_devnet_manifest(&manifest, pin, &devnet).unwrap();
    assert_eq!(
        trust.pool.deployment_environment,
        DeploymentEnvironment::Devnet
    );
    let config = runtime_config(dir.path(), &manifest, Some(devnet));
    let daemon = runtime::Runtime::open(config.clone(), true).unwrap();
    drop(daemon);
    runtime::Runtime::open(config.clone(), false).unwrap();
    assert!(!config.fee_key_file.exists());
    assert!(!config.database_dsn_file.exists());
    let mut implicit = config;
    implicit.devnet = None;
    assert!(implicit.trust().is_err());
    let (_, local) = trust_and_manifest();
    let config = runtime_config(dir.path(), &local, None);
    let mut json = serde_json::to_value(&config).unwrap();
    json.as_object_mut().unwrap().remove("devnet");
    let legacy: runtime::Config = serde_json::from_value(json).unwrap();
    assert_eq!(
        legacy.trust().unwrap().pool.deployment_environment,
        DeploymentEnvironment::Local
    );
}
#[test]
fn devnet_rejects_repinned_wrong_chain_profile_and_signing_roles() {
    let dir = tempfile::tempdir().unwrap();
    for (name, value) in [
        ("deployment_environment", json!("mainnet")),
        ("deployment_environment", json!("local")),
        ("setup_profile", json!("ceremony_verified")),
        (
            "genesis_hash",
            json!(zkapi_indexer::snapshot::key([81; 32])),
        ),
        ("mint", json!(zkapi_indexer::snapshot::key([82; 32]))),
        (
            "token_program",
            json!(zkapi_indexer::snapshot::key([83; 32])),
        ),
        ("state_key", json!({"x":"0x01","y":"0x02"})),
        ("clearance_key", json!({"x":"0x01","y":"0x02"})),
        ("circuit_profile_hash", json!("00".repeat(32))),
    ] {
        let (mut manifest, mut devnet) = fixture(dir.path());
        manifest[name] = match name {
            "state_key" => manifest["clearance_key"].clone(),
            "clearance_key" => manifest["state_key"].clone(),
            _ => value,
        };
        bind(&mut manifest);
        let mut build: Value =
            serde_json::from_slice(&std::fs::read(&devnet.build_manifest_file).unwrap()).unwrap();
        build[name] = manifest[name].clone();
        save_build(&mut manifest, &mut devnet, &build);
        let pin = repin(&mut manifest);
        assert!(
            Trust::from_pinned_devnet_manifest(&manifest, pin, &devnet).is_err(),
            "{name}"
        );
    }
}
#[test]
fn devnet_rejects_corrupt_or_repinned_different_build_wire_and_external_pins() {
    let dir = tempfile::tempdir().unwrap();
    for target in ["idl", "program", "build"] {
        let (mut manifest, devnet) = fixture(dir.path());
        let path = match target {
            "idl" => &devnet.idl_file,
            "program" => &devnet.program_file,
            _ => &devnet.build_manifest_file,
        };
        std::fs::write(path, b"changed").unwrap();
        let pin = repin(&mut manifest);
        assert!(
            Trust::from_pinned_devnet_manifest(&manifest, pin, &devnet).is_err(),
            "{target}"
        );
    }
    for mutation in [
        "wire",
        "address",
        "initializer",
        "external-build",
        "external-manifest",
    ] {
        let (mut manifest, mut devnet) = fixture(dir.path());
        let mut build: Value =
            serde_json::from_slice(&std::fs::read(&devnet.build_manifest_file).unwrap()).unwrap();
        if mutation == "wire" || mutation == "address" {
            let mut idl: Value =
                serde_json::from_slice(&std::fs::read(&devnet.idl_file).unwrap()).unwrap();
            if mutation == "wire" {
                idl["instructions"][0]["name"] = "different_wire".into();
            } else {
                idl["address"] = zkapi_indexer::snapshot::key([84; 32]).into();
            }
            let bytes = serde_json::to_vec(&idl).unwrap();
            std::fs::write(&devnet.idl_file, &bytes).unwrap();
            build["idl_sha256"] = hex::encode(sha(&bytes)).into();
            manifest["idl_hash"] = build["idl_sha256"].clone();
        } else if mutation == "initializer" {
            build["deployment_authority"] = zkapi_indexer::snapshot::key([0; 32]).into();
        }
        save_build(&mut manifest, &mut devnet, &build);
        let mut pin = repin(&mut manifest);
        if mutation == "external-build" {
            devnet.trusted_build_manifest_hash = "00".repeat(32);
        }
        if mutation == "external-manifest" {
            pin = [0; 32];
            devnet.build_manifest_file = dir.path().join("absent-build");
        }
        let result = Trust::from_pinned_devnet_manifest(&manifest, pin, &devnet);
        assert!(result.is_err(), "{mutation}");
        if mutation == "external-manifest" {
            assert!(matches!(
                result,
                Err(Error::Evidence("distribution manifest hash"))
            ));
        }
    }
}
#[test]
fn devnet_requires_https_rpc_and_unix_readonly_database_without_changing_local_policy() {
    let dir = tempfile::tempdir().unwrap();
    let (mut manifest, devnet) = fixture(dir.path());
    let pin = repin(&mut manifest);
    let trust = Trust::from_pinned_devnet_manifest(&manifest, pin, &devnet).unwrap();
    let config = runtime_config(dir.path(), &manifest, Some(devnet.clone()));
    for rpc in [
        "http://127.0.0.1:8899",
        "http://devnet.invalid",
        "https://user:secret@devnet.invalid",
        "https://devnet.invalid/#fragment",
    ] {
        let mut invalid = config.clone();
        invalid.rpc_url = rpc.into();
        assert!(invalid.trust().is_err(), "{rpc}");
    }
    for name in [
        "control_api_origin",
        "inference_api_origin",
        "proving_keys_base_url",
    ] {
        let mut invalid = manifest.clone();
        invalid[name] = "http://127.0.0.1:8788".into();
        let pin = repin(&mut invalid);
        assert!(
            Trust::from_pinned_devnet_manifest(&invalid, pin, &devnet).is_err(),
            "{name}"
        );
    }
    assert!(read_model::trusted_config("host=/tmp/devnet-pg user=reader", &trust).is_ok());
    for dsn in [
        "user=reader",
        "host=localhost user=reader",
        "hostaddr=127.0.0.1 user=reader",
        "host=/tmp hostaddr=127.0.0.1 user=reader",
        "host=/tmp,localhost user=reader",
        "host=remote.invalid user=reader",
    ] {
        assert!(read_model::trusted_config(dsn, &trust).is_err(), "{dsn}");
    }
    let (local, _) = trust_and_manifest();
    assert!(read_model::trusted_config("host=localhost user=reader", &local).is_ok());
}
