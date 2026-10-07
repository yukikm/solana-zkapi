//! I09 first slice: finalized evidence, real proofs and independent durable jobs.
//! No provider capability and no control ledger writer are owned by this crate.
pub mod archive_indexer;
pub mod journal;
pub mod read_model;
pub mod runtime;
pub mod scan;
mod shutdown;

use ark_bn254::Bn254;
use ark_groth16::ProvingKey;
use ark_serialize::CanonicalSerialize;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zkapi_control::{
    chain::TrustedPool,
    config::DevnetConfig,
    wire::{self, SessionCreate},
};
use zkapi_layout2::{binding, Command, Operation, TreeUpdate};
use zkapi_tree_prover::{TreeCircuit, TreeRequest};

pub type Hash = [u8; 32];
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("challenger stopping at a durable checkpoint")]
    Interrupted,
    #[error("challenger transport child could not be reaped")]
    BridgeCleanup,
    #[error("challenger rejected evidence: {0}")]
    Evidence(&'static str),
    #[error("challenger journal conflict: {0}")]
    Conflict(&'static str),
    #[error("challenger storage I/O")]
    Io(#[from] std::io::Error),
    #[error("challenger journal encoding")]
    Json(#[from] serde_json::Error),
    #[error("challenger read repository unavailable")]
    Database(#[from] tokio_postgres::Error),
}
pub fn sha(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}
fn bad(why: &'static str) -> Error {
    Error::Evidence(why)
}

/// Starts from a distribution-pinned hash, never a hash trusted from the fetched
/// manifest itself. Both local and explicit devnet use the fixed test profile.
#[derive(Clone)]
pub struct Trust {
    pub(crate) pool: TrustedPool,
    pub(crate) deployment: String,
    pub(crate) manifest_hash: Hash,
    pub(crate) tree_pk_hash: Hash,
    pub(crate) tree_vk_hash: Hash,
}
impl Trust {
    pub fn from_pinned_manifest(manifest: &Value, pinned_hash: Hash) -> Result<Self> {
        Self::from_pinned_manifest_for(manifest, pinned_hash, None)
    }
    /// Explicit devnet opt-in reuses the control service's offline build/IDL
    /// validation, without loading any control, provider or wallet secret.
    pub fn from_pinned_devnet_manifest(
        manifest: &Value,
        pinned_hash: Hash,
        devnet: &DevnetConfig,
    ) -> Result<Self> {
        Self::from_pinned_manifest_for(manifest, pinned_hash, Some(devnet))
    }
    fn from_pinned_manifest_for(
        manifest: &Value,
        pinned_hash: Hash,
        devnet: Option<&DevnetConfig>,
    ) -> Result<Self> {
        let mut body = manifest.as_object().ok_or(bad("manifest object"))?.clone();
        body.remove("manifest_hash");
        body.remove("manifest_signature");
        let digest = sha(&serde_jcs::to_vec(&body).map_err(|_| bad("manifest JCS"))?);
        if digest != pinned_hash || manifest["manifest_hash"] != hex::encode(digest) {
            return Err(bad("distribution manifest hash"));
        }
        Ok(Self {
            pool: match devnet {
                Some(devnet) => devnet
                    .validate_manifest(manifest)
                    .map_err(|_| bad("devnet manifest/build pins"))?,
                None => {
                    TrustedPool::from_manifest(manifest).map_err(|_| bad("manifest/build pins"))?
                }
            },
            deployment: manifest["deployment_id"]
                .as_str()
                .ok_or(bad("deployment"))?
                .into(),
            manifest_hash: digest,
            tree_pk_hash: wire::hash(
                manifest["tree_proof_artifacts"]["pk_hash"]
                    .as_str()
                    .ok_or(bad("tree PK"))?,
            )
            .map_err(|_| bad("tree PK"))?,
            tree_vk_hash: wire::hash(
                manifest["tree_proof_artifacts"]["vk_hash"]
                    .as_str()
                    .ok_or(bad("tree VK"))?,
            )
            .map_err(|_| bad("tree VK"))?,
        })
    }
    pub fn pool(&self) -> Hash {
        wire::pubkey(&self.pool.pool).expect("validated pool")
    }
    pub fn load_tree_key(&self, bytes: &[u8]) -> Result<ProvingKey<Bn254>> {
        let pk =
            zkapi_tree_prover::load_pk(bytes, &self.tree_pk_hash).map_err(|_| bad("tree PK"))?;
        let mut vk = Vec::new();
        pk.vk
            .serialize_compressed(&mut vk)
            .map_err(|_| bad("tree VK"))?;
        if sha(&vk) != self.tree_vk_hash {
            return Err(bad("tree VK"));
        }
        Ok(pk)
    }
}

/// Archived AUTH record. SETTLED is intentionally neither excluded nor special.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub pool: Hash,
    pub request_id: uuid::Uuid,
    pub nullifier: Hash,
    pub transcript_digest: Hash,
    pub transcript: Vec<u8>,
}
impl Evidence {
    pub fn verify(&self, trust: &Trust) -> Result<SessionCreate> {
        if self.pool != trust.pool() || sha(&self.transcript) != self.transcript_digest {
            return Err(bad("transcript digest/pool"));
        }
        let request: SessionCreate =
            wire::strict_parse(&self.transcript).map_err(|_| bad("transcript encoding"))?;
        if wire::jcs(&request).map_err(|_| bad("transcript JCS"))? != self.transcript
            || request.authorization.request_id != self.request_id.to_string()
            || request.authorization.pool != trust.pool.pool
            || request.authorization.deployment_id != trust.deployment
            || request.quote.body.pool != trust.pool.pool
            || request.quote.body.deployment_id != trust.deployment
            || *request.public_inputs[8].as_bytes() != self.nullifier
        {
            return Err(bad("archived AUTH identity"));
        }
        let p = request.public_inputs.map(|f| *f.as_bytes());
        if p[0] != zkapi_layout2::integer(2)
            || p[1] != zkapi_layout2::integer(zkapi_layout2::NAMESPACE)
            || p[2] != *trust.pool.vault_binding.as_bytes()
            || p[4..6] != trust.pool.state_key.map(|f| *f.as_bytes())
        {
            return Err(bad("historical RP deployment"));
        }
        zkapi_control::crypto::verify_request(
            &request.public_inputs,
            &request.proof.bytes().map_err(|_| bad("RP encoding"))?,
        )
        .map_err(|_| bad("historical RP verification"))?;
        // Deliberately no validate_new(), quote freshness or RP[3] comparison.
        Ok(request)
    }
}

pub struct PreparedChallenge {
    pub job: journal::JobIdentity,
    pub evidence: Evidence,
    pub circuit: TreeCircuit,
    context: binding::Context,
}
impl PreparedChallenge {
    pub fn from_finalized(
        view: &scan::FinalizedView,
        note_id: u32,
        evidence: Evidence,
    ) -> Result<Self> {
        let pending = view
            .state
            .pending
            .get(&note_id)
            .ok_or(bad("Pending absent"))?;
        evidence.verify(&view.trust)?;
        if pending.nullifier != evidence.nullifier || view.now >= pending.deadline {
            return Err(bad("Pending nullifier/deadline"));
        }
        let generation = view
            .generations
            .get(&note_id)
            .ok_or(bad("Pending generation absent"))?
            .clone();
        let circuit = zkapi_tree_prover::prepare(
            TreeRequest {
                vault: *view.trust.pool.vault_binding.as_bytes(),
                old_root: view.state.root,
                id: note_id,
                commitment: pending.note.commitment,
                deposit: pending.note.deposit,
                expiry: pending.note.expiry,
                op: 2,
            },
            view.tree.path(note_id),
        )
        .map_err(|_| bad("current zero path"))?;
        Ok(Self {
            job: journal::JobIdentity {
                pool: view.trust.pool(),
                note_id,
                nullifier: pending.nullifier,
                deadline: pending.deadline,
                generation,
            },
            evidence,
            circuit,
            context: binding::Context {
                vault: *view.trust.pool.vault_binding.as_bytes(),
                state_key: view.trust.pool.state_key.map(|f| *f.as_bytes()),
                clearance_key: view.trust.pool.clearance_key.map(|f| *f.as_bytes()),
                root: view.state.root,
                next_id: view.state.next_note_id,
                note: Some(binding::Note {
                    id: note_id,
                    commitment: pending.note.commitment,
                    deposit: pending.note.deposit,
                    expiry: pending.note.expiry,
                    status: 2,
                }),
                pending: Some(binding::Pending {
                    exists: true,
                    nullifier: pending.nullifier,
                    deadline: pending.deadline,
                }),
                now: view.now,
                ttl: 0,
                paused: view.paused,
                exit_consumed: true,
                destination: [0; 32],
            },
        })
    }
    /// Only keys loaded against the trusted manifest should be supplied. Verify
    /// both fixed VK and semantic bindings again before publishing payload bytes.
    pub fn prove(self, trust: &Trust, pk: &ProvingKey<Bn254>) -> Result<Vec<u8>> {
        let mut vk = Vec::new();
        pk.vk
            .serialize_compressed(&mut vk)
            .map_err(|_| bad("tree VK"))?;
        if sha(&vk) != trust.tree_vk_hash || self.job.pool != trust.pool() {
            return Err(bad("tree VK/pool"));
        }
        let tree = zkapi_tree_prover::prove(self.circuit.clone(), pk, &mut rand::rngs::OsRng)
            .map_err(|_| bad("tree proof"))?;
        self.assemble_verified(trust, &tree, &pk.vk)
    }
    pub fn assemble_verified(
        &self,
        trust: &Trust,
        tree: &TreeUpdate,
        vk: &ark_groth16::VerifyingKey<Bn254>,
    ) -> Result<Vec<u8>> {
        let mut vk_bytes = Vec::new();
        vk.serialize_compressed(&mut vk_bytes)
            .map_err(|_| bad("tree VK"))?;
        if sha(&vk_bytes) != trust.tree_vk_hash || self.job.pool != trust.pool() {
            return Err(bad("tree VK/pool"));
        }
        zkapi_tree_prover::verify(tree, vk).map_err(|_| bad("tree proof"))?;
        let request = self.evidence.verify(trust)?;
        let mut payload = Vec::with_capacity(Operation::Challenge.payload_len());
        payload.extend_from_slice(&self.job.note_id.to_le_bytes());
        for f in request.public_inputs {
            payload.extend_from_slice(f.as_bytes());
        }
        payload.extend_from_slice(&request.proof.bytes().map_err(|_| bad("RP encoding"))?);
        let mut wire = [0; zkapi_layout2::TREE_BYTES];
        tree.encode(&mut wire).map_err(|_| bad("tree encoding"))?;
        payload.extend_from_slice(&wire);
        let command =
            Command::decode(Operation::Challenge, &payload).map_err(|_| bad("challenge wire"))?;
        binding::validate(&command, &self.context).map_err(|_| bad("Vault challenge binding"))?;
        Ok(payload)
    }
}

#[cfg(test)]
mod tests;
