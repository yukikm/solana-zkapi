//! Typed local history input. A pending finalized target is retained between
//! polls, so a writer which commits in batches cannot cause a moving-tip chase.
use super::*;
use crate::FinalizedBlock;
use std::time::Instant;

pub type ArchiveSourceResult<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

/// Implementations authenticate a fixed committed prefix, reject rollback and
/// replacement, and revalidate referenced bytes before delivering each chunk.
/// `refresh` must fail if any previously committed source file changed. It may
/// use protected-file identity/size/mtime/ctime checks for unchanged files.
/// No implementation may fill holes from RPC or adopt uncommitted files.
pub trait FinalizedArchiveSource: Send {
    /// Optional private replay cache, authenticated by the source against its
    /// retained prefix. Invalid payloads must discard the metadata fast path and
    /// cold-validate the archive before returning None. Never restore readiness.
    fn restore_indexer(
        &mut self,
        _program: Bytes32,
        _pool: Bytes32,
    ) -> ArchiveSourceResult<Option<Indexer>> {
        Ok(None)
    }
    /// Optional best-effort private cache. It must bind the exact replay anchor
    /// and cannot mutate committed history or authorize financial activity.
    fn save_indexer(&self, _index: &Indexer) -> ArchiveSourceResult<()> {
        Ok(())
    }
    fn refresh(&mut self) -> ArchiveSourceResult<()>;
    /// First retained block's (slot, parent_slot), authenticated with its chunk.
    fn first(&self) -> Option<(u64, u64)>;
    fn tail(&self) -> Option<(u64, Bytes32)>;
    fn replay_range(
        &self,
        start: u64,
        end: u64,
        visit: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
    ) -> ArchiveSourceResult<()>;
}

const MAX_CUT_AGE: Duration = Duration::from_secs(30);

// Only these authenticated-prefix waits may keep an HTTP readiness wait open.
// A source/RPC error with identical text must never acquire this classification.
#[derive(Debug, thiserror::Error)]
#[error("local archive is not yet complete")]
pub(super) struct ArchivePending;

#[derive(Default)]
pub struct ArchiveRefresh {
    target: Option<u64>,
    cut: Option<(AccountCut, Instant)>,
    // Any source validation failure is terminal for this process. A later
    // successful refresh must not turn a substituted prefix into readiness.
    failed: bool,
}

impl ArchiveRefresh {
    /// Numeric observation only. Cleared/expired cuts remain absent; this
    /// never recaptures a bank, refreshes the source or alters retry progress.
    pub(super) fn failure_diagnostic(
        &self,
        source: &dyn FinalizedArchiveSource,
        next_slot: u64,
        category: &str,
    ) -> Value {
        json!({
            "event": "archive_indexer_failure",
            "category": category,
            "next_slot": next_slot,
            "target_slot": self.target,
            "cut_slot": self.cut.as_ref().map(|(cut, _)| cut.slot()),
            "cut_age_ms": self.cut.as_ref().map(|(_, captured)| captured.elapsed().as_millis().min(u64::MAX as u128) as u64),
            "archive_tail_slot": source.tail().map(|(slot, _)| slot),
            "source_halted": self.failed,
        })
    }
    fn discard_expired_cut(&mut self, now: Instant) -> bool {
        if let Some((cut, captured)) = &self.cut {
            if now.saturating_duration_since(*captured) > MAX_CUT_AGE {
                self.target = Some(cut.slot());
                self.cut = None;
                return true;
            }
        }
        false
    }
    fn refresh_source(&mut self, source: &mut dyn FinalizedArchiveSource) -> Result<()> {
        if self.failed {
            return Err("local archive source halted".into());
        }
        if source.refresh().is_err() {
            self.failed = true;
            return Err("local archive source unavailable".into());
        }
        Ok(())
    }

    fn replay_to(
        &mut self,
        cfg: &Config,
        index: &mut Indexer,
        next: &mut u64,
        source: &dyn FinalizedArchiveSource,
        target: u64,
    ) -> Result<()> {
        let Some((first, parent)) = source.first() else {
            return Err(ArchivePending.into());
        };
        if first > cfg.start_slot && parent >= cfg.start_slot {
            self.failed = true;
            return Err("local archive omits the configured start".into());
        }
        if *next <= target {
            let result = source.replay_range(*next, target, &mut |block| {
                if block.slot < *next || block.slot > target {
                    return Err("local archive range mismatch".into());
                }
                index.apply_block(block)?;
                *next = block.slot.checked_add(1).ok_or("slot overflow")?;
                Ok(())
            });
            if result.is_err() {
                self.failed = true;
                index.halt();
                return Err("local archive replay failed".into());
            }
        }
        if source.tail().is_none_or(|(slot, _)| slot < target) {
            return Err(ArchivePending.into());
        }
        if index.replay_state()?.slot != target {
            self.failed = true;
            index.halt();
            return Err("local archive lacks the finalized target".into());
        }
        Ok(())
    }
}

