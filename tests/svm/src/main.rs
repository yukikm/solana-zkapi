//! Runs compiled ELF in LiteSVM (no native processor replacement).
mod runner;
mod sizes;
use ark_bn254::{Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, Field, PrimeField};
use runner::Runner;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{account::Account, instruction::AccountMeta, program_pack::Pack, pubkey::Pubkey};
use std::{fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let elf =
        fs::read(root.join("target/i02-sbf/zkapi_i02_harness.so")).expect("run SBF build first");
    let wrong_elf = fs::read(root.join("target/i02-sbf-wrong/zkapi_i02_harness.so"))
        .expect("build wrong-vk negative control");
    let mut r = Runner::new(&elf, 1_000_000);
    let mut wrong = Runner::new(&wrong_elf, 1_000_000);
    let mut payloads = vec![];
    for kind in ["request", "withdrawal", "escape"] {
        for variant in ["genesis", "signed"] {
            let name = format!("{kind}-{variant}");
            let f: Value = serde_json::from_slice(
                &fs::read(root.join(format!("tests/fixtures/crypto/{name}.json"))).unwrap(),
            )
            .unwrap();
            let mut data = vec![u8::from(kind != "request")];
            data.extend(hex::decode(f["proof_wire_hex"].as_str().unwrap()).unwrap());
            for input in f["public_inputs"].as_array().unwrap() {
                data.extend(hex::decode(input.as_str().unwrap().trim_start_matches("0x")).unwrap());
            }
            r.run(&name, data.clone(), vec![], Some(true)).unwrap();
            let n = f["public_inputs"].as_array().unwrap().len();
            for i in 0..n {
                let mut changed = data.clone();
                let start = 257 + i * 32;
                let f = Fr::from_be_bytes_mod_order(&changed[start..start + 32]) + Fr::ONE;
                changed[start..start + 32].copy_from_slice(&zkapi_poseidon::bytes(f));
                r.run(&format!("{name}/input-{i}"), changed, vec![], Some(false))
                    .unwrap_err();
                let mut changed = data.clone();
                changed[start..start + 32].copy_from_slice(&Fr::MODULUS.to_bytes_be());
                r.run(
                    &format!("{name}/noncanonical-input-{i}"),
                    changed,
                    vec![],
                    Some(false),
                )
                .unwrap_err();
            }
            for i in 0..8 {
                let start = 1 + i * 32;
                let mut changed = data.clone();
                changed[start + 31] ^= 1;
                r.run(
                    &format!("{name}/coordinate-{i}"),
                    changed,
                    vec![],
                    Some(false),
                )
                .unwrap_err();
                let mut changed = data.clone();
                let mut n = Fq::from_be_bytes_mod_order(&changed[start..start + 32]).into_bigint();
                assert!(!n.add_with_carry(&Fq::MODULUS));
                changed[start..start + 32].copy_from_slice(&n.to_bytes_be());
                r.run(
                    &format!("{name}/noncanonical-coordinate-{i}"),
                    changed,
                    vec![],
                    Some(false),
                )
                .unwrap_err();
            }
            let mut changed = data.clone();
            changed[33..65].copy_from_slice(
                &(-Fq::from_be_bytes_mod_order(&data[33..65]))
                    .into_bigint()
                    .to_bytes_be(),
            );
            r.run(&format!("{name}/A-sign"), changed, vec![], Some(false))
                .unwrap_err();
            let mut changed = data.clone();
            for start in [65, 129] {
                changed[start..start + 32].copy_from_slice(&data[start + 32..start + 64]);
                changed[start + 32..start + 64].copy_from_slice(&data[start..start + 32]);
            }
            r.run(&format!("{name}/G2-order"), changed, vec![], Some(false))
                .unwrap_err();
            wrong
                .run(
                    &format!("{name}/wrong-VK"),
                    data.clone(),
                    vec![],
                    Some(false),
                )
                .unwrap_err();
            let b = (0..100u64)
                .filter_map(|i| {
                    G2Affine::get_point_from_x_unchecked(Fq2::new(Fq::from(i), Fq::ONE), false)
                })
                .find(|p| !p.is_in_correct_subgroup_assuming_on_curve())
                .unwrap();
            let g = G1Affine::generator();
            let coords = [g.x, g.y, b.x.c0, b.x.c1, b.y.c0, b.y.c1, g.x, g.y];
            let mut changed = data.clone();
            for (out, f) in changed[1..257].chunks_exact_mut(32).zip(coords) {
                out.copy_from_slice(&f.into_bigint().to_bytes_be());
            }
            r.run(
                &format!("{name}/non-subgroup-G2"),
                changed,
                vec![],
                Some(false),
            )
            .unwrap_err();
            let mut changed = data.clone();
            changed.push(0);
            r.run(&format!("{name}/trailing"), changed, vec![], Some(false))
                .unwrap_err();
            let mut changed = data.clone();
            changed.pop();
            r.run(&format!("{name}/truncated"), changed, vec![], Some(false))
                .unwrap_err();
            payloads.push((name, data));
        }
    }
    // Real SBF sponge outputs, checked against the independently tested host implementation.
    for n in [0, 1, 2, 3, 4, 5, 11] {
        let fields: Vec<_> = (1..=n).map(|i| Fr::from(i as u64)).collect();
        let mut data = vec![2, n];
        for f in &fields {
            data.extend(zkapi_poseidon::bytes(*f));
        }
        let result = r.run(&format!("poseidon-{n}"), data, vec![], None);
        if let Ok(meta) = result {
            assert_eq!(
                meta.return_data.data,
                zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(&fields))
            );
        }
    }
    let mut diagnostic = Runner::new(&elf, 1_000_000_000);
    for n in [0, 1, 2, 3, 4, 5, 11] {
        let fields: Vec<_> = (1..=n).map(|i| Fr::from(i as u64)).collect();
        let mut data = vec![2, n];
        for f in &fields {
            data.extend(zkapi_poseidon::bytes(*f));
        }
        let meta = diagnostic
            .run(
                &format!("poseidon-{n}/diagnostic-only"),
                data,
                vec![],
                Some(true),
            )
            .unwrap();
        assert_eq!(
            meta.return_data.data,
            zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(&fields))
        );
    }
    for id in [0, u32::MAX] {
        let mut zero = Fr::from(0);
        let siblings: [Fr; 32] = std::array::from_fn(|_| {
            let s = zero;
            zero = zkapi_poseidon::node(zero, zero);
            s
        });
        let c = zkapi_poseidon::hash_fields(&[
            zkapi_poseidon::domain(b"zkapi.v2.reg"),
            Fr::from(42),
            Fr::from(0),
        ]);
        for op in [3, 4, 5] {
            let leaf = zkapi_poseidon::leaf(id, c, 5_000_000, 4_000_000_000);
            let expected = if op == 4 {
                zkapi_poseidon::root(id, leaf, &siblings)
            } else {
                zero
            };
            let new_root = if op == 4 {
                zero
            } else {
                zkapi_poseidon::root(id, leaf, &siblings)
            };
            let mut state = zkapi_poseidon::bytes(expected).to_vec();
            state.extend(id.to_le_bytes());
            state.extend(zkapi_poseidon::bytes(c));
            state.extend(5_000_000u64.to_le_bytes());
            state.extend(4_000_000_000u64.to_le_bytes());
            for s in siblings {
                state.extend(zkapi_poseidon::bytes(s));
            }
            let mut data = vec![op];
            if op != 3 {
                let prefix = if op == 4 {
                    "withdrawal-signed"
                } else {
                    "request-genesis"
                };
                data.extend(&payloads.iter().find(|x| x.0 == prefix).unwrap().1[1..]);
            }
            let accounts = r.accounts(state.clone());
            let diagnostic_accounts = diagnostic.accounts(state.clone());
            r.run(
                &format!("tree-{op}-id-{id}/release-budget"),
                data.clone(),
                accounts.clone(),
                Some(false),
            )
            .unwrap_err();
            assert_eq!(
                r.svm.get_account(&accounts[0].pubkey).unwrap().data,
                state,
                "failed transaction rollback"
            );
            assert_eq!(r.token_amount(&accounts[1].pubkey), 5_000_000);
            let meta = diagnostic
                .run(
                    &format!("tree-{op}-id-{id}/diagnostic-only"),
                    data,
                    diagnostic_accounts.clone(),
                    Some(true),
                )
                .unwrap();
            diagnostic.check_transfers(&diagnostic_accounts, op);
            assert_eq!(meta.return_data.data, zkapi_poseidon::bytes(new_root));
        }
    }
    for id in [0, u32::MAX] {
        for op in 0..3 {
            let name = format!("tree-{id}-{op}");
            let f: Value = serde_json::from_slice(
                &fs::read(root.join(format!("tests/fixtures/tree/{name}.json"))).unwrap(),
            )
            .unwrap();
            let fields: Vec<Vec<u8>> = f["public_inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap())
                .collect();
            let mut payload = hex::decode(f["proof_wire_hex"].as_str().unwrap()).unwrap();
            for field in &fields {
                payload.extend(field);
            }
            let mut proof = vec![9];
            proof.extend(&payload);
            r.run(
                &format!("{name}/verifier-only"),
                proof.clone(),
                vec![],
                Some(true),
            )
            .unwrap();
            for i in 0..11 {
                let mut changed = proof.clone();
                let start = 257 + i * 32;
                changed[start + 31] ^= 1;
                r.run(&format!("{name}/input-{i}"), changed, vec![], Some(false))
                    .unwrap_err();
            }
            wrong
                .run(&format!("{name}/wrong-VK"), proof, vec![], Some(false))
                .unwrap_err();
            let mut state = fields[1].clone();
            state.extend(id.to_le_bytes());
            state.extend(&fields[6]);
            state.extend(5_000_000u64.to_le_bytes());
            state.extend(4_000_000_000u64.to_le_bytes());
            state.extend(&fields[0]);
            let mut data = vec![6 + op as u8];
            if op != 0 {
                let prefix = if op == 1 {
                    "withdrawal-signed"
                } else {
                    "request-genesis"
                };
                data.extend(&payloads.iter().find(|x| x.0 == prefix).unwrap().1[1..]);
            }
            for (runner, mode, expected) in [
                (&mut r, "release-budget", false),
                (&mut diagnostic, "diagnostic-only", true),
            ] {
                let mut accounts = runner.accounts(state.clone());
                let payload_id = Pubkey::new_unique();
                runner
                    .svm
                    .set_account(
                        payload_id,
                        Account {
                            lamports: 10_000_000,
                            data: payload.clone(),
                            owner: runner.id,
                            executable: false,
                            rent_epoch: 0,
                        },
                    )
                    .unwrap();
                accounts.push(AccountMeta::new_readonly(payload_id, false));
                let result = runner.run(
                    &format!("fallback-{name}/{mode}"),
                    data.clone(),
                    accounts.clone(),
                    Some(expected),
                );
                if expected {
                    assert_eq!(result.unwrap().return_data.data, fields[2]);
                    runner.check_transfers(&accounts, 6 + op as u8);
                } else {
                    assert_eq!(
                        runner.svm.get_account(&accounts[0].pubkey).unwrap().data,
                        state
                    );
                    assert_eq!(runner.token_amount(&accounts[1].pubkey), 5_000_000);
                }
                // Cause the SECOND payout to fail after root write and first CPI; all must roll back.
                if expected && id == 0 && op == 1 {
                    let mut accounts = runner.accounts(state.clone());
                    accounts.push(AccountMeta::new_readonly(payload_id, false));
                    let treasury = accounts[4].pubkey;
                    let mut a = runner.svm.get_account(&treasury).unwrap();
                    let mut token = spl_token::state::Account::unpack(&a.data).unwrap();
                    token.state = spl_token::state::AccountState::Frozen;
                    spl_token::state::Account::pack(token, &mut a.data).unwrap();
                    runner.svm.set_account(treasury, a).unwrap();
                    runner
                        .run(
                            "fallback/second-CPI-failure-rollback",
                            data.clone(),
                            accounts.clone(),
                            Some(false),
                        )
                        .unwrap_err();
                    assert_eq!(
                        runner.svm.get_account(&accounts[0].pubkey).unwrap().data,
                        state
                    );
                    assert_eq!(runner.token_amount(&accounts[1].pubkey), 5_000_000);
                    assert_eq!(runner.token_amount(&accounts[3].pubkey), 0);
                }
            }
        }
    }
    let transaction_sizes = sizes::measure(&root);
    fs::create_dir_all(root.join("docs/evidence")).unwrap();
    fs::write(
        root.join("docs/evidence/I02-transaction-sizes.json"),
        serde_json::to_vec_pretty(&transaction_sizes).unwrap(),
    )
    .unwrap();
    let out = json!({"scope":"SBF ELF in LiteSVM; diagnostic limit is NOT cluster-admissible", "litesvm":"0.6.1","release_budget":1_000_000,"diagnostic_budget":1_000_000_000,"elf_sha256":hex::encode(Sha256::digest(&elf)),"wrong_vk_elf_sha256":hex::encode(Sha256::digest(&wrong_elf)),"cases":r.rows,"wrong_vk_cases":wrong.rows,"diagnostic_cases":diagnostic.rows});
    fs::write(
        root.join("docs/evidence/I02-svm-results.json"),
        serde_json::to_vec_pretty(&out).unwrap(),
    )
    .unwrap();
    println!(
        "PASS: {} release-budget cases, {} wrong-VK controls, {} diagnostic tree cases",
        r.rows.len(),
        wrong.rows.len(),
        diagnostic.rows.len()
    );
    for row in r
        .rows
        .iter()
        .filter(|x| !x["case"].as_str().unwrap().contains('/'))
        .chain(diagnostic.rows.iter())
    {
        println!("{}: ok={} CU={}", row["case"], row["ok"], row["cu"]);
    }
}
