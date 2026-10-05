//! Versioned deposit wire: omit only duplicated inputs and fixed deposit zeros.
use crate::{canonical, integer, Command, Error, Field, Operation, ZERO};

pub const DEPOSIT_COMPACT_V1_BYTES: usize = 436;
const DEPOSIT_BYTES: usize = Operation::Deposit.payload_len();

/// Expand exactly 436 args bytes into the unchanged canonical deposit payload.
/// The caller MUST derive `vault_binding` from its authenticated PoolConfig.
/// Proof validation and financial/state checks remain the shared handler's job.
#[inline(never)]
pub fn expand_deposit_compact_v1(
    bytes: &[u8],
    vault_binding: &Field,
) -> Result<[u8; DEPOSIT_BYTES], Error> {
    if bytes.len() != DEPOSIT_COMPACT_V1_BYTES {
        return Err(Error::Encoding);
    }
    canonical(vault_binding)?;
    for offset in [4, 44, 84, 116, 148] {
        canonical(bytes[offset..offset + 32].try_into().unwrap())?;
    }
    let id = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    let expiry = u64::from_le_bytes(bytes[36..44].try_into().unwrap());
    let amount = u64::from_le_bytes(bytes[76..84].try_into().unwrap());
    let mut out = [0; DEPOSIT_BYTES];
    out[..84].copy_from_slice(&bytes[..84]);
    let public = [
        *vault_binding,
        bytes[4..36].try_into().unwrap(),
        bytes[84..116].try_into().unwrap(),
        integer(u64::from(id)),
        ZERO,
        bytes[116..148].try_into().unwrap(),
        bytes[44..76].try_into().unwrap(),
        integer(amount),
        integer(expiry),
        ZERO,
        bytes[148..180].try_into().unwrap(),
    ];
    for (field, target) in public.iter().zip(out[84..436].chunks_exact_mut(32)) {
        target.copy_from_slice(field);
    }
    out[436..].copy_from_slice(&bytes[180..]);
    Ok(out)
}

/// Compress only a canonical deposit whose omitted inputs exactly match its
/// explicit args, deposit constants and authenticated manifest/pool binding.
/// In particular, never hide inconsistent public inputs by dropping them.
pub fn compress_deposit_compact_v1(
    canonical_payload: &[u8],
    vault_binding: &Field,
) -> Result<[u8; DEPOSIT_COMPACT_V1_BYTES], Error> {
    canonical(vault_binding)?;
    let command = Command::decode(Operation::Deposit, canonical_payload)?;
    let deposit = command.deposit.ok_or(Error::Encoding)?;
    let public = command.tree.public;
    for (index, expected) in [
        (0, *vault_binding),
        (1, deposit.expected_root),
        (3, integer(u64::from(deposit.expected_id))),
        (4, ZERO),
        (6, deposit.commitment),
        (7, integer(deposit.amount)),
        (8, integer(deposit.expiry)),
        (9, ZERO),
    ] {
        if *public.get(index) != expected {
            return Err(Error::Binding);
        }
    }
    let mut out = [0; DEPOSIT_COMPACT_V1_BYTES];
    out[..84].copy_from_slice(&canonical_payload[..84]);
    out[84..116].copy_from_slice(public.get(2));
    out[116..148].copy_from_slice(public.get(5));
    out[148..180].copy_from_slice(public.get(10));
    out[180..].copy_from_slice(command.tree.proof);
    Ok(out)
}
