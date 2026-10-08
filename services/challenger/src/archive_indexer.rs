//! Explicit read-only indexer over the retained challenger archive. This mode
//! never constructs a challenger Runtime, opens a writer lock, or loads keys/DB.
//!
//! `challengerd archive-indexer CONFIG.json` accepts exactly
//! `{ "archive_directory": "/absolute/existing/challenger", "indexer": { ... } }`.
//! `indexer` is the existing indexer configuration including its original
//! `start_slot`, pool/program/genesis/profile pins, RPC, listener and snapshot
//! directory. The archive must already use v2; no migration/initialization is
//! performed. Source corruption/rollback requires operator review and process
//! restart; incomplete history remains unavailable with bounded polling.
use crate::{
    bad,
    journal::{ArchiveCheckpointState, ArchiveTail, ReadOnlyArchive},
    sha, Hash, Result,
};
use serde::Deserialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use zkapi_indexer::{
    runtime::{self, ArchiveSourceResult, FinalizedArchiveSource},
    FinalizedBlock, Indexer,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub archive_directory: PathBuf,
    pub indexer: runtime::Config,
}

struct Source {
    archive: ReadOnlyArchive,
    directory: PathBuf,
    checkpoint_path: PathBuf,
    binding: Hash,
    cached: Option<ArchiveCheckpointState>,
}
fn checkpoint_binding(config: &runtime::Config) -> Hash {
    sha(&serde_json::to_vec(&serde_json::json!({
        "domain": "zkapi-archive-indexer-replay-v1",
        "program": config.program_id, "pool": config.pool,
        "genesis": config.genesis_hash, "profile": config.circuit_profile_hash,
        "start_slot": config.start_slot,
    }))
    .expect("private checkpoint binding"))
}
fn snapshot_destination(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(bad("archive indexer snapshot directory"));
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    while !ancestor.try_exists()? {
        missing.push(
            ancestor
                .file_name()
                .ok_or(bad("archive indexer snapshot ancestor"))?
                .to_owned(),
        );
        ancestor = ancestor
            .parent()
            .ok_or(bad("archive indexer snapshot ancestor"))?;
    }
    let mut resolved = ancestor.canonicalize()?;
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}
fn separated_paths(config: &Config) -> Result<()> {
    if !config.archive_directory.is_absolute()
        || config
            .archive_directory
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || config.archive_directory.canonicalize()? != config.archive_directory
    {
        return Err(bad("archive indexer directory"));
    }
    let snapshots = snapshot_destination(&config.indexer.snapshots_directory)?;
    if snapshots.starts_with(&config.archive_directory)
        || config.archive_directory.starts_with(&snapshots)
    {
        return Err(bad("archive indexer snapshot separation"));
    }
    Ok(())
}
impl FinalizedArchiveSource for Source {
    fn restore_indexer(
        &mut self,
        program: Hash,
        pool: Hash,
    ) -> ArchiveSourceResult<Option<Indexer>> {
        let Some(cache) = self.cached.take() else {
            return Ok(None);
        };
        let restored = cache.tail.and_then(|tail| {
            Indexer::restore_checkpoint(
                &cache.bytes,
                cache.sha256,
                program,
                pool,
                tail.slot,
                tail.blockhash,
            )
            .ok()
        });
        if restored.is_none() {
            // A metadata cache without a valid complete runtime state must not
            // bypass the original full history validation.
            self.archive = ReadOnlyArchive::open(&self.directory, pool)?;
        }
        Ok(restored)
    }
    fn save_indexer(&self, index: &Indexer) -> ArchiveSourceResult<()> {
        let state = index.replay_state()?;
        let bytes = index.checkpoint_bytes()?;
        let mut anchor = None;
        self.archive.replay_range(state.slot, state.slot, |block| {
            if block.slot != state.slot || block.blockhash != state.blockhash || anchor.is_some() {
                return Err(bad("private index checkpoint anchor"));
            }
            anchor = Some(ArchiveTail::from(block));
            Ok(())
        })?;
        self.archive.save_checkpoint(
            &self.checkpoint_path,
            self.binding,
            &bytes,
            anchor.ok_or_else(|| bad("private index checkpoint anchor absent"))?,
        )?;
        Ok(())
    }
    fn refresh(&mut self) -> ArchiveSourceResult<()> {
        self.archive
            .refresh()
            .map(|_| ())
            .map_err(|_| "local archive validation failed".into())
    }
    fn first(&self) -> Option<(u64, u64)> {
        self.archive.archive_first()
    }
    fn tail(&self) -> Option<(u64, [u8; 32])> {
        self.archive
            .archive_tail()
            .map(|tail| (tail.slot, tail.blockhash))
    }
    fn replay_range(
        &self,
        start: u64,
        end: u64,
        visit: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
    ) -> ArchiveSourceResult<()> {
        self.archive
            .replay_range(start, end, |block| {
                visit(block).map_err(|_| bad("local archive indexer replay"))
            })
            .map_err(|_| "local archive replay failed".into())
    }
}

