use super::*;
use zkapi_indexer::{
    runtime::{ArchiveRefresh, ArchiveSourceResult, FinalizedArchiveSource},
    FinalizedBlock,
};

struct Local {
    blocks: Vec<FinalizedBlock>,
    visible: usize,
    corrupt: bool,
}
impl Local {
    fn new(f: &Fixture) -> Self {
        let blocks: Vec<_> = f
            .blocks
            .iter()
            .map(|(slot, value)| decode_finalized_block(*slot, value).unwrap())
            .collect();
        Self {
            visible: blocks.len(),
            blocks,
            corrupt: false,
        }
    }
}
impl FinalizedArchiveSource for Local {
    fn refresh(&mut self) -> ArchiveSourceResult<()> {
        if self.corrupt {
            Err("PRIVATE_SOURCE_PATH fixture corruption".into())
        } else {
            Ok(())
        }
    }
    fn first(&self) -> Option<(u64, u64)> {
        self.blocks[..self.visible]
            .first()
            .map(|b| (b.slot, b.parent_slot))
    }
    fn tail(&self) -> Option<(u64, Bytes32)> {
        self.blocks[..self.visible]
            .last()
            .map(|b| (b.slot, b.blockhash))
    }
    fn replay_range(
        &self,
        start: u64,
        end: u64,
        visit: &mut dyn FnMut(&FinalizedBlock) -> ArchiveSourceResult<()>,
    ) -> ArchiveSourceResult<()> {
        for block in self.blocks[..self.visible]
            .iter()
            .filter(|b| b.slot >= start && b.slot <= end)
        {
            visit(block)?;
        }
        Ok(())
    }
}
fn assert_no_full_reads(calls: &[Value]) {
    assert!(calls.iter().all(|c| c["method"] != "getBlocks"));
    for call in calls.iter().filter(|c| c["method"] == "getBlock") {
        assert_eq!(call["params"][1]["transactionDetails"], "none");
    }
}

#[tokio::test]
async fn typed_archive_new_account_inventory_is_recaptured_without_replaying_history() {
    for (before, after) in [("deposit-1", "deposit-2"), ("deposit-2", "initiate_escape")] {
        let near = Fixture::load_at(before);
        let captured = Fixture::load_at(after);
        let mut local = Local::new(&captured);
        let expected = captured.expected.clone();
        let initial = near.expected.slot;
        let server = mock(move |q| {
            if q["method"] == "getSlot" {
                success(&q, json!(initial))
            } else if q["method"] == "getMultipleAccounts" {
                captured.captured_response(&q)
            } else {
                captured.response(&q)
            }
        })
        .await;
        let mut index = Indexer::new(key(&near.cfg.program_id), key(&near.cfg.pool));
        let mut next = near.cfg.start_slot;
        let mut progress = ArchiveRefresh::default();
        let error = server
            .rpc
            .refresh_from_archive(&near.cfg, &mut index, &mut next, &mut local, &mut progress)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("inventory missing"));
        assert_eq!(index.replay_state().unwrap(), expected);
        assert!(!index.is_ready());
        let next_before = next;
        server
            .rpc
            .refresh_from_archive(&near.cfg, &mut index, &mut next, &mut local, &mut progress)
            .await
            .unwrap();
        assert!(index.is_ready());
        assert_eq!(next, next_before);
        let calls = server.calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|c| c["method"] == "getSlot").count(), 1);
        assert_eq!(
            calls
                .iter()
                .filter(|c| c["method"] == "getMultipleAccounts")
                .count(),
            2
        );
        assert_no_full_reads(&calls);
    }
}

#[tokio::test]
async fn typed_archive_waits_for_extension_then_authenticates_independent_cut_without_full_rpc() {
    let fixture = Fixture::load(false);
    let serving = fixture.clone();
    let server = mock(move |q| {
        if q["method"] == "getMultipleAccounts" {
            serving.captured_response(&q)
        } else {
            serving.response(&q)
        }
    })
    .await;
    let mut local = Local::new(&fixture);
    let mut index = Indexer::new(key(&fixture.cfg.program_id), key(&fixture.cfg.pool));
    let mut next = fixture.cfg.start_slot;
    let mut state = ArchiveRefresh::default();
    local.visible = 0;
    assert!(server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .is_err());
    assert_eq!(next, fixture.cfg.start_slot);
    assert!(!index.is_ready());
    local.visible = 1;
    assert!(server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .is_err());
    assert!(!index.is_ready());
    assert_eq!(next, local.blocks[0].slot + 1);
    assert_eq!(
        server.calls.lock().unwrap().len(),
        1,
        "one captured getSlot; no RPC history fallback"
    );
    local.visible = local.blocks.len();
    server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .unwrap();
    assert!(index.is_ready());
    assert_eq!(index.replay_state().unwrap(), fixture.expected);
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| c["method"] == "getSlot").count(), 1);
    assert!(calls.iter().any(|c| c["method"] == "getMultipleAccounts"));
    assert!(calls.iter().any(|c| c["method"] == "getBlock"));
    assert_no_full_reads(&calls);
}

