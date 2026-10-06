//! Isolated Baby-JubJub signer. Requests identify immutable primary-ledger targets;
//! the wire protocol never accepts an arbitrary message. The separate, exclusively
//! locked journal must already exist and is synced both before and after signing.
use anyhow::{anyhow, ensure, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature as EdSignature, VerifyingKey};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tokio_postgres::{Client, IsolationLevel, NoTls, Transaction};
use uuid::Uuid;
use zkapi_core::v2 as core;
use zkapi_proof::compact::{self, CompactSigner};
use zkapi_solana_types::{FieldElement, Scalar, CHAIN_NAMESPACE, PROTOCOL_VERSION};
use zkapi_types::{wire::CurvePointWire, Felt252, SchnorrSignature};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicKey {
    pub x: [u8; 32],
    pub y: [u8; 32],
}
impl PublicKey {
    pub fn from_wire(p: &CurvePointWire) -> Self {
        Self { x: p.x.0, y: p.y.0 }
    }
    pub fn wire(&self) -> Result<CurvePointWire> {
        FieldElement::from_bytes(self.x)?;
        FieldElement::from_bytes(self.y)?;
        let p = ark_ed_on_bn254::EdwardsAffine::new_unchecked(
            FieldElement::from_bytes(self.x)?.to_field(),
            FieldElement::from_bytes(self.y)?.to_field(),
        );
        ensure!(
            !p.is_zero() && p.is_on_curve() && p.is_in_correct_subgroup_assuming_on_curve(),
            "invalid signing public key"
        );
        Ok(CurvePointWire {
            x: Felt252(self.x),
            y: Felt252(self.y),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicDevnetProfilePin {
    pub file: PathBuf,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignerConfig {
    /// Absent on historical fixtures so their immutable journal digest remains unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_devnet_profile: Option<PublicDevnetProfilePin>,
    pub authorization: crate::quote::BindingConfig,
    pub pool: [u8; 32],
    pub binding: [u8; 32],
    pub state_key: PublicKey,
    pub clearance_key: PublicKey,
    pub receipt_key: [u8; 32],
}
impl SignerConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        FieldElement::from_bytes(self.binding)?;
        ensure!(
            crate::wire::pubkey(&self.authorization.pool)? == self.pool
                && self.authorization.vault_binding.as_bytes() == &self.binding
                && self.authorization.state_key[0].as_bytes() == &self.state_key.x
                && self.authorization.state_key[1].as_bytes() == &self.state_key.y,
            "signer authorization configuration mismatch"
        );
        ensure!(
            self.authorization.quote_key != self.receipt_key,
            "quote and receipt keys must be separate"
        );
        self.state_key.wire()?;
        self.clearance_key.wire()?;
        ensure!(
            self.state_key != self.clearance_key,
            "state and clearance keys must be separate"
        );
        if let Some(pin) = &self.public_devnet_profile {
            ensure!(
                std::fs::symlink_metadata(&pin.file)?.file_type().is_file(),
                "regular public signer profile required"
            );
            let bytes = std::fs::read(&pin.file)?;
            ensure!(
                crate::wire::hash(&pin.sha256)? == hash(&bytes),
                "independent signer profile hash mismatch"
            );
            let profile: Value = serde_json::from_slice(&bytes)?;
            crate::chain::validate_public_devnet_profile(&profile)?;
            for (name, key) in [
                ("state_key", &self.state_key),
                ("clearance_key", &self.clearance_key),
            ] {
                ensure!(
                    profile[name]["x"].as_str()
                        == Some(format!("0x{}", hex::encode(key.x)).as_str())
                        && profile[name]["y"].as_str()
                            == Some(format!("0x{}", hex::encode(key.y)).as_str()),
                    "signer public role differs from pinned profile"
                );
            }
            ensure!(
                crate::wire::pubkey(
                    profile["quote_public_key"]
                        .as_str()
                        .context("profile quote key")?
                )? == self.authorization.quote_key
                    && crate::wire::pubkey(
                        profile["receipt_public_key"]
                            .as_str()
                            .context("profile receipt key")?
                    )? == self.receipt_key,
                "signer Ed25519 roles differ from pinned profile"
            );
        } else {
            ensure!(
                self.state_key.x.as_slice() == &crate::crypto::deployment_keys::STATE_KEY[..32]
                    && self.state_key.y.as_slice()
                        == &crate::crypto::deployment_keys::STATE_KEY[32..]
                    && self.clearance_key.x.as_slice()
                        == &crate::crypto::deployment_keys::CLEARANCE_KEY[..32]
                    && self.clearance_key.y.as_slice()
                        == &crate::crypto::deployment_keys::CLEARANCE_KEY[32..],
                "signer public keys differ from role-specific build pins"
            );
        }
        VerifyingKey::from_bytes(&self.receipt_key)?;
        VerifyingKey::from_bytes(&self.authorization.quote_key)?;
        ensure!(
            !self.authorization.deployment_id.is_empty() && self.authorization.cap.get() > 0,
            "signer deployment/cap config"
        );
        crate::wire::origin(&self.authorization.control_api_origin)?;
        crate::wire::origin(&self.authorization.inference_api_origin)?;
        Ok(())
    }
    pub fn digest(&self) -> Result<[u8; 32]> {
        Ok(hash(&serde_jcs::to_vec(self)?))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SignTarget {
    Settlement { request_id: Uuid },
    Clearance { nullifier: [u8; 32] },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettlementDraft {
    pub charge_micro: u64,
    pub next_anchor: [u8; 32],
    pub next_commitment_x: [u8; 32],
    pub next_commitment_y: [u8; 32],
    pub blind_delta: [u8; 32],
    pub anchor_randomness: [u8; 32],
    pub signature_message: [u8; 32],
    pub message_digest: [u8; 32],
}
/// Called once while the writer owns the RECONCILING transaction. Retries load
/// the stored draft rather than producing new randomness or a new successor.
pub fn prepare_settlement(
    binding: [u8; 32],
    nullifier: [u8; 32],
    anonymous_x: [u8; 32],
    anonymous_y: [u8; 32],
    charge_micro: u64,
) -> Result<SettlementDraft> {
    FieldElement::from_bytes(binding)?;
    FieldElement::from_bytes(nullifier)?;
    FieldElement::from_bytes(anonymous_x)?;
    FieldElement::from_bytes(anonymous_y)?;
    zkapi_solana_types::MicroUsdc::new(charge_micro)?;
    let blind_delta = compact::random_scalar();
    let anchor_randomness = compact::random_field();
    let next = compact::server_update(
        &CurvePointWire {
            x: Felt252(anonymous_x),
            y: Felt252(anonymous_y),
        },
        charge_micro.into(),
        &blind_delta,
    )?;
    let next_anchor = core::next_anchor(&anchor_randomness, &Felt252(nullifier), &next.x, &next.y);
    let signature_message = core::state_message(
        PROTOCOL_VERSION,
        CHAIN_NAMESPACE,
        &Felt252(binding),
        &next.x,
        &next.y,
        &next_anchor,
    )
    .0;
    Ok(SettlementDraft {
        charge_micro,
        next_anchor: next_anchor.0,
        next_commitment_x: next.x.0,
        next_commitment_y: next.y.0,
        blind_delta: blind_delta.0,
        anchor_randomness: anchor_randomness.0,
        signature_message,
        message_digest: hash(&signature_message),
    })
}
pub fn clearance_message(binding: [u8; 32], nullifier: [u8; 32]) -> Result<[u8; 32]> {
    FieldElement::from_bytes(binding)?;
    FieldElement::from_bytes(nullifier)?;
    Ok(core::clearance_message(
        PROTOCOL_VERSION,
        CHAIN_NAMESPACE,
        &Felt252(binding),
        &Felt252(nullifier),
    )
    .0)
}
pub fn signature_bytes(s: &SchnorrSignature) -> [u8; 96] {
    let mut b = [0; 96];
    b[..32].copy_from_slice(&s.r_x.0);
    b[32..64].copy_from_slice(&s.r_y.0);
    b[64..].copy_from_slice(&s.s.0);
    b
}
pub fn decode_signature(b: &[u8]) -> Result<SchnorrSignature> {
    ensure!(b.len() == 96, "signature length");
    let x = bytes32(&b[..32])?;
    let y = bytes32(&b[32..64])?;
    let s = bytes32(&b[64..])?;
    FieldElement::from_bytes(x)?;
    FieldElement::from_bytes(y)?;
    Scalar::from_bytes(s)?;
    Ok(SchnorrSignature {
        r_x: Felt252(x),
        r_y: Felt252(y),
        s: Felt252(s),
    })
}
pub fn verify_signature(key: &PublicKey, message: [u8; 32], bytes: &[u8]) -> Result<()> {
    FieldElement::from_bytes(message)?;
    ensure!(
        compact::verify_signature(&key.wire()?, &Felt252(message), &decode_signature(bytes)?)?,
        "signature verification failed"
    );
    Ok(())
}
fn hash(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
fn bytes32(b: &[u8]) -> Result<[u8; 32]> {
    b.try_into().map_err(|_| anyhow!("expected 32 bytes"))
}
fn integer(v: &Value, name: &str) -> Result<u128> {
    let s = v
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing integer {name}"))?;
    ensure!(
        !s.is_empty() && (s == "0" || !s.starts_with('0')) && s.bytes().all(|c| c.is_ascii_digit()),
        "noncanonical integer"
    );
    Ok(s.parse()?)
}
fn hex32(v: &Value, name: &str) -> Result<[u8; 32]> {
    let s = v
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing digest {name}"))?;
    ensure!(
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "noncanonical digest"
    );
    bytes32(&hex::decode(s)?)
}
fn pool_text(pool: &[u8; 32]) -> String {
    bs58::encode(pool).into_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Intent {
    pool: [u8; 32],
    nullifier: [u8; 32],
    target: SignTarget,
    key: PublicKey,
    message: [u8; 32],
    digest: [u8; 32],
    frozen_digest: [u8; 32],
}
#[derive(Clone, Debug)]
struct FrozenTarget {
    intent: Intent,
    signature: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
// A journal frame holds one modest fixed intent while it is synced.
#[allow(clippy::large_enum_variant)]
enum JournalEvent {
    Header {
        version: u32,
        id: Uuid,
        config_digest: [u8; 32],
    },
    Intent {
        intent: Intent,
    },
    Signed {
        nullifier: [u8; 32],
        signature: Vec<u8>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    sequence: u64,
    previous: [u8; 32],
    event: JournalEvent,
    digest: [u8; 32],
}
#[derive(Clone)]
struct JournalEntry {
    intent: Intent,
    signature: Option<Vec<u8>>,
}
struct Journal {
    file: File,
    poisoned: bool,
    sequence: u64,
    previous: [u8; 32],
    entries: BTreeMap<[u8; 32], JournalEntry>,
}
impl Journal {
    fn initialize(path: &Path, config: &SignerConfig) -> Result<()> {
        config.validate()?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .context("journal initialization requires a new path")?;
        file.try_lock_exclusive()
            .context("journal already in use")?;
        let mut journal = Self {
            file,
            poisoned: false,
            sequence: 0,
            previous: [0; 32],
            entries: BTreeMap::new(),
        };
        journal.append(JournalEvent::Header {
            version: 1,
            id: Uuid::new_v4(),
            config_digest: config.digest()?,
        })?;
        File::open(
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?
        .sync_all()?;
        Ok(())
    }
    fn open(path: &Path, config: &SignerConfig) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path)
            .context("signer journal missing; never automatically reinitialize a lost journal")?;
        ensure!(
            metadata.file_type().is_file(),
            "journal must be a regular file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "journal must be owner-only"
            );
        }
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .open(path)
            .context("signer journal missing; never automatically reinitialize a lost journal")?;
        file.try_lock_exclusive()
            .context("another signer owns the journal")?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        ensure!(
            !data.is_empty() && data.last() == Some(&b'\n'),
            "journal truncated; operator reconciliation required"
        );
        let mut result = Self {
            file,
            poisoned: false,
            sequence: 0,
            previous: [0; 32],
            entries: BTreeMap::new(),
        };
        // Every line is a durable frame, including the mandatory first header.
        // Skipping empty lines would accept a newline-only, headerless file as a
        // fresh journal after loss/corruption of the independently stored history.
        for line in data[..data.len() - 1].split(|b| *b == b'\n') {
            ensure!(!line.is_empty(), "empty journal frame");
            let frame: Frame = serde_json::from_slice(line).context("invalid journal frame")?;
            ensure!(
                frame.sequence == result.sequence && frame.previous == result.previous,
                "journal chain discontinuity"
            );
            ensure!(
                frame.digest == frame_digest(frame.sequence, frame.previous, &frame.event)?,
                "journal digest mismatch"
            );
            match frame.event {
                JournalEvent::Header {
                    version,
                    config_digest,
                    ..
                } => {
                    ensure!(
                        result.sequence == 0 && version == 1 && config_digest == config.digest()?,
                        "journal header/config mismatch"
                    );
                }
                JournalEvent::Intent { intent } => {
                    ensure!(
                        result.sequence > 0
                            && intent.pool == config.pool
                            && intent.digest == hash(&intent.message),
                        "invalid journal intent"
                    );
                    let expected = match intent.target {
                        SignTarget::Settlement { .. } => &config.state_key,
                        SignTarget::Clearance { .. } => &config.clearance_key,
                    };
                    ensure!(
                        &intent.key == expected && !result.entries.contains_key(&intent.nullifier),
                        "journal intent reuse"
                    );
                    result.entries.insert(
                        intent.nullifier,
                        JournalEntry {
                            intent,
                            signature: None,
                        },
                    );
                }
                JournalEvent::Signed {
                    nullifier,
                    signature,
                } => {
                    let entry = result
                        .entries
                        .get_mut(&nullifier)
                        .context("signature without journal intent")?;
                    ensure!(entry.signature.is_none(), "duplicate journal signature");
                    verify_signature(&entry.intent.key, entry.intent.message, &signature)?;
                    entry.signature = Some(signature);
                }
            }
            result.sequence += 1;
            result.previous = frame.digest;
        }
        result.file.seek(SeekFrom::End(0))?;
        Ok(result)
    }
    fn append(&mut self, event: JournalEvent) -> Result<()> {
        ensure!(
            !self.poisoned,
            "journal I/O failed; restart and reconcile required"
        );
        let digest = frame_digest(self.sequence, self.previous, &event)?;
        let frame = Frame {
            sequence: self.sequence,
            previous: self.previous,
            event,
            digest,
        };
        let mut bytes = serde_json::to_vec(&frame)?;
        bytes.push(b'\n');
        self.poisoned = true;
        self.file.write_all(&bytes)?;
        self.file.sync_all()?;
        self.poisoned = false;
        self.sequence += 1;
        self.previous = digest;
        Ok(())
    }
    fn pin(&mut self, intent: &Intent) -> Result<()> {
        ensure!(
            !self.poisoned,
            "journal I/O failed; restart and reconcile required"
        );
        if let Some(entry) = self.entries.get(&intent.nullifier) {
            ensure!(
                &entry.intent == intent,
                "journal target mismatch: role, request, key or message changed"
            );
            return Ok(());
        }
        self.append(JournalEvent::Intent {
            intent: intent.clone(),
        })?;
        self.entries.insert(
            intent.nullifier,
            JournalEntry {
                intent: intent.clone(),
                signature: None,
            },
        );
        Ok(())
    }
    fn save_signature(&mut self, nullifier: [u8; 32], signature: Vec<u8>) -> Result<()> {
        let entry = self.entries.get(&nullifier).context("missing intent")?;
        ensure!(entry.signature.is_none(), "already signed");
        verify_signature(&entry.intent.key, entry.intent.message, &signature)?;
        self.append(JournalEvent::Signed {
            nullifier,
            signature: signature.clone(),
        })?;
        self.entries.get_mut(&nullifier).unwrap().signature = Some(signature);
        Ok(())
    }
}
fn frame_digest(sequence: u64, previous: [u8; 32], event: &JournalEvent) -> Result<[u8; 32]> {
    Ok(hash(&serde_jcs::to_vec(&(sequence, previous, event))?))
}

/// The primary connection is read-only; only the pool writer stores signatures
/// and makes results visible. This process exclusively owns the independent file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignCheckpoint {
    IntentSynced,
    SignatureCreated,
    SignatureSynced,
}

pub struct Signer {
    config: SignerConfig,
    primary: Client,
    journal: Journal,
    state: CompactSigner,
    clearance: CompactSigner,
}
impl Signer {
    /// Explicit first-deployment provisioning only. Existing files are never
    /// replaced. Runtime startup always uses `open` and cannot create a journal.
    pub fn initialize_journal(path: impl AsRef<Path>, config: &SignerConfig) -> Result<()> {
        Journal::initialize(path.as_ref(), config)
    }
    pub async fn open(
        config: SignerConfig,
        primary_url: &str,
        journal_path: impl AsRef<Path>,
        state_seed: [u8; 32],
        clearance_seed: [u8; 32],
    ) -> Result<Self> {
        config.validate()?;
        Scalar::from_bytes(state_seed)?;
        Scalar::from_bytes(clearance_seed)?;
        ensure!(
            state_seed != [0; 32] && clearance_seed != [0; 32],
            "zero signing secret"
        );
        let state = CompactSigner::from_seed(&Felt252(state_seed));
        let clearance = CompactSigner::from_seed(&Felt252(clearance_seed));
        ensure!(
            PublicKey::from_wire(&state.public_key()) == config.state_key
                && PublicKey::from_wire(&clearance.public_key()) == config.clearance_key,
            "signer keys do not match role-specific pins"
        );
        let journal = Journal::open(journal_path.as_ref(), &config)?;
        let (primary, connection) = tokio_postgres::connect(primary_url, NoTls).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut signer = Self {
            config,
            primary,
            journal,
            state,
            clearance,
        };
        signer.reconcile().await?;
        Ok(signer)
    }
    pub async fn reconcile(&mut self) -> Result<()> {
        let tx = self
            .primary
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        audit(&tx, &self.config, &self.journal).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn sign(&mut self, target: SignTarget) -> Result<Vec<u8>> {
        self.sign_with_checkpoint(target, |_| {}).await
    }
    /// Checkpoints support the local crash harness; they cannot replace validation.
    pub async fn sign_with_checkpoint(
        &mut self,
        target: SignTarget,
        mut checkpoint: impl FnMut(SignCheckpoint),
    ) -> Result<Vec<u8>> {
        let tx = self
            .primary
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        audit(&tx, &self.config, &self.journal).await?;
        let frozen = load_target(&tx, &self.config, &target).await?;
        tx.commit().await?;
        self.journal.pin(&frozen.intent)?; // durable intent BEFORE crypto
        checkpoint(SignCheckpoint::IntentSynced);
        if let Some(signature) = self
            .journal
            .entries
            .get(&frozen.intent.nullifier)
            .and_then(|x| x.signature.clone())
        {
            return Ok(signature);
        }
        ensure!(
            frozen.signature.is_none(),
            "primary signed without durable journal signature"
        );
        let key = match target {
            SignTarget::Settlement { .. } => &self.state,
            SignTarget::Clearance { .. } => &self.clearance,
        };
        let signature = signature_bytes(&key.sign(&Felt252(frozen.intent.message))).to_vec();
        checkpoint(SignCheckpoint::SignatureCreated);
        self.journal
            .save_signature(frozen.intent.nullifier, signature.clone())?; // durable signature BEFORE response
        checkpoint(SignCheckpoint::SignatureSynced);
        Ok(signature)
    }
}
async fn audit(tx: &Transaction<'_>, config: &SignerConfig, journal: &Journal) -> Result<()> {
    crate::ledger::verify_schema(tx).await?;
    let recovery: bool = tx
        .query_one("SELECT pg_is_in_recovery()", &[])
        .await?
        .get(0);
    ensure!(!recovery, "signing from a replica is forbidden");
    let row = tx
        .query_opt(
            "SELECT authorization_config FROM pools WHERE pool=$1",
            &[&&config.pool[..]],
        )
        .await?
        .context("signer pool missing")?;
    let pool: Value = row.get(0);
    ensure!(
        pool.get("signer") == Some(&serde_json::to_value(config)?),
        "primary pool signing config mismatch"
    );
    for entry in journal.entries.values() {
        let target = load_target(tx, config, &entry.intent.target)
            .await
            .context("journal target absent or inconsistent after primary restore")?;
        ensure!(
            target.intent == entry.intent,
            "journal/primary frozen target mismatch"
        );
        if let Some(signature) = target.signature {
            ensure!(
                entry.signature.as_ref() == Some(&signature),
                "primary/journal signature mismatch"
            );
        }
    }
    let rows=tx.query("SELECT s.nullifier FROM settlements t JOIN sessions s USING(pool,request_id) WHERE t.pool=$1 AND t.state_signature IS NOT NULL UNION ALL SELECT nullifier FROM clearances WHERE pool=$1 AND signature IS NOT NULL",&[&&config.pool[..]]).await?;
    for row in rows {
        let n: Vec<u8> = row.get(0);
        ensure!(
            journal
                .entries
                .get(&bytes32(&n)?)
                .and_then(|e| e.signature.as_ref())
                .is_some(),
            "signed primary target missing from journal"
        );
    }
    Ok(())
}
async fn load_target(
    tx: &Transaction<'_>,
    config: &SignerConfig,
    target: &SignTarget,
) -> Result<FrozenTarget> {
    match target {
        SignTarget::Settlement { request_id } => load_settlement(tx, config, *request_id).await,
        SignTarget::Clearance { nullifier } => load_clearance(tx, config, *nullifier).await,
    }
}
async fn load_clearance(
    tx: &Transaction<'_>,
    config: &SignerConfig,
    nullifier: [u8; 32],
) -> Result<FrozenTarget> {
    let row=tx.query_opt("SELECT c.signature_message,c.message_digest,c.signature,r.kind FROM clearances c JOIN nullifier_reservations r USING(pool,nullifier) WHERE c.pool=$1 AND c.nullifier=$2",&[&&config.pool[..],&&nullifier[..]]).await?.context("clearance target missing")?;
    ensure!(
        row.get::<_, String>(3) == "CLEARANCE",
        "clearance reservation mismatch"
    );
    let message = clearance_message(config.binding, nullifier)?;
    let stored: Vec<u8> = row.get(0);
    let digest: Vec<u8> = row.get(1);
    ensure!(
        stored == message && digest == hash(&message),
        "clearance message mismatch"
    );
    let signature: Option<Vec<u8>> = row.get(2);
    if let Some(s) = &signature {
        verify_signature(&config.clearance_key, message, s)?;
    }
    let intent = Intent {
        pool: config.pool,
        nullifier,
        target: SignTarget::Clearance { nullifier },
        key: config.clearance_key.clone(),
        message,
        digest: hash(&message),
        frozen_digest: hash(&serde_jcs::to_vec(&(config, nullifier, message))?),
    };
    Ok(FrozenTarget { intent, signature })
}
async fn load_settlement(
    tx: &Transaction<'_>,
    config: &SignerConfig,
    request_id: Uuid,
) -> Result<FrozenTarget> {
    let row=tx.query_opt("SELECT s.nullifier,s.request_digest,s.request_transcript,s.state,s.cap_micro,s.charged_nano::text,s.reserved_nano::text,s.active_operations,s.mode,s.provider,s.quote_id,s.control_secret_hash,s.proxy_secret_hash,t.charge_micro,t.next_anchor,t.next_commitment_x,t.next_commitment_y,t.blind_delta,t.anchor_randomness,t.signature_message,t.message_digest,t.state_signature,r.kind,q.canonical_body,q.quote_hash,q.tariff_hash,q.signature,s.direct_stop_evidence FROM sessions s JOIN settlements t USING(pool,request_id) JOIN nullifier_reservations r USING(pool,nullifier) JOIN quotes q ON q.pool=s.pool AND q.quote_id=s.quote_id WHERE s.pool=$1 AND s.request_id=$2",&[&&config.pool[..],&request_id]).await?.context("settlement target missing")?;
    let n = bytes32(&row.get::<_, Vec<u8>>(0))?;
    let transcript: Vec<u8> = row.get(2);
    ensure!(
        hash(&transcript) == bytes32(&row.get::<_, Vec<u8>>(1))?,
        "transcript digest mismatch"
    );
    let checked: crate::wire::SessionCreate = crate::wire::strict_parse(&transcript)?;
    let credential = crate::wire::ControlCredential {
        request_id,
        secret_hash: bytes32(&row.get::<_, Vec<u8>>(11))?,
    };
    crate::quote::validate_binding(&checked, &credential, &config.authorization)?;
    let body: Value = serde_json::from_slice(&transcript)?;
    ensure!(
        serde_jcs::to_vec(&body)? == transcript,
        "noncanonical frozen transcript"
    );
    let p: Vec<FieldElement> =
        serde_json::from_value(body.get("public_inputs").context("missing inputs")?.clone())?;
    let p: [FieldElement; 12] = p.try_into().map_err(|_| anyhow!("request input count"))?;
    ensure!(
        p[0].as_bytes() == &Felt252::from_u64(PROTOCOL_VERSION.into()).0
            && p[1].as_bytes() == &Felt252::from_u64(CHAIN_NAMESPACE).0
            && p[2].as_bytes() == &config.binding
            && p[4].as_bytes() == &config.state_key.x
            && p[5].as_bytes() == &config.state_key.y
            && p[8].as_bytes() == &n,
        "request pool/public inputs mismatch"
    );
    let cap: u64 = u64::try_from(row.get::<_, i64>(4))?;
    ensure!(
        p[7].as_bytes() == &Felt252::from_u64(cap).0,
        "request cap mismatch"
    );
    let auth = body.get("authorization").context("missing authorization")?;
    ensure!(
        auth.get("request_id").and_then(Value::as_str) == Some(&request_id.to_string())
            && auth.get("pool").and_then(Value::as_str) == Some(&pool_text(&config.pool)),
        "authorization identity mismatch"
    );
    ensure!(
        auth.get("mode").and_then(Value::as_str) == Some(&row.get::<_, String>(8))
            && hex32(auth, "control_secret_hash")? == bytes32(&row.get::<_, Vec<u8>>(11))?,
        "authorization immutable fields mismatch"
    );
    let proxy: Option<Vec<u8>> = row.get(12);
    match proxy {
        Some(v) => ensure!(
            hex32(auth, "proxy_secret_hash")? == bytes32(&v)?,
            "proxy credential hash mismatch"
        ),
        None => ensure!(
            auth.get("proxy_secret_hash") == Some(&Value::Null),
            "unexpected proxy credential"
        ),
    }
    let context = zkapi_solana_types::binding::authorization_context(&serde_jcs::to_vec(auth)?)?;
    ensure!(
        core::authorization_tag(&Felt252(n), &Felt252(*context.as_bytes())).0 == *p[9].as_bytes(),
        "authorization tag mismatch"
    );
    let quote = body.get("quote").context("missing quote")?;
    let quote_body = quote.get("body").context("missing quote body")?;
    let canonical_quote = serde_jcs::to_vec(quote_body)?;
    ensure!(
        canonical_quote == row.get::<_, Vec<u8>>(23)
            && hash(&canonical_quote) == bytes32(&row.get::<_, Vec<u8>>(24))?
            && hex32(auth, "quote_hash")? == hash(&canonical_quote)
            && hex32(quote, "quote_hash")? == hash(&canonical_quote),
        "frozen quote mismatch"
    );
    ensure!(
        quote_body.get("quote_id").and_then(Value::as_str)
            == Some(&row.get::<_, Uuid>(10).to_string())
            && quote_body.get("provider").and_then(Value::as_str) == Some(&row.get::<_, String>(9))
            && quote_body.get("mode") == auth.get("mode")
            && integer(quote_body, "cap_micro_usdc")? == cap.into(),
        "quote fields mismatch"
    );
    let proof = body.get("proof").context("missing proof")?;
    ensure!(
        proof.get("backend").and_then(Value::as_str) == Some("groth16_bn254"),
        "request proof backend"
    );
    let proof_bytes = base64::engine::general_purpose::STANDARD.decode(
        proof
            .get("proof")
            .and_then(Value::as_str)
            .context("missing proof bytes")?,
    )?;
    crate::crypto::verify_request(&p, &proof_bytes)?;
    ensure!(
        matches!(row.get::<_, String>(3).as_str(), "SIGN_PENDING" | "SETTLED")
            && row.get::<_, String>(6) == "0"
            && row.get::<_, i16>(7) == 0
            && row.get::<_, String>(22) == "AUTH",
        "session is not quiesced for signing"
    );
    let unfinished:bool=tx.query_one("SELECT EXISTS(SELECT 1 FROM operations WHERE pool=$1 AND request_id=$2 AND state NOT IN ('DONE','WAIVED_OPERATOR_LOSS')) OR EXISTS(SELECT 1 FROM dispatch_attempts WHERE pool=$1 AND request_id=$2 AND finished_at IS NULL AND fenced_at IS NULL)",&[&&config.pool[..],&request_id]).await?.get(0);
    ensure!(
        !unfinished,
        "unfinished operations or unfenced dispatch attempts"
    );
    let mode: String = row.get(8);
    ensure!(
        mode == "proxy" || row.get::<_, Option<Vec<u8>>>(27).is_some(),
        "direct issuance/keys are not quiesced"
    );
    ensure!(
        crate::wire::base64_exact::<64>(&checked.quote.signature)?.as_slice()
            == row.get::<_, Vec<u8>>(26),
        "frozen quote signature mismatch"
    );
    let tariff_hash = bytes32(&row.get::<_, Vec<u8>>(25))?;
    ensure!(
        tariff_hash == crate::wire::hash(&checked.quote.body.tariff_hash)?,
        "ledger tariff differs from authorized quote"
    );
    let stored_tariff: Vec<u8> = tx
        .query_one(
            "SELECT canonical_body FROM tariffs WHERE tariff_hash=$1",
            &[&&tariff_hash[..]],
        )
        .await?
        .get(0);
    ensure!(
        hash(&stored_tariff) == tariff_hash,
        "frozen tariff hash mismatch"
    );
    let mut tariff_value: Value = serde_json::from_slice(&stored_tariff)?;
    ensure!(
        serde_jcs::to_vec(&tariff_value)? == stored_tariff
            && tariff_value.get("tariff_hash").is_none(),
        "frozen tariff encoding"
    );
    tariff_value
        .as_object_mut()
        .context("tariff object")?
        .insert(
            "tariff_hash".into(),
            Value::String(hex::encode(tariff_hash)),
        );
    let tariff: crate::wire::Tariff = serde_json::from_value(tariff_value)?;
    crate::quote::validate_tariff(&tariff)?;
    ensure!(
        tariff.provider == checked.quote.body.provider
            && checked.quote.body.models == [tariff.model.clone()],
        "frozen tariff provider/model mismatch"
    );
    let issued = crate::wire::uint(&checked.quote.body.issued_at)?;
    ensure!(
        issued >= crate::wire::uint(&tariff.valid_from)?
            && issued < crate::wire::uint(&tariff.valid_until)?,
        "frozen tariff validity mismatch"
    );
    let charged: u128 = row.get::<_, String>(5).parse()?;
    let receipt_total = verify_receipts(tx, config, request_id, &mode, &tariff).await?;
    ensure!(
        receipt_total == charged,
        "receipt total does not match session"
    );
    let charge: u64 = u64::try_from(row.get::<_, i64>(13))?;
    ensure!(
        u128::from(charge) == charged.checked_add(999).context("charge overflow")? / 1000
            && charge <= cap,
        "settlement charge mismatch"
    );
    let anchor = bytes32(&row.get::<_, Vec<u8>>(14))?;
    let x = bytes32(&row.get::<_, Vec<u8>>(15))?;
    let y = bytes32(&row.get::<_, Vec<u8>>(16))?;
    let delta = bytes32(&row.get::<_, Vec<u8>>(17))?;
    Scalar::from_bytes(delta)?;
    let randomness = bytes32(&row.get::<_, Vec<u8>>(18))?;
    FieldElement::from_bytes(randomness)?;
    let next = compact::server_update(
        &CurvePointWire {
            x: Felt252(*p[10].as_bytes()),
            y: Felt252(*p[11].as_bytes()),
        },
        charge.into(),
        &Felt252(delta),
    )?;
    ensure!(
        next.x.0 == x
            && next.y.0 == y
            && core::next_anchor(&Felt252(randomness), &Felt252(n), &next.x, &next.y).0 == anchor,
        "settlement successor mismatch"
    );
    let message = core::state_message(
        PROTOCOL_VERSION,
        CHAIN_NAMESPACE,
        &Felt252(config.binding),
        &next.x,
        &next.y,
        &Felt252(anchor),
    )
    .0;
    ensure!(
        row.get::<_, Vec<u8>>(19) == message && row.get::<_, Vec<u8>>(20) == hash(&message),
        "settlement message mismatch"
    );
    let signature: Option<Vec<u8>> = row.get(21);
    if let Some(s) = &signature {
        verify_signature(&config.state_key, message, s)?;
    }
    let frozen_digest = hash(&serde_jcs::to_vec(&(
        hash(&transcript),
        charge,
        anchor,
        x,
        y,
        delta,
        randomness,
        message,
    ))?);
    Ok(FrozenTarget {
        intent: Intent {
            pool: config.pool,
            nullifier: n,
            target: SignTarget::Settlement { request_id },
            key: config.state_key.clone(),
            message,
            digest: hash(&message),
            frozen_digest,
        },
        signature,
    })
}
async fn verify_receipts(
    tx: &Transaction<'_>,
    config: &SignerConfig,
    request_id: Uuid,
    mode: &str,
    tariff: &crate::wire::Tariff,
) -> Result<u128> {
    let rows=tx.query("SELECT canonical_body,receipt_hash,signature,operation_id,receipt_id FROM receipts WHERE pool=$1 AND request_id=$2 AND billing_effect='charge' ORDER BY sequence",&[&&config.pool[..],&request_id]).await?;
    let key = VerifyingKey::from_bytes(&config.receipt_key)?;
    let mut total = 0u128;
    let mut operations = std::collections::HashSet::new();
    for row in &rows {
        let body: Vec<u8> = row.get(0);
        let digest = hash(&body);
        ensure!(row.get::<_, Vec<u8>>(1) == digest, "receipt hash mismatch");
        let signature: Option<Vec<u8>> = row.get(2);
        let signature = signature.context("unsigned receipt prevents settlement")?;
        key.verify_strict(&digest, &EdSignature::from_slice(&signature)?)?;
        let v: Value = serde_json::from_slice(&body)?;
        let typed: crate::receipts::ReceiptBody = crate::wire::strict_parse(&body)?;
        ensure!(typed.canonical_bytes()? == body, "noncanonical receipt");
        crate::receipts::validate_tariff_math(&typed, tariff)?;
        ensure!(
            typed.deployment_id == config.authorization.deployment_id,
            "receipt deployment mismatch"
        );
        ensure!(
            v.get("request_id").and_then(Value::as_str) == Some(&request_id.to_string())
                && v.get("pool").and_then(Value::as_str) == Some(&pool_text(&config.pool))
                && v.get("receipt_id").and_then(Value::as_str)
                    == Some(&row.get::<_, Uuid>(4).to_string())
                && v.get("billing_effect").and_then(Value::as_str) == Some("charge")
                && hex32(&v, "tariff_hash")? == crate::wire::hash(&tariff.tariff_hash)?,
            "receipt identity mismatch"
        );
        let operation: Option<Uuid> = row.get(3);
        let charged = integer(&v, "charged_nano_usdc")?;
        ensure!(
            charged <= integer(&v, "reservation_nano_usdc")?,
            "receipt exceeds reservation"
        );
        match operation {
            Some(id) => {
                ensure!(
                    mode == "proxy"
                        && v.get("operation_id").and_then(Value::as_str) == Some(&id.to_string())
                        && operations.insert(id),
                    "receipt operation mismatch"
                );
                let op=tx.query_one("SELECT charged_nano::text,reservation_nano::text,state,observed_cost_nano::text,operator_loss_nano::text,model,dispatched_at FROM operations WHERE pool=$1 AND request_id=$2 AND operation_id=$3",&[&&config.pool[..],&request_id,&id]).await?;
                ensure!(
                    op.get::<_, String>(0).parse::<u128>()? == charged
                        && op.get::<_, String>(1).parse::<u128>()?
                            == integer(&v, "reservation_nano_usdc")?,
                    "receipt operation totals mismatch"
                );
                ensure!(
                    op.get::<_, Option<String>>(3) == typed.observed_nano_usdc
                        && op.get::<_, String>(5) == tariff.model,
                    "operation observation/model mismatch"
                );
                if let Some(loss) = &typed.operator_loss_nano_usdc {
                    ensure!(&op.get::<_, String>(4) == loss, "operator loss mismatch");
                }
                if typed.reason == "not_dispatched" {
                    ensure!(
                        op.get::<_, Option<i64>>(6).is_none(),
                        "dispatched operation cannot be not-dispatched"
                    );
                }
                if op.get::<_, String>(2) == "WAIVED_OPERATOR_LOSS" {
                    ensure!(
                        charged == 0
                            && v.get("reason").and_then(Value::as_str) == Some("waived_unknown"),
                        "waived receipt mismatch"
                    );
                }
            }
            None => {
                ensure!(
                    mode != "proxy"
                        && rows.len() == 1
                        && v.get("operation_id") == Some(&Value::Null)
                        && integer(&v, "reservation_nano_usdc")?
                            == config.authorization.cap.as_nano()
                        && typed.reason != "waived_unknown",
                    "direct receipt mismatch"
                );
                if typed.reason == "not_dispatched" {
                    let issuance = tx.query_one("SELECT provider_key_ref,activated_at FROM sessions WHERE pool=$1 AND request_id=$2", &[&&config.pool[..],&request_id]).await?;
                    ensure!(
                        issuance.get::<_, Option<String>>(0).is_none()
                            && issuance.get::<_, Option<i64>>(1).is_none(),
                        "issued direct key requires final measured usage"
                    );
                }
            }
        }
        total = total
            .checked_add(charged)
            .context("receipt total overflow")?;
    }
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM operations WHERE pool=$1 AND request_id=$2",
            &[&&config.pool[..], &request_id],
        )
        .await?
        .get(0);
    ensure!(
        (mode == "proxy" && usize::try_from(count)? == operations.len())
            || (mode != "proxy" && rows.len() == 1 && count == 0),
        "missing charge receipts"
    );
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> SignerConfig {
        let state_key =
            PublicKey::from_wire(&CompactSigner::from_seed(&Felt252::from_u64(31)).public_key());
        SignerConfig {
            public_devnet_profile: None,
            authorization: crate::quote::BindingConfig {
                deployment_id: "signer-unit".into(),
                pool: pool_text(&[42; 32]),
                vault_binding: FieldElement::from_bytes(Felt252::from_u64(99).0).unwrap(),
                state_key: [
                    FieldElement::from_bytes(state_key.x).unwrap(),
                    FieldElement::from_bytes(state_key.y).unwrap(),
                ],
                cap: zkapi_solana_types::MicroUsdc::new(1_000_000).unwrap(),
                control_api_origin: "http://127.0.0.1:8788".into(),
                inference_api_origin: "http://127.0.0.1:8789".into(),
                quote_key: ed25519_dalek::SigningKey::from_bytes(&[11; 32])
                    .verifying_key()
                    .to_bytes(),
            },
            pool: [42; 32],
            binding: Felt252::from_u64(99).0,
            state_key: PublicKey::from_wire(
                &CompactSigner::from_seed(&Felt252::from_u64(31)).public_key(),
            ),
            clearance_key: PublicKey::from_wire(
                &CompactSigner::from_seed(&Felt252::from_u64(37)).public_key(),
            ),
            receipt_key: ed25519_dalek::SigningKey::from_bytes(&[31; 32])
                .verifying_key()
                .to_bytes(),
        }
    }
    fn intent(config: &SignerConfig) -> Intent {
        let nullifier = Felt252::from_u64(42).0;
        let message = clearance_message(config.binding, nullifier).unwrap();
        Intent {
            pool: config.pool,
            nullifier,
            target: SignTarget::Clearance { nullifier },
            key: config.clearance_key.clone(),
            message,
            digest: hash(&message),
            frozen_digest: [99; 32],
        }
    }
    #[test]
    fn commitment_and_signature_use_upstream_arithmetic_and_canonical_fields() {
        let initial =
            compact::balance_commitment(1_000_000, &Felt252::from_u64(9), &Felt252::from_u64(88));
        let rerandomization = Felt252::from_u64(23);
        let anonymous = compact::rerandomize(&initial, &rerandomization).unwrap();
        for charge in [0, 1, 7, 999_999] {
            let draft = prepare_settlement(
                Felt252::from_u64(99).0,
                Felt252::from_u64(51).0,
                anonymous.x.0,
                anonymous.y.0,
                charge,
            )
            .unwrap();
            let blind = compact::add_blindings(
                &compact::add_blindings(&Felt252::from_u64(9), &rerandomization),
                &Felt252(draft.blind_delta),
            );
            let expected = compact::balance_commitment(
                1_000_000 - u128::from(charge),
                &blind,
                &Felt252::from_u64(88),
            );
            assert_eq!(expected.x.0, draft.next_commitment_x);
            assert_eq!(expected.y.0, draft.next_commitment_y);
            let key = CompactSigner::from_seed(&Felt252::from_u64(31));
            let signature = signature_bytes(&key.sign(&Felt252(draft.signature_message)));
            verify_signature(
                &PublicKey::from_wire(&key.public_key()),
                draft.signature_message,
                &signature,
            )
            .unwrap();
            let mut bad = signature;
            bad[64..].fill(255);
            assert!(decode_signature(&bad).is_err());
            let mut bad = signature;
            bad[..32].fill(255);
            assert!(decode_signature(&bad).is_err());
        }
        assert!(prepare_settlement([255; 32], [0; 32], anonymous.x.0, anonymous.y.0, 0).is_err());
    }
    #[test]
    fn journal_restart_locks_and_preserves_exact_signature() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let config = config();
        assert!(Journal::open(&path, &config).is_err());
        Journal::initialize(&path, &config).unwrap();
        assert!(Journal::initialize(&path, &config).is_err());
        let intent = intent(&config);
        let mut journal = Journal::open(&path, &config).unwrap();
        assert!(Journal::open(&path, &config).is_err());
        journal.pin(&intent).unwrap();
        drop(journal);
        let mut journal = Journal::open(&path, &config).unwrap();
        journal.pin(&intent).unwrap();
        let signature = signature_bytes(
            &CompactSigner::from_seed(&Felt252::from_u64(37)).sign(&Felt252(intent.message)),
        )
        .to_vec();
        journal
            .save_signature(intent.nullifier, signature.clone())
            .unwrap();
        drop(journal);
        let journal = Journal::open(&path, &config).unwrap();
        assert_eq!(
            journal.entries[&intent.nullifier].signature,
            Some(signature)
        );
    }
    #[test]
    fn journal_rejects_cross_role_request_key_message_and_frozen_target_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let config = config();
        Journal::initialize(&path, &config).unwrap();
        let mut journal = Journal::open(&path, &config).unwrap();
        let original = intent(&config);
        journal.pin(&original).unwrap();
        let mut changed = original.clone();
        changed.target = SignTarget::Settlement {
            request_id: Uuid::new_v4(),
        };
        assert!(journal.pin(&changed).is_err());
        changed = original.clone();
        changed.key = config.state_key.clone();
        assert!(journal.pin(&changed).is_err());
        changed = original.clone();
        changed.message[31] ^= 1;
        changed.digest = hash(&changed.message);
        assert!(journal.pin(&changed).is_err());
        changed = original.clone();
        changed.frozen_digest[0] ^= 1;
        assert!(journal.pin(&changed).is_err());
        drop(journal);
        let mut swapped = config.clone();
        std::mem::swap(&mut swapped.state_key, &mut swapped.clearance_key);
        assert!(Journal::open(&path, &swapped).is_err());
    }
    #[test]
    fn incomplete_journal_and_tampering_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let config = config();
        Journal::initialize(&path, &config).unwrap();
        let original = std::fs::read(&path).unwrap();
        for empty in [b"\n".as_slice(), b"\n\n".as_slice()] {
            std::fs::write(&path, empty).unwrap();
            assert!(Journal::open(&path, &config).is_err());
        }
        let mut empty_frame = original.clone();
        empty_frame.push(b'\n');
        std::fs::write(&path, &empty_frame).unwrap();
        assert!(Journal::open(&path, &config).is_err());
        let mut truncated = original.clone();
        truncated.pop();
        std::fs::write(&path, &truncated).unwrap();
        assert!(Journal::open(&path, &config).is_err());
        let mut tampered = original.clone();
        let pos = tampered.iter().position(|b| *b == b'1').unwrap();
        tampered[pos] = b'2';
        std::fs::write(&path, &tampered).unwrap();
        assert!(Journal::open(&path, &config).is_err());
    }
}