impl ArchiveRpc {
    /// One bounded attempt. Incomplete local history returns unavailable; the
    /// server waits two seconds before trying the same target/cut again. RPC
    /// errors preserve the applied prefix and never trigger full-block fallback.
    pub async fn refresh_from_archive(
        &self,
        cfg: &Config,
        index: &mut Indexer,
        next_slot: &mut u64,
        source: &mut dyn FinalizedArchiveSource,
        progress: &mut ArchiveRefresh,
    ) -> Result<()> {
        index.ready = false;
        progress.refresh_source(source)?;
        let target = match progress.target {
            Some(target) => target,
            None => {
                let tip = self
                    .call("getSlot", json!([{"commitment":"finalized"}]))
                    .await?
                    .as_u64()
                    .ok_or("invalid finalized slot")?;
                progress.target = Some(tip);
                tip
            }
        };
        // Once a bank has been captured, replay must stop exactly there even if
        // the local writer is already ahead. Never replay backwards to target.
        if progress.cut.is_none() {
            progress.replay_to(cfg, index, next_slot, source, target)?;
            let capture_started = Instant::now();
            let cut = self.capture_chain(cfg, &index.replay_state()?).await?;
            progress.cut = Some((cut, capture_started));
        }
        let cut_slot = progress.cut.as_ref().expect("captured cut").0.slot();
        progress.replay_to(cfg, index, next_slot, source, cut_slot)?;
        // Waiting can be arbitrarily long, but an old captured bank can never
        // become healthy. Retain the fully replayed prefix, then capture again.
        if progress.discard_expired_cut(Instant::now()) {
            return Err("local archive account cut expired".into());
        }
        let (cut, _) = progress.cut.as_ref().expect("captured cut");
        let observed = self.observe_cut(cfg, &index.replay_state()?, cut).await;
        let observed = match observed {
            Ok(observed) => observed,
            Err(error) => {
                // An inventory which changed during replay requires a new
                // capture, including when RPC failed before anchor validation.
                progress.target = Some(cut_slot);
                progress.cut = None;
                return Err(error);
            }
        };
        progress.refresh_source(source)?;
        if progress.discard_expired_cut(Instant::now()) {
            return Err("local archive account cut expired".into());
        }
        index.reconcile(&observed)?;
        progress.target = None;
        progress.cut = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Prefix {
        blocks: Vec<FinalizedBlock>,
        bad_refresh: bool,
        bad_replay: bool,
    }
    impl FinalizedArchiveSource for Prefix {
        fn refresh(&mut self) -> ArchiveSourceResult<()> {
            if self.bad_refresh {
                // Matching display text is not a pending classification.
                Err("local archive is not yet complete".into())
            } else {
                Ok(())
            }
        }
        fn first(&self) -> Option<(u64, u64)> {
            self.blocks.first().map(|b| (b.slot, b.parent_slot))
        }
        fn tail(&self) -> Option<(u64, Bytes32)> {
            self.blocks.last().map(|b| (b.slot, b.blockhash))
        }
        fn replay_range(
            &self,
            start: u64,
            end: u64,
            visit: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
        ) -> ArchiveSourceResult<()> {
            if self.bad_replay {
                return Err(ArchivePending.into());
            }
            for block in self
                .blocks
                .iter()
                .filter(|b| b.slot >= start && b.slot <= end)
            {
                visit(block)?;
            }
            Ok(())
        }
    }
    fn prefix_fixture() -> (Prefix, Config, Indexer, ArchiveRefresh) {
        (
            Prefix {
                blocks: Vec::new(),
                bad_refresh: false,
                bad_replay: false,
            },
            Config {
                rpc_url: "http://127.0.0.1:1".into(),
                program_id: b58(&[1; 32]),
                pool: b58(&[2; 32]),
                genesis_hash: b58(&[0; 32]),
                circuit_profile_hash: "00".repeat(32),
                start_slot: 1,
                listen: "127.0.0.1:0".into(),
                public_origin: "https://indexer.example".into(),
                snapshots_directory: PathBuf::new(),
            },
            Indexer::new([1; 32], [2; 32]),
            ArchiveRefresh {
                target: Some(2),
                ..ArchiveRefresh::default()
            },
        )
    }
    fn prefix_block(slot: u64, parent: u64) -> FinalizedBlock {
        FinalizedBlock {
            finalized: true,
            slot,
            parent_slot: parent,
            blockhash: [slot as u8; 32],
            previous_blockhash: [parent as u8; 32],
            block_time: slot,
            transactions: Vec::new(),
        }
    }
    #[tokio::test]
    async fn authenticated_empty_and_partial_prefixes_are_typed_pending_without_rpc() {
        let (mut source, config, mut index, mut progress) = prefix_fixture();
        let rpc = ArchiveRpc::new(config.rpc_url.clone()).unwrap();
        let mut next = 1;
        for expected_next in [1, 2] {
            let error = rpc
                .refresh_from_archive(&config, &mut index, &mut next, &mut source, &mut progress)
                .await
                .unwrap_err();
            assert!(error.is::<ArchivePending>());
            assert_eq!(error.to_string(), "local archive is not yet complete");
            assert_eq!(next, expected_next);
            assert_eq!(progress.target, Some(2));
            assert!(!progress.failed && !index.is_ready());
            source.blocks.push(prefix_block(1, 0));
        }
    }
    #[tokio::test]
    async fn source_corruption_replay_failure_and_missing_target_are_never_pending() {
        for failure in ["refresh", "replay", "target"] {
            let (mut source, config, mut index, mut progress) = prefix_fixture();
            source.blocks = vec![prefix_block(1, 0)];
            source.bad_refresh = failure == "refresh";
            source.bad_replay = failure == "replay";
            if failure == "target" {
                // Slot 2 is absent although the authenticated source is past it.
                source.blocks.push(prefix_block(3, 1));
            }
            let error = ArchiveRpc::new(config.rpc_url.clone())
                .unwrap()
                .refresh_from_archive(&config, &mut index, &mut 1, &mut source, &mut progress)
                .await
                .unwrap_err();
            assert!(!error.is::<ArchivePending>(), "{failure}");
            assert!(progress.failed && !index.is_ready(), "{failure}");
        }
    }

    #[test]
    fn archive_failure_diagnostic_is_bounded_numeric_and_does_not_refresh_source() {
        struct Source;
        impl FinalizedArchiveSource for Source {
            fn refresh(&mut self) -> ArchiveSourceResult<()> {
                panic!("diagnostic must not refresh")
            }
            fn first(&self) -> Option<(u64, u64)> {
                panic!("diagnostic must not replay")
            }
            fn tail(&self) -> Option<(u64, Bytes32)> {
                Some((11, [99; 32]))
            }
            fn replay_range(
                &self,
                _: u64,
                _: u64,
                _: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
            ) -> ArchiveSourceResult<()> {
                panic!("diagnostic must not replay")
            }
        }
        let mut progress = ArchiveRefresh {
            target: Some(10),
            cut: Some((
                AccountCut {
                    slot: 12,
                    program: [0; 32],
                    values: BTreeMap::new(),
                    raw_accounts: BTreeMap::new(),
                },
                Instant::now(),
            )),
            failed: false,
        };
        let output = progress.failure_diagnostic(&Source, 12, "local archive incomplete");
        assert_eq!(output.as_object().unwrap().len(), 8);
        assert_eq!(output["event"], "archive_indexer_failure");
        assert_eq!(output["target_slot"], 10);
        assert_eq!(output["cut_slot"], 12);
        assert!(output["cut_age_ms"].as_u64().is_some());
        assert_eq!(output["archive_tail_slot"], 11);
        assert_eq!(output["source_halted"], false);
        assert_eq!(progress.target, Some(10));
        assert_eq!(progress.cut.as_ref().unwrap().0.slot(), 12);
        progress.cut = None;
        assert!(
            progress.failure_diagnostic(&Source, 12, "local archive account cut expired")
                ["cut_age_ms"]
                .is_null()
        );
    }
    #[test]
    fn expired_account_cut_keeps_exact_replayed_target_but_requires_new_capture() {
        let captured = Instant::now();
        let mut state = ArchiveRefresh {
            target: Some(10),
            cut: Some((
                AccountCut {
                    slot: 12,
                    program: [0; 32],
                    values: BTreeMap::new(),
                    raw_accounts: BTreeMap::new(),
                },
                captured,
            )),
            failed: false,
        };
        assert!(!state.discard_expired_cut(captured + MAX_CUT_AGE));
        assert!(state.discard_expired_cut(captured + MAX_CUT_AGE + Duration::from_nanos(1)));
        assert_eq!(state.target, Some(12));
        assert!(state.cut.is_none());
        assert!(!state.failed);
    }
}
