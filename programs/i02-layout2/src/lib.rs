//! I02-B real-SBF integration/measurement. Fixed TEST keys and measurement state.
//! No Vault initialization/PDA lifecycle, buffer upload lifecycle, or release claim.
#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use zkapi_layout2::{
    binding::{self, Context, Note, Pending},
    framing, Command, Error, Inputs, Operation,
};
mod profile;
pub mod state;
#[path = "../../i02-harness/src/tree_vk.rs"]
mod tree_vk;
mod verify;
#[path = "../../i02-harness/src/vk.rs"]
mod vk;
entrypoint!(process_instruction);
fn custom(e: Error) -> ProgramError {
    ProgramError::Custom(e as u32)
}
fn check(ok: bool, code: u32) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(ProgramError::Custom(code))
    }
}
fn discriminator(name: &str) -> [u8; 8] {
    hash(name.as_bytes()).to_bytes()[..8].try_into().unwrap()
}
fn token(a: &AccountInfo, mint: &Pubkey) -> Result<spl_token::state::Account, ProgramError> {
    check(*a.owner == spl_token::id(), 31)?;
    let t = spl_token::state::Account::unpack(&a.try_borrow_data()?)?;
    check(t.mint == *mint, 31)?;
    Ok(t)
}
fn transfer<'a>(
    a: &[AccountInfo<'a>],
    amount: u64,
    to_treasury: bool,
    deposit: bool,
    bump: u8,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let authority = &a[if deposit { 5 } else { 8 }];
    let dest = &a[if to_treasury { 4 } else { 3 }];
    let ix = spl_token::instruction::transfer_checked(
        a[6].key,
        a[1].key,
        a[2].key,
        dest.key,
        authority.key,
        &[],
        amount,
        6,
    )?;
    let infos = [
        a[1].clone(),
        a[2].clone(),
        dest.clone(),
        authority.clone(),
        a[6].clone(),
    ];
    if deposit {
        invoke(&ix, &infos)
    } else {
        invoke_signed(&ix, &infos, &[&[b"i02-vault", a[0].key.as_ref(), &[bump]]])
    }
}
#[inline(never)]
fn execute(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(a.len() == 9 && data.len() == 40, 30)?;
    check(
        a[0].owner == program && a[7].owner == program && a[0].is_writable && a[7].is_writable,
        30,
    )?;
    check(a[5].is_signer && *a[6].key == spl_token::id(), 30)?;
    let mut state = state::State::decode(&a[0].try_borrow_data()?).map_err(custom)?;
    check(
        state.layout == 2
            && state.backend == 1
            && state.policy == 1
            && state.profile == profile::PROFILE,
        32,
    )?;
    // Constant is used to establish the empty-root invariant at the first insert.
    if state.next_id == 0 && state.status == 0 {
        check(state.root == profile::EMPTY_ROOT, 32)?;
    }
    check(
        state.mint == a[2].key.to_bytes() && state.treasury == a[4].key.to_bytes(),
        31,
    )?;
    check(*a[2].owner == spl_token::id(), 31)?;
    let mint = spl_token::state::Mint::unpack(&a[2].try_borrow_data()?)?;
    check(mint.decimals == 6, 31)?;
    let source = token(&a[1], a[2].key)?;
    let dest = token(&a[3], a[2].key)?;
    let _treasury = token(&a[4], a[2].key)?;
    let (authority, bump) =
        Pubkey::find_program_address(&[b"i02-vault", a[0].key.as_ref()], program);
    check(*a[8].key == authority, 31)?;
    let now: u64 = Clock::get()?
        .unix_timestamp
        .try_into()
        .map_err(|_| custom(Error::Time))?;
    let payload = a[7].try_borrow_data()?;
    check(
        payload.len() >= 115 && &payload[..8] == b"I02BPAYL" && payload[8] == 2 && payload[10] == 1,
        33,
    )?;
    check(
        payload[11..43] == a[0].key.to_bytes() && payload[43..75] == a[5].key.to_bytes(),
        33,
    )?;
    check(
        now < u64::from_le_bytes(payload[75..83].try_into().unwrap()),
        33,
    )?;
    check(
        data[8..] == payload[83..115] && hash(&payload[115..]).as_ref() == &payload[83..115],
        33,
    )?;
    let op = Operation::from_byte(payload[9]).map_err(custom)?;
    let c = Command::decode(op, &payload[115..]).map_err(custom)?;
    if op == Operation::Deposit {
        check(source.owner == *a[5].key && dest.owner == authority, 31)?;
    } else {
        check(source.owner == authority, 31)?;
    }
    let vault = framing::reduce(
        hash(&framing::vault(
            &state.genesis,
            &program.to_bytes(),
            &a[0].key.to_bytes(),
            &a[6].key.to_bytes(),
            &a[2].key.to_bytes(),
        ))
        .to_bytes(),
    );
    let destination =
        framing::reduce(hash(&framing::destination(&dest.owner.to_bytes())).to_bytes());
    let ctx = Context {
        vault,
        state_key: [state.keys[0], state.keys[1]],
        clearance_key: [state.keys[2], state.keys[3]],
        root: state.root,
        next_id: state.next_id,
        note: if state.status == 0 {
            None
        } else {
            Some(Note {
                id: state.id,
                commitment: state.commitment,
                deposit: state.deposit,
                expiry: state.expiry,
                status: state.status,
            })
        },
        pending: Some(Pending {
            exists: state.pending == 1,
            nullifier: state.pending_n,
            deadline: state.deadline,
        }),
        now,
        ttl: state.ttl,
        paused: state.paused != 0,
        exit_consumed: state.consumed == 1
            && c.authorization.is_some_and(|auth| {
                matches!(op, Operation::Close | Operation::Escape)
                    && *auth.public.get(11) == state.exit_n
            }),
        destination,
    };
    let transition = binding::validate(&c, &ctx).map_err(custom)?;
    if let Some(auth) = c.authorization {
        match op {
            Operation::Close | Operation::Escape => {
                verify::verify::<14>(auth.proof, auth.public, &vk::WITHDRAWAL)?
            }
            Operation::Challenge => verify::verify::<12>(auth.proof, auth.public, &vk::REQUEST)?,
            _ => return Err(custom(Error::Encoding)),
        }
    }
    verify::verify::<11>(c.tree.proof, c.tree.public, &tree_vk::TREE)?;
    state.old_root = state.root;
    state.root = transition.root;
    state.sequence = state.sequence.checked_add(1).ok_or(custom(Error::Range))?;
    if let Some(n) = transition.exit_nullifier {
        state.consumed = 1;
        state.exit_n = n;
    }
    match op {
        Operation::Deposit => {
            let d = c.deposit.unwrap();
            state.status = 1;
            state.id = d.expected_id;
            state.commitment = d.commitment;
            state.deposit = d.amount;
            state.expiry = d.expiry;
            state.next_id += 1;
        }
        Operation::Close | Operation::Expiry => state.status = 3,
        Operation::Escape => {
            state.status = 2;
            state.pending = 1;
            state.pending_n = transition.exit_nullifier.unwrap();
            state.deadline = now.checked_add(86400).ok_or(custom(Error::Range))?;
            state.balance =
                zkapi_layout2::to_u64(c.authorization.unwrap().public.get(9)).map_err(custom)?;
            state.destination = dest.owner.to_bytes();
        }
        Operation::Challenge => {
            state.status = 1;
            state.pending = 0;
        }
    }
    drop(payload);
    a[0].try_borrow_mut_data()?.copy_from_slice(&state.encode());
    a[7].try_borrow_mut_data()?[10] = 0;
    if op == Operation::Deposit {
        transfer(a, transition.deposit, false, true, bump)?;
    }
    transfer(a, transition.payout, false, false, bump)?;
    transfer(a, transition.treasury, true, false, bump)?;
    set_return_data(&state.root);
    Ok(())
}
pub fn process_instruction(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(custom(Error::Encoding));
    }
    if data[..8] == discriminator("global:execute_payload") {
        return execute(program, a, data);
    }
    // Measurement-only entrypoints prove each candidate is valid BEFORE mixing.
    let (n, key) = if data[..8] == discriminator("global:i02_verify_tree") {
        (11, &tree_vk::TREE)
    } else if data[..8] == discriminator("global:i02_verify_request") {
        (12, &vk::REQUEST)
    } else if data[..8] == discriminator("global:i02_verify_withdrawal") {
        (14, &vk::WITHDRAWAL)
    } else {
        return Err(custom(Error::Encoding));
    };
    check(a.is_empty() && data.len() == 8 + n * 32 + 256, 30)?;
    let inputs = Inputs::decode(&data[8..8 + n * 32], n).map_err(custom)?;
    let proof = data[8 + n * 32..].try_into().unwrap();
    match n {
        11 => verify::verify::<11>(proof, inputs, key),
        12 => verify::verify::<12>(proof, inputs, key),
        14 => verify::verify::<14>(proof, inputs, key),
        _ => unreachable!(),
    }
}
