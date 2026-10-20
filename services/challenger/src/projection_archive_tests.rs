//! Filesystem/durability cases use synthetic decoded history. The separately
//! ignored SBF case consumes the existing real proof/SBF harness output offline.
use super::*;
use crate::{journal::Journal, tests::trust_and_manifest};
use std::collections::BTreeMap;
use zkapi_indexer::{discriminator, Instruction, Transaction};

fn blocks(trust: &Trust) -> Vec<FinalizedBlock> {
    let program = zkapi_control::wire::pubkey(&trust.pool.program_id).unwrap();
    let mut data = discriminator("global", "initialize_pool").to_vec();
    let mut args = vec![0; 280];
    args[32..64].copy_from_slice(&zkapi_control::wire::pubkey(&trust.pool.genesis_hash).unwrap());
    args[192..200].copy_from_slice(&86400u64.to_le_bytes());
    args[200..208].copy_from_slice(&60u64.to_le_bytes());
    data.extend(args);
    let mut accounts = vec![[9; 32]; 11];
    accounts[0] = trust.pool();
    accounts[3] = [4; 32];
    accounts[8] = [10; 32];
    (1u64..=5)
        .map(|slot| {
            let mut transactions: Vec<_> = (0u64..12)
                .map(|index| Transaction {
                    signature: format!("foreign-{slot}-{index}"),
                    succeeded: true,
                    instructions: vec![Instruction {
                        program: [99; 32],
                        accounts: vec![],
                        data: (0u64..64)
                            .flat_map(|j| {
                                sha(&[slot.to_le_bytes(), index.to_le_bytes(), j.to_le_bytes()]
                                    .concat())
                            })
                            .collect(),
                        outer_index: 0,
                        invocation_index: 0,
                        stack_height: 1,
                        succeeded: Some(true),
                        events: vec![],
                    }],
                })
                .collect();
            if slot == 1 {
                transactions.insert(
                    7,
                    Transaction {
                        signature: "initialize-at-index-seven".into(),
                        succeeded: true,
                        instructions: vec![Instruction {
                            program,
                            accounts: accounts.clone(),
                            data: data.clone(),
                            outer_index: 0,
                            invocation_index: 0,
                            stack_height: 1,
                            succeeded: Some(true),
                            events: vec![],
                        }],
                    },
                );
            }
            FinalizedBlock {
                finalized: true,
                slot,
                parent_slot: slot - 1,
                blockhash: sha(&slot.to_le_bytes()),
                previous_blockhash: sha(&(slot - 1).to_le_bytes()),
                block_time: slot,
                transactions,
            }
        })
        .collect()
}
fn fixture() -> (tempfile::TempDir, Config, Trust, Journal) {
    let root = tempfile::tempdir().unwrap();
    let (trust, manifest) = trust_and_manifest();
    let manifest_path = root.path().join("pinned-manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let source = root.path().join("source");
    let mut journal = Journal::initialize(&source, trust.pool()).unwrap();
    journal.append_archive_batch(blocks(&trust)).unwrap();
    drop(journal);
    Journal::migrate_v1_to_segmented(&source, trust.pool()).unwrap();
    let journal = Journal::open(&source, trust.pool()).unwrap();
    let config = Config {
        manifest: manifest_path,
        manifest_sha256: hex::encode(trust.manifest_hash),
        devnet: None,
        start_slot: 1,
        source: Source::ArchiveV2 { directory: source },
        output_directory: root.path().join("projected"),
        max_output_bytes: 8 * 1024 * 1024,
        chunk_blocks: 2,
        chunk_bytes: MAX_CHUNK,
    };
    (root, config, trust, journal)
}
fn files(path: &Path) -> BTreeMap<PathBuf, Hash> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.extend(files(&path));
        } else {
            result.insert(path.clone(), sha(&fs::read(path).unwrap()));
        }
    }
    result
}
fn source(config: &Config) -> &Path {
    match &config.source {
        Source::ArchiveV2 { directory } => directory,
        _ => panic!("archive"),
    }
}

