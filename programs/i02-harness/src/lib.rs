//! I02 measurement program only. NOT a deployable Vault or its account contract.
//! Raw-proof checks execute in SBF; pairing syscalls enforce curve/subgroup validity.
#![allow(unexpected_cfgs)]
use ark_bn254::Fr;
use ark_ff::AdditiveGroup;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, program::set_return_data,
    program_error::ProgramError, pubkey::Pubkey,
};
mod tree_vk;
mod vk;
entrypoint!(process_instruction);
const FQ: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 151, 129, 106, 145,
    104, 113, 202, 141, 60, 32, 140, 22, 216, 124, 253, 71,
];
fn invalid() -> ProgramError {
    ProgramError::InvalidInstructionData
}
fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8], ProgramError> {
    if data.len() < n {
        return Err(invalid());
    }
    let (head, rest) = data.split_at(n);
    *data = rest;
    Ok(head)
}
fn field(data: &mut &[u8]) -> Result<Fr, ProgramError> {
    zkapi_poseidon::parse(take(data, 32)?.try_into().unwrap()).ok_or(invalid())
}
fn negate(y: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = i16::from(FQ[i]) - i16::from(y[i]) - borrow;
        out[i] = v as u8;
        borrow = i16::from(v < 0);
    }
    if y.iter().all(|x| *x == 0) {
        [0; 32]
    } else {
        out
    }
}
#[inline(never)]
fn verify<const N: usize>(data: &mut &[u8], key: &Groth16Verifyingkey) -> ProgramResult {
    let raw = take(data, 256)?;
    for c in raw.chunks_exact(32) {
        if c >= FQ.as_slice() {
            return Err(invalid());
        }
    }
    // Do not accept infinity, including Solana's (0,0) sentinel.
    for point in [&raw[..64], &raw[64..192], &raw[192..]] {
        if point.iter().all(|x| *x == 0) {
            return Err(invalid());
        }
    }
    let mut a = [0; 64];
    a[..32].copy_from_slice(&raw[..32]);
    a[32..].copy_from_slice(&negate(&raw[32..64]));
    let mut b = [0; 128];
    b[..32].copy_from_slice(&raw[96..128]);
    b[32..64].copy_from_slice(&raw[64..96]);
    b[64..96].copy_from_slice(&raw[160..192]);
    b[96..].copy_from_slice(&raw[128..160]);
    let c: &[u8; 64] = raw[192..].try_into().unwrap();
    let mut inputs = [[0; 32]; N];
    for input in &mut inputs {
        input.copy_from_slice(take(data, 32)?);
        if zkapi_poseidon::parse(input).is_none() {
            return Err(invalid());
        }
    }
    #[cfg(feature = "wrong-vk")]
    let key = &Groth16Verifyingkey {
        vk_alpha_g1: {
            let mut alpha = key.vk_alpha_g1;
            alpha[32..].copy_from_slice(&negate(&key.vk_alpha_g1[32..]));
            alpha
        },
        ..*key
    };
    Groth16Verifier::new(&a, &b, c, &inputs, key)
        .map_err(|_| ProgramError::Custom(1))?
        .verify()
        .map_err(|_| ProgramError::Custom(1))
}

