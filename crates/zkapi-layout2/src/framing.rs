//! Exact H2F frames; the caller supplies SHA256 (syscall on SBF).
use crate::{Field, FR_MODULUS};
const VAULT: &[u8] = b"solana-zkapi-vault-v1";
const DESTINATION: &[u8] = b"solana-zkapi-destination-v1";
pub const VAULT_LEN: usize = 2 + VAULT.len() + 2 + 5 * (4 + 32) + 4 + 1;
pub const DESTINATION_LEN: usize = 2 + DESTINATION.len() + 2 + 4 + 32;
pub fn vault(
    genesis: &Field,
    program: &Field,
    pool: &Field,
    token: &Field,
    mint: &Field,
) -> [u8; VAULT_LEN] {
    let mut out = [0; VAULT_LEN];
    out[..2].copy_from_slice(&(VAULT.len() as u16).to_be_bytes());
    out[2..2 + VAULT.len()].copy_from_slice(VAULT);
    let mut at = 2 + VAULT.len();
    out[at..at + 2].copy_from_slice(&6u16.to_be_bytes());
    at += 2;
    for part in [genesis, program, pool, token, mint] {
        out[at..at + 4].copy_from_slice(&32u32.to_be_bytes());
        at += 4;
        out[at..at + 32].copy_from_slice(part);
        at += 32;
    }
    out[at..at + 4].copy_from_slice(&1u32.to_be_bytes());
    out[at + 4] = 6;
    out
}
pub fn destination(owner: &Field) -> [u8; DESTINATION_LEN] {
    let mut out = [0; DESTINATION_LEN];
    out[..2].copy_from_slice(&(DESTINATION.len() as u16).to_be_bytes());
    out[2..2 + DESTINATION.len()].copy_from_slice(DESTINATION);
    let at = 2 + DESTINATION.len();
    out[at..at + 2].copy_from_slice(&1u16.to_be_bytes());
    out[at + 2..at + 6].copy_from_slice(&32u32.to_be_bytes());
    out[at + 6..].copy_from_slice(owner);
    out
}
/// SHA256 digest modulo BN254 Fr. At most five subtractions; no field library.
pub fn reduce(mut hash: Field) -> Field {
    while hash >= FR_MODULUS {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let n = hash[i] as i16 - FR_MODULUS[i] as i16 - borrow;
            hash[i] = n as u8;
            borrow = i16::from(n < 0);
        }
    }
    hash
}
