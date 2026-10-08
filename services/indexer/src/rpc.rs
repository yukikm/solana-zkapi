//! JSON getBlock adapter. The transport MUST request commitment=finalized,
//! encoding=json, transactionDetails=full, maxSupportedTransactionVersion=1.
//! This is a read-only envelope decoder, not a transaction signer or fee estimator.
//! A JSON object cannot prove finality; FinalizedArchive is the explicit trust boundary.
use crate::{
    snapshot::parse_key, Bytes32, Error, FinalizedBlock, Instruction, Result, Transaction,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use num_bigint::BigUint;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

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
const fn base58_digits() -> [u8; 256] {
    let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits = [u8::MAX; 256];
    let mut index = 0;
    while index < alphabet.len() {
        digits[alphabet[index] as usize] = index as u8;
        index += 1;
    }
    digits
}
const BASE58_DIGITS: [u8; 256] = base58_digits();

/// Preserve the complete default-alphabet Base58 payload, including leading
/// zero bytes. BigUint groups radix digits into machine words, avoiding bs58's
/// byte-at-a-time multiplication cost for large foreign instruction payloads.
/// Signature and public-key decoding retain their existing bs58 paths.
fn instruction_data(value: &str) -> Result<Vec<u8>> {
    let leading = value.bytes().take_while(|byte| *byte == b'1').count();
    let mut digits = Vec::with_capacity(value.len() - leading);
    for byte in &value.as_bytes()[leading..] {
        let digit = BASE58_DIGITS[*byte as usize];
        if digit == u8::MAX {
            return Err(Error::Encoding("RPC base58 data"));
        }
        digits.push(digit);
    }
    let mut bytes = vec![0; leading];
    // BigUint encodes numeric zero as [0]; empty/all-'1' Base58 strings already
    // have their exact byte representation in the prefix above.
    if !digits.is_empty() {
        bytes.extend(
            BigUint::from_radix_be(&digits, 58)
                .ok_or(Error::Encoding("RPC base58 data"))?
                .to_bytes_be(),
        );
    }
    Ok(bytes)
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
        data: instruction_data(string(&value["data"])?)?,
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
fn validate_version(value: &Value) -> Result<()> {
    let message = &value["transaction"]["message"];
    if value["version"] != 1 {
        if !value["version"].is_null() && value["version"] != 0 && value["version"] != "legacy" {
            return Err(Error::Encoding("unsupported transaction version"));
        }
        if message.get("transactionConfig").is_some() {
            return Err(Error::Encoding("unexpected transaction configuration"));
        }
        return Ok(());
    }
    // V1 has inline accounts and a separate resource configuration. Validate
    // its shape, but do not interpret ComputeBudget instructions as v1 limits
    // or convert priorityFee (total lamports) to the v0 per-CU price.
    let config = message["transactionConfig"]
        .as_object()
        .ok_or(Error::Encoding("RPC v1 transaction configuration"))?;
    let fields = [
        "computeUnitLimit",
        "heapSize",
        "loadedAccountsDataSizeLimit",
        "priorityFee",
    ];
    if config.len() != fields.len() || fields.iter().any(|field| !config.contains_key(*field)) {
        return Err(Error::Encoding("RPC v1 transaction configuration"));
    }
    for field in fields {
        let value = &config[field];
        if !value.is_null()
            && (value.as_u64().is_none()
                || (field != "priorityFee" && number(value)? > u64::from(u32::MAX)))
        {
            return Err(Error::Encoding("RPC v1 resource integer"));
        }
    }
    if let Some(lookups) = message.get("addressTableLookups") {
        if !array(lookups)?.is_empty() {
            return Err(Error::Encoding("RPC v1 address lookups"));
        }
    }
    let loaded = &value["meta"]["loadedAddresses"];
    if !loaded.is_null() {
        let loaded = loaded
            .as_object()
            .ok_or(Error::Encoding("RPC v1 loaded addresses"))?;
        if loaded.len() != 2 {
            return Err(Error::Encoding("RPC v1 loaded addresses"));
        }
        for part in ["writable", "readonly"] {
            if !array(
                loaded
                    .get(part)
                    .ok_or(Error::Encoding("RPC v1 loaded addresses"))?,
            )?
            .is_empty()
            {
                return Err(Error::Encoding("RPC v1 loaded addresses"));
            }
        }
    }
    let keys = array(&message["accountKeys"])?
        .iter()
        .map(key)
        .collect::<Result<Vec<_>>>()?;
    if keys.is_empty()
        || keys.len() > 64
        || keys.iter().collect::<BTreeSet<_>>().len() != keys.len()
    {
        return Err(Error::Encoding("RPC v1 account keys"));
    }
    key(&message["recentBlockhash"])?;
    let header = &message["header"];
    let required = number(&header["numRequiredSignatures"])?;
    if required == 0
        || required as usize != array(&value["transaction"]["signatures"])?.len()
        || required > keys.len() as u64
        || number(&header["numReadonlySignedAccounts"])? >= required
        || number(&header["numReadonlyUnsignedAccounts"])? > keys.len() as u64 - required
    {
        return Err(Error::Encoding("RPC v1 message header"));
    }
    for signature in array(&value["transaction"]["signatures"])? {
        if wire(signature)?.len() != 64 {
            return Err(Error::Encoding("RPC signature length"));
        }
    }
    Ok(())
}
fn decode_transaction(value: &Value) -> Result<Transaction> {
    validate_version(value)?;
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
            // Agave can retain shorter lines after its first dropped log. The
            // invocation stack is no longer complete past this exact runtime
            // marker, so later logs cannot establish ownership or completion.
            // Preserve earlier evidence; unknown CPI outcomes remain unknown.
            // Program-generated text has the distinct "Program log: " prefix.
            if line == "Log truncated" {
                break;
            }
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

#[cfg(test)]
mod instruction_data_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn check(text: &str) -> Option<Vec<u8>> {
        let expected = bs58::decode(text).into_vec().ok();
        assert_eq!(instruction_data(text).ok(), expected);
        expected
    }
    fn random(state: &mut u64, len: usize) -> Vec<u8> {
        (0..len)
            .map(|_| {
                *state ^= *state << 13;
                *state ^= *state >> 7;
                *state ^= *state << 17;
                *state as u8
            })
            .collect()
    }

    #[test]
    fn instruction_base58_matches_reference_through_large_payloads() {
        let mut state = 0x28bb_198f_e51d_7a61;
        for len in [
            0, 1, 2, 3, 7, 8, 16, 32, 64, 128, 256, 512, 1024, 4096, 16384,
        ] {
            let bytes = random(&mut state, len);
            for prefix in [0, 1, 2, 8, 64, len / 2, len] {
                let mut with_zero = bytes.clone();
                with_zero[..prefix.min(len)].fill(0);
                let text = bs58::encode(&with_zero).into_string();
                assert_eq!(check(&text).unwrap(), with_zero);
            }
            assert_eq!(check(&"1".repeat(len)).unwrap(), vec![0; len]);
        }
        for byte in 0..=255_u8 {
            assert_eq!(check(&bs58::encode([byte]).into_string()).unwrap(), [byte]);
        }
        let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        for i in 0..256 {
            let len = (i * 43) % 2049;
            let bytes = random(&mut state, len);
            assert_eq!(check(&bs58::encode(&bytes).into_string()).unwrap(), bytes);
            // Independently generated strings exercise the decoder without
            // relying solely on the reference encoder to create valid input.
            let text = random(&mut state, len)
                .into_iter()
                .map(|byte| alphabet[usize::from(byte % 58)] as char)
                .collect::<String>();
            check(&text).unwrap();
        }
    }

    #[test]
    fn instruction_base58_rejects_the_same_invalid_inputs() {
        for byte in 0..=127_u8 {
            check(&String::from_utf8(vec![byte]).unwrap());
        }
        let mut state = 0x283a_176d_35fa_6831;
        for len in [1, 32, 256, 4096, 16384] {
            let valid = bs58::encode(random(&mut state, len)).into_string();
            for bad in [
                "0", "O", "I", "l", " ", "\n", "\r", "\t", "\0", "é", "😃", "＋",
            ] {
                for at in [0, valid.len() / 2, valid.len()] {
                    let text = format!("{}{bad}{}", &valid[..at], &valid[at..]);
                    assert!(check(&text).is_none());
                    assert_eq!(
                        instruction_data(&text),
                        Err(Error::Encoding("RPC base58 data"))
                    );
                }
            }
        }
    }

    #[test]
    fn public_instruction_data_and_framed_digest_match_reference() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/public-base58-instruction-data.json"
        ))
        .unwrap();
        let mut digest = Sha256::new();
        let mut count = 0;
        for block in fixture["blocks"].as_array().unwrap() {
            for text in block["instruction_data"].as_array().unwrap() {
                let text = text.as_str().unwrap();
                let bytes = check(text).unwrap();
                // The exact original payload, including unrelated programs'
                // bytes, reaches Instruction without filtering or shortening.
                let instruction = compiled(
                    &serde_json::json!({"programIdIndex":0,"accounts":[1],"data":text}),
                    &[[2; 32], [3; 32]],
                    4,
                    5,
                    6,
                )
                .unwrap();
                assert_eq!(instruction.data, bytes);
                assert_eq!(instruction.accounts, [[3; 32]]);
                assert_eq!(
                    (
                        instruction.outer_index,
                        instruction.invocation_index,
                        instruction.stack_height
                    ),
                    (4, 5, 6)
                );
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(&bytes);
                count += 1;
            }
        }
        assert_eq!(count, 40);
        assert_eq!(
            hex::encode(digest.finalize()),
            fixture["decoded_framed_sha256"].as_str().unwrap()
        );
    }
}
