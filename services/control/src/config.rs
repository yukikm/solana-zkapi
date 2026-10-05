//! Trusted test deployment configuration. Fixed test VKs cannot start a production service.
use crate::{
    chain::TrustedPool,
    quote::{validate_tariff, BindingConfig},
    signer::{PublicKey, SignerConfig},
    wire::{self, Tariff},
};
use anyhow::{ensure, Context, Result};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfig {
    pub local_test_only: bool,
    /// Explicit public-devnet chain with local test services. Omission preserves
    /// the local chain/embedded IDL profile; a manifest never selects this alone.
    #[serde(default)]
    pub devnet: Option<DevnetConfig>,
    pub listen: SocketAddr,
    pub manifest: Value,
    pub trusted_manifest_hash: String,
    pub primary_rpc: String,
    pub secondary_rpc: String,
    pub indexer_origin: String,
    pub signer_socket: PathBuf,
    pub quote_seed_file: PathBuf,
    pub receipt_seed_file: PathBuf,
    /// Synthetic I05 adapter remains separate from actual HTTP provider adapters.
    pub enable_local_adapter: bool,
    #[serde(default)]
    pub providers: crate::provider_runtime::ProviderConfig,
    pub tariffs: Vec<Tariff>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevnetConfig {
    pub idl_file: PathBuf,
    pub program_file: PathBuf,
    pub build_manifest_file: PathBuf,
    pub trusted_build_manifest_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevnetBuildManifest {
    schema: u32,
    deployment_environment: String,
    setup_profile: String,
    program_id: String,
    deployment_authority: String,
    genesis_hash: String,
    mint: String,
    token_program: String,
    idl_sha256: String,
    program_sha256: String,
    state_key: Value,
    clearance_key: Value,
    circuit_profile_hash: String,
}
impl DevnetConfig {
    /// Shared offline trust boundary for local test services attached to devnet.
    /// Callers must also authenticate the public manifest against their own
    /// distribution pin. This never reads service or wallet signing keys.
    pub fn validate_manifest(&self, manifest: &Value) -> Result<TrustedPool> {
        self.validate(manifest)?;
        let trusted = TrustedPool::from_devnet_manifest(manifest)?;
        for name in [
            "control_api_origin",
            "inference_api_origin",
            "proving_keys_base_url",
        ] {
            let url = reqwest::Url::parse(
                manifest[name]
                    .as_str()
                    .context("devnet public service URL")?,
            )?;
            ensure!(
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none(),
                "devnet public service URLs require HTTPS without embedded credentials"
            );
        }
        Ok(trusted)
    }

    fn validate(&self, manifest: &Value) -> Result<()> {
        let build_bytes = std::fs::read(&self.build_manifest_file)?;
        let build_hash = hex::encode(wire::sha256(&build_bytes));
        wire::hash(&self.trusted_build_manifest_hash)?;
        ensure!(
            build_hash == self.trusted_build_manifest_hash
                && manifest["artifact_digests"]["devnet_build_manifest"] == build_hash,
            "devnet build manifest trusted hash mismatch"
        );
        let build: DevnetBuildManifest = serde_json::from_slice(&build_bytes)?;
        ensure!(
            build.schema == 1
                && build.deployment_environment == "devnet"
                && build.setup_profile == "test_only"
                && manifest["deployment_environment"] == "devnet"
                && manifest["setup_profile"] == "test_only",
            "devnet test build profile"
        );
        ensure!(
            wire::pubkey(&build.deployment_authority)? != [0; 32],
            "devnet initializer pin"
        );
        for (name, value) in [
            ("program_id", &build.program_id),
            ("genesis_hash", &build.genesis_hash),
            ("mint", &build.mint),
            ("token_program", &build.token_program),
            ("circuit_profile_hash", &build.circuit_profile_hash),
        ] {
            ensure!(manifest[name] == *value, "devnet build binding mismatch");
        }
        ensure!(
            build.state_key == manifest["state_key"]
                && build.clearance_key == manifest["clearance_key"],
            "devnet build signing role pins"
        );
        let idl_bytes = std::fs::read(&self.idl_file)?;
        let program = std::fs::read(&self.program_file)?;
        wire::hash(&build.idl_sha256)?;
        wire::hash(&build.program_sha256)?;
        ensure!(
            hex::encode(wire::sha256(&idl_bytes)) == build.idl_sha256
                && manifest["idl_hash"] == build.idl_sha256,
            "devnet IDL/build pin"
        );
        ensure!(
            program.starts_with(b"\x7fELF")
                && hex::encode(wire::sha256(&program)) == build.program_sha256
                && manifest["artifact_digests"]["vault_program"] == build.program_sha256,
            "devnet program/build pin"
        );
        let mut idl: Value = serde_json::from_slice(&idl_bytes)?;
        let local_idl: Value =
            serde_json::from_str(include_str!("../../../docs/contracts/zkapi_vault.json"))?;
        ensure!(idl["address"] == build.program_id, "devnet IDL program ID");
        idl["address"] = local_idl["address"].clone();
        ensure!(
            idl == local_idl,
            "devnet IDL must preserve build wire contract"
        );
        Ok(())
    }
}
pub struct ValidatedConfig {
    pub runtime: RuntimeConfig,
    pub trusted: TrustedPool,
    pub binding: BindingConfig,
    pub signer: SignerConfig,
    pub quote_key: SigningKey,
    pub receipt_key: SigningKey,
}
impl ValidatedConfig {
    pub fn validate_database(&self, database_url: &str) -> Result<()> {
        if self.runtime.devnet.is_some() {
            let database: tokio_postgres::Config = database_url.parse()?;
            ensure!(
                !database.get_hosts().is_empty()
                    && database
                        .get_hosts()
                        .iter()
                        .all(|host| matches!(host, tokio_postgres::config::Host::Unix(_)))
                    && database.get_hostaddrs().is_empty(),
                "devnet test services require a Unix-socket database"
            );
        }
        Ok(())
    }
}
fn read_key(path: &Path) -> Result<SigningKey> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
            "key file must be owner-only"
        );
    }
    let mut bytes = std::fs::read(path)?;
    ensure!(bytes.len() == 32, "key must contain raw32");
    let key = SigningKey::from_bytes(bytes.as_slice().try_into()?);
    bytes.fill(0);
    Ok(key)
}
impl RuntimeConfig {
    pub fn validate(self) -> Result<ValidatedConfig> {
        ensure!(
            self.local_test_only && self.listen.ip().is_loopback(),
            "I05 test artifacts require explicit local configuration and loopback listener"
        );
        let contract: Value =
            serde_json::from_str(include_str!("../../../docs/contracts/openapi.json"))?;
        let schema = &contract["components"]["schemas"]["Manifest"];
        let manifest = self.manifest.as_object().context("manifest object")?;
        for name in schema["required"].as_array().context("manifest schema")? {
            ensure!(
                manifest.contains_key(name.as_str().unwrap()),
                "missing public manifest field"
            );
        }
        ensure!(
            manifest
                .keys()
                .all(|key| schema["properties"].get(key).is_some()),
            "unknown public manifest field"
        );
        let signature = self.manifest["manifest_signature"]
            .as_str()
            .context("manifest signature")?;
        wire::base64_exact::<64>(signature)?;
        wire::hash(self.manifest["idl_hash"].as_str().context("IDL hash")?)?;
        if self.devnet.is_none() {
            ensure!(
                self.manifest["idl_hash"]
                    == hex::encode(wire::sha256(include_bytes!(
                        "../../../docs/contracts/zkapi_vault.json"
                    ))),
                "IDL/build pin"
            );
        }
        let mut body = self.manifest.clone();
        let object = body.as_object_mut().context("manifest object")?;
        object.remove("manifest_hash");
        object.remove("manifest_signature");
        let hash = hex::encode(wire::sha256(&serde_jcs::to_vec(&body)?));
        ensure!(
            hash == self.trusted_manifest_hash && self.manifest["manifest_hash"] == hash,
            "trusted manifest hash mismatch"
        );
        let trusted = if let Some(devnet) = &self.devnet {
            devnet.validate_manifest(&self.manifest)?
        } else {
            TrustedPool::from_manifest(&self.manifest)?
        };
        if self.devnet.is_some() {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                self.signer_socket.is_absolute(),
                "absolute local signer socket required"
            );
            let parent = std::fs::symlink_metadata(
                self.signer_socket
                    .parent()
                    .context("signer socket parent")?,
            )?;
            ensure!(
                parent.is_dir() && parent.permissions().mode() & 0o077 == 0,
                "devnet signer socket parent must be owner-only"
            );
            // Validate transport policy before reading any signing key. Actual
            // genesis/PoolConfig checks remain on the existing live RPC path.
            crate::chain::ChainClient::new(
                self.primary_rpc.clone(),
                self.secondary_rpc.clone(),
                self.indexer_origin.clone(),
                trusted.clone(),
            )?;
        }
        ensure!(
            self.manifest["db_schema_version"] == "2",
            "ledger schema version"
        );
        let quote_key = read_key(&self.quote_seed_file)?;
        let receipt_key = read_key(&self.receipt_seed_file)?;
        ensure!(
            quote_key.verifying_key() != receipt_key.verifying_key(),
            "quote and receipt keys must differ"
        );
        let get = |name: &str| {
            self.manifest[name]
                .as_str()
                .context("missing manifest field")
        };
        ensure!(
            wire::pubkey(get("quote_public_key")?)? == quote_key.verifying_key().to_bytes()
                && wire::pubkey(get("receipt_public_key")?)?
                    == receipt_key.verifying_key().to_bytes(),
            "manifest signing key mismatch"
        );
        wire::origin(get("control_api_origin")?)?;
        wire::origin(get("inference_api_origin")?)?;
        let binding = BindingConfig {
            deployment_id: get("deployment_id")?.into(),
            pool: trusted.pool.clone(),
            vault_binding: trusted.vault_binding,
            state_key: trusted.state_key,
            cap: trusted.cap_micro_usdc,
            control_api_origin: get("control_api_origin")?.into(),
            inference_api_origin: get("inference_api_origin")?.into(),
            quote_key: quote_key.verifying_key().to_bytes(),
        };
        let signer = SignerConfig {
            authorization: binding.clone(),
            pool: wire::pubkey(&trusted.pool)?,
            binding: *trusted.vault_binding.as_bytes(),
            state_key: PublicKey {
                x: *trusted.state_key[0].as_bytes(),
                y: *trusted.state_key[1].as_bytes(),
            },
            clearance_key: PublicKey {
                x: *trusted.clearance_key[0].as_bytes(),
                y: *trusted.clearance_key[1].as_bytes(),
            },
            receipt_key: receipt_key.verifying_key().to_bytes(),
        };
        let allowed = self.manifest["tariff_hashes"]
            .as_array()
            .context("tariff hashes")?;
        for tariff in &self.tariffs {
            validate_tariff(tariff)?;
            ensure!(
                allowed.iter().any(|x| x == &tariff.tariff_hash),
                "unlisted tariff"
            );
            ensure!(
                self.providers.supports_tariff(tariff)?
                    || (self.enable_local_adapter
                        && tariff.model == "i05-local-only"
                        && tariff.pricing_basis == "fixed_usage_rates"
                        && tariff.provider == wire::Provider::Openai),
                "provider adapter unavailable"
            );
        }
        for (index, tariff) in self.tariffs.iter().enumerate() {
            for other in &self.tariffs[..index] {
                ensure!(
                    tariff.provider != other.provider
                        || tariff.model != other.model
                        || wire::uint(&tariff.valid_from)? >= wire::uint(&other.valid_until)?
                        || wire::uint(&other.valid_from)? >= wire::uint(&tariff.valid_until)?,
                    "overlapping tariffs for provider/model"
                );
            }
        }
        self.providers
            .validate(&self.tariffs, self.local_test_only)?;
        Ok(ValidatedConfig {
            runtime: self,
            trusted,
            binding,
            signer,
            quote_key,
            receipt_key,
        })
    }
}
