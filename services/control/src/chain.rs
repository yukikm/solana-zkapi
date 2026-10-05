//! Authorization reads the ready I04 HTTP root and authenticates the actual
//! Vault accounts. Historical replay checkpoints are never an admission source.
use crate::{
    crypto::{deployment_keys, role_key, REQUEST_VK_HASH},
    wire::*,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_pubkey::Pubkey;
use std::time::Duration;
use zkapi_solana_types::{FieldElement, MicroUsdc};

const OBSERVATION_TIMEOUT: Duration = Duration::from_secs(30);
const OBSERVATION_INTERVAL: Duration = Duration::from_millis(250);
const OBSERVATION_ATTEMPTS: usize = 120;

/// Retry only incomplete indexer publication or a cut that moved during the
/// reads. The closure contains reads only; no admission or provider action can
/// be repeated here. One deadline covers every request and delay in the loop.
async fn consistent_read<T, F, Fut>(
    timeout: Duration,
    interval: Duration,
    attempts: usize,
    mut read: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    tokio::time::timeout(timeout, async {
        for attempt in 0..attempts {
            match read().await {
                Err(error @ ValidationError::Unavailable("indexer not ready"))
                | Err(error @ ValidationError::Conflict("root changed during observation")) => {
                    if attempt + 1 == attempts {
                        return Err(error);
                    }
                    tokio::time::sleep(interval).await;
                }
                result => return result,
            }
        }
        Err(unavailable("chain observation attempts"))
    })
    .await
    .unwrap_or_else(|_| Err(unavailable("chain observation deadline")))
}

pub const PROFILE_HASH: &str = "ba688d8a2be7647499c98d52c335c381b86f0471f39fa6539f7d451b76dafca1";
pub const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
pub const DEVNET_USDC_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
pub const SPL_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentEnvironment {
    #[default]
    Local,
    Devnet,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedPool {
    #[serde(default)]
    pub deployment_environment: DeploymentEnvironment,
    pub program_id: String,
    pub pool: String,
    pub genesis_hash: String,
    pub mint: String,
    pub token_program: String,
    pub vault_binding: FieldElement,
    pub state_key: [FieldElement; 2],
    pub clearance_key: [FieldElement; 2],
    pub cap_micro_usdc: MicroUsdc,
    pub note_ttl_seconds: String,
    pub challenge_seconds: String,
    pub circuit_profile_hash: String,
}
impl TrustedPool {
    /// The input must already be operator trusted (signature verification belongs
    /// to manifest distribution). All authorization settings are extracted here.
    pub fn from_manifest(m: &Value) -> Result<Self> {
        Self::from_manifest_for(m, DeploymentEnvironment::Local)
    }
    /// Explicit test-only public-devnet profile; runtime separately pins the
    /// exact public IDL, ELF and operator-trusted build manifest.
    pub fn from_devnet_manifest(m: &Value) -> Result<Self> {
        Self::from_manifest_for(m, DeploymentEnvironment::Devnet)
    }
    fn from_manifest_for(m: &Value, environment: DeploymentEnvironment) -> Result<Self> {
        let profile: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/layout2/profile.json"))
                .expect("build profile");
        for (name, value) in profile.as_object().expect("build profile object") {
            if m.get(name) != Some(value) {
                return Err(invalid("manifest artifact/profile build pin"));
            }
        }
        let get = |name: &str| m[name].as_str().ok_or(invalid("manifest field"));
        let point = |name: &str| -> Result<[FieldElement; 2]> {
            Ok([
                m[name]["x"]
                    .as_str()
                    .ok_or(invalid("manifest point"))?
                    .parse()
                    .map_err(|_| invalid("manifest point"))?,
                m[name]["y"]
                    .as_str()
                    .ok_or(invalid("manifest point"))?
                    .parse()
                    .map_err(|_| invalid("manifest point"))?,
            ])
        };
        if m["protocol_layout_version"] != 2
            || m["decimals"] != 6
            || m["tree_backend"] != "transition_proof"
            || m["tree_tag_policy"] != "proof_bound"
            || m["circuit_id"] != "zkapi-v2-note-bound-v1"
            || m["request_vk_hash"] != REQUEST_VK_HASH
            || m["setup_profile"] != "test_only"
            || m["deployment_environment"] != serde_json::to_value(environment).unwrap()
            || !m["transaction_formats"].as_array().is_some_and(|a| {
                a.iter().any(|v| v == "v0_buffer")
                    && a.iter().enumerate().all(|(index, value)| {
                        matches!(
                            value.as_str(),
                            Some("v0_buffer" | "v0_inline" | "v1_inline" | "v0_inline_deposit_v1")
                        ) && !a[..index].contains(value)
                    })
            })
        {
            return Err(invalid("manifest/build profile"));
        }
        let result = Self {
            deployment_environment: environment,
            program_id: get("program_id")?.into(),
            pool: get("pool")?.into(),
            genesis_hash: get("genesis_hash")?.into(),
            mint: get("mint")?.into(),
            token_program: get("token_program")?.into(),
            vault_binding: get("vault_binding")?
                .parse()
                .map_err(|_| invalid("manifest binding"))?,
            state_key: point("state_key")?,
            clearance_key: point("clearance_key")?,
            cap_micro_usdc: get("cap_micro_usdc")?
                .parse()
                .map_err(|_| invalid("manifest cap"))?,
            note_ttl_seconds: get("note_ttl_seconds")?.into(),
            challenge_seconds: get("challenge_seconds")?.into(),
            circuit_profile_hash: get("circuit_profile_hash")?.into(),
        };
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<()> {
        let program = pubkey(&self.program_id)?;
        let pool = pubkey(&self.pool)?;
        let genesis = pubkey(&self.genesis_hash)?;
        let mint = pubkey(&self.mint)?;
        let token = pubkey(&self.token_program)?;
        let deployment_matches = match self.deployment_environment {
            DeploymentEnvironment::Local => true,
            DeploymentEnvironment::Devnet => {
                self.genesis_hash == DEVNET_GENESIS
                    && self.mint == DEVNET_USDC_MINT
                    && self.token_program == SPL_TOKEN_PROGRAM
                    && program != [0; 32]
                    && program != [43; 32]
            }
        };
        if self.vault_binding
            != zkapi_solana_types::binding::vault_binding(&genesis, &program, &pool, &token, &mint)
            || self.state_key != role_key(&deployment_keys::STATE_KEY)?
            || self.clearance_key != role_key(&deployment_keys::CLEARANCE_KEY)?
            || self.circuit_profile_hash != PROFILE_HASH
            || !deployment_matches
            || self.cap_micro_usdc == MicroUsdc::ZERO
            || uint(&self.note_ttl_seconds)? == 0
            || uint(&self.challenge_seconds)? == 0
        {
            return Err(invalid("trusted manifest/build pins"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolObservation {
    pub paused: bool,
    pub slot: u64,
}
#[derive(Clone, Debug)]
pub struct ChainObservation {
    pub root: Root,
    pub pool: PoolObservation,
    pub exit_consumed: bool,
    pub primary_slot: u64,
    pub secondary_slot: u64,
}
fn unavailable(message: &'static str) -> ValidationError {
    ValidationError::Unavailable(message)
}
fn discriminator(name: &str) -> [u8; 8] {
    sha256(format!("account:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}
fn pda(program: &[u8; 32], seeds: &[&[u8]]) -> ([u8; 32], u8) {
    let (k, b) = Pubkey::find_program_address(seeds, &Pubkey::new_from_array(*program));
    (k.to_bytes(), b)
}
fn u64_at(raw: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(raw[offset..offset + 8].try_into().unwrap())
}
fn account_bytes(value: &Value, program: &str) -> Result<Vec<u8>> {
    if value["owner"] != program
        || value["executable"] != false
        || value["data"][1] != "base64"
        || value["lamports"].as_u64().is_none_or(|n| n == 0)
    {
        return Err(unavailable("account owner/metadata"));
    }
    let text = value["data"][0]
        .as_str()
        .ok_or(unavailable("account encoding"))?;
    let raw = STANDARD
        .decode(text)
        .map_err(|_| unavailable("account base64"))?;
    if STANDARD.encode(&raw) != text {
        return Err(unavailable("account canonical base64"));
    }
    Ok(raw)
}
pub fn validate_pool_account(
    trusted: &TrustedPool,
    value: &Value,
    slot: u64,
) -> Result<PoolObservation> {
    trusted.validate()?;
    let raw = account_bytes(value, &trusted.program_id)
        .map_err(|_| ValidationError::TrustMismatch("PoolConfig account metadata"))?;
    if raw.len() != 422 || raw[..8] != discriminator("PoolConfig") || raw[8] != 2 {
        return Err(ValidationError::TrustMismatch("PoolConfig layout"));
    }
    let (program, pool) = (pubkey(&trusted.program_id)?, pubkey(&trusted.pool)?);
    let (derived, bump) = pda(&program, &[b"pool", &raw[390..422]]);
    let mut expected_state = Vec::<u8>::new();
    let mut expected_clearance = Vec::<u8>::new();
    for f in trusted.state_key {
        expected_state.extend_from_slice(f.as_bytes())
    }
    for f in trusted.clearance_key {
        expected_clearance.extend_from_slice(f.as_bytes())
    }
    if derived != pool
        || raw[9] != bump
        || raw[10..42] != pubkey(&trusted.genesis_hash)?
        || raw[42..74] != pubkey(&trusted.mint)?
        || raw[74..106] != pubkey(&trusted.token_program)?
        || raw[106] != 6
        || raw[107..139] != *trusted.vault_binding.as_bytes()
        || raw[203..267] != expected_state
        || raw[267..331] != expected_clearance
        || u64_at(&raw, 331) != uint(&trusted.note_ttl_seconds)?
        || u64_at(&raw, 339) != uint(&trusted.challenge_seconds)?
        || u64_at(&raw, 347) != trusted.cap_micro_usdc.get()
        || raw[355] > 1
        || raw[356..358] != [1, 1]
        || raw[358..390] != hash(&trusted.circuit_profile_hash)?
    {
        return Err(ValidationError::TrustMismatch(
            "PoolConfig manifest mismatch",
        ));
    }
    Ok(PoolObservation {
        paused: raw[355] == 1,
        slot,
    })
}
pub fn exit_address(trusted: &TrustedPool, nullifier: FieldElement) -> Result<(String, u8)> {
    let (key, bump) = pda(
        &pubkey(&trusted.program_id)?,
        &[b"exit", &pubkey(&trusted.pool)?, nullifier.as_bytes()],
    );
    Ok((bs58::encode(key).into_string(), bump))
}
pub fn validate_exit_account(
    trusted: &TrustedPool,
    nullifier: FieldElement,
    address: &str,
    value: &Value,
) -> Result<bool> {
    let (expected, bump) = exit_address(trusted, nullifier)?;
    if address != expected {
        return Err(unavailable("ExitNullifier PDA"));
    }
    if value.is_null() {
        return Ok(false);
    }
    let raw = account_bytes(value, &trusted.program_id)?;
    if raw.len() != 11
        || raw[..8] != discriminator("ExitNullifier")
        || raw[8] != 2
        || raw[9] != bump
        || raw[10] != 1
    {
        return Err(unavailable("ExitNullifier layout"));
    }
    Ok(true)
}
#[derive(Clone)]
pub struct ChainClient {
    client: reqwest::Client,
    primary: String,
    secondary: String,
    indexer: String,
    pub trusted: TrustedPool,
}
impl ChainClient {
    pub fn new(
        primary: String,
        secondary: String,
        indexer: String,
        trusted: TrustedPool,
    ) -> Result<Self> {
        trusted.validate()?;
        let mut rpc_origins = Vec::new();
        for (index, url) in [&primary, &secondary, &indexer].into_iter().enumerate() {
            let url = reqwest::Url::parse(url).map_err(|_| invalid("chain URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid("chain URL"));
            }
            if trusted.deployment_environment == DeploymentEnvironment::Devnet {
                if index < 2 && url.scheme() != "https" {
                    return Err(invalid("devnet RPC requires HTTPS"));
                }
                if index == 2
                    && !url
                        .host_str()
                        .and_then(|host| {
                            host.trim_matches(['[', ']'])
                                .parse::<std::net::IpAddr>()
                                .ok()
                        })
                        .is_some_and(|ip| ip.is_loopback())
                {
                    return Err(invalid("devnet test indexer must be numeric loopback"));
                }
            }
            rpc_origins.push(url.origin());
        }
        // Paths, query credentials, host casing and default ports cannot turn
        // one RPC origin into two independent observations. Distinct backends
        // behind different origins still require operator configuration.
        if rpc_origins[0] == rpc_origins[1] {
            return Err(invalid("independent RPC origins required"));
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| invalid("HTTP client"))?,
            primary,
            secondary,
            indexer,
            trusted,
        })
    }
    async fn rpc(&self, url: &str, method: &str, params: Value) -> Result<Value> {
        let response = self
            .client
            .post(url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| unavailable("RPC transport"))?;
        if !response.status().is_success() {
            return Err(unavailable("RPC HTTP"));
        }
        let value: Value = response.json().await.map_err(|_| unavailable("RPC JSON"))?;
        if value["jsonrpc"] != "2.0" || value["id"] != 1 || value.get("error").is_some() {
            return Err(unavailable("RPC response"));
        }
        value
            .get("result")
            .cloned()
            .ok_or(unavailable("RPC result"))
    }
    pub async fn startup(&self) -> Result<()> {
        tokio::time::timeout(OBSERVATION_TIMEOUT, self.startup_once())
            .await
            .unwrap_or_else(|_| Err(unavailable("chain observation deadline")))
    }
    async fn startup_once(&self) -> Result<()> {
        for url in [&self.primary, &self.secondary] {
            if self.rpc(url, "getGenesisHash", json!([])).await? != self.trusted.genesis_hash {
                return Err(ValidationError::TrustMismatch("RPC genesis"));
            }
        }
        let root = self.current_root().await?;
        if self.pool_at(uint(&root.slot)?).await?.paused {
            return Err(ValidationError::Conflict("pool paused"));
        }
        Ok(())
    }
    pub async fn current_root(&self) -> Result<Root> {
        consistent_read(
            OBSERVATION_TIMEOUT,
            OBSERVATION_INTERVAL,
            OBSERVATION_ATTEMPTS,
            || self.current_root_once(),
        )
        .await
    }
    async fn current_root_once(&self) -> Result<Root> {
        let response = self
            .client
            .get(format!(
                "{}/zkapi/v1/tree/root",
                self.indexer.trim_end_matches('/')
            ))
            .timeout(OBSERVATION_TIMEOUT)
            .send()
            .await
            .map_err(|_| unavailable("indexer transport"))?;
        if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
            return Err(unavailable("indexer not ready"));
        }
        if !response.status().is_success() {
            return Err(unavailable("indexer HTTP"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| unavailable("indexer body"))?;
        let root: Root = strict_parse(&bytes).map_err(|_| unavailable("indexer root encoding"))?;
        if root.pool != self.trusted.pool
            || uint(&root.next_note_id).map_err(|_| unavailable("indexer counter"))? > 1u64 << 32
        {
            return Err(unavailable("indexer pool/counter"));
        }
        uint(&root.slot).map_err(|_| unavailable("indexer slot"))?;
        uint(&root.sequence).map_err(|_| unavailable("indexer sequence"))?;
        pubkey(&root.blockhash).map_err(|_| unavailable("indexer blockhash"))?;
        Ok(root)
    }
    async fn account(
        &self,
        url: &str,
        address: &str,
        commitment: &str,
        minimum: u64,
    ) -> Result<(u64, Value)> {
        let value=self.rpc(url,"getAccountInfo",json!([address,{"encoding":"base64","commitment":commitment,"minContextSlot":minimum}])).await?;
        let slot = value["context"]["slot"]
            .as_u64()
            .ok_or(unavailable("RPC context slot"))?;
        if slot < minimum {
            return Err(unavailable("RPC stale context slot"));
        }
        Ok((
            slot,
            value
                .get("value")
                .cloned()
                .ok_or(unavailable("RPC account missing"))?,
        ))
    }
    pub async fn pool_at(&self, minimum: u64) -> Result<PoolObservation> {
        let (slot, value) = self
            .account(&self.primary, &self.trusted.pool, "finalized", minimum)
            .await?;
        validate_pool_account(&self.trusted, &value, slot)
    }
    pub async fn observe(&self, nullifier: FieldElement) -> Result<ChainObservation> {
        self.observe_bounded(nullifier, None, false).await
    }
    async fn observe_bounded(
        &self,
        nullifier: FieldElement,
        expected_root: Option<FieldElement>,
        require_live: bool,
    ) -> Result<ChainObservation> {
        consistent_read(
            OBSERVATION_TIMEOUT,
            OBSERVATION_INTERVAL,
            OBSERVATION_ATTEMPTS,
            || self.observe_once(nullifier, expected_root, require_live),
        )
        .await
    }
    async fn observe_once(
        &self,
        nullifier: FieldElement,
        expected_root: Option<FieldElement>,
        require_live: bool,
    ) -> Result<ChainObservation> {
        // Each attempt starts from a fresh root and fresh independent account
        // reads. Do not call current_root's retry wrapper inside this deadline.
        let root = self.current_root_once().await?;
        let min = uint(&root.slot)?;
        let (address, _) = exit_address(&self.trusted, nullifier)?;
        let (pool, primary, secondary) = tokio::try_join!(
            self.pool_at(min),
            self.account(&self.primary, &address, "confirmed", min),
            self.account(&self.secondary, &address, "confirmed", min)
        )?;
        let exit_consumed = validate_exit_account(&self.trusted, nullifier, &address, &primary.1)?
            | validate_exit_account(&self.trusted, nullifier, &address, &secondary.1)?;
        // A known denial is terminal even if the indexer moves at the same time.
        if require_live {
            if pool.paused {
                return Err(ValidationError::Conflict("pool paused"));
            }
            if exit_consumed {
                return Err(ValidationError::Conflict("exit consumed"));
            }
            if expected_root.is_some_and(|expected| expected != root.root) {
                return Err(ValidationError::Conflict("stale root"));
            }
        }
        if self.current_root_once().await? != root {
            return Err(ValidationError::Conflict("root changed during observation"));
        }
        Ok(ChainObservation {
            root,
            pool,
            exit_consumed,
            primary_slot: primary.0,
            secondary_slot: secondary.0,
        })
    }
    /// Call again under the writer transaction after locking, and immediately
    /// before activation/key return. No cached observation substitutes this call.
    pub async fn assert_live(
        &self,
        nullifier: FieldElement,
        expected_root: Option<FieldElement>,
    ) -> Result<ChainObservation> {
        self.observe_bounded(nullifier, expected_root, true).await
    }
}

#[cfg(test)]
mod observation_retry_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn only_503_and_changed_cut_repeat_and_terminal_failures_do_not() {
        let reads = AtomicUsize::new(0);
        let value = consistent_read(Duration::from_secs(1), Duration::ZERO, 3, || {
            let read = reads.fetch_add(1, Ordering::SeqCst);
            async move {
                match read {
                    0 => Err(unavailable("indexer not ready")),
                    1 => Err(ValidationError::Conflict("root changed during observation")),
                    _ => Ok(7),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(value, 7);
        assert_eq!(reads.load(Ordering::SeqCst), 3);
        for error in [
            unavailable("indexer HTTP"),
            unavailable("indexer transport"),
            unavailable("indexer root encoding"),
            unavailable("RPC stale context slot"),
            ValidationError::TrustMismatch("PoolConfig layout"),
            ValidationError::Conflict("pool paused"),
            ValidationError::Conflict("exit consumed"),
            ValidationError::Conflict("stale root"),
        ] {
            reads.store(0, Ordering::SeqCst);
            let result = consistent_read(Duration::from_secs(1), Duration::ZERO, 3, || {
                reads.fetch_add(1, Ordering::SeqCst);
                let error = error.clone();
                async move { Err::<(), _>(error) }
            })
            .await;
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(reads.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn persistent_unavailability_and_inflight_reads_have_finite_bounds() {
        let reads = AtomicUsize::new(0);
        let result = consistent_read(Duration::from_secs(1), Duration::ZERO, 3, || {
            reads.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(unavailable("indexer not ready")) }
        })
        .await;
        assert_eq!(result.unwrap_err(), unavailable("indexer not ready"));
        assert_eq!(reads.load(Ordering::SeqCst), 3);
        reads.store(0, Ordering::SeqCst);
        let result = consistent_read(Duration::from_millis(10), Duration::ZERO, 3, || {
            reads.fetch_add(1, Ordering::SeqCst);
            std::future::pending::<Result<()>>()
        })
        .await;
        assert_eq!(
            result.unwrap_err(),
            unavailable("chain observation deadline")
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // The deadline also covers delays, not just individual HTTP requests.
        reads.store(0, Ordering::SeqCst);
        let result = consistent_read(Duration::from_millis(10), Duration::from_secs(1), 3, || {
            reads.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(unavailable("indexer not ready")) }
        })
        .await;
        assert_eq!(
            result.unwrap_err(),
            unavailable("chain observation deadline")
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }
}
