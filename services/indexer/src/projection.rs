//! Versioned offline Pool evidence. Construction follows complete-block replay;
//! a record digest detects corruption, not omitted provider history. Existing
//! production archives and checkpoints do not consume this format.
use crate::{discriminator, sha, Bytes32, Error, FinalizedBlock, Instruction, Result, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const FORMAT_VERSION: u32 = 1;
pub const RULES_VERSION: u32 = 1;
pub const MAX_PROJECTED_BLOCK_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedTransaction {
    pub original_index: u32,
    pub transaction: Transaction,
}

/// Complete produced-block coverage plus whole selected decoded transactions.
/// `source_block_digest` hashes serde_json bytes of the original FinalizedBlock;
/// `digest` commits the distinct projection format, binding and original indices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedBlock {
    pub version: u32,
    pub rules_version: u32,
    pub program: Bytes32,
    pub pool: Bytes32,
    pub finalized: bool,
    pub slot: u64,
    pub parent_slot: u64,
    pub blockhash: Bytes32,
    pub previous_blockhash: Bytes32,
    pub block_time: u64,
    pub original_transaction_count: u32,
    pub source_block_digest: Bytes32,
    pub transactions: Vec<ProjectedTransaction>,
    pub digest: Bytes32,
}

pub(crate) struct BlockHeader {
    pub finalized: bool,
    pub slot: u64,
    pub parent_slot: u64,
    pub blockhash: Bytes32,
    pub previous_blockhash: Bytes32,
    pub block_time: u64,
}
impl From<&FinalizedBlock> for BlockHeader {
    fn from(block: &FinalizedBlock) -> Self {
        Self {
            finalized: block.finalized,
            slot: block.slot,
            parent_slot: block.parent_slot,
            blockhash: block.blockhash,
            previous_blockhash: block.previous_blockhash,
            block_time: block.block_time,
        }
    }
}

fn selected(tx: &Transaction, program: Bytes32, pool: Bytes32) -> Result<bool> {
    if !tx.succeeded {
        return Ok(false);
    }
    let mut relevant = false;
    // Visit all instructions: finding one match must not hide a later malformed
    // Vault invocation. Full replay remains the mandatory prior validation.
    for ix in &tx.instructions {
        if ix.program != program || ix.succeeded == Some(false) {
            continue;
        }
        if ix.succeeded.is_none() {
            return Err(Error::Invocation);
        }
        relevant |= instruction_pool(ix)? == pool;
    }
    Ok(relevant)
}

/// The same pinned account-selector rule used by replay::instruction. Unknown
/// successful instructions are rejected by full replay when they target this
/// Pool; no version-dependent address heuristic is added by projection.
pub(crate) fn instruction_pool(ix: &Instruction) -> Result<Bytes32> {
    let d = ix
        .data
        .get(..8)
        .ok_or(Error::Encoding("instruction discriminator"))?;
    let is = |name| d == discriminator("global", name);
    let index = if is("create_payload")
        || is("append_payload")
        || is("seal_payload")
        || is("close_payload")
    {
        1
    } else if is("execute_payload") {
        3
    } else {
        0
    };
    ix.accounts
        .get(index)
        .copied()
        .ok_or(Error::Encoding("account index"))
}

impl ProjectedBlock {
    // Only Indexer::validate_and_project constructs new evidence for export.
    pub(crate) fn from_validated(
        block: &FinalizedBlock,
        program: Bytes32,
        pool: Bytes32,
    ) -> Result<Self> {
        let mut transactions = Vec::new();
        for (i, tx) in block.transactions.iter().enumerate() {
            if selected(tx, program, pool)? {
                transactions.push(ProjectedTransaction {
                    original_index: u32::try_from(i).map_err(|_| Error::History)?,
                    transaction: tx.clone(),
                });
            }
        }
        let mut result = Self {
            version: FORMAT_VERSION,
            rules_version: RULES_VERSION,
            program,
            pool,
            finalized: block.finalized,
            slot: block.slot,
            parent_slot: block.parent_slot,
            blockhash: block.blockhash,
            previous_blockhash: block.previous_blockhash,
            block_time: block.block_time,
            original_transaction_count: u32::try_from(block.transactions.len())
                .map_err(|_| Error::History)?,
            source_block_digest: sha(&serde_json::to_vec(block).map_err(|_| Error::History)?),
            transactions,
            digest: [0; 32],
        };
        result.digest = result.compute_digest()?;
        result.validate()?;
        Ok(result)
    }

