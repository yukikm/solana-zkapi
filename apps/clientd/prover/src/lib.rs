//! Solana wallet cryptography shared by the native companion and browser WASM.
//! No networking, storage, accounting state machine, or setup generation.
use anyhow::{ensure, Result};
use ark_bn254::{Bn254, Fr};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bn254::{EdwardsAffine, Fr as ScalarField};
use ark_ff::{UniformRand, Zero};
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zkapi_proof::groth16::*;
use zkapi_solana_types::{binding, FieldElement, MicroUsdc, Scalar, CHAIN_NAMESPACE};
use zkapi_tree_prover::TreeRequest;
mod snapshot;

// Recompile the exact shared wire/accounting/verifier implementation for WASM.
// These modules are pure: no ledger, signer, provider client, Tokio, or DB.
// The alias lets the companion retain its normal native control-crate import.
extern crate self as zkapi_control;
#[path = "../../../../services/control/src/crypto.rs"]
pub mod crypto;
#[path = "../../../../services/control/src/quote.rs"]
pub mod quote;
#[path = "../../../../services/control/src/receipts.rs"]
pub mod receipts;
#[path = "../../companion/src/lib.rs"]
pub mod verifier;
#[path = "../../../../services/control/src/wire.rs"]
pub mod wire;

const HEADER: &[u8] = b"zkapi-v2-note-bound-v1\0";
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub bytes_base64: String,
    pub pk_sha256: String,
    pub vk_sha256: String,
}
impl Key {
    fn load(&self, tree: bool) -> Result<ProvingKey<Bn254>> {
        let bytes = STANDARD.decode(&self.bytes_base64)?;
        ensure!(
            hex::encode(Sha256::digest(&bytes)) == self.pk_sha256,
            "PK digest"
        );
        let mut raw = if tree {
            bytes.as_slice()
        } else {
            bytes
                .strip_prefix(HEADER)
                .ok_or_else(|| anyhow::anyhow!("key revision"))?
        };
        let pk = ProvingKey::<Bn254>::deserialize_compressed(&mut raw)?;
        ensure!(raw.is_empty(), "key trailing bytes");
        let mut vk = if tree { Vec::new() } else { HEADER.to_vec() };
        pk.vk.serialize_compressed(&mut vk)?;
        ensure!(
            hex::encode(Sha256::digest(vk)) == self.vk_sha256,
            "VK digest"
        );
        Ok(pk)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub vault_binding: FieldElement,
    pub state_key: [FieldElement; 2],
    pub clearance_key: [FieldElement; 2],
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Witness {
    pub secret: FieldElement,
    pub note_id: u32,
    pub deposit_micro_usdc: MicroUsdc,
    pub expiry: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicNote {
    pub note_id: u32,
    pub registration_commitment: FieldElement,
    pub deposit_micro_usdc: MicroUsdc,
    pub expiry: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub r_x: FieldElement,
    pub r_y: FieldElement,
    pub s: Scalar,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: FieldElement,
    pub y: FieldElement,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub balance_micro_usdc: MicroUsdc,
    pub balance_blinding: Scalar,
    pub note_leaf: FieldElement,
    pub commitment: Point,
    pub anchor: FieldElement,
    pub state_signature: Option<Signature>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    SnapshotPath {
        root: FieldElement,
        next_note_id: String,
        active_notes: Vec<snapshot::SnapshotNote>,
        note_id: u32,
    },
    Verify {
        command: verifier::Command,
    },
    Deposit {
        note_id: u32,
        amount: MicroUsdc,
        expiry: String,
    },
    RebaseDeposit {
        witness: Witness,
        note_id: u32,
        expiry: String,
    },
    Inspect {
        context: Context,
        witness: Witness,
        state: State,
    },
    Request {
        context: Context,
        witness: Witness,
        state: State,
        root: FieldElement,
        siblings: Box<[FieldElement; 32]>,
        authorization: Value,
        request_time: String,
        cap: MicroUsdc,
        key: Key,
    },
    Withdrawal {
        context: Context,
        witness: Witness,
        state: State,
        root: FieldElement,
        siblings: Box<[FieldElement; 32]>,
        destination_owner_hex: String,
        clearance: Option<Signature>,
        mutual: bool,
        key: Key,
    },
    Clearance {
        context: Context,
        nullifier: FieldElement,
        signature: Signature,
    },
    Tree {
        context: Context,
        note: PublicNote,
        root: FieldElement,
        siblings: Box<[FieldElement; 32]>,
        op: u8,
        key: Key,
    },
}
fn number(value: &str) -> Result<u64> {
    ensure!(
        !value.is_empty()
            && (value == "0" || !value.starts_with('0'))
            && value.bytes().all(|x| x.is_ascii_digit()),
        "integer"
    );
    Ok(value.parse()?)
}
fn point(value: [FieldElement; 2]) -> Result<EdwardsAffine> {
    let point = EdwardsAffine::new_unchecked(value[0].to_field(), value[1].to_field());
    ensure!(
        point.is_on_curve() && point.is_in_correct_subgroup_assuming_on_curve() && !point.is_zero(),
        "point"
    );
    Ok(point)
}
fn signature(value: &Option<Signature>) -> Result<StateSignature> {
    Ok(match value {
        Some(s) => StateSignature {
            r: point([s.r_x, s.r_y])?,
            s: s.s.to_field(),
        },
        None => StateSignature {
            r: EdwardsAffine::zero(),
            s: ScalarField::zero(),
        },
    })
}
fn leaf(w: &Witness) -> Result<Fr> {
    ensure!(
        w.secret != FieldElement::ZERO && w.deposit_micro_usdc.get() > 0,
        "note identity"
    );
    Ok(note_leaf(
        w.note_id,
        registration_commitment(w.secret.to_field()),
        w.deposit_micro_usdc.get() as u128,
        number(&w.expiry)?,
    ))
}
fn validate(
    context: &Context,
    w: &Witness,
    state: &State,
) -> Result<(Fr, EdwardsAffine, StateSignature)> {
    ensure!(state.anchor != FieldElement::ZERO, "zero anchor");
    let l = leaf(w)?;
    ensure!(
        l == state.note_leaf.to_field()
            && state.balance_micro_usdc.get() <= w.deposit_micro_usdc.get(),
        "note binding"
    );
    let commitment = balance_commitment(
        state.balance_micro_usdc.get() as u128,
        state.balance_blinding.to_field(),
        l,
    )
    .into_affine();
    ensure!(
        commitment == point([state.commitment.x, state.commitment.y])?,
        "private commitment"
    );
    let sig = signature(&state.state_signature)?;
    if state.state_signature.is_none() {
        ensure!(
            state.anchor.to_field() == Fr::from(1u64)
                && state.balance_micro_usdc == w.deposit_micro_usdc,
            "genesis state"
        );
    } else {
        ensure!(
            verify_state_signature(
                point(context.state_key)?,
                state_message(
                    2,
                    CHAIN_NAMESPACE,
                    context.vault_binding.to_field(),
                    commitment,
                    state.anchor.to_field()
                ),
                sig
            ),
            "state signature"
        );
    }
    Ok((l, commitment, sig))
}
fn clearance(context: &Context, nullifier: FieldElement, value: Signature) -> Result<()> {
    let sig = signature(&Some(value))?;
    ensure!(
        verify_state_signature(
            point(context.clearance_key)?,
            clearance_message(
                2,
                CHAIN_NAMESPACE,
                context.vault_binding.to_field(),
                nullifier.to_field()
            ),
            sig
        ),
        "clearance signature"
    );
    Ok(())
}
fn satisfied(c: impl ConstraintSynthesizer<Fr>) -> Result<()> {
    let cs = ConstraintSystem::new_ref();
    c.generate_constraints(cs.clone())?;
    ensure!(cs.is_satisfied()?, "witness constraints");
    Ok(())
}
fn proof_value(
    public: Vec<Fr>,
    proof: ark_groth16::Proof<Bn254>,
    pk: &ProvingKey<Bn254>,
) -> Result<Value> {
    ensure!(
        Groth16::<Bn254>::verify_proof(&prepare_verifying_key(&pk.vk), &proof, &public)?,
        "local proof verification"
    );
    Ok(
        json!({"public_inputs":public.into_iter().map(FieldElement::from).collect::<Vec<_>>(), "proof_wire_hex":hex::encode(zkapi_solana_crypto::encode_upstream_proof(&proof))}),
    )
}
fn deposit_state(witness: Witness) -> Result<Value> {
    let l = leaf(&witness)?;
    let blinding = ScalarField::rand(&mut OsRng);
    let amount = witness.deposit_micro_usdc;
    let c = balance_commitment(amount.get() as u128, blinding, l).into_affine();
    Ok(
        json!({"registration_commitment":FieldElement::from(registration_commitment(witness.secret.to_field())),
        "witness": witness, "state": State { balance_micro_usdc: amount, balance_blinding: blinding.into(), note_leaf:l.into(),
            commitment:Point { x:c.x.into(), y:c.y.into() }, anchor:Fr::from(1u64).into(), state_signature:None }}),
    )
}
pub fn execute(command: Command) -> Result<Value> {
    match command {
        Command::SnapshotPath { root, next_note_id, active_notes, note_id } => snapshot::path(root, next_note_id, active_notes, note_id),
        Command::Verify { command } => verifier::execute(command),
        Command::Deposit {
            note_id,
            amount,
            expiry,
        } => {
            let mut secret = Fr::rand(&mut OsRng);
            while secret.is_zero() {
                secret = Fr::rand(&mut OsRng);
            }
            let witness = Witness {
                secret: secret.into(),
                note_id,
                deposit_micro_usdc: amount,
                expiry,
            };
            deposit_state(witness)
        }
        Command::RebaseDeposit {
            mut witness,
            note_id,
            expiry,
        } => {
            witness.note_id = note_id;
            witness.expiry = expiry;
            deposit_state(witness)
        }
        Command::Inspect {
            context,
            witness,
            state,
        } => {
            let _ = validate(&context, &witness, &state)?;
            Ok(
                json!({"nullifier": FieldElement::from(request_nullifier(witness.secret.to_field(), state.anchor.to_field())),
                "registration_commitment": FieldElement::from(registration_commitment(witness.secret.to_field()))}),
            )
        }
        Command::Clearance {
            context,
            nullifier,
            signature,
        } => {
            clearance(&context, nullifier, signature)?;
            Ok(json!({"verified":true}))
        }
        Command::Request {
            context,
            witness,
            state,
            root,
            siblings,
            authorization,
            request_time,
            cap,
            key,
        } => {
            let (_, current, state_signature) = validate(&context, &witness, &state)?;
            let request_context =
                binding::authorization_context(&serde_jcs::to_vec(&authorization)?)?.to_field();
            let rerandomization = ScalarField::rand(&mut OsRng);
            let n = request_nullifier(witness.secret.to_field(), state.anchor.to_field());
            let circuit = RequestCircuit {
                public: RequestPublic {
                    protocol_version: 2,
                    chain_id: CHAIN_NAMESPACE,
                    contract_address: context.vault_binding.to_field(),
                    active_root: root.to_field(),
                    state_signing_key: point(context.state_key)?,
                    request_time: number(&request_time)?,
                    solvency_bound: cap.get() as u128,
                    request_nullifier: n,
                    authorization_tag: authorization_tag(n, request_context),
                    anonymous_commitment: rerandomize_commitment(
                        current.into_group(),
                        rerandomization,
                    )
                    .into_affine(),
                },
                witness: RequestWitness {
                    secret: witness.secret.to_field(),
                    request_context,
                    note_id: witness.note_id,
                    deposit_amount: witness.deposit_micro_usdc.get() as u128,
                    expiry: number(&witness.expiry)?,
                    merkle_siblings: siblings.map(FieldElement::to_field),
                    current_balance: state.balance_micro_usdc.get() as u128,
                    current_blinding: state.balance_blinding.to_field(),
                    rerandomization,
                    current_anchor: state.anchor.to_field(),
                    is_genesis: state.state_signature.is_none(),
                    state_signature,
                },
            };
            satisfied(circuit.clone())?;
            let pk = key.load(false)?;
            let public = circuit.public.to_field_elements();
            let proof = prove_request(&pk, circuit, &mut OsRng)?;
            Ok(
                json!({"auth":proof_value(public, proof, &pk)?, "rerandomization":Scalar::from(rerandomization)}),
            )
        }
        Command::Withdrawal {
            context,
            witness,
            state,
            root,
            siblings,
            destination_owner_hex,
            clearance: c,
            mutual,
            key,
        } => {
            let (_, _, state_signature) = validate(&context, &witness, &state)?;
            let destination: [u8; 32] = hex::decode(destination_owner_hex)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("destination"))?;
            let destination = binding::destination_binding(&destination).to_field();
            let n = request_nullifier(witness.secret.to_field(), state.anchor.to_field());
            ensure!(mutual == c.is_some(), "clearance mode");
            if let Some(sig) = c.clone() {
                clearance(&context, n.into(), sig)?;
            }
            let circuit = WithdrawalCircuit {
                public: WithdrawalPublic {
                    protocol_version: 2,
                    chain_id: CHAIN_NAMESPACE,
                    contract_address: context.vault_binding.to_field(),
                    active_root: root.to_field(),
                    state_signing_key: point(context.state_key)?,
                    clearance_signing_key: point(context.clearance_key)?,
                    note_id: witness.note_id,
                    final_balance: state.balance_micro_usdc.get() as u128,
                    destination,
                    withdrawal_nullifier: n,
                    has_clearance: mutual,
                    withdrawal_tag: withdrawal_tag(
                        n,
                        destination,
                        state.balance_micro_usdc.get() as u128,
                        mutual,
                    ),
                },
                witness: WithdrawalWitness {
                    secret: witness.secret.to_field(),
                    deposit_amount: witness.deposit_micro_usdc.get() as u128,
                    expiry: number(&witness.expiry)?,
                    merkle_siblings: siblings.map(FieldElement::to_field),
                    final_blinding: state.balance_blinding.to_field(),
                    current_anchor: state.anchor.to_field(),
                    is_genesis: state.state_signature.is_none(),
                    state_signature,
                    clearance_signature: signature(&c)?,
                },
            };
            satisfied(circuit.clone())?;
            let pk = key.load(false)?;
            let public = circuit.public.to_field_elements();
            let proof = prove_withdrawal(&pk, circuit, &mut OsRng)?;
            proof_value(public, proof, &pk)
        }
        Command::Tree {
            context,
            note,
            root,
            siblings,
            op,
            key,
        } => {
            let pk = key.load(true)?;
            let circuit = zkapi_tree_prover::prepare(
                TreeRequest {
                    vault: *context.vault_binding.as_bytes(),
                    old_root: *root.as_bytes(),
                    id: note.note_id,
                    commitment: *note.registration_commitment.as_bytes(),
                    deposit: note.deposit_micro_usdc.get(),
                    expiry: number(&note.expiry)?,
                    op,
                },
                siblings.map(|x| *x.as_bytes()),
            )?;
            let update = zkapi_tree_prover::prove(circuit, &pk, &mut OsRng)?;
            Ok(
                json!({"public_inputs":update.public.into_iter().map(|b| FieldElement::from_bytes(b).unwrap()).collect::<Vec<_>>(), "proof_wire_hex":hex::encode(update.proof)}),
            )
        }
    }
}
pub fn run(input: &[u8]) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&execute(serde_json::from_slice(
        input,
    )?)?)?)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    // Tiny audited ABI; no generated glue, networking, or JS execution from Rust.
    // Every call returns a newly allocated JSON buffer owned by the JS caller.
    #[link(wasm_import_module = "zkapi")]
    extern "C" {
        fn random_fill(pointer: *mut u8, length: usize) -> i32;
    }
    fn random(bytes: &mut [u8]) -> Result<(), getrandom::Error> {
        if unsafe { random_fill(bytes.as_mut_ptr(), bytes.len()) } == 0 {
            Ok(())
        } else {
            Err(getrandom::Error::UNSUPPORTED)
        }
    }
    getrandom::register_custom_getrandom!(random);
    #[no_mangle]
    pub extern "C" fn zkapi_alloc(length: usize) -> *mut u8 {
        Box::into_raw(vec![0u8; length].into_boxed_slice()).cast::<u8>()
    }
    #[no_mangle]
    pub unsafe extern "C" fn zkapi_free(pointer: *mut u8, length: usize) {
        // Erase serialized secrets before returning memory to the allocator.
        std::ptr::write_bytes(pointer, 0, length);
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
    #[no_mangle]
    pub unsafe extern "C" fn zkapi_run(pointer: *const u8, length: usize) -> u64 {
        let result = if length > 64 * 1024 * 1024 {
            Err(anyhow::anyhow!("input bound"))
        } else {
            super::run(std::slice::from_raw_parts(pointer, length))
        };
        let bytes = result
            .unwrap_or_else(|_| b"{\"error\":\"offline prover rejected\"}".to_vec())
            .into_boxed_slice();
        let size = bytes.len();
        let pointer = Box::into_raw(bytes).cast::<u8>();
        ((size as u64) << 32) | pointer as u64
    }
}
