//! Offline profile validation plus an isolated PostgreSQL scope check.
//! Synthetic ELF bytes test hash binding, not
//! SBF execution or a public deployment. No RPC or signing key from the user.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path};
use zkapi_control::{
    chain::{ChainClient, DeploymentEnvironment, TrustedPool, DEVNET_GENESIS, DEVNET_USDC_MINT},
    config::{DevnetConfig, RuntimeConfig},
    crypto::{deployment_keys, role_key},
    wire,
};

fn hash(bytes: &[u8]) -> String {
    hex::encode(wire::sha256(bytes))
}
fn repin(config: &mut RuntimeConfig) {
    let mut body = config.manifest.clone();
    body.as_object_mut().unwrap().remove("manifest_hash");
    body.as_object_mut().unwrap().remove("manifest_signature");
    config.trusted_manifest_hash = hash(&serde_jcs::to_vec(&body).unwrap());
    config.manifest["manifest_hash"] = config.trusted_manifest_hash.clone().into();
}
fn fixture(dir: &Path, devnet: bool) -> RuntimeConfig {
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut manifest: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json")).unwrap();
    let point = |key| {
        let [x, y] = role_key(key).unwrap();
        json!({"x":x,"y":y})
    };
    let genesis = if devnet {
        DEVNET_GENESIS.to_string()
    } else {
        bs58::encode([0; 32]).into_string()
    };
    let mint = if devnet {
        DEVNET_USDC_MINT.to_string()
    } else {
        bs58::encode([4; 32]).into_string()
    };
    let program = bs58::encode(if devnet { [71; 32] } else { [43; 32] }).into_string();
    let pool = bs58::encode([72; 32]).into_string();
    let token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    let binding = zkapi_solana_types::binding::vault_binding(
        &wire::pubkey(&genesis).unwrap(),
        &wire::pubkey(&program).unwrap(),
        &wire::pubkey(&pool).unwrap(),
        &wire::pubkey(token).unwrap(),
        &wire::pubkey(&mint).unwrap(),
    );
    manifest.as_object_mut().unwrap().extend(json!({
        "deployment_id":"offline-profile-test", "deployment_environment":if devnet {"devnet"} else {"local"},
        "program_id":program,"pool":pool,"genesis_hash":genesis,"mint":mint,"token_program":token,
        "decimals":6,"vault_binding":binding,"state_key":point(&deployment_keys::STATE_KEY),
        "clearance_key":point(&deployment_keys::CLEARANCE_KEY),"cap_micro_usdc":"1000000",
        "note_ttl_seconds":"3600","challenge_seconds":"60","transaction_formats":["v0_buffer"],
        "quote_public_key":bs58::encode(SigningKey::from_bytes(&[11;32]).verifying_key().to_bytes()).into_string(),
        "receipt_public_key":bs58::encode(SigningKey::from_bytes(&[12;32]).verifying_key().to_bytes()).into_string(),
        "control_api_origin":"http://127.0.0.1:8788","inference_api_origin":"http://127.0.0.1:8789",
        "manifest_signature":STANDARD.encode([0;64]),"db_schema_version":"2","tariff_hashes":[],
        "api_endpoints":[],"proving_keys_base_url":"http://127.0.0.1:8788/keys","authorities":{},
        "artifact_digests":{},"idl_hash":hash(include_bytes!("../../../docs/contracts/zkapi_vault.json"))
    }).as_object().unwrap().clone());
    for (name, seed) in [("quote.seed", 11), ("receipt.seed", 12)] {
        let path = dir.join(name);
        std::fs::write(&path, [seed; 32]).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut config = RuntimeConfig {
        local_test_only: true,
        devnet: None,
        listen: "127.0.0.1:0".parse().unwrap(),
        manifest,
        trusted_manifest_hash: String::new(),
        primary_rpc: "https://primary.invalid".into(),
        secondary_rpc: "https://secondary.invalid".into(),
        indexer_origin: "http://127.0.0.1:8787".into(),
        signer_socket: dir.join("signer.sock"),
        quote_seed_file: dir.join("quote.seed"),
        receipt_seed_file: dir.join("receipt.seed"),
        enable_local_adapter: false,
        providers: Default::default(),
        tariffs: vec![],
    };
    if devnet {
        config.manifest["control_api_origin"] = "https://127.0.0.1:8788".into();
        config.manifest["inference_api_origin"] = "https://127.0.0.1:8789".into();
        config.manifest["proving_keys_base_url"] = "https://127.0.0.1:8788/keys".into();
        let mut idl: Value =
            serde_json::from_slice(include_bytes!("../../../docs/contracts/zkapi_vault.json"))
                .unwrap();
        idl["address"] = config.manifest["program_id"].clone();
        let idl = serde_json::to_vec(&idl).unwrap();
        let program = b"\x7fELFoffline-hash-fixture";
        let mut build = json!({"schema":1,"deployment_environment":"devnet","setup_profile":"test_only",
            "deployment_authority":bs58::encode([73;32]).into_string(),"idl_sha256":hash(&idl),"program_sha256":hash(program)});
        for name in [
            "program_id",
            "genesis_hash",
            "mint",
            "token_program",
            "state_key",
            "clearance_key",
            "circuit_profile_hash",
        ] {
            build[name] = config.manifest[name].clone();
        }
        let build_bytes = serde_json::to_vec(&build).unwrap();
        let build_hash = hash(&build_bytes);
        std::fs::write(dir.join("devnet-idl.json"), &idl).unwrap();
        std::fs::write(dir.join("vault.so"), program).unwrap();
        std::fs::write(dir.join("build.json"), build_bytes).unwrap();
        config.manifest["idl_hash"] = hash(&idl).into();
        config.manifest["artifact_digests"] =
            json!({"vault_program":hash(program),"devnet_build_manifest":build_hash});
        config.devnet = Some(DevnetConfig {
            idl_file: dir.join("devnet-idl.json"),
            program_file: dir.join("vault.so"),
            build_manifest_file: dir.join("build.json"),
            trusted_build_manifest_hash: build_hash,
        });
    }
    repin(&mut config);
    config
}

#[test]
fn local_default_and_explicit_devnet_test_profiles_validate_without_network() {
    let dir = tempfile::tempdir().unwrap();
    let local = fixture(dir.path(), false);
    let mut json = serde_json::to_value(&local).unwrap();
    json.as_object_mut().unwrap().remove("devnet");
    let legacy: RuntimeConfig = serde_json::from_value(json).unwrap();
    assert_eq!(
        legacy.validate().unwrap().trusted.deployment_environment,
        DeploymentEnvironment::Local
    );
    let mut custom_local = TrustedPool::from_manifest(&local.manifest).unwrap();
    custom_local.genesis_hash = bs58::encode([76; 32]).into_string();
    custom_local.mint = bs58::encode([77; 32]).into_string();
    custom_local.vault_binding = zkapi_solana_types::binding::vault_binding(
        &wire::pubkey(&custom_local.genesis_hash).unwrap(),
        &wire::pubkey(&custom_local.program_id).unwrap(),
        &wire::pubkey(&custom_local.pool).unwrap(),
        &wire::pubkey(&custom_local.token_program).unwrap(),
        &wire::pubkey(&custom_local.mint).unwrap(),
    );
    custom_local.validate().unwrap();
    let config = fixture(dir.path(), true);
    let validated = config.clone().validate().unwrap();
    assert_eq!(
        validated.trusted.deployment_environment,
        DeploymentEnvironment::Devnet
    );
    assert!(validated
        .validate_database("host=/tmp/devnet-pg user=test dbname=test")
        .is_ok());
    for dsn in [
        "host=127.0.0.1 user=test",
        "host=remote.invalid user=test",
        "user=test",
        "host=/tmp/devnet-pg hostaddr=127.0.0.1 user=test",
    ] {
        assert!(validated.validate_database(dsn).is_err(), "{dsn}");
    }
    assert!(TrustedPool::from_manifest(&config.manifest).is_err());
    let mut implicit = config;
    implicit.devnet = None;
    assert!(implicit.validate().is_err());
}

#[test]
fn public_provider_dispatcher_requires_pinned_devnet_and_prohibits_fixture_egress() {
    use zkapi_control::{
        direct::DirectConfig,
        egress::{DevnetProviderScope, ServiceConfig},
        provider_runtime::ProxyProviderConfig,
    };
    let dir = tempfile::tempdir().unwrap();
    let runtime = fixture(dir.path(), true);
    let credential = dir.path().join("provider-credential");
    std::fs::write(&credential, b"offline-test-only").unwrap();
    std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut config = ServiceConfig {
        local_test_only: false,
        devnet: Some(DevnetProviderScope {
            deployment: runtime.devnet.unwrap(),
            manifest: runtime.manifest.clone(),
            trusted_manifest_hash: runtime.trusted_manifest_hash,
        }),
        database_url: "host=/tmp/devnet-fixture user=reader".into(),
        pool: wire::pubkey(runtime.manifest["pool"].as_str().unwrap()).unwrap(),
        claims_directory: dir.path().join("claims"),
        providers: Default::default(),
    };
    config.providers.direct.push(DirectConfig::Openrouter {
        api_base: "https://openrouter.ai/api/v1".into(),
        credential_file: credential.clone(),
        inference_base: "https://openrouter.ai/api/v1".into(),
        settlement_grace_seconds: 60,
    });
    config.validate_scope().unwrap(); // No database connection, RPC or provider request.
    for change in [
        "missing-scope",
        "ambiguous",
        "mainnet",
        "pin",
        "pool",
        "tcp",
        "fixture-proxy",
        "fixture-direct",
        "short-drain",
    ] {
        let mut changed = config.clone();
        match change {
            "missing-scope" => changed.devnet = None,
            "ambiguous" => changed.local_test_only = true,
            "mainnet" => {
                let scope = changed.devnet.as_mut().unwrap();
                scope.manifest["deployment_environment"] = "mainnet".into();
                let mut body = scope.manifest.clone();
                body.as_object_mut().unwrap().remove("manifest_hash");
                body.as_object_mut().unwrap().remove("manifest_signature");
                scope.trusted_manifest_hash = hash(&serde_jcs::to_vec(&body).unwrap());
                scope.manifest["manifest_hash"] = scope.trusted_manifest_hash.clone().into();
            }
            "pin" => changed.devnet.as_mut().unwrap().trusted_manifest_hash = "00".repeat(32),
            "pool" => changed.pool = [91; 32],
            "tcp" => changed.database_url = "host=127.0.0.1 user=reader".into(),
            "fixture-proxy" => changed.providers.proxy.push(ProxyProviderConfig {
                provider: wire::Provider::Openai,
                credential_file: credential.clone(),
                local_test_base: Some("http://127.0.0.1:9999".into()),
                models: vec![],
            }),
            "fixture-direct" => {
                if let DirectConfig::Openrouter { api_base, .. } = &mut changed.providers.direct[0]
                {
                    *api_base = "http://127.0.0.1:9999".into();
                }
            }
            "short-drain" => {
                if let DirectConfig::Openrouter {
                    settlement_grace_seconds,
                    ..
                } = &mut changed.providers.direct[0]
                {
                    *settlement_grace_seconds = 0;
                }
            }
            _ => unreachable!(),
        }
        assert!(changed.validate_scope().is_err(), "{change}");
    }
    let mut legacy = serde_json::to_value(&config).unwrap();
    legacy.as_object_mut().unwrap().remove("devnet");
    legacy["local_test_only"] = true.into();
    serde_json::from_value::<ServiceConfig>(legacy)
        .unwrap()
        .validate_scope()
        .unwrap();
}

#[test]
fn deployment_setup_chain_and_live_service_policy_cannot_be_reinterpreted() {
    let dir = tempfile::tempdir().unwrap();
    let config = fixture(dir.path(), true);
    for (field, value) in [
        ("deployment_environment", "mainnet"),
        ("deployment_environment", "local"),
        ("setup_profile", "ceremony_verified"),
        ("genesis_hash", "11111111111111111111111111111111"),
        ("mint", "11111111111111111111111111111111"),
        ("program_id", "3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ"),
    ] {
        let mut changed = config.clone();
        changed.manifest[field] = value.into();
        repin(&mut changed);
        assert!(changed.validate().is_err(), "{field}={value}");
    }
    let mut changed = config.clone();
    changed.local_test_only = false;
    assert!(changed.validate().is_err());
    let mut changed = config.clone();
    changed.listen = "0.0.0.0:8788".parse().unwrap();
    assert!(changed.validate().is_err());
    let mut changed = config.clone();
    changed.primary_rpc = "http://primary.invalid".into();
    assert!(changed.validate().is_err());
    let mut changed = config.clone();
    changed.secondary_rpc = "https://primary.invalid/other-key".into();
    assert!(changed.validate().is_err());
    let mut changed = config.clone();
    changed.indexer_origin = "https://indexer.invalid".into();
    assert!(changed.validate().is_err());
    for name in [
        "control_api_origin",
        "inference_api_origin",
        "proving_keys_base_url",
    ] {
        let mut changed = config.clone();
        changed.manifest[name] = "http://127.0.0.1:8788".into();
        repin(&mut changed);
        assert!(changed.validate().is_err(), "{name}");
    }
    let mut changed = config;
    changed.signer_socket = "relative.sock".into();
    assert!(changed.validate().is_err());
}

#[test]
fn public_build_idl_program_and_role_pin_changes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    for filename in ["devnet-idl.json", "vault.so", "build.json"] {
        let config = fixture(dir.path(), true);
        std::fs::write(dir.path().join(filename), b"changed").unwrap();
        assert!(config.validate().is_err(), "{filename}");
    }
    let config = fixture(dir.path(), true);
    for name in ["vault_program", "devnet_build_manifest"] {
        let mut changed = config.clone();
        changed.manifest["artifact_digests"][name] = "00".repeat(32).into();
        repin(&mut changed);
        assert!(changed.validate().is_err(), "{name}");
    }
    // Even a newly operator-pinned build cannot change the trusted role keys,
    // wrong IDL address or fixed instruction/account schema.
    for mutation in ["role", "address", "wire"] {
        let mut changed = fixture(dir.path(), true);
        let mut build: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("build.json")).unwrap()).unwrap();
        if mutation == "role" {
            build["state_key"] = build["clearance_key"].clone();
            changed.manifest["state_key"] = build["state_key"].clone();
        } else {
            let mut idl: Value =
                serde_json::from_slice(&std::fs::read(dir.path().join("devnet-idl.json")).unwrap())
                    .unwrap();
            if mutation == "address" {
                idl["address"] = bs58::encode([74; 32]).into_string().into();
            } else {
                idl["instructions"][0]["name"] = "changed_wire".into();
            }
            let bytes = serde_json::to_vec(&idl).unwrap();
            std::fs::write(dir.path().join("devnet-idl.json"), &bytes).unwrap();
            build["idl_sha256"] = hash(&bytes).into();
            changed.manifest["idl_hash"] = hash(&bytes).into();
        }
        let bytes = serde_json::to_vec(&build).unwrap();
        std::fs::write(dir.path().join("build.json"), &bytes).unwrap();
        changed.devnet.as_mut().unwrap().trusted_build_manifest_hash = hash(&bytes);
        changed.manifest["artifact_digests"]["devnet_build_manifest"] = hash(&bytes).into();
        repin(&mut changed);
        assert!(changed.validate().is_err(), "{mutation}");
    }
}