#[test]
fn shadow_export_coexists_with_owner_preserves_source_and_verifies_compression() {
    let (_root, config, trust, _owner) = fixture();
    let before = files(source(&config));
    let report = export(&config).unwrap();
    assert_eq!(files(source(&config)), before);
    assert_eq!(report.blocks_verified, 5);
    assert_eq!(report.original_transactions, 61);
    assert_eq!(report.selected_transactions, 1);
    assert!(report.saved_bytes > 0);
    assert!(!report.live_activation);
    let pin = hex::decode(&report.manifest_sha256)
        .unwrap()
        .try_into()
        .unwrap();
    verify_artifact(&config.output_directory, &trust, pin).unwrap();
    assert!(!config.output_directory.join(PREPARED).exists());
    let manifest: Manifest =
        read_json(&config.output_directory.join(MANIFEST), MAX_MANIFEST).unwrap();
    assert_eq!(
        manifest
            .segments
            .iter()
            .map(|r| r.blocks)
            .collect::<Vec<_>>(),
        [2, 2, 1]
    );
    let first = &manifest.segments[0];
    let compressed = fs::read(
        config
            .output_directory
            .join(format!("{}.json.gz", hex::encode(first.sha256))),
    )
    .unwrap();
    let segment: Segment<Vec<ProjectedBlock>> =
        serde_json::from_reader(GzDecoder::new(compressed.as_slice())).unwrap();
    assert_eq!(segment.blocks[0].transactions[0].original_index, 7);
    assert!(segment.blocks[1].transactions.is_empty());
    assert_eq!(
        report.artifact_bytes,
        files(&config.output_directory)
            .keys()
            .map(|path| fs::metadata(path).unwrap().len())
            .sum::<u64>()
    );
}

#[test]
fn shadow_output_budget_failure_has_no_committed_manifest_and_never_changes_source() {
    let (_root, mut config, _trust, _owner) = fixture();
    let before = files(source(&config));
    config.max_output_bytes = 1;
    assert!(export(&config).is_err());
    assert!(!config.output_directory.join(MANIFEST).exists());
    assert_eq!(files(source(&config)), before);
    assert!(export(&config).is_err()); // No automatic partial-output adoption.
}

#[test]
fn shadow_refuses_existing_output_nested_output_wrong_start_and_wrong_pin() {
    let (_root, mut config, _trust, _owner) = fixture();
    let before = files(source(&config));
    fs::create_dir(&config.output_directory).unwrap();
    fs::write(config.output_directory.join("keep"), b"retained").unwrap();
    assert!(export(&config).is_err());
    assert_eq!(
        fs::read(config.output_directory.join("keep")).unwrap(),
        b"retained"
    );
    config.output_directory = source(&config).join("do-not-create");
    assert!(export(&config).is_err());
    assert!(!config.output_directory.exists());
    config.start_slot = 2;
    assert!(export(&config).is_err());
    config.start_slot = 1;
    config.manifest_sha256 = "00".repeat(32);
    assert!(export(&config).is_err());
    assert_eq!(files(source(&config)), before);
}

#[test]
fn shadow_readback_rejects_corruption_missing_segments_and_untrusted_manifest() {
    let (_root, config, trust, _owner) = fixture();
    let report = export(&config).unwrap();
    let pin = hex::decode(report.manifest_sha256)
        .unwrap()
        .try_into()
        .unwrap();
    assert!(verify_artifact(&config.output_directory, &trust, [0; 32]).is_err());
    let manifest: Manifest =
        read_json(&config.output_directory.join(MANIFEST), MAX_MANIFEST).unwrap();
    let path = config.output_directory.join(format!(
        "{}.json.gz",
        hex::encode(manifest.segments[0].sha256)
    ));
    let saved = fs::read(&path).unwrap();
    let mut corrupt = saved.clone();
    corrupt[20] ^= 1;
    fs::write(&path, corrupt).unwrap();
    assert!(verify_artifact(&config.output_directory, &trust, pin).is_err());
    fs::remove_file(&path).unwrap();
    assert!(verify_artifact(&config.output_directory, &trust, pin).is_err());
    fs::write(&path, saved).unwrap();
    verify_artifact(&config.output_directory, &trust, pin).unwrap();
}

#[test]
fn shadow_readback_rejects_rehashed_wrong_chain_coverage_and_semantic_claims() {
    let (_root, config, trust, _owner) = fixture();
    export(&config).unwrap();
    let original: Manifest =
        read_json(&config.output_directory.join(MANIFEST), MAX_MANIFEST).unwrap();
    for kind in 0..4 {
        let mut modified = original.clone();
        match kind {
            0 => modified.segments[1].sequence += 1,
            1 => modified.segments[0].semantic_sha256 = [0; 32],
            2 => modified.counters.blocks += 1,
            _ => modified.segments[0].decoded_bytes = MAX_CHUNK * 2 + 1,
        }
        let bytes = serde_json::to_vec(&modified).unwrap();
        fs::write(config.output_directory.join(MANIFEST), &bytes).unwrap();
        assert!(verify_artifact(&config.output_directory, &trust, sha(&bytes)).is_err());
    }
}

