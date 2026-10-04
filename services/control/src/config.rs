//! Trusted local deployment configuration. Fixed test VKs cannot start a production service.
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
pub struct ValidatedConfig {
    pub runtime: RuntimeConfig,
    pub trusted: TrustedPool,
    pub binding: BindingConfig,
    pub signer: SignerConfig,
    pub quote_key: SigningKey,
    pub receipt_key: SigningKey,
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
        ensure!(
            self.manifest["idl_hash"]
                == hex::encode(wire::sha256(include_bytes!(
                    "../../../docs/contracts/zkapi_vault.json"
                ))),
            "IDL/build pin"
        );
        let mut body = self.manifest.clone();
        let object = body.as_object_mut().context("manifest object")?;
        object.remove("manifest_hash");
        object.remove("manifest_signature");
        let hash = hex::encode(wire::sha256(&serde_jcs::to_vec(&body)?));
        ensure!(
            hash == self.trusted_manifest_hash && self.manifest["manifest_hash"] == hash,
            "trusted manifest hash mismatch"
        );
        let trusted = TrustedPool::from_manifest(&self.manifest)?;
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
