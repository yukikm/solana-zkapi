//! Mutually authenticated, certificate-pinned bridge to an owner-only signer
//! socket. No plaintext network fallback, proxy headers or debug routes exist.
use anyhow::{ensure, Context, Result};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, ServerName},
    RootCertStore,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub mode: String,
    pub listen: SocketAddr,
    pub remote: SocketAddr,
    pub server_name: String,
    pub unix_socket: PathBuf,
    pub ca_der: PathBuf,
    pub certificate_der: PathBuf,
    pub private_key_der: PathBuf,
    pub peer_certificate_sha256: String,
}
impl Config {
    fn material(
        &self,
    ) -> Result<(
        RootCertStore,
        Vec<CertificateDer<'static>>,
        PrivateKeyDer<'static>,
    )> {
        crate::egress::private_file(&self.private_key_der)?;
        crate::wire::hash(&self.peer_certificate_sha256)?;
        let mut root = RootCertStore::empty();
        root.add(CertificateDer::from(std::fs::read(&self.ca_der)?))?;
        let certificate = vec![CertificateDer::from(std::fs::read(&self.certificate_der)?)];
        let private = PrivateKeyDer::try_from(std::fs::read(&self.private_key_der)?)
            .map_err(|_| anyhow::anyhow!("TLS private key format"))?;
        Ok((root, certificate, private))
    }
    fn pin(&self, certificates: Option<&[CertificateDer<'_>]>) -> Result<()> {
        let cert = certificates
            .and_then(|c| c.first())
            .context("mutual TLS certificate required")?;
        ensure!(
            hex::encode(crate::wire::sha256(cert.as_ref())) == self.peer_certificate_sha256,
            "TLS peer role pin mismatch"
        );
        Ok(())
    }
    pub async fn run(self) -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use std::os::unix::fs::PermissionsExt;
        let parent = self.unix_socket.parent().context("socket parent")?;
        ensure!(
            std::fs::symlink_metadata(parent)?.is_dir()
                && std::fs::metadata(parent)?.permissions().mode() & 0o077 == 0,
            "private socket directory required"
        );
        let (roots, cert, key) = self.material()?;
        if self.mode == "server" {
            let verifier =
                rustls::server::WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
            let config = rustls::ServerConfig::builder()
                .with_client_cert_verifier(verifier)
                .with_single_cert(cert, key)?;
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
            let listener = TcpListener::bind(self.listen).await?;
            loop {
                let (stream, _) = listener.accept().await?;
                let acceptor = acceptor.clone();
                let cfg = self.clone();
                tokio::spawn(async move {
                    let run = async {
                        let mut tls = acceptor.accept(stream).await?;
                        cfg.pin(tls.get_ref().1.peer_certificates())?;
                        let mut backend = UnixStream::connect(&cfg.unix_socket).await?;
                        tokio::io::copy_bidirectional(&mut tls, &mut backend).await?;
                        Ok::<_, anyhow::Error>(())
                    };
                    let _ = tokio::time::timeout(Duration::from_secs(35), run).await;
                });
            }
        } else {
            ensure!(self.mode == "client", "TLS bridge mode");
            let config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_client_auth_cert(cert, key)?;
            let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
            let name = ServerName::try_from(self.server_name.clone())?;
            let listener = UnixListener::bind(&self.unix_socket)?;
            std::fs::set_permissions(&self.unix_socket, std::fs::Permissions::from_mode(0o600))?;
            loop {
                let (mut frontend, _) = listener.accept().await?;
                let connector = connector.clone();
                let cfg = self.clone();
                let name = name.clone();
                tokio::spawn(async move {
                    let run = async {
                        let stream = TcpStream::connect(cfg.remote).await?;
                        let mut tls = connector.connect(name, stream).await?;
                        cfg.pin(tls.get_ref().1.peer_certificates())?;
                        tokio::io::copy_bidirectional(&mut frontend, &mut tls).await?;
                        Ok::<_, anyhow::Error>(())
                    };
                    let _ = tokio::time::timeout(Duration::from_secs(35), run).await;
                });
            }
        }
    }
}
