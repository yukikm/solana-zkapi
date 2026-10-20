//! Current-account synchronization. No history reader is reachable from this module.
//! Finalized RPC bytes are trusted; reconstruction verifies consistency, not RPC truth.
mod identity;
mod rpc;
pub mod service;
pub use identity::{IdentityGuard, ProgramPin};
pub use rpc::StateRpc;

use crate::{
    runtime::{array, check_account, decode_note, decode_pending, key, pda, u64_at},
    tree::Tree,
    Bytes32, ChainState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
    path::PathBuf,
};
use zkapi_control::chain::{validate_pool_account, TrustedPool};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const POLICY: &str = "account_state_poc_v1";
pub const MAX_CAPTURE: usize = 32 * 1024 * 1024;
pub const FRESH_MS: u64 = 5_000;
pub const CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR: &str = "Sysvar1111111111111111111111111111111111111";
const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/// Check serialized evidence size without allocating another copy of it.
pub(crate) fn encoded_len(value: &impl Serialize, limit: usize) -> Result<usize> {
    struct Counter {
        length: usize,
        limit: usize,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.length = self
                .length
                .checked_add(bytes.len())
                .filter(|length| *length <= self.limit)
                .ok_or_else(|| io::Error::other("capture size limit"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { length: 0, limit };
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.length)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub mode: String,
    pub poll_idle_seconds: u64,
    pub poll_active_seconds: u64,
    pub max_note_ids: u32,
    pub rpc_concurrency: usize,
    pub max_response_bytes: usize,
    pub max_chain_time_age_seconds: u64,
    pub state_socket: PathBuf,
    pub cache_file: PathBuf,
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        if self.mode != POLICY
            || !(1..=10).contains(&self.poll_idle_seconds)
            || !(1..=2).contains(&self.poll_active_seconds)
            || self.poll_active_seconds > self.poll_idle_seconds
            || !(1..=4096).contains(&self.max_note_ids)
            || !(1..=4).contains(&self.rpc_concurrency)
            || !(1..=16 * 1024 * 1024).contains(&self.max_response_bytes)
            || !(30..=120).contains(&self.max_chain_time_age_seconds)
            || !self.state_socket.is_absolute()
            || !self.cache_file.is_absolute()
            || self.state_socket == self.cache_file
        {
            return Err("current-state configuration".into());
        }
        Ok(())
    }
}

/// Durable observation, never a fabricated transaction execution position.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountCutRef {
    pub deployment: Bytes32,
    pub genesis: Bytes32,
    pub program: Bytes32,
    pub pool: Bytes32,
    pub slot: u64,
    pub blockhash: Bytes32,
    pub sequence: u64,
    pub block_time: u64,
}
impl AccountCutRef {
    pub fn follows(&self, old: &Self) -> bool {
        self.deployment == old.deployment
            && self.genesis == old.genesis
            && self.program == old.program
            && self.pool == old.pool
            && self.slot >= old.slot
            && self.sequence >= old.sequence
            && self.block_time >= old.block_time
            && (self.slot != old.slot
                || (self.blockhash == old.blockhash
                    && self.sequence == old.sequence
                    && self.block_time == old.block_time))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub slot: u64,
    pub first_id: u32,
    pub pairs: u32,
    pub values: Vec<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub slot: u64,
    pub blockhash: Bytes32,
    pub block_time: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub schema: u32,
    pub policy: String,
    pub deployment: Bytes32,
    pub boot: Bytes32,
    pub started_ms: u64,
    pub batches: Vec<Batch>,
    pub header: Header,
    pub digest: Bytes32,
}
impl Capture {
    pub fn digest(&self) -> Result<Bytes32> {
        encoded_len(self, MAX_CAPTURE)?;
        let mut candidate = self.clone();
        candidate.digest = [0; 32];
        Ok(crate::sha(&serde_json::to_vec(&candidate)?))
    }
    pub fn age_ms(&self) -> Result<u64> {
        if self.boot != service::boot_id()? {
            return Err("capture boot changed".into());
        }
        service::monotonic_ms()?
            .checked_sub(self.started_ms)
            .ok_or("capture clock regressed".into())
    }
}

#[derive(Clone, Debug)]
pub struct VerifiedPoolState {
    chain: ChainState,
    tree: Tree,
    cut: AccountCutRef,
    pool_account: Value,
    paused: bool,
    capture: Capture,
}
impl VerifiedPoolState {
    pub fn chain(&self) -> &ChainState {
        &self.chain
    }
    pub fn tree(&self) -> &Tree {
        &self.tree
    }
    pub fn cut(&self) -> &AccountCutRef {
        &self.cut
    }
    pub fn pool(&self) -> Bytes32 {
        self.cut.pool
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn pool_account(&self) -> &Value {
        &self.pool_account
    }
    pub fn capture(&self) -> &Capture {
        &self.capture
    }
    pub fn ensure_fresh(&self) -> Result<()> {
        if self.capture.age_ms()? > FRESH_MS {
            return Err("current view expired".into());
        }
        Ok(())
    }
    pub fn follows(&self, old: &Self) -> bool {
        self.cut.follows(&old.cut)
            && immutable_pool_bytes(&self.pool_account).is_ok_and(|current| {
                immutable_pool_bytes(&old.pool_account).is_ok_and(|previous| current == previous)
            })
            && self.chain.next_note_id >= old.chain.next_note_id
            && (self.chain.sequence != old.chain.sequence
                || (self.chain.root == old.chain.root
                    && self.chain.outstanding_deposits == old.chain.outstanding_deposits
                    && self.chain.next_note_id == old.chain.next_note_id
                    && self.chain.active == old.chain.active
                    && self.chain.pending == old.chain.pending
                    // Closed tombstones and retained Pending records are also
                    // financial account data, even though they have zero leaves.
                    && financial_data(&self.capture).eq(financial_data(&old.capture))))
    }
}

fn immutable_pool_bytes(value: &Value) -> Result<Vec<u8>> {
    let mut raw = STANDARD.decode(value["data"][0].as_str().ok_or("pool encoding")?)?;
    if raw.len() != 422 {
        return Err("pool layout".into());
    }
    raw[171..203].fill(0); // Current treasury.
    raw[355] = 0; // Pause.
    Ok(raw)
}

fn financial_data(capture: &Capture) -> impl Iterator<Item = &Value> {
    capture
        .batches
        .iter()
        .flat_map(|batch| batch.values[4..].iter().map(|value| &value["data"]))
}

pub(crate) fn bytes(value: &Value, owner: &str, executable: bool) -> Result<Vec<u8>> {
    if value["owner"] != owner
        || value["executable"] != executable
        || value["lamports"].as_u64().is_none_or(|n| n == 0)
        || value["data"][1] != "base64"
    {
        return Err("account metadata".into());
    }
    let text = value["data"][0].as_str().ok_or("account encoding")?;
    let raw = STANDARD.decode(text)?;
    if STANDARD.encode(&raw) != text {
        return Err("noncanonical account encoding".into());
    }
    Ok(raw)
}
pub fn addresses(trusted: &TrustedPool, first: u32, pairs: u32) -> Result<Vec<String>> {
    let program = key(&trusted.program_id)?;
    let pool = key(&trusted.pool)?;
    let authority = pda(&program, &[b"vault", &pool]).0;
    let vault = pda(
        &key(ATA)?,
        &[
            &authority,
            &key(&trusted.token_program)?,
            &key(&trusted.mint)?,
        ],
    )
    .0;
    let mut out = vec![pool, pda(&program, &[b"tree", &pool]).0, vault, key(CLOCK)?];
    for id in first..first.checked_add(pairs).ok_or("inventory overflow")? {
        out.push(pda(&program, &[b"note", &pool, &id.to_le_bytes()]).0);
        out.push(pda(&program, &[b"pending", &pool, &id.to_le_bytes()]).0);
    }
    Ok(out.iter().map(|a| bs58::encode(a).into_string()).collect())
}

fn base(trusted: &TrustedPool, batch: &Batch) -> Result<(Vec<u8>, Vec<u8>)> {
    if batch.values.len() != 4 + batch.pairs as usize * 2 || batch.pairs == 0 || batch.pairs > 48 {
        return Err("account batch length".into());
    }
    validate_pool_account(trusted, &batch.values[0], batch.slot)?;
    let pool_raw = bytes(&batch.values[0], &trusted.program_id, false)?;
    if pool_raw[139..171] == [0; 32] || pool_raw[171..203] == [0; 32] {
        return Err("invalid Pool role key".into());
    }
    let tree_raw = bytes(&batch.values[1], &trusted.program_id, false)?;
    let bump = pda(&key(&trusted.program_id)?, &[b"tree", &key(&trusted.pool)?]).1;
    check_account(&tree_raw, "TreeState", 66, bump)?;
    crate::canonical(array(&tree_raw, 10)?)?;
    Ok((pool_raw, tree_raw))
}

/// Pure validation shared with the challenger. All batches, including the
/// initial inventory probe, are authenticated again after socket decoding.
pub fn verify(
    trusted: &TrustedPool,
    deployment: Bytes32,
    settings: &Settings,
    capture: Capture,
    wall_time: u64,
    max_age_ms: u64,
) -> Result<VerifiedPoolState> {
    settings.validate()?;
    if capture.schema != 1
        || capture.policy != POLICY
        || capture.deployment != deployment
        || capture.digest != capture.digest()?
        || capture.age_ms()? > max_age_ms
        || capture.batches.is_empty()
        || capture.batches.len() > 86
    {
        return Err("capture identity/age/size".into());
    }
    let first = &capture.batches[0];
    if first.first_id != 0 || first.pairs != settings.max_note_ids.min(48) {
        return Err("first account inventory".into());
    }
    let (pool_initial, tree_initial) = base(trusted, first)?;
    let n = u64_at(&tree_initial, 42)?;
    if n > u64::from(settings.max_note_ids) {
        return Err("unsupported note capacity".into());
    }
    let mut selected = first;
    let mut expected_id = 0;
    let mut active = BTreeMap::new();
    let mut pending = BTreeMap::new();
    let mut nullifiers = BTreeSet::new();
    let mut outstanding = 0u64;
    let program = key(&trusted.program_id)?;
    let pool = key(&trusted.pool)?;
    for (index, batch) in capture.batches.iter().enumerate() {
        if batch.slot < first.slot
            || batch.first_id != expected_id
            || (index > 0
                && (expected_id as u64 >= n || batch.pairs != (n as u32 - expected_id).min(48)))
        {
            return Err("account inventory/cut order".into());
        }
        let (mut pool_raw, tree_raw) = base(trusted, batch)?;
        // Admin, treasury and pause can change independently of financial sequence.
        // Admin is immutable in this program; only treasury and pause are mutable.
        pool_raw[171..203].copy_from_slice(&pool_initial[171..203]);
        pool_raw[355] = pool_initial[355];
        if tree_raw != tree_initial || pool_raw != pool_initial {
            return Err("financial state changed during capture".into());
        }
        for other in capture
            .batches
            .iter()
            .take(index)
            .filter(|b| b.slot == batch.slot)
        {
            if other.values[..4] != batch.values[..4] {
                return Err("same-slot base conflict".into());
            }
        }
        let vault = bytes(&batch.values[2], TOKEN, false)?;
        let authority = pda(&program, &[b"vault", &pool]).0;
        if trusted.token_program != TOKEN
            || vault.len() != 165
            || vault[..32] != key(&trusted.mint)?
            || vault[32..64] != authority
            || vault[72..76] != [0; 4]
            || vault[129..133] != [0; 4]
            || vault[109..113] != [0; 4]
            || vault[108] != 1
            || u64_at(&vault, 64)? < u64_at(&tree_initial, 58)?
        {
            return Err("vault binding/principal".into());
        }
        let clock = bytes(&batch.values[3], SYSVAR, false)?;
        if clock.len() != 40
            || u64_at(&clock, 0)? != batch.slot
            || i64::from_le_bytes(array(&clock, 32)?) < 0
        {
            return Err("Clock sysvar".into());
        }
        if batch.slot > selected.slot {
            selected = batch;
        }
        for offset in 0..batch.pairs {
            let id = batch.first_id + offset;
            let note_value = &batch.values[4 + offset as usize * 2];
            let pending_value = &batch.values[5 + offset as usize * 2];
            if u64::from(id) >= n {
                if !note_value.is_null() || !pending_value.is_null() {
                    return Err("unallocated account exists".into());
                }
                continue;
            }
            let note_raw = bytes(note_value, &trusted.program_id, false)?;
            let status = *note_raw.get(62).ok_or("short Note")?;
            if !(1..=3).contains(&status) {
                return Err("invalid Note status".into());
            }
            let note = decode_note(
                &note_raw,
                id,
                status,
                pda(&program, &[b"note", &pool, &id.to_le_bytes()]).1,
            )?;
            if note.expiry == 0 {
                return Err("invalid Note expiry".into());
            }
            if status != 3 {
                outstanding = outstanding
                    .checked_add(note.deposit)
                    .ok_or("principal overflow")?;
            }
            let pending_raw = if pending_value.is_null() {
                None
            } else {
                Some(bytes(pending_value, &trusted.program_id, false)?)
            };
            let bump = pda(&program, &[b"pending", &pool, &id.to_le_bytes()]).1;
            if status == 2 {
                let p =
                    decode_pending(pending_raw.as_deref().ok_or("missing Pending")?, note, bump)?;
                if p.destination_owner == [0; 32]
                    || p.deadline == 0
                    || !nullifiers.insert(p.nullifier)
                {
                    return Err("invalid/duplicate Pending".into());
                }
                pending.insert(id, p);
            } else {
                if let Some(raw) = pending_raw {
                    check_account(&raw, "PendingWithdrawal", 123, bump)?;
                    if raw[10] != 0 {
                        return Err("unexpected live Pending".into());
                    }
                    crate::canonical(array(&raw, 11)?)?;
                    crate::canonical(array(&raw, 43)?)?;
                    if u64_at(&raw, 75)? > note.deposit {
                        return Err("retained Pending balance".into());
                    }
                    if array::<32>(&raw, 83)? == [0; 32] || u64_at(&raw, 115)? == 0 {
                        return Err("invalid retained Pending".into());
                    }
                }
                if status == 1 {
                    active.insert(id, note);
                }
            }
        }
        expected_id += batch.pairs;
    }
    if u64::from(expected_id) < n {
        return Err("incomplete Note inventory".into());
    }
    let clock = bytes(&selected.values[3], SYSVAR, false)?;
    let time = u64_at(&clock, 32)?;
    if capture.header.slot != selected.slot
        || capture.header.block_time != time
        || wall_time.saturating_sub(time) > settings.max_chain_time_age_seconds
        || time > wall_time.saturating_add(5)
    {
        return Err("stale/mismatched chain Clock".into());
    }
    let mut tree = Tree::new();
    for note in active.values() {
        tree.update(note.id, note.leaf()?)?;
    }
    if tree.root() != array(&tree_initial, 10)? || outstanding != u64_at(&tree_initial, 58)? {
        return Err("current tree/principal mismatch".into());
    }
    let cut = AccountCutRef {
        deployment,
        program,
        pool,
        genesis: key(&trusted.genesis_hash)?,
        slot: selected.slot,
        blockhash: capture.header.blockhash,
        sequence: u64_at(&tree_initial, 50)?,
        block_time: time,
    };
    let chain = ChainState {
        slot: cut.slot,
        blockhash: cut.blockhash,
        root: tree.root(),
        sequence: cut.sequence,
        next_note_id: n,
        outstanding_deposits: outstanding,
        active,
        pending,
    };
    Ok(VerifiedPoolState {
        chain,
        tree,
        cut,
        pool_account: selected.values[0].clone(),
        paused: bytes(&selected.values[0], &trusted.program_id, false)?[355] == 1,
        capture,
    })
}
