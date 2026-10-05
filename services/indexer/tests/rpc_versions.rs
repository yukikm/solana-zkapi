//! Read-only RPC envelope regression, including a selected public devnet block.
//! No synthetic transaction here establishes proof, signing or account finality.
use serde_json::{json, Value};
use zkapi_indexer::{discriminator, rpc::decode_finalized_block, tree::Tree, Indexer};

const SLOT: u64 = 507_277_497;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/devnet-v1-initialize-block.json")).unwrap()
}

#[test]
fn public_devnet_v1_neighbor_does_not_block_actual_v0_pool_initialization() {
    let raw = fixture();
    assert_eq!(raw["transactions"][0]["version"], 1);
    assert_eq!(raw["transactions"][1]["version"], 0);
    let block = decode_finalized_block(SLOT, &raw).unwrap();
    assert_eq!(block.transactions.len(), 2);
    assert!(block.transactions.iter().all(|tx| tx.succeeded));
    let init = block.transactions[1]
        .instructions
        .iter()
        .find(|ix| {
            ix.data
                .starts_with(&discriminator("global", "initialize_pool"))
        })
        .unwrap();
    assert_eq!(init.data.len(), 288);
    assert_eq!(init.succeeded, Some(true));
    assert_eq!(
        bs58::encode(init.program).into_string(),
        "64C2qsG8xB5XpnqiJBBDPqJqBc2P8wz73knVhFpi1PDh"
    );
    let mut index = Indexer::new(init.program, init.accounts[0]);
    index.apply_block(&block).unwrap();
    let state = index.replay_state().unwrap();
    assert_eq!(state.slot, SLOT);
    assert_eq!(state.blockhash, block.blockhash);
    assert_eq!(state.root, Tree::new().root());
    assert_eq!(state.next_note_id, 0);
    assert_eq!(state.sequence, 0);
    assert_eq!(state.outstanding_deposits, 0);
    assert!(state.active.is_empty() && state.pending.is_empty());
    // Replaying the archive is still insufficient to publish trusted paths.
    assert!(index.snapshot_bytes().is_err());
}

#[test]
fn legacy_and_v0_replay_stay_identical_and_v1_resource_config_is_not_fee_accounting() {
    let raw = fixture();
    let decoded = decode_finalized_block(SLOT, &raw).unwrap();
    for version in [Value::Null, json!("legacy"), json!(0)] {
        let mut changed = raw.clone();
        let tx = &mut changed["transactions"][0];
        tx["version"] = version;
        tx["transaction"]["message"]
            .as_object_mut()
            .unwrap()
            .remove("transactionConfig");
        assert_eq!(decode_finalized_block(SLOT, &changed).unwrap(), decoded);
    }
    let mut v0_lookup = raw.clone();
    let tx = &mut v0_lookup["transactions"][0];
    tx["version"] = json!(0);
    tx["transaction"]["message"]
        .as_object_mut()
        .unwrap()
        .remove("transactionConfig");
    let loaded = tx["transaction"]["message"]["accountKeys"]
        .as_array_mut()
        .unwrap()
        .pop()
        .unwrap();
    tx["meta"]["loadedAddresses"]["readonly"] = json!([loaded]);
    assert_eq!(decode_finalized_block(SLOT, &v0_lookup).unwrap(), decoded);
    for config in [
        json!({"computeUnitLimit":null,"heapSize":null,"loadedAccountsDataSizeLimit":null,"priorityFee":null}),
        json!({"computeUnitLimit":u32::MAX,"heapSize":u32::MAX,"loadedAccountsDataSizeLimit":u32::MAX,"priorityFee":u64::MAX}),
    ] {
        let mut changed = raw.clone();
        changed["transactions"][0]["transaction"]["message"]["transactionConfig"] = config;
        assert_eq!(decode_finalized_block(SLOT, &changed).unwrap(), decoded);
    }
    let mut failed = raw;
    failed["transactions"][0]["meta"]["err"] = json!({"InstructionError":[0,"InvalidArgument"]});
    let failed = decode_finalized_block(SLOT, &failed).unwrap();
    assert!(!failed.transactions[0].succeeded);
    assert!(failed.transactions[0].instructions.is_empty());
    assert_eq!(failed.transactions[1], decoded.transactions[1]);
}

#[test]
fn v1_malformed_configuration_lookups_headers_and_unknown_versions_fail_closed() {
    let raw = fixture();
    let mut mutations = Vec::new();
    for version in [json!(2), json!("1"), json!(-1), json!(1.5), json!(true)] {
        let mut v = raw.clone();
        v["transactions"][0]["version"] = version;
        mutations.push(v);
    }
    for field in [
        "computeUnitLimit",
        "heapSize",
        "loadedAccountsDataSizeLimit",
        "priorityFee",
    ] {
        for invalid in [json!(-1), json!(1.5), json!("1"), json!(true)] {
            let mut v = raw.clone();
            v["transactions"][0]["transaction"]["message"]["transactionConfig"][field] = invalid;
            mutations.push(v);
        }
        let mut v = raw.clone();
        v["transactions"][0]["transaction"]["message"]["transactionConfig"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        mutations.push(v);
        if field != "priorityFee" {
            let mut v = raw.clone();
            v["transactions"][0]["transaction"]["message"]["transactionConfig"][field] =
                json!(u64::from(u32::MAX) + 1);
            mutations.push(v);
        }
    }
    let message = "/transactions/0/transaction/message";
    for (suffix, invalid) in [
        ("/transactionConfig", Value::Null),
        ("/transactionConfig/unknownLimit", json!(0)),
        ("/addressTableLookups", json!([{}])),
        ("/header/numRequiredSignatures", json!(2)),
        ("/header/numReadonlySignedAccounts", json!(1)),
        ("/header/numReadonlyUnsignedAccounts", json!(4)),
        ("/recentBlockhash", json!("invalid")),
        ("/instructions/0/programIdIndex", json!(4)),
        ("/instructions/0/accounts/0", json!(4)),
    ] {
        let mut v = raw.clone();
        // Object-valued paths are added explicitly for absent optional fields.
        if suffix == "/addressTableLookups" {
            v.pointer_mut(message).unwrap()["addressTableLookups"] = invalid;
        } else if suffix == "/transactionConfig/unknownLimit" {
            v.pointer_mut(&format!("{message}/transactionConfig"))
                .unwrap()["unknownLimit"] = invalid;
        } else {
            *v.pointer_mut(&format!("{message}{suffix}")).unwrap() = invalid;
        }
        mutations.push(v);
    }
    let mut duplicate = raw.clone();
    duplicate["transactions"][0]["transaction"]["message"]["accountKeys"][1] =
        raw["transactions"][0]["transaction"]["message"]["accountKeys"][0].clone();
    mutations.push(duplicate);
    let mut loaded = raw.clone();
    loaded["transactions"][0]["meta"]["loadedAddresses"]["writable"] =
        json!(["11111111111111111111111111111111"]);
    mutations.push(loaded);
    for version in [json!("legacy"), json!(0), Value::Null] {
        let mut v = raw.clone();
        v["transactions"][0]["version"] = version;
        mutations.push(v);
    }
    for (index, invalid) in mutations.into_iter().enumerate() {
        assert!(
            decode_finalized_block(SLOT, &invalid).is_err(),
            "mutation {index}"
        );
    }
}