#[test]
fn offline_config_rejects_live_transport_fields_and_input_symlinks() {
    let (_root, config, _trust, _owner) = fixture();
    let value = serde_json::json!({ "manifest":config.manifest, "manifest_sha256":config.manifest_sha256,
        "start_slot":1, "source":{"kind":"archive_v2","directory":source(&config)},
        "output_directory":config.output_directory, "max_output_bytes":1000,
        "rpc_url":"https://unused.invalid", "database_dsn_file":"/unused" });
    assert!(serde_json::from_value::<Config>(value).is_err());
    #[cfg(unix)]
    {
        let link = config.output_directory.with_extension("link");
        std::os::unix::fs::symlink(&config.manifest, &link).unwrap();
        assert!(read_bytes(&link, MAX_INPUT).is_err());
    }
}

#[test]
#[ignore = "requires existing target/i04/sdk-svm-history.json; no new SBF or RPC run"]
fn shadow_export_existing_actual_sbf_scenarios_replays_identically() {
    let root = tempfile::tempdir().unwrap();
    let (trust, manifest) = trust_and_manifest();
    let manifest_path = root.path().join("manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/i04/sdk-svm-history.json")
        .canonicalize()
        .unwrap();
    for scenario in ["close", "challenge", "finalize", "expiry"] {
        let config = Config {
            manifest: manifest_path.clone(),
            manifest_sha256: hex::encode(trust.manifest_hash),
            devnet: None,
            start_slot: 1,
            source: Source::SbfFixture {
                path: fixture.clone(),
                scenario: scenario.into(),
            },
            output_directory: root.path().join(scenario),
            max_output_bytes: 8 * 1024 * 1024,
            chunk_blocks: 4,
            chunk_bytes: MAX_CHUNK,
        };
        let report = export(&config).unwrap();
        println!("{scenario}: {}", serde_json::to_string(&report).unwrap());
        assert!(report.blocks_verified >= 10);
        verify_artifact(
            &config.output_directory,
            &trust,
            hex::decode(report.manifest_sha256)
                .unwrap()
                .try_into()
                .unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn shadow_readback_rejects_trailing_gzip_even_with_updated_file_and_manifest_hashes() {
    let (_root, config, trust, _owner) = fixture();
    export(&config).unwrap();
    let mut manifest: Manifest =
        read_json(&config.output_directory.join(MANIFEST), MAX_MANIFEST).unwrap();
    let reference = manifest.segments.last_mut().unwrap();
    let old = config
        .output_directory
        .join(format!("{}.json.gz", hex::encode(reference.sha256)));
    let mut bytes = fs::read(old).unwrap();
    bytes.extend_from_slice(b"uncommitted suffix");
    let extra = bytes.len() as u64 - reference.gzip_bytes;
    reference.gzip_bytes += extra;
    reference.sha256 = sha(&bytes);
    fs::write(
        config
            .output_directory
            .join(format!("{}.json.gz", hex::encode(reference.sha256))),
        bytes,
    )
    .unwrap();
    manifest.counters.projected_gzip_bytes += extra;
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(config.output_directory.join(MANIFEST), &bytes).unwrap();
    assert!(verify_artifact(&config.output_directory, &trust, sha(&bytes)).is_err());
}

#[test]
fn shadow_duplicate_full_block_does_not_publish_manifest() {
    let (root, _config, trust, _owner) = fixture();
    let output = root.path().join("direct");
    fs::create_dir(&output).unwrap();
    let source = blocks(&trust);
    let binding = Binding {
        format: "zkapi-pool-history-shadow".into(),
        version: VERSION,
        rules_version: RULES,
        genesis: trust.pool.genesis_hash.clone(),
        program: trust.pool.program_id.clone(),
        pool: trust.pool(),
        manifest_sha256: trust.manifest_hash,
        validator_sha256: [1; 32],
        start_slot: 1,
        source_kind: "synthetic".into(),
        source_sha256: [2; 32],
        source_blocks: 2,
        first_slot: 1,
        tail_slot: 1,
        tail_blockhash: source[0].blockhash,
        chunk_blocks: 2,
        chunk_bytes: MAX_CHUNK,
        gzip_level: GZIP_LEVEL,
    };
    let mut writer = Projector::new(&output, MAX_INPUT, binding, trust).unwrap();
    writer.push(&source[0]).unwrap();
    assert!(writer.push(&source[0]).is_err());
    assert!(!output.join(MANIFEST).exists());
}

#[test]
fn shadow_manifest_preflight_rejects_large_default_before_any_output_work() {
    // Captured production-scale count, with conservative maximum reference
    // widths. This check is arithmetic only: it reads/writes no archive files.
    assert!(preflight_manifest_capacity(2_826_413, 64, 2048).is_err());
    assert!(preflight_manifest_capacity(2_826_413, 256, 2048).is_ok());
    assert!(preflight_manifest_capacity(20, 4, 2048).is_ok());
    assert!(preflight_manifest_capacity(u64::MAX, 256, 2048).is_err());
    assert!(preflight_manifest_capacity(1, 1, MAX_MANIFEST).is_err());
}