#[tokio::test]
async fn typed_archive_retains_exact_account_cut_and_accepts_proven_skipped_slots() {
    let mut fixture = Fixture::load(false);
    let original = fixture.expected.slot;
    fixture.add_empty_block();
    // Skip two slots, preserving the actual parent link to the produced block.
    let mut last = fixture.blocks.remove(&(original + 1)).unwrap();
    last["blockHeight"] = json!(original + 3);
    fixture.blocks.insert(original + 3, last);
    fixture.expected.slot = original + 3;
    let serving = fixture.clone();
    let server = mock(move |q| {
        if q["method"] == "getSlot" {
            success(&q, json!(original))
        } else if q["method"] == "getMultipleAccounts" {
            serving.captured_response(&q)
        } else {
            serving.response(&q)
        }
    })
    .await;
    let mut local = Local::new(&fixture);
    local.visible -= 1;
    let mut index = Indexer::new(key(&fixture.cfg.program_id), key(&fixture.cfg.pool));
    let mut next = fixture.cfg.start_slot;
    let mut state = ArchiveRefresh::default();
    assert!(server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .is_err());
    assert_eq!(index.replay_state().unwrap().slot, original);
    assert!(!index.is_ready());
    local.visible += 1;
    server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .unwrap();
    assert_eq!(index.replay_state().unwrap().slot, original + 3);
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| c["method"] == "getSlot").count(), 1);
    assert_eq!(
        calls
            .iter()
            .filter(|c| c["method"] == "getMultipleAccounts")
            .count(),
        1
    );
    assert_no_full_reads(&calls);
}

#[tokio::test]
async fn typed_archive_corruption_after_ready_is_redacted_and_latched_without_fallback() {
    let fixture = Fixture::load(false);
    let serving = fixture.clone();
    let server = mock(move |q| {
        if q["method"] == "getMultipleAccounts" {
            serving.captured_response(&q)
        } else {
            serving.response(&q)
        }
    })
    .await;
    let mut local = Local::new(&fixture);
    let mut index = Indexer::new(key(&fixture.cfg.program_id), key(&fixture.cfg.pool));
    let mut next = fixture.cfg.start_slot;
    let mut state = ArchiveRefresh::default();
    server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .unwrap();
    let before = server.calls.lock().unwrap().len();
    local.corrupt = true;
    let error = server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "local archive source unavailable");
    assert!(!index.is_ready());
    local.corrupt = false;
    assert!(server
        .rpc
        .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
        .await
        .is_err());
    assert_eq!(server.calls.lock().unwrap().len(), before);
}

#[tokio::test]
async fn typed_archive_omitted_produced_block_or_start_cannot_become_ready() {
    let fixture = Fixture::load(false);
    let serving = fixture.clone();
    let server = mock(move |q| serving.response(&q)).await;
    for omit_first in [true, false] {
        let mut local = Local::new(&fixture);
        local.blocks.remove(if omit_first { 0 } else { 1 });
        local.visible = local.blocks.len();
        let mut index = Indexer::new(key(&fixture.cfg.program_id), key(&fixture.cfg.pool));
        let mut next = fixture.cfg.start_slot;
        let mut state = ArchiveRefresh::default();
        assert!(server
            .rpc
            .refresh_from_archive(&fixture.cfg, &mut index, &mut next, &mut local, &mut state)
            .await
            .is_err());
        assert!(!index.is_ready());
    }
    assert_no_full_reads(&server.calls.lock().unwrap());
}

#[tokio::test]
async fn typed_archive_wrong_independent_account_root_or_anchor_cannot_become_ready() {
    for wrong_anchor in [false, true] {
        let fixture = Fixture::load(false);
        let mut serving = fixture.clone();
        if !wrong_anchor {
            let (tree, _) = pda(
                key(&fixture.cfg.program_id),
                &[b"tree", &key(&fixture.cfg.pool)],
            );
            serving.mutate_account(tree, |raw| raw[10..42].copy_from_slice(&[0; 32]));
        }
        let server = mock(move |q| {
            if q["method"] == "getMultipleAccounts" {
                serving.captured_response(&q)
            } else if wrong_anchor && q["method"] == "getBlock" {
                success(&q, json!({"blockhash":b58([42;32])}))
            } else {
                serving.response(&q)
            }
        })
        .await;
        let mut local = Local::new(&fixture);
        let mut index = Indexer::new(key(&fixture.cfg.program_id), key(&fixture.cfg.pool));
        let mut next = fixture.cfg.start_slot;
        assert!(server
            .rpc
            .refresh_from_archive(
                &fixture.cfg,
                &mut index,
                &mut next,
                &mut local,
                &mut ArchiveRefresh::default()
            )
            .await
            .is_err());
        assert!(!index.is_ready());
        assert_no_full_reads(&server.calls.lock().unwrap());
    }
}
