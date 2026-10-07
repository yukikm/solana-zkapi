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
use crate::{bad, journal::ReadOnlyArchive, Result};
use serde::Deserialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use zkapi_indexer::{
    runtime::{self, ArchiveSourceResult, FinalizedArchiveSource},
    FinalizedBlock,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub archive_directory: PathBuf,
    pub indexer: runtime::Config,
}

struct Source(ReadOnlyArchive);
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
    fn refresh(&mut self) -> ArchiveSourceResult<()> {
        self.0
            .refresh()
            .map(|_| ())
            .map_err(|_| "local archive validation failed".into())
    }
    fn first(&self) -> Option<(u64, u64)> {
        self.0.archive_first()
    }
    fn tail(&self) -> Option<(u64, [u8; 32])> {
        self.0
            .archive_tail()
            .map(|tail| (tail.slot, tail.blockhash))
    }
    fn replay_range(
        &self,
        start: u64,
        end: u64,
        visit: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
    ) -> ArchiveSourceResult<()> {
        self.0
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
    // Full cold validation completes before the HTTP listener or RPC exists.
    let source = Source(ReadOnlyArchive::open(&config.archive_directory, pool)?);
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
