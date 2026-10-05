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
mod buffers;
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

#[cfg(feature = "local-test")]
declare_id!("3uWi9x2SRpmjztkpkr2WWeBoVq3exjXG2YfDWLvm8KsQ");
#[cfg(feature = "local-test")]
pub const DEPLOYMENT_AUTHORITY: Pubkey = Pubkey::new_from_array([
    138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93, 114, 202, 103, 9, 191, 29,
    148, 18, 27, 243, 116, 136, 1, 180, 15, 111, 92,
]);
#[cfg(all(feature = "devnet", not(feature = "local-test")))]
include!(concat!(env!("OUT_DIR"), "/devnet_pins.rs"));
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
    pub fn create_payload(
        ctx: Context<CreatePayload>,
        op: u8,
        len: u32,
        digest: [u8; 32],
        nonce: [u8; 32],
        expires: u64,
    ) -> Result<()> {
        buffers::create(ctx.accounts, op, len, digest, nonce, expires)
    }
    pub fn append_payload(ctx: Context<UploadPayload>, offset: u32, bytes: Vec<u8>) -> Result<()> {
        buffers::append(ctx.accounts, offset, &bytes)
    }
    pub fn seal_payload(ctx: Context<UploadPayload>) -> Result<()> {
        buffers::seal(ctx.accounts)
    }
    pub fn close_payload(ctx: Context<ClosePayload>) -> Result<()> {
        buffers::close(ctx.accounts)
    }
    pub fn execute_payload<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecutePayload<'info>>,
        expected_digest: [u8; 32],
    ) -> Result<()> {
        handlers::execute(ctx, expected_digest)
    }
}

// Anchor's dispatcher permits trailing bytes and decodes Vec lengths before
// handler entry. Bound and exactly match append length before deserialization.
#[cfg(any(feature = "sbf-entrypoint", test))]
fn validate_instruction_length(data: &[u8]) -> Result<()> {
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
        (instruction::CreatePayload::DISCRIMINATOR, 77),
        (instruction::SealPayload::DISCRIMINATOR, 0),
        (instruction::ClosePayload::DISCRIMINATOR, 0),
    ];
    for (discriminator, len) in lengths {
        if data.starts_with(discriminator) {
            require!(data.len() == 8 + len, VaultError::InvalidBuffer);
        }
    }
    if data.starts_with(instruction::AppendPayload::DISCRIMINATOR) {
        let prefix = data
            .get(12..16)
            .ok_or_else(|| error!(VaultError::InvalidBuffer))?;
        let len = u32::from_le_bytes(prefix.try_into().unwrap()) as usize;
        require!(
            len <= buffers::MAX_PAYLOAD && data.len() == 16 + len,
            VaultError::InvalidBuffer
        );
    }
    Ok(())
}
#[cfg(feature = "sbf-entrypoint")]
solana_program::entrypoint!(checked_entry);
#[cfg(feature = "sbf-entrypoint")]
fn checked_entry<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    validate_instruction_length(data)?;
    entry(program_id, accounts, data)
}

#[cfg(test)]
mod transport_wire_tests {
    use super::*;
    use anchor_lang::InstructionData;
    #[test]
    fn append_rejects_unbounded_truncated_and_trailing_vec_before_decode() {
        let valid = instruction::AppendPayload {
            offset: 0,
            bytes: vec![1, 2, 3],
        }
        .data();
        assert!(validate_instruction_length(&valid).is_ok());
        for cut in 8..valid.len() {
            assert!(validate_instruction_length(&valid[..cut]).is_err());
        }
        let mut trailing = valid.clone();
        trailing.push(0);
        assert!(validate_instruction_length(&trailing).is_err());
        let mut forged = valid;
        forged[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_instruction_length(&forged).is_err());
    }
    #[test]
    fn creation_and_empty_instructions_have_exact_wire_lengths() {
        let commands = [
            instruction::CreatePayload {
                op: 0,
                len: 692,
                digest: [0; 32],
                nonce: [0; 32],
                expires: 1,
            }
            .data(),
            instruction::SealPayload {}.data(),
            instruction::ClosePayload {}.data(),
        ];
        for mut data in commands {
            assert!(validate_instruction_length(&data).is_ok());
            data.push(0);
            assert!(validate_instruction_length(&data).is_err());
        }
    }
}

#[cfg(test)]
mod deployment_pin_tests {
    use super::*;
    #[test]
    fn pins_match_the_selected_deployment() {
        #[cfg(feature = "local-test")]
        {
            assert_eq!(ID, Pubkey::new_from_array([43; 32]));
            assert_eq!(
                DEPLOYMENT_AUTHORITY,
                pubkey!("AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9")
            );
            assert_eq!(USDC_MINT, Pubkey::new_from_array([4; 32]));
        }
        #[cfg(all(feature = "devnet", not(feature = "local-test")))]
        {
            assert_eq!(ID.to_string(), env!("ZKAPI_DEVNET_PROGRAM_ID"));
            assert_eq!(
                DEPLOYMENT_AUTHORITY.to_string(),
                env!("ZKAPI_DEVNET_INITIALIZER")
            );
            assert_eq!(
                USDC_MINT,
                pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
            );
        }
    }
}