// Actual SPL Token TransferChecked CPIs in the same instruction as the root write.
// Accounts: state, source, mint, recipient, treasury, payer-authority, token program.
fn transfer(accounts: &[AccountInfo], amount: u64, treasury: bool) -> ProgramResult {
    if accounts.len() != 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let source = &accounts[1];
    let mint = &accounts[2];
    let dest = &accounts[if treasury { 4 } else { 3 }];
    let authority = &accounts[5];
    let token = &accounts[6];
    if *token.key != spl_token::id() || !authority.is_signer {
        return Err(ProgramError::IncorrectProgramId);
    }
    let ix = spl_token::instruction::transfer_checked(
        token.key,
        source.key,
        mint.key,
        dest.key,
        authority.key,
        &[],
        amount,
        6,
    )?;
    solana_program::program::invoke(
        &ix,
        &[
            source.clone(),
            mint.clone(),
            dest.clone(),
            authority.clone(),
            token.clone(),
        ],
    )
}
fn transfers(op: u8, accounts: &[AccountInfo]) -> ProgramResult {
    if op == 3 || op == 6 {
        transfer(accounts, 5_000_000, false)?;
    }
    if op == 4 || op == 7 {
        transfer(accounts, 4_900_000, false)?;
        transfer(accounts, 100_000, true)?;
    }
    Ok(())
}
#[inline(never)]
fn tree_fallback(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &mut &[u8],
    op: u8,
) -> ProgramResult {
    // Account 7 contains the immutable-for-this-instruction proof+11 inputs.
    // Payload lifecycle/authentication belongs to I04; no buffer security claim here.
    if accounts.len() != 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let state = &accounts[0];
    let payload = &accounts[7];
    if state.owner != program_id || payload.owner != program_id || !state.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if op == 7 {
        verify::<14>(data, &vk::WITHDRAWAL)?;
    }
    if op == 8 {
        verify::<12>(data, &vk::REQUEST)?;
    }
    let raw = payload.try_borrow_data()?;
    if raw.len() != 256 + 11 * 32 {
        return Err(invalid());
    }
    let mut proof = &raw[..];
    verify::<11>(&mut proof, &tree_vk::TREE)?;
    let mut fields = &raw[256..];
    let mut p = [Fr::ZERO; 11];
    for f in &mut p {
        *f = field(&mut fields)?;
    }
    let mut state = state.try_borrow_mut_data()?;
    if state.len() != 32 + 4 + 32 + 8 + 8 + 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut stored = &state[..];
    let root = field(&mut stored)?;
    let id = u32::from_le_bytes(take(&mut stored, 4)?.try_into().unwrap());
    let c = field(&mut stored)?;
    let deposit = u64::from_le_bytes(take(&mut stored, 8)?.try_into().unwrap());
    let expiry = u64::from_le_bytes(take(&mut stored, 8)?.try_into().unwrap());
    let vault = field(&mut stored)?;
    let tree_op = match op {
        6 => 0u64,
        7 => 1,
        8 => 2,
        _ => return Err(invalid()),
    };
    if p[0] != vault
        || p[1] != root
        || p[3] != Fr::from(id)
        || p[6] != c
        || p[7] != Fr::from(deposit)
        || p[8] != Fr::from(expiry)
        || p[9] != Fr::from(tree_op)
    {
        return Err(ProgramError::Custom(2));
    }
    // Research-only proposal: the fixed tree circuit already constrains this
    // exact tag, and verify::<11> above binds all eleven public inputs. The
    // seven state/op comparisons above remain mandatory. Production adoption
    // needs a specification decision; the default retains recomputation.
    #[cfg(not(feature = "research-proof-bound-tag"))]
    {
        let mut tag = [Fr::ZERO; 11];
        tag[0] = zkapi_poseidon::domain(b"solana.zkapi.tree.v1");
        // Domain + ten fields = eleven sponge elements (six permutations).
        tag[1..].copy_from_slice(&p[..10]);
        if zkapi_poseidon::hash_fields(&tag) != p[10] {
            return Err(ProgramError::Custom(2));
        }
    }
    let root = zkapi_poseidon::bytes(p[2]);
    state[..32].copy_from_slice(&root);
    drop(state);
    transfers(op, &accounts[..7])?;
    set_return_data(&root);
    Ok(())
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let mut data = data;
    let op = take(&mut data, 1)?[0];
    match op {
        0 => verify::<12>(&mut data, &vk::REQUEST)?,
        1 => verify::<14>(&mut data, &vk::WITHDRAWAL)?,
        2 => {
            let n = take(&mut data, 1)?[0] as usize;
            if n > 16 {
                return Err(invalid());
            }
            let mut fields = [Fr::ZERO; 16];
            for f in &mut fields[..n] {
                *f = field(&mut data)?;
            }
            set_return_data(&zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(
                &fields[..n],
            )));
        }
        // Full old-root verification + leaf generation + new-root calculation.
        // Tree path comes from a program-owned measurement account to allow v0 transport.
        3..=5 => {
            let state = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
            if state.owner != program_id || !state.is_writable {
                return Err(ProgramError::InvalidAccountData);
            }
            if op == 4 {
                verify::<14>(&mut data, &vk::WITHDRAWAL)?;
            }
            if op == 5 {
                verify::<12>(&mut data, &vk::REQUEST)?;
            }
            let mut state = state.try_borrow_mut_data()?;
            if state.len() != 32 + 4 + 32 + 8 + 8 + 32 * 32 {
                return Err(ProgramError::InvalidAccountData);
            }
            let mut payload = &state[..];
            let expected = field(&mut payload)?;
            let id = u32::from_le_bytes(take(&mut payload, 4)?.try_into().unwrap());
            let commitment = field(&mut payload)?;
            let deposit = u64::from_le_bytes(take(&mut payload, 8)?.try_into().unwrap());
            let expiry = u64::from_le_bytes(take(&mut payload, 8)?.try_into().unwrap());
            let mut siblings = [Fr::ZERO; 32];
            for s in &mut siblings {
                *s = field(&mut payload)?;
            }
            let leaf = zkapi_poseidon::leaf(id, commitment, deposit, expiry);
            let (old, new) = if op == 4 {
                (leaf, Fr::ZERO)
            } else {
                (Fr::ZERO, leaf)
            };
            if zkapi_poseidon::root(id, old, &siblings) != expected {
                return Err(ProgramError::Custom(2));
            }
            let root = zkapi_poseidon::bytes(zkapi_poseidon::root(id, new, &siblings));
            state[..32].copy_from_slice(&root);
            drop(state);
            transfers(op, accounts)?;
            set_return_data(&root);
        }
        6..=8 => tree_fallback(program_id, accounts, &mut data, op)?,
        9 => verify::<11>(&mut data, &tree_vk::TREE)?,
        #[cfg(feature = "research-syscall")]
        10 => {
            use solana_poseidon::{hashv, Endianness, Parameters};
            let n = take(&mut data, 1)?[0] as usize;
            if n == 0 || n > 12 {
                return Err(invalid());
            }
            let mut fields = [[0; 32]; 12];
            for f in &mut fields[..n] {
                f.copy_from_slice(take(&mut data, 32)?);
            }
            let inputs: Vec<&[u8]> = fields[..n].iter().map(|f| &f[..]).collect();
            let hash = hashv(Parameters::Bn254X5, Endianness::BigEndian, &inputs)
                .map_err(|_| invalid())?;
            set_return_data(&hash.to_bytes());
        }
        _ => return Err(invalid()),
    }
    if !data.is_empty() {
        return Err(invalid());
    }
    Ok(())
}
