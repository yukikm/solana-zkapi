use super::*;
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use fs2::FileExt;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::Path as FsPath,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot, RwLock, Semaphore},
};

pub fn wall_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn monotonic_ms() -> Result<u64> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // CLOCK_MONOTONIC is shared between processes on this host.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 || time.tv_sec < 0 {
        return Err("monotonic clock unavailable".into());
    }
    Ok(time.tv_sec as u64 * 1000 + time.tv_nsec as u64 / 1_000_000)
}
pub fn boot_id() -> Result<Bytes32> {
    #[cfg(target_os = "linux")]
    {
        Ok(crate::sha(&fs::read("/proc/sys/kernel/random/boot_id")?))
    }
    #[cfg(target_os = "macos")]
    {
        let mut boot = libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        };
        let mut size = std::mem::size_of_val(&boot);
        if unsafe {
            libc::sysctlbyname(
                c"kern.boottime".as_ptr(),
                &mut boot as *mut _ as *mut _,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err("boot clock unavailable".into());
        }
        Ok(crate::sha(
            format!("{}:{}", boot.tv_sec, boot.tv_usec).as_bytes(),
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err("unsupported current-state host".into())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub config_version: u32,
    pub manifest: PathBuf,
    pub manifest_sha256: String,
    #[serde(default)]
    pub devnet: Option<zkapi_control::config::DevnetConfig>,
    pub program_identity: ProgramPin,
    pub rpc_url: String,
    pub listen: String,
    pub public_origin: String,
    pub snapshots_directory: PathBuf,
    pub chain_state: Settings,
}
pub fn load_trust(
    manifest: &FsPath,
    digest: &str,
    devnet: Option<&zkapi_control::config::DevnetConfig>,
) -> Result<TrustedPool> {
    let value: Value = serde_json::from_slice(&fs::read(manifest)?)?;
    let mut body = value.as_object().ok_or("manifest object")?.clone();
    body.remove("manifest_hash");
    body.remove("manifest_signature");
    if hex::encode(crate::sha(&serde_jcs::to_vec(&body)?)) != digest
        || value["manifest_hash"] != digest
    {
        return Err("independent manifest hash mismatch".into());
    }
    Ok(match devnet {
        Some(d) => d.validate_manifest(&value)?,
        None => TrustedPool::from_manifest(&value)?,
    })
}
pub fn hash(text: &str) -> Result<Bytes32> {
    Ok(hex::decode(text)?.try_into().map_err(|_| "hash length")?)
}
impl Config {
    pub fn validate(&self) -> Result<TrustedPool> {
        if self.config_version != 2 {
            return Err("current-state config version".into());
        }
        self.chain_state.validate()?;
        let origin = reqwest::Url::parse(&self.public_origin)?;
        if !matches!(origin.scheme(), "http" | "https")
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("public origin".into());
        }
        load_trust(&self.manifest, &self.manifest_sha256, self.devnet.as_ref())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedCapture {
    pub capacity: u32,
    pub max_chain_time_age_seconds: u64,
    pub capture: Capture,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: u32,
    fresh: bool,
    active: bool,
}
struct Query {
    request: Request,
    reply: oneshot::Sender<Option<SharedCapture>>,
}
#[derive(Clone, Default, Serialize)]
pub struct Health {
    pub ready: bool,
    pub observed_ms: u64,
    pub slot: Option<u64>,
    pub rpc: Value,
    pub pool: String,
    pub genesis: String,
    pub observed_at: u64,
    pub age_ms: u64,
    pub policy: String,
}
#[derive(Clone)]
pub struct Owner {
    queries: mpsc::Sender<Query>,
    health: Arc<RwLock<Health>>,
}
impl Owner {
    pub async fn read(&self, fresh: bool, active: bool) -> Result<SharedCapture> {
        tokio::time::timeout(Duration::from_secs(25), async {
            let (reply, receive) = oneshot::channel();
            self.queries
                .send(Query {
                    request: Request {
                        schema: 1,
                        fresh,
                        active,
                    },
                    reply,
                })
                .await
                .map_err(|_| "state worker stopped")?;
            receive
                .await
                .map_err(|_| "state worker stopped")?
                .ok_or("state unavailable".into())
        })
        .await
        .map_err(|_| "state read deadline")?
    }
    pub async fn health(&self) -> Health {
        let mut h = self.health.read().await.clone();
        h.age_ms = monotonic_ms().map_or(u64::MAX, |n| n.saturating_sub(h.observed_ms));
        h.ready &= !self.queries.is_closed() && h.age_ms <= 30_000;
        h
    }
}
pub fn start_owner(
    config: Config,
    trusted: TrustedPool,
) -> Result<(Owner, tokio::task::JoinHandle<()>)> {
    config.validate()?;
    let deployment = hash(&config.manifest_sha256)?;
    let rpc = StateRpc::new(
        config.rpc_url.clone(),
        config.chain_state.max_response_bytes,
    )?;
    let mut identity = IdentityGuard::new(
        rpc.clone(),
        trusted.program_id.clone(),
        trusted.genesis_hash.clone(),
        config.program_identity.clone(),
    )?;
    let (send, mut receive) = mpsc::channel::<Query>(128);
    let health = Arc::new(RwLock::new(Health::default()));
    let owner = Owner {
        queries: send,
        health: health.clone(),
    };
    let task = tokio::spawn(async move {
        let mut previous: Option<VerifiedPoolState> = None;
        let mut available = false;
        let mut deadline = tokio::time::Instant::now();
        let mut active_until = tokio::time::Instant::now();
        loop {
            let query = tokio::select! {
                _ = tokio::time::sleep_until(deadline) => None,
                q = receive.recv() => match q {Some(q)=>Some(q),None=>break},
            };
            if query.as_ref().is_some_and(|q| q.request.active) {
                active_until = tokio::time::Instant::now() + Duration::from_secs(30);
                deadline = deadline.min(
                    tokio::time::Instant::now()
                        + Duration::from_secs(config.chain_state.poll_active_seconds),
                );
            }
            let record = |state: &VerifiedPoolState| SharedCapture {
                capacity: config.chain_state.max_note_ids,
                max_chain_time_age_seconds: config.chain_state.max_chain_time_age_seconds,
                capture: state.capture().clone(),
            };
            if let Some(q) = query.as_ref() {
                let age_limit = if q.request.fresh { FRESH_MS } else { 30_000 };
                if available
                    && identity.healthy()
                    && previous
                        .as_ref()
                        .is_some_and(|s| s.capture.age_ms().is_ok_and(|n| n <= age_limit))
                {
                    let _ = query.unwrap().reply.send(previous.as_ref().map(record));
                    continue;
                }
                // Share a failed refresh/backoff with queued callers instead of
                // converting each HTTP failure into another RPC refresh.
                if !available && tokio::time::Instant::now() < deadline {
                    let _ = query.unwrap().reply.send(None);
                    continue;
                }
            }
            let minimum = previous.as_ref().map_or(0, |s| s.cut.slot);
            // Identity checks share the refresh budget with account acquisition.
            // A slow startup must not extend one refresh beyond thirty seconds.
            let result: Result<VerifiedPoolState> =
                tokio::time::timeout(Duration::from_secs(30), async {
                    identity.ensure(minimum, Duration::from_secs(60)).await?;
                    let state = rpc
                        .capture_with_failure(
                            &trusted,
                            deployment,
                            &config.chain_state,
                            minimum,
                            || async {
                                // Do not advertise the previous view as ready while
                                // a failed verification is being retried.
                                health.write().await.ready = false;
                            },
                        )
                        .await?;
                    if previous.as_ref().is_some_and(|old| !state.follows(old)) {
                        return Err("current-state regression".into());
                    }
                    // Cache failure cannot create financial state or make cached bytes ready.
                    atomic_cache(&config.chain_state.cache_file, &state.capture)?;
                    Ok(state)
                })
                .await
                .map_err(|_| "current-state owner refresh deadline".into())
                .and_then(|result| result);
            available = result.is_ok();
            if let Ok(state) = result {
                previous = Some(state);
            }
            let ready = available && identity.healthy();
            *health.write().await = Health {
                ready,
                observed_ms: previous.as_ref().map_or(0, |s| s.capture.started_ms),
                slot: previous.as_ref().map(|s| s.cut.slot),
                rpc: rpc.usage(),
                pool: trusted.pool.clone(),
                genesis: trusted.genesis_hash.clone(),
                observed_at: wall_time(),
                age_ms: 0,
                policy: POLICY.into(),
            };
            let response = if ready {
                previous.as_ref().map(record)
            } else {
                None
            };
            if let Some(q) = query {
                let _ = q.reply.send(response.clone());
            }
            while let Ok(q) = receive.try_recv() {
                if q.request.active {
                    active_until = tokio::time::Instant::now() + Duration::from_secs(30);
                }
                let _ = q.reply.send(response.clone());
            }
            let active = tokio::time::Instant::now() < active_until
                || previous
                    .as_ref()
                    .is_some_and(|s| s.chain.pending.values().any(|p| p.deadline > wall_time()));
            let delay = if active {
                config.chain_state.poll_active_seconds
            } else {
                config.chain_state.poll_idle_seconds
            };
            deadline = tokio::time::Instant::now() + Duration::from_secs(delay);
        }
        health.write().await.ready = false;
    });
    Ok((owner, task))
}
fn private_parent(path: &FsPath) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let parent = path.parent().ok_or("private parent")?;
    if !parent.exists() {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let meta = fs::symlink_metadata(parent)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o007 != 0 {
        return Err("private state directory ownership/mode".into());
    }
    Ok(())
}
fn atomic_cache(path: &FsPath, capture: &Capture) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    private_parent(path)?;
    let bytes = serde_json::to_vec(capture)?;
    if bytes.len() > MAX_CAPTURE {
        return Err("cache limit".into());
    }
    let temporary = path.with_extension("next");
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    f.write_all(&bytes)?;
    f.sync_all()?;
    fs::rename(&temporary, path)?;
    fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
pub struct SocketServer {
    task: tokio::task::JoinHandle<()>,
    _lock: fs::File,
    path: PathBuf,
}
impl Drop for SocketServer {
    fn drop(&mut self) {
        self.task.abort();
        let _ = fs::remove_file(&self.path);
    }
}
pub fn serve_socket(path: &FsPath, owner: Owner) -> Result<SocketServer> {
    let (listener, lock) = bind_socket(path)?;
    Ok(spawn_socket(path, owner, listener, lock))
}
fn bind_socket(path: &FsPath) -> Result<(tokio::net::UnixListener, fs::File)> {
    use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
    private_parent(path)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path.with_extension("lock"))?;
    lock.try_lock_exclusive()?;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() {
            return Err("state socket path occupied".into());
        }
        fs::remove_file(path)?;
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok((listener, lock))
}
fn spawn_socket(
    path: &FsPath,
    owner: Owner,
    listener: tokio::net::UnixListener,
    lock: fs::File,
) -> SocketServer {
    let task = tokio::spawn(async move {
        let capacity = Arc::new(Semaphore::new(64));
        loop {
            let Ok(permit) = capacity.clone().acquire_owned().await else {
                break;
            };
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let owner = owner.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = tokio::time::timeout(Duration::from_secs(30), async {
                    let n = stream.read_u32().await?;
                    if n > 1024 {
                        return Err::<(), Box<dyn std::error::Error + Send + Sync>>(
                            "socket request limit".into(),
                        );
                    }
                    let mut raw = vec![0; n as usize];
                    stream.read_exact(&mut raw).await?;
                    let request: Request = serde_json::from_slice(&raw)?;
                    if request.schema != 1 {
                        return Err("socket schema".into());
                    }
                    let value = owner.read(request.fresh, request.active).await.ok();
                    let bytes = serde_json::to_vec(&value)?;
                    if bytes.len() > MAX_CAPTURE {
                        return Err("socket capture limit".into());
                    }
                    stream.write_u32(bytes.len() as u32).await?;
                    stream.write_all(&bytes).await?;
                    Ok(())
                })
                .await;
            });
        }
    });
    SocketServer {
        task,
        _lock: lock,
        path: path.into(),
    }
}
pub async fn read_socket(
    path: &FsPath,
    trusted: &TrustedPool,
    deployment: Bytes32,
    fresh: bool,
    active: bool,
) -> Result<VerifiedPoolState> {
    tokio::time::timeout(Duration::from_secs(25), async {
        private_parent(path)?;
        let mut stream = tokio::net::UnixStream::connect(path).await?;
        let raw = serde_json::to_vec(&Request {
            schema: 1,
            fresh,
            active,
        })?;
        stream.write_u32(raw.len() as u32).await?;
        stream.write_all(&raw).await?;
        let n = stream.read_u32().await? as usize;
        if n > MAX_CAPTURE {
            return Err("socket response limit".into());
        }
        let mut raw = vec![0; n];
        stream.read_exact(&mut raw).await?;
        let record: Option<SharedCapture> = serde_json::from_slice(&raw)?;
        let record = record.ok_or("state owner unavailable")?;
        let settings = Settings {
            mode: POLICY.into(),
            poll_idle_seconds: 10,
            poll_active_seconds: 2,
            max_note_ids: record.capacity,
            rpc_concurrency: 4,
            max_response_bytes: 16 * 1024 * 1024,
            max_chain_time_age_seconds: record.max_chain_time_age_seconds,
            state_socket: path.into(),
            cache_file: path.with_extension("cache"),
        };
        verify(
            trusted,
            deployment,
            &settings,
            record.capture,
            wall_time(),
            if fresh { FRESH_MS } else { 30_000 },
        )
    })
    .await
    .map_err(|_| "state socket deadline")?
}

#[derive(Clone)]
struct Http {
    owner: Owner,
    config: Arc<Config>,
    trusted: TrustedPool,
}
async fn view(h: &Http) -> Result<crate::snapshot::ReadView> {
    let record = h.owner.read(true, false).await?;
    // The owner already ran the expensive validation. This boundary still
    // checks age; verification here reuses exactly the same pure constructor.
    let state = verify(
        &h.trusted,
        hash(&h.config.manifest_sha256)?,
        &h.config.chain_state,
        record.capture,
        wall_time(),
        FRESH_MS,
    )?;
    Ok(crate::snapshot::ReadView::from_current(&state))
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":{"code":"indexer_unavailable","message":"Current finalized state unavailable","retriable":true}}))).into_response()
}
fn invalid() -> Response {
    (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"invalid_path","message":"Note path unavailable","retriable":false}}))).into_response()
}
async fn root(State(h): State<Http>) -> Response {
    match view(&h).await.and_then(|v| Ok(v.root()?)) {
        Ok(v) => Json(v).into_response(),
        Err(_) => unavailable(),
    }
}
async fn path(h: Http, id: String, zero: bool) -> Response {
    let Ok(n) = id.parse::<u32>() else {
        return invalid();
    };
    if n.to_string() != id {
        return invalid();
    }
    let Ok(v) = view(&h).await else {
        return unavailable();
    };
    match if zero { v.zero_path(n) } else { v.path(n) } {
        Ok(p) => Json(p).into_response(),
        Err(_) => invalid(),
    }
}
async fn snapshot(State(h): State<Http>) -> Response {
    let Ok(v) = view(&h).await else {
        return unavailable();
    };
    let Ok(bytes) = v.snapshot_bytes() else {
        return unavailable();
    };
    let digest = hex::encode(crate::sha(&bytes));
    if fs::write(
        h.config.snapshots_directory.join(format!("{digest}.json")),
        &bytes,
    )
    .is_err()
    {
        return unavailable();
    }
    Json(json!({"snapshot":v.root().unwrap(),"sha256":digest,
        "download_url":format!("{}/zkapi/v1/tree/snapshots/{digest}.json",h.config.public_origin.trim_end_matches('/'))})).into_response()
}
async fn download(State(h): State<Http>, Path(name): Path<String>) -> Response {
    let Some(hash) = name.strip_suffix(".json") else {
        return invalid();
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return invalid();
    }
    let Ok(bytes) = fs::read(h.config.snapshots_directory.join(&name)) else {
        return invalid();
    };
    if hex::encode(crate::sha(&bytes)) != hash {
        return unavailable();
    }
    ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
pub fn router(owner: Owner, config: Config, trusted: TrustedPool) -> Router {
    Router::new()
        .route("/zkapi/v1/tree/root", get(root))
        .route(
            "/zkapi/v1/tree/notes/{id}/path",
            get(|State(h): State<Http>, Path(id): Path<String>| path(h, id, false)),
        )
        .route(
            "/zkapi/v1/tree/notes/{id}/zero-path",
            get(|State(h): State<Http>, Path(id): Path<String>| path(h, id, true)),
        )
        .route("/zkapi/v1/tree/snapshot", get(snapshot))
        .route("/zkapi/v1/tree/snapshots/{name}", get(download))
        .route(
            "/health",
            get(|State(h): State<Http>| async move { Json(h.owner.health().await) }),
        )
        .with_state(Http {
            owner,
            config: Arc::new(config),
            trusted,
        })
}
pub async fn serve(config: Config) -> Result<()> {
    let trusted = config.validate()?;
    fs::create_dir_all(&config.snapshots_directory)?;
    let listener = tokio::net::TcpListener::bind(&config.listen).await?;
    // Establish sole ownership before starting any RPC work.
    let (socket_listener, socket_lock) = bind_socket(&config.chain_state.state_socket)?;
    let (owner, mut worker) = start_owner(config.clone(), trusted.clone())?;
    let _socket = spawn_socket(
        &config.chain_state.state_socket,
        owner.clone(),
        socket_listener,
        socket_lock,
    );
    let server = axum::serve(listener, router(owner, config, trusted)).into_future();
    use std::future::IntoFuture;
    tokio::select! {
        result=server=>{worker.abort();result?;}
        _=&mut worker=>return Err("state worker stopped".into()),
        _=tokio::signal::ctrl_c()=>worker.abort(),
    }
    Ok(())
}
