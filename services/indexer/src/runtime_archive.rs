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

#[derive(Default)]
pub struct ArchiveRefresh {
    target: Option<u64>,
    cut: Option<(AccountCut, Instant)>,
    // Any source validation failure is terminal for this process. A later
    // successful refresh must not turn a substituted prefix into readiness.
    failed: bool,
}

impl ArchiveRefresh {
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
            return Err("local archive is not yet complete".into());
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
            return Err("local archive is not yet complete".into());
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
