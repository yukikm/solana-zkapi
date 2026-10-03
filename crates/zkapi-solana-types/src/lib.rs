//! Canonical wire values, Solana domain bindings and integer USDC accounting.
//! Circuit/Poseidon semantics remain in the pinned upstream crates.
pub mod amount;
pub mod binding;
pub mod field;

pub use amount::MicroUsdc;
pub use field::{FieldElement, Scalar};
pub use zkapi_layout2::{Operation as Layout2Operation, TreeUpdate};

pub const CHAIN_NAMESPACE: u64 = 0x534f4c;
pub const PROTOCOL_VERSION: u16 = 2;
pub const USDC_DECIMALS: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("noncanonical wire encoding")]
    InvalidEncoding,
    #[error("value outside the permitted range")]
    OutOfRange,
    #[error("integer overflow")]
    Overflow,
    #[error("session budget exceeded")]
    BudgetExceeded,
    #[error("invalid framing length or label")]
    InvalidFrame,
}
