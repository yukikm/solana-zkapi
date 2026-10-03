//! Layout-2 Anchor Vault. The embedded setup is deliberately TEST ONLY.
#![allow(unexpected_cfgs, deprecated)]
#[cfg(feature = "production")]
compile_error!(
    "production Vault is unavailable: reviewed ceremony artifacts and deployment pins are required"
);
#[cfg(all(feature = "local-test", feature = "devnet"))]
compile_error!("select exactly one deployment: local-test or devnet");
#[cfg(not(any(feature = "local-test", feature = "devnet")))]
compile_error!("select an explicit deployment feature: local-test or devnet");

#[cfg(all(target_os = "solana", not(feature = "sbf-entrypoint")))]
compile_error!("SBF builds require --features sbf-entrypoint for strict wire decoding");

use anchor_lang::prelude::*;
use zkapi_layout2::Operation;
#[path = "accounts.rs"]
pub mod contexts;
pub mod deployment_keys;
mod handlers;
mod keys;
pub mod profile;
pub mod state;
#[path = "../../i02-harness/src/tree_vk.rs"]
mod tree_vk;
mod verify;
#[path = "../../i02-harness/src/vk.rs"]
mod vk;
pub use contexts::*;
pub use state::*;

declare_id!("3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ");
pub const DEPLOYMENT_AUTHORITY: Pubkey = Pubkey::new_from_array([
    138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114, 202, 103, 9, 191, 29,
    148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92,
]);
#[cfg(feature = "local-test")]
pub const USDC_MINT: Pubkey = Pubkey::new_from_array([4; 32]);
#[cfg(all(feature = "devnet", not(feature = "local-test")))]
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TreeUpdate {
    pub public: [[u8; 32]; 11],
    pub proof: [u8; 256],
}

#[program]
pub mod zkapi_vault {
    use super::*;
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_id: [u8; 32],
        genesis: [u8; 32],
        state_key: [u8; 64],
        clearance_key: [u8; 64],
        ttl: u64,
        challenge: u64,
        cap: u64,
        admin: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        handlers::initialize(
            ctx.accounts,
            pool_id,
            genesis,
            state_key,
            clearance_key,
            ttl,
            challenge,
            cap,
            admin,
            treasury,
        )
    }
    pub fn deposit(
        ctx: Context<DepositAccounts>,
        expected_id: u32,
        expected_root: [u8; 32],
        expiry: u64,
        commitment: [u8; 32],
        amount: u64,
        tree: Box<TreeUpdate>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_owner_signer.key(),
            ctx.accounts.financial.token_owner.key(),
            VaultError::InvalidTokenAccount
        );
        let bytes = (expected_id, expected_root, expiry, commitment, amount, tree).try_to_vec()?;
        handlers::run(&ctx.accounts.financial, Operation::Deposit, &bytes)
    }
    pub fn mutual_close(
        ctx: Context<Financial>,
        public: [[u8; 32]; 14],
        proof: [u8; 256],
        tree: Box<TreeUpdate>,
    ) -> Result<()> {
        handlers::run(
            ctx.accounts,
            Operation::Close,
            &(public, proof, tree).try_to_vec()?,
        )
    }
    pub fn initiate_escape(
        ctx: Context<Financial>,
        public: [[u8; 32]; 14],
        proof: [u8; 256],
        tree: Box<TreeUpdate>,
    ) -> Result<()> {
        handlers::run(
            ctx.accounts,
            Operation::Escape,
            &(public, proof, tree).try_to_vec()?,
        )
    }
    pub fn challenge_escape(
        ctx: Context<Financial>,
        note_id: u32,
        public: [[u8; 32]; 12],
        proof: [u8; 256],
        tree: Box<TreeUpdate>,
    ) -> Result<()> {
        handlers::run(
            ctx.accounts,
            Operation::Challenge,
            &(note_id, public, proof, tree).try_to_vec()?,
        )
    }
    pub fn finalize_escape(ctx: Context<Financial>, note_id: u32) -> Result<()> {
        handlers::finalize(ctx.accounts, note_id)
    }
    pub fn claim_expired(
        ctx: Context<Financial>,
        note_id: u32,
        tree: Box<TreeUpdate>,
    ) -> Result<()> {
        handlers::run(
            ctx.accounts,
            Operation::Expiry,
            &(note_id, tree).try_to_vec()?,
        )
    }
    pub fn set_treasury(ctx: Context<Admin>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), VaultError::InvalidBinding);
        handlers::admin(ctx.accounts, Some(new_owner), None)
    }
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        handlers::admin(ctx.accounts, None, Some(true))
    }
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        handlers::admin(ctx.accounts, None, Some(false))
    }
    pub fn execute_payload<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecutePayload<'info>>,
        expected_digest: [u8; 32],
    ) -> Result<()> {
        handlers::execute(ctx, expected_digest)
    }
}

// Anchor's Borsh dispatcher permits trailing arguments. The SBF build wraps it
// to enforce the published fixed wire lengths before decoding any account.
#[cfg(feature = "sbf-entrypoint")]
solana_program::entrypoint!(checked_entry);
#[cfg(feature = "sbf-entrypoint")]
fn checked_entry<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    use anchor_lang::Discriminator;
    let lengths: &[(&[u8], usize)] = &[
        (instruction::InitializePool::DISCRIMINATOR, 280),
        (instruction::Deposit::DISCRIMINATOR, 692),
        (instruction::MutualClose::DISCRIMINATOR, 1312),
        (instruction::InitiateEscape::DISCRIMINATOR, 1312),
        (instruction::ChallengeEscape::DISCRIMINATOR, 1252),
        (instruction::FinalizeEscape::DISCRIMINATOR, 4),
        (instruction::ClaimExpired::DISCRIMINATOR, 612),
        (instruction::SetTreasury::DISCRIMINATOR, 32),
        (instruction::Pause::DISCRIMINATOR, 0),
        (instruction::Unpause::DISCRIMINATOR, 0),
        (instruction::ExecutePayload::DISCRIMINATOR, 32),
    ];
    for (discriminator, len) in lengths {
        if data.starts_with(discriminator) && data.len() != 8 + len {
            return Err(error!(VaultError::InvalidBuffer).into());
        }
    }
    entry(program_id, accounts, data)
}
