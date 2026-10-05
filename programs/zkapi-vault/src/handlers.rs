use crate::*;
use anchor_spl::token::spl_token;
use solana_program::{
    hash::hash,
    program::{invoke, invoke_signed},
    program_pack::Pack,
    system_instruction,
};
use zkapi_layout2::{binding, framing, Command, Operation, MAX_AMOUNT};

pub(crate) fn decode<T: AccountDeserialize>(a: &AccountInfo) -> Result<T> {
    require_keys_eq!(*a.owner, crate::ID, VaultError::InvalidBinding);
    T::try_deserialize(&mut &a.try_borrow_data()?[..])
        .map_err(|_| error!(VaultError::InvalidBinding))
}
pub(crate) fn save<T: AccountSerialize>(a: &AccountInfo, value: &T) -> Result<()> {
    require!(a.is_writable, VaultError::InvalidBinding);
    value.try_serialize(&mut &mut a.try_borrow_mut_data()?[..])
}
fn pda(a: &AccountInfo, seeds: &[&[u8]]) -> Result<u8> {
    let (key, bump) = Pubkey::find_program_address(seeds, &crate::ID);
    require_keys_eq!(*a.key, key, VaultError::InvalidBinding);
    Ok(bump)
}
fn layout(version: u8) -> Result<()> {
    require!(version == 2, VaultError::InvalidBinding);
    Ok(())
}
pub(crate) fn now() -> Result<u64> {
    Clock::get()?
        .unix_timestamp
        .try_into()
        .map_err(|_| error!(VaultError::ArithmeticOverflow))
}
pub(crate) fn add(a: u64, b: u64) -> Result<u64> {
    u64::try_from(u128::from(a) + u128::from(b)).map_err(|_| error!(VaultError::ArithmeticOverflow))
}
fn sub(a: u64, b: u64) -> Result<u64> {
    u128::from(a)
        .checked_sub(u128::from(b))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| error!(VaultError::ArithmeticOverflow))
}
fn fresh(a: &AccountInfo) -> bool {
    a.owner == &System::id() && a.data_is_empty()
}
#[inline(never)]
pub(crate) fn create<'info>(
    a: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
) -> Result<u8> {
    let bump = pda(a, seeds)?;
    require!(fresh(a) && a.is_writable, VaultError::InvalidBinding);
    let bump_seed = [bump];
    let mut signed = seeds.to_vec();
    signed.push(&bump_seed);
    let rent = Rent::get()?.minimum_balance(space);
    if a.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, a.key, rent, space as u64, &crate::ID),
            &[payer.clone(), a.clone(), system.clone()],
            &[&signed],
        )?;
    } else {
        if a.lamports() < rent {
            invoke(
                &system_instruction::transfer(payer.key, a.key, rent - a.lamports()),
                &[payer.clone(), a.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(a.key, space as u64),
            &[a.clone(), system.clone()],
            &[&signed],
        )?;
        invoke_signed(
            &system_instruction::assign(a.key, &crate::ID),
            &[a.clone(), system.clone()],
            &[&signed],
        )?;
    }
    Ok(bump)
}
fn mint(a: &AccountInfo) -> Result<()> {
    require_keys_eq!(*a.key, USDC_MINT, VaultError::InvalidMint);
    require_keys_eq!(*a.owner, spl_token::id(), VaultError::InvalidMint);
    let m = spl_token::state::Mint::unpack(&a.try_borrow_data()?)
        .map_err(|_| error!(VaultError::InvalidMint))?;
    require!(m.decimals == 6 && m.is_initialized, VaultError::InvalidMint);
    Ok(())
}
fn token(a: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> Result<u64> {
    require_keys_eq!(*a.owner, spl_token::id(), VaultError::InvalidTokenAccount);
    require_keys_eq!(
        *a.key,
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            owner,
            mint,
            &spl_token::id()
        ),
        VaultError::InvalidTokenAccount
    );
    let t = spl_token::state::Account::unpack(&a.try_borrow_data()?)
        .map_err(|_| error!(VaultError::InvalidTokenAccount))?;
    require!(
        t.owner == *owner && t.mint == *mint && t.delegate.is_none() && t.close_authority.is_none(),
        VaultError::InvalidTokenAccount
    );
    Ok(t.amount)
}
#[inline(never)]
fn ata<'info>(
    account: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    ata_program: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
) -> Result<()> {
    require_keys_eq!(
        *account.key,
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            owner.key,
            mint.key,
            &spl_token::id()
        ),
        VaultError::InvalidTokenAccount
    );
    if fresh(account) {
        anchor_spl::associated_token::create_idempotent(CpiContext::new(
            ata_program.clone(),
            anchor_spl::associated_token::Create {
                payer: payer.clone(),
                associated_token: account.clone(),
                authority: owner.clone(),
                mint: mint.clone(),
                system_program: system.clone(),
                token_program: token_program.clone(),
            },
        ))?;
    }
    token(account, owner.key, mint.key)?;
    Ok(())
}
pub(crate) fn pool(a: &AccountInfo) -> Result<PoolConfig> {
    let p: PoolConfig = decode(a)?;
    layout(p.layout_version)?;
    require!(
        p.bump == pda(a, &[b"pool", &p.pool_id])?,
        VaultError::InvalidBinding
    );
    require!(
        p.mint == USDC_MINT && p.token_program == spl_token::id() && p.decimals == 6,
        VaultError::InvalidMint
    );
    require!(
        p.tree_backend == 1 && p.tree_tag_policy == 1 && p.circuit_profile_hash == profile::PROFILE,
        VaultError::InvalidBinding
    );
    let binding = framing::reduce(
        hash(&framing::vault(
            &p.genesis_hash,
            &crate::ID.to_bytes(),
            &a.key.to_bytes(),
            &p.token_program.to_bytes(),
            &p.mint.to_bytes(),
        ))
        .to_bytes(),
    );
    require!(binding == p.vault_binding, VaultError::InvalidBinding);
    require!(
        p.ttl > 0
            && p.challenge > 0
            && p.cap > 0
            && p.cap <= MAX_AMOUNT
            && p.admin != Pubkey::default()
            && p.treasury_owner != Pubkey::default(),
        VaultError::InvalidBinding
    );
    keys::validate_pair(&p.state_key, &p.clearance_key)?;
    Ok(p)
}
fn tree(a: &Financial) -> Result<TreeState> {
    let t: TreeState = decode(&a.tree)?;
    layout(t.layout_version)?;
    require!(
        t.bump == pda(&a.tree, &[b"tree", a.pool.key.as_ref()])?,
        VaultError::InvalidBinding
    );
    zkapi_layout2::canonical(&t.root).map_err(|_| error!(VaultError::InvalidField))?;
    require!(t.next_note_id <= 1u64 << 32, VaultError::InvalidBinding);
    Ok(t)
}
fn note(a: &Financial, id: u32) -> Result<Note> {
    let n: Note = decode(&a.note)?;
    layout(n.layout_version)?;
    require!(
        n.bump == pda(&a.note, &[b"note", a.pool.key.as_ref(), &id.to_le_bytes()])?
            && n.note_id == id,
        VaultError::InvalidBinding
    );
    require!(
        n.deposit > 0 && n.deposit <= MAX_AMOUNT,
        VaultError::InvalidBalance
    );
    zkapi_layout2::canonical(&n.commitment).map_err(|_| error!(VaultError::InvalidField))?;
    require!(n.commitment != [0; 32], VaultError::InvalidField);
    Ok(n)
}
fn pending(a: &Financial, id: u32) -> Result<PendingWithdrawal> {
    let p: PendingWithdrawal = decode(&a.pending)?;
    layout(p.layout_version)?;
    require!(
        p.bump
            == pda(
                &a.pending,
                &[b"pending", a.pool.key.as_ref(), &id.to_le_bytes()]
            )?,
        VaultError::InvalidBinding
    );
    require!(p.exists, VaultError::NotPending);
    Ok(p)
}
#[allow(clippy::too_many_arguments)]
pub fn initialize(
    a: &InitializePool,
    pool_id: [u8; 32],
    genesis_hash: [u8; 32],
    state_key: [u8; 64],
    clearance_key: [u8; 64],
    ttl: u64,
    challenge: u64,
    cap: u64,
    admin: Pubkey,
    treasury_owner: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        a.deployment_authority.key(),
        DEPLOYMENT_AUTHORITY,
        VaultError::InvalidBinding
    );
    require_keys_eq!(a.admin.key(), admin, VaultError::InvalidBinding);
    require!(
        admin != Pubkey::default()
            && treasury_owner != Pubkey::default()
            && ttl > 0
            && challenge > 0
            && cap > 0
            && cap <= MAX_AMOUNT,
        VaultError::InvalidBinding
    );
    keys::validate_pair(&state_key, &clearance_key)?;
    mint(&a.mint)?;
    pda(&a.vault_authority, &[b"vault", a.pool.key.as_ref()])?;
    let bump = create(
        &a.pool,
        &a.payer,
        &a.system_program,
        &[b"pool", &pool_id],
        PoolConfig::SPACE,
    )?;
    let tree_bump = create(
        &a.tree,
        &a.payer,
        &a.system_program,
        &[b"tree", a.pool.key.as_ref()],
        TreeState::SPACE,
    )?;
    ata(
        &a.vault,
        &a.vault_authority,
        &a.mint,
        &a.payer,
        &a.token_program,
        &a.associated_token_program,
        &a.system_program,
    )?;
    let vault_binding = framing::reduce(
        hash(&framing::vault(
            &genesis_hash,
            &crate::ID.to_bytes(),
            &a.pool.key.to_bytes(),
            &spl_token::id().to_bytes(),
            &USDC_MINT.to_bytes(),
        ))
        .to_bytes(),
    );
    save(
        &a.pool,
        &PoolConfig {
            layout_version: 2,
            bump,
            genesis_hash,
            mint: USDC_MINT,
            token_program: spl_token::id(),
            decimals: 6,
            vault_binding,
            admin,
            treasury_owner,
            state_key,
            clearance_key,
            ttl,
            challenge,
            cap,
            paused: false,
            tree_backend: 1,
            tree_tag_policy: 1,
            circuit_profile_hash: profile::PROFILE,
            pool_id,
        },
    )?;
    save(
        &a.tree,
        &TreeState {
            layout_version: 2,
            bump: tree_bump,
            root: profile::EMPTY_ROOT,
            next_note_id: 0,
            sequence: 0,
            outstanding_deposits: 0,
        },
    )
}
pub fn admin(a: &Admin, treasury: Option<Pubkey>, paused: Option<bool>) -> Result<()> {
    let mut p = pool(&a.pool)?;
    require_keys_eq!(p.admin, a.admin.key(), VaultError::InvalidBinding);
    if let Some(owner) = treasury {
        p.treasury_owner = owner;
    }
    if let Some(value) = paused {
        p.paused = value;
    }
    save(&a.pool, &p)
}
fn validate_vault(a: &Financial, p: &PoolConfig, t: &TreeState) -> Result<u8> {
    mint(&a.mint)?;
    let bump = pda(&a.vault_authority, &[b"vault", a.pool.key.as_ref()])?;
    require!(
        token(&a.vault, a.vault_authority.key, &p.mint)? >= t.outstanding_deposits,
        VaultError::InvalidBalance
    );
    Ok(bump)
}
fn transfer<'info>(
    a: &Financial<'info>,
    destination: &AccountInfo<'info>,
    amount: u64,
    deposit: bool,
    bump: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let source = if deposit {
        a.source.to_account_info()
    } else {
        a.vault.to_account_info()
    };
    let authority = if deposit {
        a.token_owner.to_account_info()
    } else {
        a.vault_authority.to_account_info()
    };
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        source.key,
        a.mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        6,
    )?;
    let infos = [
        source,
        a.mint.to_account_info(),
        destination.clone(),
        authority,
        a.token_program.to_account_info(),
    ];
    if deposit {
        invoke(&ix, &infos)?;
    } else {
        invoke_signed(&ix, &infos, &[&[b"vault", a.pool.key.as_ref(), &[bump]]])?;
    }
    Ok(())
}
fn payout(
    a: &Financial,
    p: &PoolConfig,
    owner: Option<Pubkey>,
    balance: u64,
    treasury: u64,
    bump: u8,
) -> Result<()> {
    require_keys_eq!(
        a.treasury_owner.key(),
        p.treasury_owner,
        VaultError::InvalidBinding
    );
    ata(
        &a.treasury,
        &a.treasury_owner,
        &a.mint,
        &a.payer,
        &a.token_program,
        &a.associated_token_program,
        &a.system_program,
    )?;
    if let Some(owner) = owner {
        require_keys_eq!(a.destination_owner.key(), owner, VaultError::InvalidBinding);
        ata(
            &a.destination,
            &a.destination_owner,
            &a.mint,
            &a.payer,
            &a.token_program,
            &a.associated_token_program,
            &a.system_program,
        )?;
        transfer(a, &a.destination, balance, false, bump)?;
    }
    transfer(a, &a.treasury, treasury, false, bump)
}
fn command_error(e: zkapi_layout2::Error) -> anchor_lang::error::Error {
    match e {
        zkapi_layout2::Error::Field => error!(VaultError::InvalidField),
        zkapi_layout2::Error::Range => error!(VaultError::InvalidBalance),
        zkapi_layout2::Error::TreeFull => error!(VaultError::TreeFull),
        zkapi_layout2::Error::Nullifier => error!(VaultError::ReplayedNullifier),
        _ => error!(VaultError::InvalidBinding),
    }
}
/// Authenticate the binding before restoring omitted inputs; all financial
/// checks and effects still run through the existing canonical deposit handler.
#[inline(never)]
pub fn deposit_compact_v1(a: &Financial, bytes: &[u8]) -> Result<()> {
    let p = pool(&a.pool)?;
    let canonical =
        zkapi_layout2::expand_deposit_compact_v1(bytes, &p.vault_binding).map_err(command_error)?;
    run(a, Operation::Deposit, &canonical)
}
#[inline(never)]
pub fn run(a: &Financial, op: Operation, bytes: &[u8]) -> Result<()> {
    let c = Command::decode(op, bytes).map_err(command_error)?;
    let p = pool(&a.pool)?;
    let mut t = tree(a)?;
    let vault_bump = validate_vault(a, &p, &t)?;
    let now = now()?;
    require!(
        !p.paused || matches!(op, Operation::Challenge | Operation::Expiry),
        VaultError::Paused
    );
    if op == Operation::Deposit {
        require!(t.next_note_id < 1u64 << 32, VaultError::TreeFull);
    }
    let old_root = t.root;
    let id = match op {
        Operation::Deposit => c.deposit.unwrap().expected_id,
        Operation::Close | Operation::Escape => {
            let n = zkapi_layout2::to_u64(c.authorization.unwrap().public.get(8))
                .map_err(command_error)?;
            u32::try_from(n).map_err(|_| error!(VaultError::InvalidField))?
        }
        _ => c.note_id.unwrap(),
    };
    let mut n = if op == Operation::Deposit {
        let d = c.deposit.unwrap();
        require!(t.next_note_id < 1u64 << 32, VaultError::TreeFull);
        require!(t.next_note_id == u64::from(id), VaultError::StaleNoteId);
        require!(d.expected_root == t.root, VaultError::StaleRoot);
        let expected = add(add(now, p.ttl)?, 86399)? / 86400 * 86400;
        require!(d.expiry == expected, VaultError::InvalidExpiry);
        require!(
            d.amount > 0 && d.amount <= MAX_AMOUNT,
            VaultError::InvalidBalance
        );
        require!(d.commitment != [0; 32], VaultError::InvalidField);
        require!(a.token_owner.is_signer, VaultError::InvalidTokenAccount);
        token(&a.source, a.token_owner.key, &p.mint)?;
        let bump = pda(&a.note, &[b"note", a.pool.key.as_ref(), &id.to_le_bytes()])?;
        require!(fresh(&a.note), VaultError::StaleNoteId);
        Note {
            layout_version: 2,
            bump,
            note_id: id,
            commitment: d.commitment,
            deposit: d.amount,
            expiry: d.expiry,
            status: 1,
        }
    } else {
        note(a, id)?
    };
    let mut stored_pending = None;
    let mut exit_bump = None;
    match op {
        Operation::Close | Operation::Escape => {
            require!(n.status == 1, VaultError::NoteNotActive);
            let w = c.authorization.unwrap().public;
            let balance = zkapi_layout2::to_u64(w.get(9)).map_err(command_error)?;
            require!(balance <= n.deposit, VaultError::InvalidBalance);
            let bump = pda(&a.exit, &[b"exit", a.pool.key.as_ref(), w.get(11)])?;
            if !fresh(&a.exit) {
                let exit: ExitNullifier = decode(&a.exit)?;
                layout(exit.layout_version)?;
                require!(exit.bump == bump, VaultError::InvalidBinding);
                require!(!exit.consumed, VaultError::ReplayedNullifier);
            }
            exit_bump = Some(bump);
            if op == Operation::Escape {
                let bump = pda(
                    &a.pending,
                    &[b"pending", a.pool.key.as_ref(), &id.to_le_bytes()],
                )?;
                if !fresh(&a.pending) {
                    let existing: PendingWithdrawal = decode(&a.pending)?;
                    layout(existing.layout_version)?;
                    require!(
                        existing.bump == bump && !existing.exists,
                        VaultError::NotPending
                    );
                }
                stored_pending = Some(PendingWithdrawal {
                    layout_version: 2,
                    bump,
                    exists: true,
                    old_root,
                    nullifier: *w.get(11),
                    balance,
                    destination_owner: a.destination_owner.key(),
                    deadline: add(now, p.challenge)?,
                });
            }
        }
        Operation::Challenge => {
            require!(n.status == 2, VaultError::NotPending);
            let pending = pending(a, id)?;
            require!(now < pending.deadline, VaultError::ChallengeExpired);
            stored_pending = Some(pending);
        }
        Operation::Expiry => {
            require!(n.status == 1, VaultError::NoteNotActive);
            require!(now >= n.expiry, VaultError::NotExpired);
        }
        Operation::Deposit => {}
    }
    require!(*c.tree.public.get(1) == t.root, VaultError::StaleRoot);
    let context = binding::Context {
        vault: p.vault_binding,
        state_key: [
            p.state_key[..32].try_into().unwrap(),
            p.state_key[32..].try_into().unwrap(),
        ],
        clearance_key: [
            p.clearance_key[..32].try_into().unwrap(),
            p.clearance_key[32..].try_into().unwrap(),
        ],
        root: t.root,
        next_id: t.next_note_id,
        note: if op == Operation::Deposit {
            None
        } else {
            Some(binding::Note {
                id: n.note_id,
                commitment: n.commitment,
                deposit: n.deposit,
                expiry: n.expiry,
                status: n.status,
            })
        },
        pending: stored_pending.as_ref().map(|p| binding::Pending {
            exists: p.exists,
            nullifier: p.nullifier,
            deadline: p.deadline,
        }),
        now,
        ttl: p.ttl,
        paused: p.paused,
        exit_consumed: false,
        destination: framing::reduce(
            hash(&framing::destination(&a.destination_owner.key.to_bytes())).to_bytes(),
        ),
    };
    let transition = binding::validate(&c, &context).map_err(command_error)?;
    if let Some(auth) = c.authorization {
        match op {
            Operation::Close | Operation::Escape => {
                verify::verify::<14>(auth.proof, auth.public, &vk::WITHDRAWAL)
            }
            Operation::Challenge => verify::verify::<12>(auth.proof, auth.public, &vk::REQUEST),
            _ => unreachable!(),
        }
        .map_err(|_| error!(VaultError::InvalidProof))?;
    }
    verify::verify::<11>(c.tree.proof, c.tree.public, &tree_vk::TREE)
        .map_err(|_| error!(VaultError::InvalidProof))?;
    // Proofs and semantic checks have completed. Any following CPI failure rolls
    // back these writes, newly created PDAs/ATAs and prior transfers. Logs from
    // failed transactions remain visible and must be filtered by meta.err.
    if op == Operation::Deposit {
        create(
            &a.note,
            &a.payer,
            &a.system_program,
            &[b"note", a.pool.key.as_ref(), &id.to_le_bytes()],
            Note::SPACE,
        )?;
        t.next_note_id = add(t.next_note_id, 1)?;
        t.outstanding_deposits = add(t.outstanding_deposits, n.deposit)?;
        transfer(a, &a.vault, n.deposit, true, vault_bump)?;
    }
    if let Some(bump) = exit_bump {
        if fresh(&a.exit) {
            create(
                &a.exit,
                &a.payer,
                &a.system_program,
                &[
                    b"exit",
                    a.pool.key.as_ref(),
                    &transition.exit_nullifier.unwrap(),
                ],
                ExitNullifier::SPACE,
            )?;
        }
        save(
            &a.exit,
            &ExitNullifier {
                layout_version: 2,
                bump,
                consumed: true,
            },
        )?;
    }
    let mut details = None;
    match op {
        Operation::Close => {
            n.status = 3;
            t.outstanding_deposits = sub(t.outstanding_deposits, n.deposit)?;
            payout(
                a,
                &p,
                Some(a.destination_owner.key()),
                transition.payout,
                transition.treasury,
                vault_bump,
            )?;
            details = Some((
                transition.exit_nullifier.unwrap(),
                transition.payout,
                a.destination_owner.key(),
                None,
            ));
        }
        Operation::Escape | Operation::Challenge => {
            let mut pending = stored_pending.unwrap();
            details = Some((
                pending.nullifier,
                pending.balance,
                pending.destination_owner,
                Some(pending.deadline),
            ));
            if op == Operation::Escape {
                n.status = 2;
                if fresh(&a.pending) {
                    create(
                        &a.pending,
                        &a.payer,
                        &a.system_program,
                        &[b"pending", a.pool.key.as_ref(), &id.to_le_bytes()],
                        PendingWithdrawal::SPACE,
                    )?;
                }
            } else {
                n.status = 1;
                pending.exists = false;
            }
            save(&a.pending, &pending)?;
        }
        Operation::Expiry => {
            n.status = 3;
            t.outstanding_deposits = sub(t.outstanding_deposits, n.deposit)?;
            payout(a, &p, None, 0, n.deposit, vault_bump)?;
        }
        Operation::Deposit => {}
    }
    t.root = transition.root;
    t.sequence = add(t.sequence, 1)?;
    require!(
        token(&a.vault, a.vault_authority.key, &p.mint)? >= t.outstanding_deposits,
        VaultError::InvalidBalance
    );
    save(&a.note, &n)?;
    save(&a.tree, &t)?;
    event(
        a.pool.key(),
        &t,
        &n,
        old_root,
        match op {
            Operation::Expiry => 5,
            _ => op as u8,
        },
        details,
    );
    Ok(())
}
type EventDetails = ([u8; 32], u64, Pubkey, Option<u64>);
fn event(
    pool: Pubkey,
    tree: &TreeState,
    note: &Note,
    old_root: [u8; 32],
    op: u8,
    details: Option<EventDetails>,
) {
    emit!(VaultTransitionV1 {
        event_version: 1,
        pool,
        sequence: tree.sequence,
        op,
        note_id: note.note_id,
        status: note.status,
        old_root,
        new_root: tree.root,
        commitment: note.commitment,
        deposit: note.deposit,
        expiry: note.expiry,
        exit_nullifier: details.map(|v| v.0),
        final_balance: details.map(|v| v.1),
        destination_owner: details.map(|v| v.2),
        deadline: details.and_then(|v| v.3)
    });
}
pub fn finalize(a: &Financial, id: u32) -> Result<()> {
    let p = pool(&a.pool)?;
    let mut t = tree(a)?;
    let bump = validate_vault(a, &p, &t)?;
    let mut n = note(a, id)?;
    require!(n.status == 2, VaultError::NotPending);
    let mut pending = pending(a, id)?;
    require!(now()? >= pending.deadline, VaultError::ChallengeNotExpired);
    require!(pending.balance <= n.deposit, VaultError::InvalidBalance);
    payout(
        a,
        &p,
        Some(pending.destination_owner),
        pending.balance,
        sub(n.deposit, pending.balance)?,
        bump,
    )?;
    t.outstanding_deposits = sub(t.outstanding_deposits, n.deposit)?;
    t.sequence = add(t.sequence, 1)?;
    n.status = 3;
    pending.exists = false;
    require!(
        token(&a.vault, a.vault_authority.key, &p.mint)? >= t.outstanding_deposits,
        VaultError::InvalidBalance
    );
    save(&a.note, &n)?;
    save(&a.pending, &pending)?;
    save(&a.tree, &t)?;
    event(
        a.pool.key(),
        &t,
        &n,
        t.root,
        4,
        Some((
            pending.nullifier,
            pending.balance,
            pending.destination_owner,
            Some(pending.deadline),
        )),
    );
    Ok(())
}
pub fn execute<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecutePayload<'info>>,
    expected_digest: [u8; 32],
) -> Result<()> {
    let buffer: PayloadBuffer =
        decode(&ctx.accounts.payload).map_err(|_| error!(VaultError::InvalidBuffer))?;
    require!(
        buffer.layout_version == 2
            && buffer.sealed
            && buffer.payload_len as usize == buffer.payload.len()
            && buffer.next_offset == buffer.payload_len
            && buffer.payload_len <= 4096
            && now()? < buffer.expires,
        VaultError::InvalidBuffer
    );
    require!(
        buffer.uploader == ctx.accounts.uploader.key()
            && buffer.rent_payer == ctx.accounts.rent_payer.key()
            && buffer.digest == expected_digest
            && hash(&buffer.payload).to_bytes() == buffer.digest,
        VaultError::InvalidBuffer
    );
    require!(
        ctx.accounts.payload.key() != ctx.accounts.rent_payer.key(),
        VaultError::InvalidBuffer
    );
    let op = Operation::from_byte(buffer.op).map_err(|_| error!(VaultError::InvalidBuffer))?;
    require!(
        buffer.payload.len() == op.payload_len(),
        VaultError::InvalidBuffer
    );
    let mut accounts = ctx.remaining_accounts;
    let mut bumps = FinancialBumps::default();
    let mut reallocs = std::collections::BTreeSet::new();
    let financial = Financial::try_accounts(
        ctx.program_id,
        &mut accounts,
        &[],
        &mut bumps,
        &mut reallocs,
    )?;
    require!(accounts.is_empty(), VaultError::InvalidBuffer);
    let bump = pda(
        &ctx.accounts.payload,
        &[
            b"payload",
            financial.pool.key.as_ref(),
            buffer.uploader.as_ref(),
            &buffer.nonce,
        ],
    )
    .map_err(|_| error!(VaultError::InvalidBuffer))?;
    require!(bump == buffer.bump, VaultError::InvalidBuffer);
    run(&financial, op, &buffer.payload)?;
    // Match Anchor close semantics, using checked lamport arithmetic.
    let refund = add(
        ctx.accounts.rent_payer.lamports(),
        ctx.accounts.payload.lamports(),
    )?;
    **ctx.accounts.rent_payer.try_borrow_mut_lamports()? = refund;
    **ctx.accounts.payload.try_borrow_mut_lamports()? = 0;
    ctx.accounts.payload.assign(&System::id());
    ctx.accounts.payload.realloc(0, false)?;
    Ok(())
}
