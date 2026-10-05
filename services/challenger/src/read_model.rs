//! Dedicated SELECT-only connection. It never constructs Ledger::connect, takes
//! the pool writer advisory lock, or consumes/mutates another consumer's outbox.
use crate::{bad, Evidence, Hash, Result, Trust};
use tokio_postgres::{Client, IsolationLevel, NoTls};
use zkapi_control::chain::DeploymentEnvironment;

pub struct ReadRepository {
    client: Client,
    trust: Trust,
}
pub(crate) fn local_config(dsn: &str) -> Result<tokio_postgres::Config> {
    let config: tokio_postgres::Config = dsn.parse()?;
    // libpq-style hostaddr overrides host for the actual connection target.
    // Checking only host=localhost would permit a plaintext remote connection.
    if config.get_hostaddrs().iter().any(|ip| !ip.is_loopback()) {
        return Err(bad("local-only DB transport"));
    }
    for host in config.get_hosts() {
        if let tokio_postgres::config::Host::Tcp(host) = host {
            if host != "localhost"
                && !host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            {
                return Err(bad("local-only DB transport"));
            }
        }
    }
    Ok(config)
}
pub(crate) fn trusted_config(dsn: &str, trust: &Trust) -> Result<tokio_postgres::Config> {
    let config = local_config(dsn)?;
    if trust.pool.deployment_environment == DeploymentEnvironment::Devnet
        && (config.get_hosts().is_empty()
            || !config
                .get_hosts()
                .iter()
                .all(|host| matches!(host, tokio_postgres::config::Host::Unix(_)))
            || !config.get_hostaddrs().is_empty())
    {
        return Err(bad("devnet Unix-socket DB transport"));
    }
    Ok(config)
}
impl ReadRepository {
    /// Use a dedicated DB role granted SELECT only on pools,
    /// nullifier_reservations and sessions. No TLS is suitable for local Unix
    /// sockets only; production transport configuration remains an I09 follow-up.
    pub async fn connect_local(dsn: &str, trust: Trust) -> Result<Self> {
        let config = trusted_config(dsn, &trust)?;
        let (client, connection) = config.connect(NoTls).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        client
            .batch_execute("SET default_transaction_read_only = on")
            .await?;
        Ok(Self { client, trust })
    }
    pub async fn auth(&mut self, nullifier: Hash) -> Result<Option<Evidence>> {
        let tx = self
            .client
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let pool = self.trust.pool();
        let identity = tx
            .query_opt(
                "SELECT deployment_id, manifest_hash FROM pools WHERE pool=$1",
                &[&&pool[..]],
            )
            .await?
            .ok_or(bad("ledger pool absent"))?;
        if identity.get::<_, String>(0) != self.trust.deployment
            || identity.get::<_, Vec<u8>>(1) != self.trust.manifest_hash
        {
            return Err(bad("ledger manifest identity"));
        }
        // LEFT JOIN distinguishes absent evidence for a permanent AUTH from an
        // unused N or CLEARANCE. Do not filter by session.state: settled RP lives.
        let row = tx.query_opt("SELECT r.kind,s.request_id,s.request_digest,s.request_transcript FROM nullifier_reservations r LEFT JOIN sessions s ON s.pool=r.pool AND s.nullifier=r.nullifier WHERE r.pool=$1 AND r.nullifier=$2", &[&&pool[..], &&nullifier[..]]).await?;
        let evidence = match row {
            None => None,
            Some(row) if row.get::<_, String>(0) == "CLEARANCE" => None,
            Some(row) if row.get::<_, String>(0) == "AUTH" => {
                let digest: Vec<u8> = row
                    .get::<_, Option<Vec<u8>>>(2)
                    .ok_or(bad("AUTH transcript missing"))?;
                Some(Evidence {
                    pool,
                    nullifier,
                    request_id: row
                        .get::<_, Option<uuid::Uuid>>(1)
                        .ok_or(bad("AUTH session missing"))?,
                    transcript_digest: digest.try_into().map_err(|_| bad("transcript digest"))?,
                    transcript: row
                        .get::<_, Option<Vec<u8>>>(3)
                        .ok_or(bad("AUTH transcript missing"))?,
                })
            }
            Some(_) => return Err(bad("reservation kind")),
        };
        if let Some(e) = &evidence {
            e.verify(&self.trust)?;
        }
        tx.commit().await?;
        Ok(evidence)
    }
}
