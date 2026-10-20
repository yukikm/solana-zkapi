//! Synthetic publication-memory regression. No RPC or funded lifecycle is run.
//! The allocator is scoped to this test binary/thread and counts allocation
//! requests, not RSS or a deployment memory guarantee.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
use zkapi_indexer::{discriminator, Error, FinalizedBlock, Indexer, Instruction, Transaction};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
}
struct Counting;
fn count(bytes: usize) {
    if TRACK.try_with(Cell::get).unwrap_or(false) {
        let _ = BYTES.try_with(|value| value.set(value.get().saturating_add(bytes)));
    }
}
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            count(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            count(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(pointer, layout, size) };
        if !pointer.is_null() {
            count(size);
        }
        pointer
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn allocated<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    BYTES.with(|bytes| bytes.set(0));
    TRACK.with(|track| track.set(true));
    let value = operation();
    TRACK.with(|track| track.set(false));
    (value, BYTES.with(Cell::get))
}
fn hash(slot: u64) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(slot.to_le_bytes()).into()
}
fn block(slot: u64) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: hash(slot),
        previous_blockhash: hash(slot - 1),
        block_time: slot,
        transactions: vec![],
    }
}
fn initial() -> FinalizedBlock {
    let mut args = vec![0; 280];
    args[32..64].copy_from_slice(&[3; 32]);
    args[192..200].copy_from_slice(&86400u64.to_le_bytes());
    args[200..208].copy_from_slice(&60u64.to_le_bytes());
    let mut accounts = vec![[9; 32]; 11];
    accounts[0] = [8; 32];
    accounts[3] = [4; 32];
    accounts[8] = [10; 32];
    let mut data = discriminator("global", "initialize_pool").to_vec();
    data.extend(args);
    let mut value = block(1);
    value.transactions.push(Transaction {
        signature: "synthetic-init".into(),
        succeeded: true,
        instructions: vec![Instruction {
            program: [7; 32],
            accounts,
            data,
            outer_index: 0,
            invocation_index: 0,
            stack_height: 1,
            succeeded: Some(true),
            events: vec![],
        }],
    });
    value
}

#[test]
fn publication_allocation_is_independent_of_retained_block_history() {
    let first = initial();
    let mut index = Indexer::new([7; 32], [8; 32]);
    index.apply_block(&first).unwrap();
    index.reconcile(&index.replay_state().unwrap()).unwrap();
    let (_, short_view_bytes) = allocated(|| index.read_view());
    for slot in 2..=20_001 {
        index.apply_block(&block(slot)).unwrap();
    }
    index.reconcile(&index.replay_state().unwrap()).unwrap();
    let checkpoint_before = index.checkpoint_bytes().unwrap();
    let (view, long_view_bytes) = allocated(|| index.read_view());
    let (full_clone, full_clone_bytes) = allocated(|| index.clone());
    assert_eq!(
        long_view_bytes, short_view_bytes,
        "quiet history must not increase public-view allocations"
    );
    assert!(
        full_clone_bytes > 20_000 * 32,
        "fixture must exercise a substantial accepted-block map"
    );
    assert_eq!(view.root(), index.root());
    assert_eq!(view.snapshot_bytes(), index.snapshot_bytes());
    assert_eq!(
        index.checkpoint_bytes().unwrap(),
        checkpoint_before,
        "publication must preserve every private checkpoint byte"
    );
    drop(full_clone);
    println!("20,001 synthetic blocks: full clone allocated {full_clone_bytes} bytes; public view {long_view_bytes} bytes");
    // Publication neither drains nor weakens the old duplicate digest history.
    index.apply_block(&first).unwrap();
    let mut conflicting = first;
    conflicting.block_time += 1;
    assert_eq!(index.apply_block(&conflicting), Err(Error::History));
    assert!(index.root().is_err());
    assert!(index.read_view().root().is_err());
}