pub async fn run(path: &Path) -> Result<()> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(bad("archive indexer config size"));
    }
    let config: Config = serde_json::from_slice(&bytes)?;
    separated_paths(&config)?;
    let pool = zkapi_control::wire::pubkey(&config.indexer.pool)
        .map_err(|_| bad("archive indexer pool"))?;
    // The filename cannot match the public digest.json snapshot route; archive
    // storage creates it owner-only. Neither this file nor its payload is served.
    let checkpoint_path = config
        .indexer
        .snapshots_directory
        .join(".archive-runtime-checkpoint");
    let binding = checkpoint_binding(&config.indexer);
    let (archive, cached) = ReadOnlyArchive::open_with_checkpoint(
        &config.archive_directory,
        pool,
        binding,
        &checkpoint_path,
    )?;
    let source = Source {
        archive,
        directory: config.archive_directory.clone(),
        checkpoint_path,
        binding,
        cached,
    };
    runtime::serve_with_archive(config.indexer, source)
        .await
        .map_err(|_| bad("archive indexer unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(archive_directory: PathBuf, snapshots_directory: PathBuf) -> Config {
        Config {
            archive_directory,
            indexer: runtime::Config {
                rpc_url: "http://127.0.0.1:1".into(),
                program_id: String::new(),
                pool: String::new(),
                genesis_hash: String::new(),
                circuit_profile_hash: String::new(),
                start_slot: 1,
                listen: "127.0.0.1:0".into(),
                public_origin: "https://example.invalid".into(),
                snapshots_directory,
            },
        }
    }
    #[test]
    fn follower_private_checkpoint_restores_partial_chunk_and_replays_suffix() {
        use crate::journal::Journal;
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let archive_dir = directory.join("archive");
        let checkpoint_path = directory.join(".archive-runtime-checkpoint");
        let pool = [2; 32];
        let program = [1; 32];
        let binding = [3; 32];
        let blocks: Vec<_> = (1..=3)
            .map(|slot| FinalizedBlock {
                finalized: true,
                slot,
                parent_slot: slot - 1,
                blockhash: [slot as u8; 32],
                previous_blockhash: [(slot - 1) as u8; 32],
                block_time: slot,
                transactions: Vec::new(),
            })
            .collect();
        let mut journal = Journal::initialize(&archive_dir, pool).unwrap();
        journal.append_archive_batch(blocks.clone()).unwrap();
        drop(journal);
        Journal::migrate_v1_to_segmented(&archive_dir, pool).unwrap();
        let (archive, cached) =
            ReadOnlyArchive::open_with_checkpoint(&archive_dir, pool, binding, &checkpoint_path)
                .unwrap();
        assert!(cached.is_none());
        let source = Source {
            archive,
            directory: archive_dir.clone(),
            checkpoint_path: checkpoint_path.clone(),
            binding,
            cached,
        };
        let mut index = Indexer::new(program, pool);
        index.apply_block(&blocks[0]).unwrap();
        source.save_indexer(&index).unwrap();
        let (archive, cached) =
            ReadOnlyArchive::open_with_checkpoint(&archive_dir, pool, binding, &checkpoint_path)
                .unwrap();
        assert_eq!(cached.as_ref().unwrap().tail.unwrap().slot, 1);
        let mut source = Source {
            archive,
            directory: archive_dir.clone(),
            checkpoint_path: checkpoint_path.clone(),
            binding,
            cached,
        };
        let mut restored = source.restore_indexer(program, pool).unwrap().unwrap();
        assert!(!restored.is_ready());
        source.refresh().unwrap();
        source
            .replay_range(2, 3, &mut |block| {
                restored.apply_block(block)?;
                Ok(())
            })
            .unwrap();
        for block in &blocks[1..] {
            index.apply_block(block).unwrap();
        }
        assert_eq!(
            restored.replay_state().unwrap(),
            index.replay_state().unwrap()
        );
        source.save_indexer(&restored).unwrap();
        // Valid archive metadata cannot authorize malformed opaque runtime data.
        source
            .archive
            .save_checkpoint(
                &checkpoint_path,
                binding,
                b"invalid runtime",
                ArchiveTail::from(&blocks[2]),
            )
            .unwrap();
        let (archive, cached) =
            ReadOnlyArchive::open_with_checkpoint(&archive_dir, pool, binding, &checkpoint_path)
                .unwrap();
        assert!(cached.is_some());
        let mut source = Source {
            archive,
            directory: archive_dir,
            checkpoint_path,
            binding,
            cached,
        };
        assert!(source.restore_indexer(program, pool).unwrap().is_none());
        assert_eq!(source.archive.archive_len(), 3);
    }
    #[test]
    fn private_checkpoint_binding_tracks_chain_domain_not_transport() {
        let mut cfg = config(PathBuf::from("/archive"), PathBuf::from("/snapshots")).indexer;
        let original = checkpoint_binding(&cfg);
        cfg.rpc_url = "https://example.invalid/new-private-rpc".into();
        cfg.listen = "127.0.0.1:2345".into();
        cfg.public_origin = "https://another.invalid".into();
        assert_eq!(checkpoint_binding(&cfg), original);
        for field in ["program", "pool", "genesis", "profile", "start"] {
            let mut changed = cfg.clone();
            match field {
                "program" => changed.program_id.push('x'),
                "pool" => changed.pool.push('x'),
                "genesis" => changed.genesis_hash.push('x'),
                "profile" => changed.circuit_profile_hash.push('x'),
                "start" => changed.start_slot += 1,
                _ => unreachable!(),
            }
            assert_ne!(checkpoint_binding(&changed), original);
        }
    }
    #[test]
    fn archive_indexer_output_separation_resolves_existing_ancestors_and_rejects_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let archive = root.join("archive");
        std::fs::create_dir(&archive).unwrap();
        assert!(separated_paths(&config(archive.clone(), root.join("snapshots/new"))).is_ok());
        assert!(separated_paths(&config(archive.clone(), archive.join("snapshots/new"))).is_err());
        assert!(separated_paths(&config(archive.clone(), root.clone())).is_err());
        assert!(
            separated_paths(&config(archive.clone(), root.join("snapshots/../archive"))).is_err()
        );
        assert!(
            separated_paths(&config(archive.join("../archive"), root.join("snapshots"))).is_err()
        );
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&archive, &alias).unwrap();
            assert!(separated_paths(&config(archive.clone(), alias.join("new"))).is_err());
            assert!(separated_paths(&config(alias, root.join("snapshots"))).is_err());
        }
    }
}
