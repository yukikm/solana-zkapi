//! Strict fresh-PoC entry point. The legacy Config is an internal carrier for
//! unchanged ledger/prover/transport inputs, never a fallback acquisition mode.
use super::*;
use zkapi_indexer::current_state::{service, IdentityGuard, ProgramPin, StateRpc, POLICY};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentSource {
    pub mode: String,
    pub state_socket: PathBuf,
}
pub struct CurrentConfig {
    pub common: Config,
    pub source: CurrentSource,
    pub program_identity: ProgramPin,
}
pub(super) struct CurrentRuntime {
    pub source: CurrentSource,
    pub identity: tokio::sync::Mutex<IdentityGuard>,
}
pub fn read_current_config(path: &Path) -> Result<CurrentConfig> {
    let mut v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let o = v.as_object_mut().ok_or(bad("current config"))?;
    if o.remove("config_version") != Some(json!(2))
        || o.contains_key("start_slot")
        || o.contains_key("archive_batch")
        || o.contains_key("poll_seconds")
    {
        return Err(bad("current config version/history fields"));
    }
    let source: CurrentSource =
        serde_json::from_value(o.remove("chain_state").ok_or(bad("chain_state required"))?)?;
    if source.mode != POLICY || !source.state_socket.is_absolute() {
        return Err(bad("current source"));
    }
    let program_identity = serde_json::from_value(
        o.remove("program_identity")
            .ok_or(bad("program identity required"))?,
    )?;
    // Unused internal legacy fields are never read by the current runtime.
    o.insert("start_slot".into(), json!(0));
    o.insert("poll_seconds".into(), json!(2));
    let common = serde_json::from_value(v)?;
    Ok(CurrentConfig {
        common,
        source,
        program_identity,
    })
}
impl Runtime {
    pub fn open_current(config: CurrentConfig, initialize: bool) -> Result<Self> {
        if config.source.mode != POLICY || !config.source.state_socket.is_absolute() {
            return Err(bad("current source"));
        }
        let trust = config.common.trust()?;
        let rpc = StateRpc::new(config.common.rpc_url.clone(), 16 * 1024 * 1024)
            .map_err(|_| bad("state identity RPC"))?;
        let identity = IdentityGuard::new(
            rpc,
            trust.pool.program_id.clone(),
            trust.pool.genesis_hash.clone(),
            config.program_identity,
        )
        .map_err(|_| bad("program identity pin"))?;
        let journal = if initialize {
            Journal::initialize_current(&config.common.journal_directory, trust.pool())?
        } else {
            Journal::open_current(&config.common.journal_directory, trust.pool())?
        };
        let rpc =
            ArchiveRpc::new(config.common.rpc_url.clone()).map_err(|_| bad("transport RPC"))?;
        Ok(Self {
            scanner: Scanner::new(trust.clone()),
            trust,
            config: config.common,
            journal,
            rpc,
            current: Some(CurrentRuntime {
                source: config.source,
                identity: tokio::sync::Mutex::new(identity),
            }),
            shutdown: None,
            checkpoint_binding: [0; 32],
            checkpoint_saved: None,
            reconciled_scan: false,
        })
    }
    pub(super) async fn current_scan(&self, fresh: bool) -> Result<FinalizedView> {
        let current = self.current.as_ref().ok_or(bad("current source absent"))?;
        let active = self
            .journal
            .jobs()
            .any(|(_, j)| j.attempts.iter().any(|a| a.outcome == Outcome::Unknown));
        let state = interruptible(
            self.shutdown.as_ref(),
            service::read_socket(
                &current.source.state_socket,
                &self.trust.pool,
                self.trust.manifest_hash,
                fresh,
                active,
            ),
        )
        .await?
        .map_err(|_| bad("current state unavailable"))?;
        if let Some(old) = self.journal.checkpoint() {
            if !Checkpoint::Accounts(state.cut().clone()).follows(old) {
                return Err(bad("current cut regression"));
            }
        }
        FinalizedView::from_current(self.trust.clone(), state)
    }
    pub(super) async fn verify_send_identity(&self) -> Result<()> {
        if let Some(current) = &self.current {
            let slot = self.journal.checkpoint().map_or(0, |c| c.slot());
            interruptible(
                self.shutdown.as_ref(),
                current
                    .identity
                    .lock()
                    .await
                    .ensure(slot, Duration::from_secs(5)),
            )
            .await?
            .map_err(|_| bad("program identity send fence"))?;
        }
        Ok(())
    }
}
pub async fn run_current(config: CurrentConfig, command: &str) -> Result<()> {
    if ![
        "init", "status", "scan", "prove", "once", "run", "recover", "cleanup",
    ]
    .contains(&command)
    {
        return Err(bad("current runtime command"));
    }
    let signals = Signals::install()?;
    let mut runtime = Runtime::open_current(config, command == "init")?;
    runtime.shutdown = Some(signals.shutdown.clone());
    match run_command(&mut runtime, command).await {
        Err(Error::Interrupted) => {
            runtime.publish_health(false, now())?;
            Ok(())
        }
        result => result,
    }
}
