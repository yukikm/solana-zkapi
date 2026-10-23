//! Offline storage preflight for the dispatcher's actual OS identity/namespace.
//! Probe names can never be confused with durable UUID attempt claims.
use anyhow::{ensure, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

pub fn check(directory: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(directory)?;
    ensure!(
        directory.is_absolute() && metadata.is_dir() && metadata.permissions().mode() & 0o077 == 0,
        "private claims directory required"
    );
    let parent = File::open(directory)?;
    let probe = directory.join(format!(".zkapi-storage-check-{}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&probe)?;
    let checked = (|| -> Result<()> {
        file.write_all(b"zkapi claims storage check\n")?;
        file.sync_all()?;
        parent.sync_all()?;
        Ok(())
    })();
    drop(file);
    // Remove only our exclusive probe, even if its synchronization failed.
    let removed = fs::remove_file(&probe);
    let synced = parent.sync_all();
    checked?;
    removed?;
    synced?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_probe_preserves_original_claims() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let claim = dir.path().join(uuid::Uuid::new_v4().to_string());
        fs::write(&claim, b"original durable claim").unwrap();
        check(dir.path()).unwrap();
        assert_eq!(fs::read(&claim).unwrap(), b"original durable claim");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_storage_fails_without_creating_a_claim() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check(dir.path()).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(check(&dir.path().join("missing")).is_err());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
        assert!(check(&alias).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
