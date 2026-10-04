//! Offline verifier for the first I08 slice. No RPC, provider, key custody or
//! journal writes live here. The SDK supplies externally trusted deployment
//! pins and commits the returned state to its encrypted CAS journal.
use anyhow::{ensure, Result};
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zkapi_control::{crypto, quote, receipts::Receipt, wire};
use zkapi_proof::compact;
use zkapi_solana_types::{FieldElement, MicroUsdc, CHAIN_NAMESPACE, PROTOCOL_VERSION};
use zkapi_types::{wire::CurvePointWire, Felt252, SchnorrSignature};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub deployment_id: String,
    pub pool: String,
    pub vault_binding: FieldElement,
    pub state_key: [FieldElement; 2],
    pub cap_micro_usdc: MicroUsdc,
    pub control_api_origin: String,
    pub inference_api_origin: String,
    pub quote_public_key: String,
    pub receipt_public_key: String,
    pub request_vk_sha256: String,
    pub tariff_hashes: Vec<String>,
}
impl Context {
    fn binding(&self) -> Result<quote::BindingConfig> {
        ensure!(
            self.request_vk_sha256 == crypto::REQUEST_VK_HASH,
            "unsupported request VK build"
        );
        crypto::validate_point(self.state_key)?;
        Ok(quote::BindingConfig {
            deployment_id: self.deployment_id.clone(),
            pool: self.pool.clone(),
            vault_binding: self.vault_binding,
            state_key: self.state_key,
            cap: self.cap_micro_usdc,
            control_api_origin: self.control_api_origin.clone(),
            inference_api_origin: self.inference_api_origin.clone(),
            quote_key: wire::pubkey(&self.quote_public_key)?,
        })
    }
    fn state_key(&self) -> CurvePointWire {
        CurvePointWire {
            x: felt(self.state_key[0]),
            y: felt(self.state_key[1]),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PrivateState {
    pub balance_micro_usdc: MicroUsdc,
    pub balance_blinding: FieldElement,
    pub note_leaf: FieldElement,
    pub commitment: Point,
    pub anchor: FieldElement,
    pub state_signature: Option<Signature>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: FieldElement,
    pub y: FieldElement,
}
impl Point {
    fn wire(&self) -> CurvePointWire {
        CurvePointWire {
            x: felt(self.x),
            y: felt(self.y),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub r_x: FieldElement,
    pub r_y: FieldElement,
    pub s: FieldElement,
}
impl Signature {
    fn wire(&self) -> Result<SchnorrSignature> {
        scalar(self.s)?;
        Ok(SchnorrSignature {
            r_x: felt(self.r_x),
            r_y: felt(self.r_y),
            s: felt(self.s),
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub request: wire::SessionCreate,
    pub control_token: String,
    pub proxy_token: Option<String>,
    pub tariff: wire::Tariff,
    pub rerandomization: FieldElement,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settlement {
    pub charge_micro_usdc: MicroUsdc,
    pub next_commitment: Point,
    pub next_anchor: FieldElement,
    pub blind_delta_srv: FieldElement,
    pub next_state_signature: Signature,
}
fn felt(f: FieldElement) -> Felt252 {
    Felt252(*f.as_bytes())
}
fn scalar(f: FieldElement) -> Result<()> {
    // Canonical scalar, rather than compact's modular conversion.
    zkapi_solana_types::Scalar::from_bytes(*f.as_bytes())?;
    Ok(())
}
fn state_message(ctx: &Context, state: &PrivateState) -> Felt252 {
    zkapi_core::v2::state_message(
        PROTOCOL_VERSION,
        CHAIN_NAMESPACE,
        &felt(ctx.vault_binding),
        &felt(state.commitment.x),
        &felt(state.commitment.y),
        &felt(state.anchor),
    )
}
pub fn verify_prepared(ctx: &Context, state: &PrivateState, prepared: &Prepared) -> Result<()> {
    let binding = ctx.binding()?;
    ensure!(
        ctx.tariff_hashes
            .iter()
            .any(|hash| hash == &prepared.tariff.tariff_hash),
        "unlisted tariff"
    );
    let credential = wire::parse_control_token(&format!("Bearer {}", prepared.control_token))?;
    quote::validate_binding(&prepared.request, &credential, &binding)?;
    quote::validate_tariff(&prepared.tariff)?;
    let b = &prepared.request.quote.body;
    ensure!(
        b.tariff_hash == prepared.tariff.tariff_hash
            && b.provider == prepared.tariff.provider
            && b.models == [prepared.tariff.model.clone()]
            && quote::tariff_valid_at(&prepared.tariff, wire::uint(&b.issued_at)?)?,
        "tariff binding"
    );
    match (&prepared.request.authorization.mode, &prepared.proxy_token) {
        (wire::Mode::Proxy, Some(token)) => {
            let p = wire::parse_proxy_token(token)?;
            ensure!(
                p.request_id == credential.request_id
                    && Some(wire::sha256(&p.secret))
                        == prepared
                            .request
                            .authorization
                            .proxy_secret_hash
                            .as_deref()
                            .map(wire::hash)
                            .transpose()?,
                "proxy secret binding"
            );
        }
        (wire::Mode::DirectOa | wire::Mode::DirectOpenrouter, None) => {}
        _ => anyhow::bail!("credential mode"),
    }
    scalar(state.balance_blinding)?;
    scalar(prepared.rerandomization)?;
    ensure!(
        state.balance_micro_usdc >= ctx.cap_micro_usdc,
        "insufficient balance"
    );
    ensure!(
        compact::balance_commitment(
            state.balance_micro_usdc.get().into(),
            &felt(state.balance_blinding),
            &felt(state.note_leaf)
        ) == state.commitment.wire(),
        "private commitment"
    );
    if let Some(signature) = &state.state_signature {
        ensure!(
            *state.anchor.as_bytes() != [0; 32]
                && compact::verify_signature(
                    &ctx.state_key(),
                    &state_message(ctx, state),
                    &signature.wire()?
                )?,
            "previous state signature"
        );
    } else {
        ensure!(felt(state.anchor) == Felt252::ONE, "genesis anchor");
    }
    let anonymous =
        compact::rerandomize(&state.commitment.wire(), &felt(prepared.rerandomization))?;
    let p = &prepared.request.public_inputs;
    ensure!(
        anonymous.x == felt(p[10]) && anonymous.y == felt(p[11]),
        "anonymous commitment"
    );
    crypto::verify_request(p, &prepared.request.proof.bytes()?)?;
    Ok(())
}

/// All charge receipts must map exactly to the caller's durable operation list.
/// The server's SETTLED label and pagination cursor alone never authorize a
/// balance update. Late observations attest losses and contribute zero charge.
pub fn verify_settlement(
    ctx: &Context,
    state: &PrivateState,
    prepared: &Prepared,
    settlement: &Settlement,
    receipts: &[Receipt],
    operations: &[String],
) -> Result<PrivateState> {
    verify_prepared(ctx, state, prepared)?;
    let key = VerifyingKey::from_bytes(&wire::pubkey(&ctx.receipt_public_key)?)?;
    let mut ids = BTreeSet::new();
    let mut hashes = BTreeMap::new();
    let mut charged_operations = BTreeSet::new();
    let mut total = 0u128;
    let proxy = prepared.request.authorization.mode == wire::Mode::Proxy;
    let mut expected = BTreeSet::new();
    for id in operations {
        wire::uuid(id)?;
        ensure!(expected.insert(id.clone()), "duplicate operation");
    }
    ensure!(proxy || expected.is_empty(), "direct operation list");
    let mut charges = 0;
    for receipt in receipts {
        receipt.verify(&key)?;
        let b = &receipt.body;
        ensure!(
            ids.insert(b.receipt_id.clone()) && !hashes.contains_key(&receipt.receipt_hash),
            "duplicate receipt"
        );
        ensure!(
            b.deployment_id == ctx.deployment_id
                && b.pool == ctx.pool
                && b.request_id == prepared.request.authorization.request_id,
            "receipt identity"
        );
        zkapi_control::receipts::validate_tariff_math(b, &prepared.tariff)?;
        let reservation = b.reservation_nano_usdc.parse::<u128>()?;
        ensure!(
            reservation <= ctx.cap_micro_usdc.as_nano()
                && (proxy || reservation == ctx.cap_micro_usdc.as_nano()),
            "receipt reservation/cap"
        );
        if b.billing_effect == "charge" {
            charges += 1;
            if proxy {
                ensure!(
                    charged_operations.insert(b.operation_id.clone().unwrap()),
                    "duplicate operation charge"
                );
            }
            total = total
                .checked_add(b.charged_nano_usdc.parse::<u128>()?)
                .ok_or_else(|| anyhow::anyhow!("sum overflow"))?;
            ensure!(
                total <= ctx.cap_micro_usdc.get() as u128 * 1000,
                "charge cap"
            );
        }
        hashes.insert(receipt.receipt_hash.clone(), b);
    }
    for receipt in receipts {
        let b = &receipt.body;
        if b.billing_effect == "late_loss_observation" {
            let earlier = hashes
                .get(b.related_receipt_hash.as_ref().unwrap())
                .ok_or_else(|| anyhow::anyhow!("missing related charge"))?;
            ensure!(
                earlier.billing_effect == "charge" && earlier.operation_id == b.operation_id,
                "late receipt binding"
            );
        }
    }
    ensure!(
        if proxy {
            charged_operations == expected
        } else {
            charges == 1
        },
        "missing or unexpected charge receipts"
    );
    let charge = settlement.charge_micro_usdc.get();
    ensure!(total.div_ceil(1000) == charge as u128, "session rounding");
    ensure!(
        charge <= ctx.cap_micro_usdc.get() && charge <= state.balance_micro_usdc.get(),
        "balance/cap"
    );
    scalar(settlement.blind_delta_srv)?;
    let p = &prepared.request.public_inputs;
    let anonymous = CurvePointWire {
        x: felt(p[10]),
        y: felt(p[11]),
    };
    ensure!(
        compact::server_update(&anonymous, charge.into(), &felt(settlement.blind_delta_srv))?
            == settlement.next_commitment.wire(),
        "successor algebra"
    );
    ensure!(
        *settlement.next_anchor.as_bytes() != [0; 32] && settlement.next_anchor != state.anchor,
        "successor anchor"
    );
    let next = PrivateState {
        balance_micro_usdc: MicroUsdc::new(state.balance_micro_usdc.get() - charge)?,
        balance_blinding: FieldElement::from_bytes(
            compact::add_blindings(
                &compact::add_blindings(
                    &felt(state.balance_blinding),
                    &felt(prepared.rerandomization),
                ),
                &felt(settlement.blind_delta_srv),
            )
            .0,
        )?,
        note_leaf: state.note_leaf,
        commitment: settlement.next_commitment.clone(),
        anchor: settlement.next_anchor,
        state_signature: Some(settlement.next_state_signature.clone()),
    };
    ensure!(
        compact::balance_commitment(
            next.balance_micro_usdc.get().into(),
            &felt(next.balance_blinding),
            &felt(next.note_leaf)
        ) == next.commitment.wire(),
        "successor private state"
    );
    ensure!(
        compact::verify_signature(
            &ctx.state_key(),
            &state_message(ctx, &next),
            &settlement.next_state_signature.wire()?
        )?,
        "successor signature"
    );
    Ok(next)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Prepare {
        context: Box<Context>,
        state: Box<PrivateState>,
        prepared: Box<Prepared>,
        now: String,
        root: FieldElement,
    },
    Settle {
        context: Box<Context>,
        state: Box<PrivateState>,
        prepared: Box<Prepared>,
        settlement: Box<Settlement>,
        receipts: Vec<Receipt>,
        operations: Vec<String>,
    },
}
pub fn execute(command: Command) -> Result<serde_json::Value> {
    match command {
        Command::Prepare {
            context,
            state,
            prepared,
            now,
            root,
        } => {
            verify_prepared(&context, &state, &prepared)?;
            quote::validate_new(&prepared.request, &prepared.tariff, wire::uint(&now)?, root)?;
            Ok(serde_json::json!({"verified":true}))
        }
        Command::Settle {
            context,
            state,
            prepared,
            settlement,
            receipts,
            operations,
        } => Ok(serde_json::to_value(verify_settlement(
            &context,
            &state,
            &prepared,
            &settlement,
            &receipts,
            &operations,
        )?)?),
    }
}
