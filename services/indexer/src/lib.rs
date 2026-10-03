//! Finalized Vault history replay. RPC data is a trust boundary: callers must
//! fetch finalized blocks from their configured archive and independently verify
//! the account checkpoint. This crate never treats a snapshot hash as a chain anchor.
pub mod replay;
pub mod rpc;
pub mod runtime;
pub mod snapshot;
pub mod tree;

pub use replay::{ChainState, Indexer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub type Bytes32 = [u8; 32];
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid or incomplete archive encoding: {0}")]
    Encoding(&'static str),
    #[error("unfinalized history")]
    Unfinalized,
    #[error("history is missing, reordered, or has conflicting duplicates")]
    History,
    #[error("Vault invocation success cannot be established")]
    Invocation,
    #[error("Vault event does not match instruction replay")]
    Event,
    #[error("Vault state or Merkle root mismatch")]
    State,
    #[error("payload buffer history or digest mismatch")]
    Buffer,
    #[error("snapshot checksum, canonical encoding, or trusted anchor mismatch")]
    Snapshot,
    #[error("path service halted or not reconciled with finalized chain accounts")]
    Unavailable,
}
pub(crate) fn sha(bytes: &[u8]) -> Bytes32 {
    Sha256::digest(bytes).into()
}
pub fn discriminator(kind: &str, name: &str) -> [u8; 8] {
    sha(format!("{kind}:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}
pub(crate) fn canonical(value: Bytes32) -> Result<Bytes32> {
    zkapi_layout2::canonical(&value).map_err(|_| Error::Encoding("noncanonical field"))?;
    Ok(value)
}
pub(crate) fn u64_field(value: &Bytes32) -> Result<u64> {
    zkapi_layout2::to_u64(value).map_err(|_| Error::Encoding("field integer"))
}

/// Archive execution position, including the buffer creation generation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Position {
    pub slot: u64,
    pub transaction_index: u32,
    pub signature: String,
    pub outer_instruction: u32,
    /// 0 for the outer instruction, then the RPC inner-instruction execution order.
    pub invocation_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Instruction {
    pub program: Bytes32,
    pub accounts: Vec<Bytes32>,
    pub data: Vec<u8>,
    pub outer_index: u32,
    pub invocation_index: u32,
    pub stack_height: u32,
    /// Includes ancestor success. None means missing evidence for CPI.
    pub succeeded: Option<bool>,
    /// Only events emitted by this exact invocation, never by its children.
    pub events: Vec<Vec<u8>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transaction {
    pub signature: String,
    pub succeeded: bool,
    pub instructions: Vec<Instruction>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FinalizedBlock {
    pub finalized: bool,
    pub slot: u64,
    pub parent_slot: u64,
    pub blockhash: Bytes32,
    pub previous_blockhash: Bytes32,
    /// On-chain Clock.unix_timestamp for this slot, not the client receive time.
    pub block_time: u64,
    pub transactions: Vec<Transaction>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: u32,
    pub commitment: Bytes32,
    pub deposit: u64,
    pub expiry: u64,
}
impl Note {
    pub fn leaf(&self) -> Result<Bytes32> {
        if self.commitment == [0; 32]
            || self.deposit == 0
            || self.deposit > zkapi_layout2::MAX_AMOUNT
        {
            return Err(Error::State);
        }
        let commitment = zkapi_poseidon::parse(&self.commitment).ok_or(Error::State)?;
        Ok(zkapi_poseidon::bytes(zkapi_poseidon::leaf(
            self.id,
            commitment,
            self.deposit,
            self.expiry,
        )))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub note: Note,
    pub old_root: Bytes32,
    pub nullifier: Bytes32,
    pub balance: u64,
    pub destination_owner: Bytes32,
    pub deadline: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub pool: Bytes32,
    pub sequence: u64,
    pub op: u8,
    pub note_id: u32,
    pub status: u8,
    pub old_root: Bytes32,
    pub new_root: Bytes32,
    pub commitment: Bytes32,
    pub deposit: u64,
    pub expiry: u64,
    pub exit_nullifier: Option<Bytes32>,
    pub final_balance: Option<u64>,
    pub destination_owner: Option<Bytes32>,
    pub deadline: Option<u64>,
}
impl Event {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader(bytes);
        if r.array::<8>()? != discriminator("event", "VaultTransitionV1") || r.byte()? != 1 {
            return Err(Error::Event);
        }
        let event = Self {
            pool: r.array()?,
            sequence: r.u64()?,
            op: r.byte()?,
            note_id: r.u32()?,
            status: r.byte()?,
            old_root: canonical(r.array()?)?,
            new_root: canonical(r.array()?)?,
            commitment: canonical(r.array()?)?,
            deposit: r.u64()?,
            expiry: r.u64()?,
            exit_nullifier: r.option(|r| canonical(r.array()?))?,
            final_balance: r.option(|r| r.u64())?,
            destination_owner: r.option(|r| r.array())?,
            deadline: r.option(|r| r.u64())?,
        };
        r.end()?;
        Ok(event)
    }
}
pub(crate) struct Reader<'a>(pub &'a [u8]);
impl Reader<'_> {
    pub fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let part = self.0.get(..N).ok_or(Error::Encoding("short wire"))?;
        let out = part.try_into().unwrap();
        self.0 = &self.0[N..];
        Ok(out)
    }
    pub fn byte(&mut self) -> Result<u8> {
        Ok(self.array::<1>()?[0])
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub fn option<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<Option<T>> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(f(self)?)),
            _ => Err(Error::Encoding("option tag")),
        }
    }
    pub fn end(&self) -> Result<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(Error::Encoding("trailing bytes"))
        }
    }
}
