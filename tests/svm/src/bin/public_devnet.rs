//! Fresh-profile SBF acceptance with real signatures and fresh tree proofs.
//! Reads public artifacts only. SPL balances and Clock exist only in LiteSVM.
#[path = "../vault_support.rs"]
#[allow(dead_code)]
mod support;
use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, PrimeField};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey, signature::Signer};
use std::{fs, path::Path, process::Command, str::FromStr};
use support::*;
use zkapi_layout2::Operation;
use zkapi_vault::{Note, PoolConfig, TreeState};

fn init(world: &World, profile: &Value) -> Vec<u8> {
    let mut args = Vec::new();
    args.extend([2; 32]);
    args.extend(
        bs58::decode("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
            .into_vec()
            .unwrap(),
    );
    for role in ["state_key", "clearance_key"] {
        for c in ["x", "y"] {
            args.extend(bytes(&profile[role][c]));
        }
    }
    args.extend(2_592_000u64.to_le_bytes());
    args.extend(CHALLENGE.to_le_bytes());
    args.extend(1_000_000u64.to_le_bytes());
    args.extend(world.payer.pubkey().to_bytes());
    args.extend(world.treasury_owner.to_bytes());
    data("initialize_pool", &args)
}
fn tree_proof(
    world: &World,
    profile: &Value,
    profile_dir: &Path,
    prover: &Path,
    output: &Path,
    op: u8,
    expiry: u64,
) -> Vec<u8> {
    let pool: PoolConfig = world.state(world.pool);
    let state: TreeState = world.state(world.tree);
    let mut siblings = [Fr::ZERO; 32];
    let mut zero = Fr::ZERO;
    for sibling in &mut siblings {
        *sibling = zero;
        zero = zkapi_poseidon::node(zero, zero);
    }
    let commitment = Fr::from(123u64);
    let leaf = zkapi_poseidon::leaf(0, commitment, DEPOSIT, expiry);
    let (old, new) = if op == 0 {
        (Fr::ZERO, leaf)
    } else {
        (leaf, Fr::ZERO)
    };
    assert_eq!(
        zkapi_poseidon::bytes(zkapi_poseidon::root(0, old, &siblings)),
        state.root
    );
    let mut public = [
        Fr::from_be_bytes_mod_order(&pool.vault_binding),
        Fr::from_be_bytes_mod_order(&state.root),
        zkapi_poseidon::root(0, new, &siblings),
        Fr::ZERO,
        old,
        new,
        commitment,
        Fr::from(DEPOSIT),
        Fr::from(expiry),
        Fr::from(op),
        Fr::ZERO,
    ];
    let mut tag = vec![zkapi_poseidon::domain(b"solana.zkapi.tree.v1")];
    tag.extend(&public[..10]);
    public[10] = zkapi_poseidon::hash_fields(&tag);
    let string = |x: Fr| format!("0x{}", hex::encode(zkapi_poseidon::bytes(x)));
    let witness = json!({"public_inputs":public.map(string),"siblings":siblings.map(string)});
    let input = output.join(format!("tree-{op}-witness.json"));
    let proof = output.join(format!("tree-{op}.bin"));
    fs::write(&input, serde_json::to_vec(&witness).unwrap()).unwrap();
    let status = Command::new(prover)
        .args(["--test-profile"])
        .arg(profile_dir.join("profile.json"))
        .arg(profile["circuit_profile_hash"].as_str().unwrap())
        .arg(profile_dir.join("tree.pk"))
        .arg(input)
        .arg(&proof)
        .status()
        .expect("native tree prover");
    assert!(status.success());
    let wire = fs::read(proof).unwrap();
    assert_eq!(wire.len(), 608);
    assert_eq!(&wire[..352], public.map(zkapi_poseidon::bytes).concat());
    wire
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        5,
        "ELF PUBLIC_PROFILE_DIRECTORY PUBLIC_PROFILE_SHA256 TREE_PROVER OUTPUT_DIRECTORY"
    );
    let elf = fs::read(&args[0]).unwrap();
    let directory = Path::new(&args[1]);
    let encoded = fs::read(directory.join("public-profile.json")).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&encoded)), args[2]);
    let profile: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(profile["kind"], "public_devnet");
    let output = Path::new(&args[4]);
    fs::create_dir_all(output).unwrap();
    let id = Pubkey::from_str("9ZKaPRLwKibNaMpsz46iC7bpHQ9RoHsBbRuBFTBaHSp2").unwrap();
    let mint = Pubkey::from_str("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").unwrap();
    let mut world = World::new_for(&elf, id, mint);
    assert_eq!(
        world.payer.pubkey().to_string(),
        "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9"
    );
    let mut old = profile.clone();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let fixture = read(root.join("tests/fixtures/crypto/withdrawal-signed.json"));
    old["state_key"] = json!({"x":fixture["public_inputs"][4],"y":fixture["public_inputs"][5]});
    old["clearance_key"] = json!({"x":fixture["public_inputs"][6],"y":fixture["public_inputs"][7]});
    world
        .run(
            "fixture_role_keys_rejected",
            world.init_accounts(),
            init(&world, &old),
            Expect::Error(6001),
        )
        .unwrap_err();
    let mut swapped = profile.clone();
    swapped["state_key"] = profile["clearance_key"].clone();
    swapped["clearance_key"] = profile["state_key"].clone();
    world
        .run(
            "swapped_fresh_roles_rejected",
            world.init_accounts(),
            init(&world, &swapped),
            Expect::Error(6001),
        )
        .unwrap_err();
    world
        .run(
            "fresh_profile_initialize_real_signatures_pdas_ata",
            world.init_accounts(),
            init(&world, &profile),
            Expect::Ok,
        )
        .unwrap();
    let config: PoolConfig = world.state(world.pool);
    assert_eq!(
        config.circuit_profile_hash,
        hex::decode(profile["circuit_profile_hash"].as_str().unwrap())
            .unwrap()
            .as_slice()
    );
    assert_eq!(
        config.state_key.as_slice(),
        [
            bytes(&profile["state_key"]["x"]),
            bytes(&profile["state_key"]["y"])
        ]
        .concat()
    );
    assert_eq!(
        config.clearance_key.as_slice(),
        [
            bytes(&profile["clearance_key"]["x"]),
            bytes(&profile["clearance_key"]["y"])
        ]
        .concat()
    );
    let saved = world.svm.get_account(&world.pool).unwrap();
    world.edit_state::<PoolConfig>(world.pool, |p| p.circuit_profile_hash = [0; 32]);
    world.admin("pause", &[], Expect::Error(6001)).unwrap_err();
    world.rows.last_mut().unwrap()["case"] =
        "modified_pool_profile_rejected_before_admin_mutation".into();
    world.svm.set_account(world.pool, saved).unwrap();
    let expiry = (NOW + 2_592_000).div_ceil(86400) * 86400;
    let insert = tree_proof(
        &world,
        &profile,
        directory,
        Path::new(&args[3]),
        output,
        0,
        expiry,
    );
    let mut payload = Vec::new();
    payload.extend(0u32.to_le_bytes());
    payload.extend(world.state::<TreeState>(world.tree).root);
    payload.extend(expiry.to_le_bytes());
    payload.extend(zkapi_poseidon::bytes(Fr::from(123u64)));
    payload.extend(DEPOSIT.to_le_bytes());
    payload.extend(&insert);
    let compact =
        zkapi_layout2::compress_deposit_compact_v1(&payload, &config.vault_binding).unwrap();
    let mut accounts = world.financial(0, None, Some(Operation::Deposit));
    accounts.push(AccountMeta::new_readonly(world.payer.pubkey(), true));
    let mut invalid = compact;
    let fixture_tree = read(root.join("tests/fixtures/tree/tree-0-0.json"));
    invalid[180..].copy_from_slice(&bytes(&fixture_tree["proof_wire_hex"]));
    world
        .run(
            "old_setup_tree_proof_rejected_under_new_vk",
            accounts.clone(),
            data("deposit_compact_v1", &invalid),
            Expect::Error(6005),
        )
        .unwrap_err();
    let before = world.amount(world.source);
    world
        .run(
            "fresh_tree_compact_deposit_real_token_cpi",
            accounts,
            data("deposit_compact_v1", &compact),
            Expect::Ok,
        )
        .unwrap();
    assert_eq!(world.amount(world.source), before - DEPOSIT);
    assert_eq!(world.amount(world.vault), DEPOSIT);
    assert_eq!(
        world.state::<TreeState>(world.tree).root.as_slice(),
        &insert[64..96]
    );
    assert_eq!(
        world.state::<TreeState>(world.tree).outstanding_deposits,
        DEPOSIT
    );
    assert_eq!(world.state::<Note>(world.note(0)).status, 1);
    let remove = tree_proof(
        &world,
        &profile,
        directory,
        Path::new(&args[3]),
        output,
        1,
        expiry,
    );
    let mut expiry_payload = 0u32.to_le_bytes().to_vec();
    expiry_payload.extend(remove);
    let accounts = world.financial(0, None, Some(Operation::Expiry));
    world
        .run(
            "fresh_tree_expiry_before_deadline_rejected",
            accounts.clone(),
            data("claim_expired", &expiry_payload),
            Expect::Error(6016),
        )
        .unwrap_err();
    world.clock(expiry as i64);
    world
        .run(
            "fresh_tree_expiry_at_deadline_real_token_cpi",
            accounts,
            data("claim_expired", &expiry_payload),
            Expect::Ok,
        )
        .unwrap();
    assert_eq!(world.amount(world.treasury), DEPOSIT);
    assert_eq!(world.amount(world.vault), 0);
    assert_eq!(world.state::<TreeState>(world.tree).outstanding_deposits, 0);
    assert_eq!(world.state::<Note>(world.note(0)).status, 3);
    let report = json!({"passed":true,"scope":"Fresh public-profile actual SBF/LiteSVM initialization, compact deposit and expiry with real tree proofs, signatures and Token CPI; no public RPC/transaction or private role key reads",
        "elf_sha256":hex::encode(Sha256::digest(&elf)),"public_profile_sha256":args[2],"circuit_profile_hash":profile["circuit_profile_hash"],"cases":world.rows.len(),
        "max_cu":world.rows.iter().map(|r|r["cu"].as_u64().unwrap()).max(),"max_transaction_bytes":world.rows.iter().map(|r|r["transaction_bytes"].as_u64().unwrap()).max(),
        "rows":world.rows,"scope_limits":["SPL mint/balances and Clock are local fixtures","No fresh-profile request/withdrawal state signature or escape/challenge lifecycle exercised","No public finality, deployment, provider acceptance or audit"]});
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        json!({"passed":true,"cases":report["cases"],"max_cu":report["max_cu"],"max_transaction_bytes":report["max_transaction_bytes"]})
    );
}
