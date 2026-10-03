use anchor_lang::prelude::*;

#[account]
#[derive(Debug)]
pub struct PoolConfig {
    pub layout_version: u8,
    pub bump: u8,
    pub genesis_hash: [u8; 32],
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub vault_binding: [u8; 32],
    pub admin: Pubkey,
    pub treasury_owner: Pubkey,
    pub state_key: [u8; 64],
    pub clearance_key: [u8; 64],
    pub ttl: u64,
    pub challenge: u64,
    pub cap: u64,
    pub paused: bool,
    pub tree_backend: u8,
    pub tree_tag_policy: u8,
    pub circuit_profile_hash: [u8; 32],
    // Stored seed permits every instruction to authenticate the Pool PDA.
    pub pool_id: [u8; 32],
}
impl PoolConfig {
    pub const SPACE: usize = 8 + 2 + 32 * 8 + 1 + 128 + 24 + 3;
}
#[account]
#[derive(Debug)]
pub struct TreeState {
    pub layout_version: u8,
    pub bump: u8,
    pub root: [u8; 32],
    pub next_note_id: u64,
    pub sequence: u64,
    pub outstanding_deposits: u64,
}
impl TreeState {
    pub const SPACE: usize = 8 + 2 + 32 + 24;
}
#[account]
#[derive(Debug)]
pub struct Note {
    pub layout_version: u8,
    pub bump: u8,
    pub note_id: u32,
    pub commitment: [u8; 32],
    pub deposit: u64,
    pub expiry: u64,
    pub status: u8,
}
impl Note {
    pub const SPACE: usize = 8 + 2 + 4 + 32 + 16 + 1;
}
#[account]
#[derive(Debug)]
pub struct PendingWithdrawal {
    pub layout_version: u8,
    pub bump: u8,
    pub exists: bool,
    pub old_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub balance: u64,
    pub destination_owner: Pubkey,
    pub deadline: u64,
}
impl PendingWithdrawal {
    pub const SPACE: usize = 8 + 3 + 96 + 16;
}
#[account]
#[derive(Debug)]
pub struct ExitNullifier {
    pub layout_version: u8,
    pub bump: u8,
    pub consumed: bool,
}
impl ExitNullifier {
    pub const SPACE: usize = 8 + 3;
}
/// I04 creates/appends/seals this account. I03 executes authenticated sealed buffers.
#[account]
#[derive(Debug)]
pub struct PayloadBuffer {
    pub layout_version: u8,
    pub bump: u8,
    pub uploader: Pubkey,
    pub op: u8,
    pub payload_len: u32,
    pub digest: [u8; 32],
    pub next_offset: u32,
    pub sealed: bool,
    pub expires: u64,
    pub rent_payer: Pubkey,
    pub payload: Vec<u8>,
    // Retained seed authenticates a buffer even after close/recreation.
    pub nonce: [u8; 32],
}
impl PayloadBuffer {
    pub const HEADER_SPACE: usize = 8 + 2 + 32 + 1 + 4 + 32 + 4 + 1 + 8 + 32 + 4 + 32;
}
#[event]
pub struct VaultTransitionV1 {
    pub event_version: u8,
    pub pool: Pubkey,
    pub sequence: u64,
    pub op: u8,
    pub note_id: u32,
    pub status: u8,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub commitment: [u8; 32],
    pub deposit: u64,
    pub expiry: u64,
    pub exit_nullifier: Option<[u8; 32]>,
    pub final_balance: Option<u64>,
    pub destination_owner: Option<Pubkey>,
    pub deadline: Option<u64>,
}
#[error_code]
pub enum VaultError {
    Paused,
    InvalidBinding,
    InvalidMint,
    InvalidTokenAccount,
    InvalidField,
    InvalidProof,
    StaleRoot,
    StaleNoteId,
    InvalidExpiry,
    TreeFull,
    InvalidBalance,
    ReplayedNullifier,
    NoteNotActive,
    NotPending,
    ChallengeExpired,
    ChallengeNotExpired,
    NotExpired,
    InvalidBuffer,
    ArithmeticOverflow,
}
