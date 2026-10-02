use ark_bn254::Fr;
use ark_ff::PrimeField;
use sha2::{Digest, Sha256};

use crate::{Error, FieldElement, USDC_DECIMALS};

pub const VAULT_LABEL: &str = "solana-zkapi-vault-v1";
pub const DESTINATION_LABEL: &str = "solana-zkapi-destination-v1";
pub const AUTHORIZATION_LABEL: &str = "solana-zkapi-authorization-v1";

pub fn frame(label: &str, parts: &[&[u8]]) -> Result<Vec<u8>, Error> {
    if ![VAULT_LABEL, DESTINATION_LABEL, AUTHORIZATION_LABEL].contains(&label) {
        return Err(Error::InvalidFrame);
    }
    let label_len = u16::try_from(label.len()).map_err(|_| Error::InvalidFrame)?;
    let count = u16::try_from(parts.len()).map_err(|_| Error::InvalidFrame)?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&label_len.to_be_bytes());
    bytes.extend_from_slice(label.as_bytes());
    bytes.extend_from_slice(&count.to_be_bytes());
    for part in parts {
        let len = u32::try_from(part.len()).map_err(|_| Error::InvalidFrame)?;
        bytes.extend_from_slice(&len.to_be_bytes());
        bytes.extend_from_slice(part);
    }
    Ok(bytes)
}

pub fn h2f(label: &str, parts: &[&[u8]]) -> Result<FieldElement, Error> {
    // Reduction is required for H2F only; external field parsing never reduces.
    Ok(Fr::from_be_bytes_mod_order(&Sha256::digest(frame(label, parts)?)).into())
}

pub fn vault_binding(
    genesis: &[u8; 32],
    program: &[u8; 32],
    pool: &[u8; 32],
    token_program: &[u8; 32],
    mint: &[u8; 32],
) -> FieldElement {
    h2f(
        VAULT_LABEL,
        &[
            genesis,
            program,
            pool,
            token_program,
            mint,
            &[USDC_DECIMALS],
        ],
    )
    .expect("fixed binding framing")
}

pub fn destination_binding(owner: &[u8; 32]) -> FieldElement {
    h2f(DESTINATION_LABEL, &[owner]).expect("fixed binding framing")
}

/// Caller must supply validated JCS AuthorizationBody bytes, not arbitrary JSON.
pub fn authorization_context(authorization_jcs: &[u8]) -> Result<FieldElement, Error> {
    h2f(AUTHORIZATION_LABEL, &[authorization_jcs])
}
