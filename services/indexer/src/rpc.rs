//! JSON getBlock adapter. The transport MUST request commitment=finalized,
//! encoding=json, transactionDetails=full, maxSupportedTransactionVersion=0.
//! A JSON object cannot prove finality; FinalizedArchive is the explicit trust boundary.
use crate::{
    snapshot::parse_key, Bytes32, Error, FinalizedBlock, Instruction, Result, Transaction,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::collections::BTreeMap;

pub trait FinalizedArchive {
    fn finalized_blocks(&mut self, start: u64, end: u64) -> Result<Vec<u64>>;
    fn finalized_block(&mut self, slot: u64) -> Result<FinalizedBlock>;
}
fn array(value: &Value) -> Result<&Vec<Value>> {
    value.as_array().ok_or(Error::Encoding("RPC array"))
}
fn number(value: &Value) -> Result<u64> {
    value.as_u64().ok_or(Error::Encoding("RPC integer"))
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or(Error::Encoding("RPC string"))
}
fn key(value: &Value) -> Result<Bytes32> {
    parse_key(string(value)?).map_err(|_| Error::Encoding("RPC public key"))
}
fn wire(value: &Value) -> Result<Vec<u8>> {
    bs58::decode(string(value)?)
        .into_vec()
        .map_err(|_| Error::Encoding("RPC base58 data"))
}
fn compiled(
    value: &Value,
    keys: &[Bytes32],
    outer: u32,
    index: u32,
    height: u32,
) -> Result<Instruction> {
    let at = |v: &Value| -> Result<Bytes32> {
        let i = usize::try_from(number(v)?).map_err(|_| Error::Encoding("RPC index"))?;
        keys.get(i)
            .copied()
            .ok_or(Error::Encoding("RPC account bounds"))
    };
    Ok(Instruction {
        program: at(&value["programIdIndex"])?,
        accounts: array(&value["accounts"])?
            .iter()
            .map(at)
            .collect::<Result<_>>()?,
        data: wire(&value["data"])?,
        outer_index: outer,
        invocation_index: index,
        stack_height: height,
        succeeded: None,
        events: Vec::new(),
    })
}
pub fn decode_finalized_block(slot: u64, value: &Value) -> Result<FinalizedBlock> {
    if value.is_null() {
        return Err(Error::History);
    }
    let transactions = array(&value["transactions"])?
        .iter()
        .map(decode_transaction)
        .collect::<Result<_>>()?;
    Ok(FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: number(&value["parentSlot"])?,
        blockhash: key(&value["blockhash"])?,
        previous_blockhash: key(&value["previousBlockhash"])?,
        block_time: number(&value["blockTime"])?,
        transactions,
    })
}
fn decode_transaction(value: &Value) -> Result<Transaction> {
    if !value["version"].is_null() && value["version"] != 0 && value["version"] != "legacy" {
        return Err(Error::Encoding("unsupported transaction version"));
    }
    let tx = &value["transaction"];
    let meta = &value["meta"];
    let signature = string(
        array(&tx["signatures"])?
            .first()
            .ok_or(Error::Encoding("RPC signature"))?,
    )?
    .to_owned();
    let signature_bytes = bs58::decode(&signature)
        .into_vec()
        .map_err(|_| Error::Encoding("RPC signature"))?;
    if signature_bytes.len() != 64 {
        return Err(Error::Encoding("RPC signature length"));
    }
    if !meta.is_object() || meta.get("err").is_none() {
        return Err(Error::Encoding("RPC transaction status"));
    }
    if !meta["err"].is_null() {
        return Ok(Transaction {
            signature,
            succeeded: false,
            instructions: Vec::new(),
        });
    }
    let message = &tx["message"];
    let mut keys = array(&message["accountKeys"])?
        .iter()
        .map(key)
        .collect::<Result<Vec<_>>>()?;
    for part in ["writable", "readonly"] {
        if let Some(list) = meta["loadedAddresses"].get(part) {
            keys.extend(array(list)?.iter().map(key).collect::<Result<Vec<_>>>()?);
        }
    }
    let outer = array(&message["instructions"])?;
    let mut inner = BTreeMap::new();
    if let Some(groups) = meta["innerInstructions"].as_array() {
        for group in groups {
            let index = number(&group["index"])? as usize;
            if index >= outer.len()
                || inner
                    .insert(index, array(&group["instructions"])?.clone())
                    .is_some()
            {
                return Err(Error::Encoding("RPC inner group"));
            }
        }
    } else if !meta["innerInstructions"].is_null() {
        return Err(Error::Encoding("RPC inner instructions"));
    }
    let mut instructions = Vec::new();
    let mut parents = Vec::new();
    for (index, ix) in outer.iter().enumerate() {
        let mut ancestry = vec![instructions.len()];
        instructions.push(compiled(ix, &keys, index as u32, 0, 1)?);
        parents.push(None);
        if let Some(children) = inner.get(&index) {
            for (child_index, child) in children.iter().enumerate() {
                let height = u32::try_from(number(&child["stackHeight"])?)
                    .map_err(|_| Error::Encoding("RPC stack height"))?;
                if height < 2 || height as usize > ancestry.len() + 1 {
                    return Err(Error::Encoding("RPC stack order"));
                }
                ancestry.truncate(height as usize - 1);
                parents.push(ancestry.last().copied());
                ancestry.push(instructions.len());
                instructions.push(compiled(
                    child,
                    &keys,
                    index as u32,
                    child_index as u32 + 1,
                    height,
                )?);
            }
        }
    }
    let mut completion = vec![None; instructions.len()];
    let mut stack: Vec<usize> = Vec::new();
    let mut cursor = 0usize;
    if let Some(logs) = meta["logMessages"].as_array() {
        for value in logs {
            let line = string(value)?;
            if let Some(rest) = line.strip_prefix("Program ") {
                if let Some((program, depth)) = rest.split_once(" invoke [") {
                    let depth = depth
                        .strip_suffix(']')
                        .ok_or(Error::Encoding("log stack"))?
                        .parse::<u32>()
                        .map_err(|_| Error::Encoding("log depth"))?;
                    let program = parse_key(program).map_err(|_| Error::Encoding("log program"))?;
                    // Some native/precompile outer instructions do not emit an
                    // invocation log. They cannot own events or be Vault CPI.
                    while cursor < instructions.len()
                        && instructions[cursor].stack_height == 1
                        && depth == 1
                        && instructions[cursor].program != program
                    {
                        cursor += 1;
                    }
                    let ix = instructions.get(cursor).ok_or(Error::Invocation)?;
                    if ix.program != program
                        || ix.stack_height != depth
                        || stack.len() + 1 != depth as usize
                    {
                        return Err(Error::Invocation);
                    }
                    stack.push(cursor);
                    cursor += 1;
                    continue;
                }
                let finished = rest
                    .strip_suffix(" success")
                    .map(|p| (p, true))
                    .or_else(|| rest.split_once(" failed:").map(|(p, _)| (p, false)));
                if let Some((program, success)) = finished {
                    let index = stack.pop().ok_or(Error::Invocation)?;
                    if instructions[index].program
                        != parse_key(program).map_err(|_| Error::Invocation)?
                    {
                        return Err(Error::Invocation);
                    }
                    completion[index] = Some(success);
                    continue;
                }
            }
            if let Some(encoded) = line.strip_prefix("Program data: ") {
                let index = *stack.last().ok_or(Error::Invocation)?;
                // sol_log_data can contain multiple base64 slices. Preserve
                // each slice under its emitting invocation; only the pinned
                // Vault's single-event payload is interpreted by replay.
                for part in encoded.split_whitespace() {
                    let bytes = STANDARD
                        .decode(part)
                        .map_err(|_| Error::Encoding("event base64"))?;
                    instructions[index].events.push(bytes);
                }
            }
        }
    } else if !meta["logMessages"].is_null() {
        return Err(Error::Encoding("RPC logs"));
    }
    for index in 0..instructions.len() {
        // A successful transaction proves every outer instruction returned
        // success. It does NOT prove success of a caught failing inner CPI.
        let own = if instructions[index].stack_height == 1 {
            if completion[index] == Some(false) {
                return Err(Error::Invocation);
            }
            Some(true)
        } else {
            completion[index]
        };
        instructions[index].succeeded = match parents[index] {
            None => own,
            Some(parent) => match (instructions[parent].succeeded, own) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (Some(true), Some(true)) => Some(true),
                _ => None,
            },
        };
    }
    Ok(Transaction {
        signature,
        succeeded: true,
        instructions,
    })
}