#[test]
fn devnet_chain_profile_checks_binding_and_transport_independently() {
    let dir = tempfile::tempdir().unwrap();
    let config = fixture(dir.path(), true);
    let trusted = TrustedPool::from_devnet_manifest(&config.manifest).unwrap();
    assert!(TrustedPool::from_manifest(&config.manifest).is_err());
    for field in ["genesis", "mint", "token"] {
        let mut changed = trusted.clone();
        let wrong = bs58::encode([76; 32]).into_string();
        match field {
            "genesis" => changed.genesis_hash = wrong,
            "mint" => changed.mint = wrong,
            _ => changed.token_program = wrong,
        }
        changed.vault_binding = zkapi_solana_types::binding::vault_binding(
            &wire::pubkey(&changed.genesis_hash).unwrap(),
            &wire::pubkey(&changed.program_id).unwrap(),
            &wire::pubkey(&changed.pool).unwrap(),
            &wire::pubkey(&changed.token_program).unwrap(),
            &wire::pubkey(&changed.mint).unwrap(),
        );
        assert!(changed.validate().is_err(), "{field}");
    }
    let mut changed = trusted.clone();
    changed.pool = bs58::encode([75; 32]).into_string();
    assert!(changed.validate().is_err());
    assert!(ChainClient::new(
        "https://rpc.invalid/a".into(),
        "https://RPC.invalid:443/b".into(),
        config.indexer_origin,
        trusted
    )
    .is_err());
}

