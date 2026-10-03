#![allow(unexpected_cfgs)]
use solana_program::{entrypoint, account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey, program_error::ProgramError};
mod state {
    use anchor_lang::prelude::*;
    #[error_code]
    pub enum VaultError { Paused, InvalidBinding, InvalidMint, InvalidTokenAccount, InvalidField }
}
#[path = "keys_generic.rs"]
mod keys;
entrypoint!(process_instruction);
pub fn process_instruction(_: &Pubkey, _: &[AccountInfo], data: &[u8]) -> ProgramResult {
    for p in data.chunks_exact(64) {
        keys::validate(p.try_into().map_err(|_| ProgramError::InvalidInstructionData)?)?;
    }
    Ok(())
}
