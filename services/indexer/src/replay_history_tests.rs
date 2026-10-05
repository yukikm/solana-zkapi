//! Compare the previous full-clone replay path with the production path. The
//! ignored benchmark measures local quiet-block replay only, never RPC capacity.
use super::*;
use std::{hint::black_box, time::Instant};

// Frozen pre-optimization path, retained only as an equivalence/measurement
// reference. It includes the historical digest clone being eliminated.
fn full_clone_reference(index: &mut Indexer, block: &FinalizedBlock) -> Result<()> {
    if index.halted {
        return Err(Error::Unavailable);
    }
    if !block.finalized {
        index.halt();
        return Err(Error::Unfinalized);
    }
    let digest = sha(&serde_json::to_vec(block).map_err(|_| Error::History)?);
    if let Some(previous) = index.blocks.get(&block.slot) {
        if previous == &digest {
            return Ok(());
        }
        index.halt();
        return Err(Error::History);
    }
    let mut candidate = index.clone();
    candidate.ready = false;
    candidate.block_transitions.clear();
    match candidate.apply(block) {
        Ok(()) => {
            candidate.blocks.insert(block.slot, digest);
            candidate.checkpoint = Some((block.slot, block.blockhash));
            *index = candidate;
            Ok(())
        }
        Err(error) => {
            index.halt();
            Err(error)
        }
    }
}

fn quiet(slot: u64) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: slot,
        transactions: Vec::new(),
    }
}

#[test]
fn growing_history_preserves_all_digests_duplicates_and_failure_state() {
    let mut optimized = Indexer::new([7; 32], [8; 32]);
    let mut previous = optimized.clone();
    for slot in 1..=4096 {
        let block = quiet(slot);
        optimized.apply_block(&block).unwrap();
        full_clone_reference(&mut previous, &block).unwrap();
    }
    assert_eq!(optimized.blocks.len(), 4096);
    assert_eq!(format!("{optimized:?}"), format!("{previous:?}"));
    for slot in [1, 2, 2048, 4095, 4096] {
        let before = format!("{optimized:?}");
        optimized.apply_block(&quiet(slot)).unwrap();
        assert_eq!(format!("{optimized:?}"), before);
    }
    // A conflicting old duplicate still uses the complete original digest.
    let mut conflict = quiet(2);
    conflict.block_time += 1;
    assert_eq!(optimized.apply_block(&conflict), Err(Error::History));
    assert_eq!(
        full_clone_reference(&mut previous, &conflict),
        Err(Error::History)
    );
    assert_eq!(format!("{optimized:?}"), format!("{previous:?}"));
    assert_eq!(optimized.blocks.len(), 4096);
    assert_eq!(optimized.checkpoint.unwrap().0, 4096);
    assert_eq!(optimized.apply_block(&quiet(4097)), Err(Error::Unavailable));
}

#[test]
#[ignore = "manual local replay microbenchmark; reports measurements without an SLO"]
fn measure_quiet_archive_history_copy_cost() {
    let mut rows = Vec::new();
    for count in [1000u64, 4000, 10000] {
        let blocks: Vec<_> = (1..=count).map(quiet).collect();
        let mut optimized_samples = Vec::new();
        let mut previous_samples = Vec::new();
        for _ in 0..3 {
            let mut optimized = Indexer::new([7; 32], [8; 32]);
            let mut previous = optimized.clone();
            let start = Instant::now();
            for block in &blocks {
                optimized.apply_block(black_box(block)).unwrap();
            }
            optimized_samples.push(start.elapsed().as_secs_f64());
            let start = Instant::now();
            for block in &blocks {
                full_clone_reference(&mut previous, black_box(block)).unwrap();
            }
            previous_samples.push(start.elapsed().as_secs_f64());
            assert_eq!(format!("{optimized:?}"), format!("{previous:?}"));
        }
        rows.push(
            serde_json::json!({"blocks":count,"optimized_seconds":optimized_samples,
            "previous_full_clone_seconds":previous_samples,"exact_state_and_history_equal":true}),
        );
    }
    println!(
        "{}",
        serde_json::json!({"schema":1,"passed":true,
        "scope":"local in-memory synthetic quiet-block replay; test profile opt-level=2; no RPC, financial proof, throughput SLO or public readiness claim",
        "samples":rows})
    );
}
