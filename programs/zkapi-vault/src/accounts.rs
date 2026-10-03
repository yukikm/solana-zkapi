use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::Token};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    /// CHECK: PDA creation and immutable config checked by initialize.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: tree PDA creation checked by initialize.
    #[account(mut)]
    pub tree: UncheckedAccount<'info>,
    /// CHECK: canonical vault signer PDA checked by initialize.
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: fixed mint, owner and decimals checked by initialize.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: canonical ATA created and checked by initialize.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub deployment_authority: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
/// Shared inline and buffer execution account contract. Unused accounts can be
/// the writable payer; each operation validates every account it actually uses.
#[derive(Accounts)]
pub struct Financial<'info> {
    /// CHECK: owner/discriminator/layout/profile/PDA checked by shared handler.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: owner/discriminator/layout/PDA checked by shared handler.
    #[account(mut)]
    pub tree: UncheckedAccount<'info>,
    /// CHECK: note PDA created/checked using authenticated instruction ID.
    #[account(mut)]
    pub note: UncheckedAccount<'info>,
    /// CHECK: pending PDA created/checked for escape/challenge/finalize.
    #[account(mut)]
    pub pending: UncheckedAccount<'info>,
    /// CHECK: permanent exit PDA checked/created for close/escape.
    #[account(mut)]
    pub exit: UncheckedAccount<'info>,
    /// CHECK: canonical vault PDA checked by shared handler.
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: fixed mint/owner/decimals checked by shared handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: deposit source ATA and signer authority checked by shared handler.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: canonical vault ATA/authority/delegate checked by shared handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: wallet bytes bound into withdrawal proof or saved pending.
    pub destination_owner: UncheckedAccount<'info>,
    /// CHECK: canonical destination ATA created/checked when funds move.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: equals current immutable/administratively set treasury owner.
    pub treasury_owner: UncheckedAccount<'info>,
    /// CHECK: canonical current treasury ATA created/checked when funds move.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: deposit explicitly requires signature and source ownership.
    pub token_owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ExecutePayload<'info> {
    /// CHECK: program/PDA/layout/uploader/digest/expiry checked before dispatch.
    #[account(mut)]
    pub payload: UncheckedAccount<'info>,
    pub uploader: Signer<'info>,
    /// CHECK: exactly the persisted rent payer; receives rent after success.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct Admin<'info> {
    /// CHECK: owner/discriminator/layout/profile/PDA/admin verified by handler.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    pub admin: Signer<'info>,
}
#[derive(Accounts)]
pub struct DepositAccounts<'info> {
    pub financial: Financial<'info>,
    pub token_owner_signer: Signer<'info>,
}
