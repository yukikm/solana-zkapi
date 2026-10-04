//! Known-entropy envelope and certificate fixtures, only for local acceptance.
use anyhow::{ensure, Result};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use zkapi_control::{
    custody::{Config, Envelope},
    signer::SignerConfig,
    wire,
};
fn private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}
pub fn envelopes(dir: &Path, signer: &SignerConfig) -> Result<()> {
    let helper = dir.join("local-kms");
    private(&helper,b"#!/usr/bin/python3\nimport json,sys\nr=json.load(sys.stdin)\nassert r['operation']=='unwrap_aes256_key' and r['key_ref']=='local-test-only' and r['encryption_context']['role'] in ('state','clearance')\nsys.stdout.buffer.write(bytes([73])*32)\n")?;
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700))?;
    let mut config = Config {
        helper_sha256: hex::encode(wire::sha256(&std::fs::read(&helper)?)),
        helper,
        deployment: signer.authorization.deployment_id.clone(),
        pool: signer.pool,
        envelopes: Default::default(),
    };
    for (role, value, nonce) in [("state", 31, 3u8), ("clearance", 37, 4)] {
        let mut envelope = Envelope {
            version: 1,
            deployment: config.deployment.clone(),
            pool: config.pool,
            role: role.into(),
            kms_key_ref: "local-test-only".into(),
            wrapped_data_key: "fixture-wrapped-data-key".into(),
            nonce_hex: hex::encode([nonce; 12]),
            ciphertext_hex: String::new(),
        };
        let key = ring::aead::LessSafeKey::new(
            ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, &[73; 32]).unwrap(),
        );
        let mut bytes = zkapi_types::Felt252::from_u64(value).0.to_vec();
        key.seal_in_place_append_tag(
            ring::aead::Nonce::assume_unique_for_key([nonce; 12]),
            ring::aead::Aad::from(envelope.aad()?),
            &mut bytes,
        )
        .unwrap();
        envelope.ciphertext_hex = hex::encode(bytes);
        let path = dir.join(format!("{role}.envelope"));
        private(&path, &serde_json::to_vec(&envelope)?)?;
        config.envelopes.insert(role.into(), path);
        std::fs::remove_file(dir.join(format!("{role}.seed")))?;
    }
    private(&dir.join("custody.json"), &serde_json::to_vec(&config)?)
}
pub async fn tls(
    dir: &Path,
    backend: PathBuf,
) -> Result<(PathBuf, Vec<tokio::task::JoinHandle<()>>)> {
    let run = |args: Vec<String>| -> Result<()> {
        ensure!(
            std::process::Command::new("openssl")
                .args(args)
                .current_dir(dir)
                .output()?
                .status
                .success(),
            "certificate fixture failed"
        );
        Ok(())
    };
    run([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-subj",
        "/CN=I09-fixture-ca",
        "-days",
        "1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect())?;
    for name in ["server", "client"] {
        run(vec![
            "req".into(),
            "-newkey".into(),
            "rsa:2048".into(),
            "-nodes".into(),
            "-keyout".into(),
            format!("{name}.key"),
            "-out".into(),
            format!("{name}.csr"),
            "-subj".into(),
            format!("/CN={name}"),
        ])?;
        std::fs::write(
            dir.join("extensions"),
            "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth,clientAuth\n",
        )?;
        run(vec![
            "x509".into(),
            "-req".into(),
            "-in".into(),
            format!("{name}.csr"),
            "-CA".into(),
            "ca.pem".into(),
            "-CAkey".into(),
            "ca.key".into(),
            "-CAcreateserial".into(),
            "-out".into(),
            format!("{name}.pem"),
            "-days".into(),
            "1".into(),
            "-extfile".into(),
            "extensions".into(),
        ])?;
        run(vec![
            "x509".into(),
            "-in".into(),
            format!("{name}.pem"),
            "-outform".into(),
            "DER".into(),
            "-out".into(),
            format!("{name}.der"),
        ])?;
        run(vec![
            "pkcs8".into(),
            "-topk8".into(),
            "-nocrypt".into(),
            "-in".into(),
            format!("{name}.key"),
            "-outform".into(),
            "DER".into(),
            "-out".into(),
            format!("{name}-key.der"),
        ])?;
        std::fs::set_permissions(
            dir.join(format!("{name}-key.der")),
            std::fs::Permissions::from_mode(0o600),
        )?;
    }
    run(
        ["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
    )?;
    let reserve = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = reserve.local_addr()?;
    drop(reserve);
    let pin = |name: &str| -> Result<String> {
        Ok(hex::encode(wire::sha256(&std::fs::read(
            dir.join(format!("{name}.der")),
        )?)))
    };
    let server = zkapi_control::mtls::Config {
        mode: "server".into(),
        listen: address,
        remote: address,
        server_name: "localhost".into(),
        unix_socket: backend,
        ca_der: dir.join("ca.der"),
        certificate_der: dir.join("server.der"),
        private_key_der: dir.join("server-key.der"),
        peer_certificate_sha256: pin("client")?,
    };
    let mut client = server.clone();
    client.mode = "client".into();
    client.unix_socket = dir.join("mtls-signer.sock");
    client.certificate_der = dir.join("client.der");
    client.private_key_der = dir.join("client-key.der");
    client.peer_certificate_sha256 = pin("server")?;
    let socket = client.unix_socket.clone();
    let tasks = vec![
        tokio::spawn(async move {
            server.run().await.unwrap();
        }),
        tokio::spawn(async move {
            client.run().await.unwrap();
        }),
    ];
    for _ in 0..100 {
        if socket.exists() {
            return Ok((socket, tasks));
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    anyhow::bail!("TLS bridge startup timeout")
}
