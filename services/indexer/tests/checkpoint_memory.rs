//! Synthetic retained-history allocation measurement; no RPC or funded state.
//! Measures the peak increase in live requested bytes on this test thread,
//! including the returned value, not allocator overhead, realloc internals,
//! other threads, or RSS. The same test also runs against the legacy source.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    time::Instant,
};
use zkapi_indexer::{FinalizedBlock, Indexer};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<i128> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}
fn change(delta: i128) {
    if TRACK.try_with(Cell::get).unwrap_or(false) {
        let _ = LIVE.try_with(|live| {
            let next = live.get() + delta;
            live.set(next);
            if next > 0 {
                let _ = PEAK.try_with(|peak| peak.set(peak.get().max(next as usize)));
            }
        });
    }
}
struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            change(layout.size() as i128);
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            change(layout.size() as i128);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        change(-(layout.size() as i128));
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(pointer, layout, size) };
        if !pointer.is_null() {
            change(size as i128 - layout.size() as i128);
        }
        pointer
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn measured<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TRACK.with(|track| track.set(false));
        }
    }
    LIVE.with(|live| live.set(0));
    PEAK.with(|peak| peak.set(0));
    TRACK.with(|track| track.set(true));
    let reset = Reset;
    let value = operation();
    drop(reset);
    (value, PEAK.with(Cell::get))
}
fn hash(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

#[test]
fn checkpoint_save_restore_allocation_measurement() {
    const COUNT: u64 = 65_537;
    const FIRST: u64 = 100_000_000;
    let last = FIRST + COUNT - 1;
    let mut index = Indexer::new([7; 32], [8; 32]);
    for slot in FIRST..=last {
        index
            .apply_block(&FinalizedBlock {
                finalized: true,
                slot,
                parent_slot: slot - 1,
                blockhash: hash(&slot.to_le_bytes()),
                previous_blockhash: hash(&(slot - 1).to_le_bytes()),
                block_time: slot,
                transactions: vec![],
            })
            .unwrap();
    }
    let start = Instant::now();
    let (bytes, save_peak) = measured(|| index.checkpoint_bytes().unwrap());
    let save_micros = start.elapsed().as_micros();
    let checksum = hash(&bytes);
    let start = Instant::now();
    let (restored, restore_peak) = measured(|| {
        Indexer::restore_checkpoint(
            &bytes,
            checksum,
            [7; 32],
            [8; 32],
            last,
            hash(&last.to_le_bytes()),
        )
        .unwrap()
    });
    let restore_micros = start.elapsed().as_micros();
    assert!(!restored.is_ready());
    assert_eq!(restored.checkpoint_bytes().unwrap(), bytes);
    println!(
        "checkpoint_memory blocks={COUNT} payload_bytes={} output_capacity={} save_peak_requested_bytes={save_peak} restore_peak_requested_bytes={restore_peak} save_micros={save_micros} restore_micros={restore_micros}",
        bytes.len(), bytes.capacity()
    );
}