#[tokio::test]
#[ignore = "requires disposable Unix ZKAPI_TEST_DATABASE_URL; no RPC/provider call"]
async fn dispatcher_refuses_same_pool_database_with_other_manifest_or_deployment() {
    use zkapi_control::{
        direct::KeyReference,
        egress::{self, Action, DevnetProviderScope, Request, ServiceConfig},
    };
    let base = std::env::var("ZKAPI_TEST_DATABASE_URL").expect("disposable local PG required");
    let source: tokio_postgres::Config = base.parse().unwrap();
    assert!(source.get_hostaddrs().is_empty());
    assert!(source
        .get_hosts()
        .iter()
        .all(|h| matches!(h, tokio_postgres::config::Host::Unix(_))));
    let (admin, connection) = source.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let reader = format!("i10_scope_reader_{suffix}");
    admin
        .batch_execute(&format!("CREATE ROLE {reader} LOGIN NOINHERIT"))
        .await
        .unwrap();
    let host = match source.get_hosts().first().unwrap() {
        tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
        _ => unreachable!(),
    };
    let port = source.get_ports().first().copied().unwrap_or(5432);
    let dir = tempfile::tempdir().unwrap();
    let runtime = fixture(dir.path(), true);
    let manifest_hash = wire::hash(&runtime.trusted_manifest_hash).unwrap();
    let pool = wire::pubkey(runtime.manifest["pool"].as_str().unwrap()).unwrap();
    let deployment = runtime.manifest["deployment_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let request = || Request {
        provider: wire::Provider::Openrouter,
        action: Action::Disable {
            reference: KeyReference {
                key_ref: "never-dispatched".into(),
                expires_at: 1,
                station_id: None,
            },
        },
    };
    for (case, identity) in [
        ("missing", None),
        ("matching", Some((deployment.clone(), manifest_hash))),
        ("other_manifest", Some((deployment.clone(), [99; 32]))),
        (
            "other_deployment",
            Some(("same-pool-other-deployment".into(), manifest_hash)),
        ),
    ] {
        // Pool identities are immutable, so model a substituted connected
        // ledger with a separate fresh migrated database. Never disable guards.
        let database = format!("i10_scope_{case}_{suffix}");
        admin
            .batch_execute(&format!("CREATE DATABASE {database}"))
            .await
            .unwrap();
        let dsn = format!(
            "host={host} port={port} user={} dbname={database}",
            source.get_user().unwrap()
        );
        zkapi_control::ledger::migrate(&dsn).await.unwrap();
        let (db, connection) = tokio_postgres::connect(&dsn, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.batch_execute(&format!(
            "GRANT USAGE ON SCHEMA public TO {reader}; GRANT SELECT ON pools TO {reader}"
        ))
        .await
        .unwrap();
        if let Some((id, digest)) = &identity {
            db.execute("INSERT INTO pools(pool,deployment_id,manifest_hash,writer_epoch,accepting) VALUES($1::bytea,$2,$3::bytea,7,true)", &[&&pool[..], id, &&digest[..]]).await.unwrap();
        }
        let config = ServiceConfig {
            local_test_only: false,
            devnet: Some(DevnetProviderScope {
                deployment: runtime.devnet.clone().unwrap(),
                manifest: runtime.manifest.clone(),
                trusted_manifest_hash: runtime.trusted_manifest_hash.clone(),
            }),
            database_url: format!("host={host} port={port} user={reader} dbname={database}"),
            pool,
            claims_directory: dir.path().join("claims"),
            providers: Default::default(),
        };
        config.validate_scope().unwrap();
        let error = egress::serve(config.clone(), request())
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            match case {
                "missing" => "provider database pool absent",
                // Positive control reaches the deliberately absent adapter; no HTTP.
                "matching" => "direct unavailable",
                _ => "provider database manifest identity mismatch",
            },
            "{case}"
        );
        let after = db.query_opt("SELECT deployment_id,manifest_hash,writer_epoch,accepting FROM pools WHERE pool=$1", &[&&pool[..]]).await.unwrap();
        if let Some((id, digest)) = &identity {
            let after = after.unwrap();
            assert_eq!(&after.get::<_, String>(0), id);
            assert_eq!(after.get::<_, Vec<u8>>(1), digest);
            assert_eq!(after.get::<_, i64>(2), 7);
            assert!(after.get::<_, bool>(3));
        } else {
            assert!(after.is_none());
        }
        // Legacy local mode retains its prior action checks even against a
        // mismatched/absent row; it never infers the new public profile.
        let mut legacy = config.clone();
        legacy.local_test_only = true;
        legacy.devnet = None;
        assert_eq!(
            egress::serve(legacy, request())
                .await
                .unwrap_err()
                .to_string(),
            "direct unavailable"
        );
        assert!(!config.claims_directory.exists());
    }
}