    pub(crate) fn header(&self) -> BlockHeader {
        BlockHeader {
            finalized: self.finalized,
            slot: self.slot,
            parent_slot: self.parent_slot,
            blockhash: self.blockhash,
            previous_blockhash: self.previous_blockhash,
            block_time: self.block_time,
        }
    }

    fn compute_digest(&self) -> Result<Bytes32> {
        #[derive(Serialize)]
        struct Body<'a> {
            domain: &'static str,
            version: u32,
            rules_version: u32,
            program: Bytes32,
            pool: Bytes32,
            finalized: bool,
            slot: u64,
            parent_slot: u64,
            blockhash: Bytes32,
            previous_blockhash: Bytes32,
            block_time: u64,
            original_transaction_count: u32,
            source_block_digest: Bytes32,
            transactions: &'a [ProjectedTransaction],
        }
        let body = Body {
            domain: "zkapi-pool-projected-block-v1",
            version: self.version,
            rules_version: self.rules_version,
            program: self.program,
            pool: self.pool,
            finalized: self.finalized,
            slot: self.slot,
            parent_slot: self.parent_slot,
            blockhash: self.blockhash,
            previous_blockhash: self.previous_blockhash,
            block_time: self.block_time,
            original_transaction_count: self.original_transaction_count,
            source_block_digest: self.source_block_digest,
            transactions: &self.transactions,
        };
        let bytes = serde_json::to_vec(&body).map_err(|_| Error::History)?;
        if bytes.len() > MAX_PROJECTED_BLOCK_BYTES {
            return Err(Error::Encoding("projected block size"));
        }
        Ok(sha(&bytes))
    }

    /// Check local record integrity and canonical selection shape. This cannot
    /// certify omitted transactions; verify_source plus validated full replay
    /// establishes the source binding during offline export.
    pub fn validate(&self) -> Result<()> {
        if self.version != FORMAT_VERSION
            || self.rules_version != RULES_VERSION
            || self.digest != self.compute_digest()?
        {
            return Err(Error::History);
        }
        if !self.finalized {
            return Err(Error::Unfinalized);
        }
        let mut previous = None;
        let mut signatures = BTreeSet::new();
        for tx in &self.transactions {
            if tx.original_index >= self.original_transaction_count
                || previous.is_some_and(|old| old >= tx.original_index)
                || !signatures.insert(&tx.transaction.signature)
                || !selected(&tx.transaction, self.program, self.pool)?
            {
                return Err(Error::History);
            }
            previous = Some(tx.original_index);
        }
        Ok(())
    }

    /// Match the entire retained source and exact selection, including positions
    /// and omitted transaction count. This byte-binding check is additional to,
    /// never a replacement for, stateful full-block validation.
    pub fn verify_source(&self, source: &FinalizedBlock) -> Result<()> {
        self.validate()?;
        if *self != Self::from_validated(source, self.program, self.pool)? {
            return Err(Error::History);
        }
        Ok(())
    }

    /// Canonical wire is serde_json struct-field order, decimal integers, UTF-8,
    /// no insignificant whitespace and no newline. Nested original types retain
    /// their existing encoding; from_bytes rejects unknown nested fields too.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::History)?;
        if bytes.len() > MAX_PROJECTED_BLOCK_BYTES {
            return Err(Error::Encoding("projected block size"));
        }
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PROJECTED_BLOCK_BYTES {
            return Err(Error::Encoding("projected block size"));
        }
        let result: Self = serde_json::from_slice(bytes).map_err(|_| Error::History)?;
        if result.canonical_bytes()? != bytes {
            return Err(Error::History);
        }
        Ok(result)
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
