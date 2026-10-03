//! Explicit local-process acceptance fault injection; service binaries require local test profile.
pub fn checkpoint(name: &str) {
    if std::env::var("ZKAPI_LOCAL_CRASH_AT").as_deref() == Ok(name) {
        // exit does not run destructors: committed rows survive, sockets disappear.
        std::process::exit(86);
    }
}
