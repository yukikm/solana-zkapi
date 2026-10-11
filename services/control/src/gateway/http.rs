//! Exact HTTP/1.1 request target and ordered octet fields over a fresh socket.
//! No URL join, redirects, automatic decompression, connection pool or retry.
use super::*;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}
type Reader = BufReader<Box<dyn Socket>>;

async fn line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
    idle: Duration,
) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    loop {
        let bytes = tokio::time::timeout(idle, reader.fill_buf()).await??;
        ensure!(!bytes.is_empty(), "truncated HTTP framing");
        let take = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(bytes.len());
        ensure!(result.len() + take <= limit, "HTTP line limit");
        let done = bytes[take - 1] == b'\n';
        result.extend_from_slice(&bytes[..take]);
        reader.consume(take);
        if done {
            ensure!(result.ends_with(b"\r\n"), "HTTP line ending");
            result.truncate(result.len() - 2);
            return Ok(result);
        }
    }
}
async fn fields(reader: &mut Reader, api: &ApiBindingV2, idle: Duration) -> Result<HeaderPairs> {
    let mut pairs = Vec::new();
    let mut total = 0usize;
    let limit = number(&api.limits.header_bytes)?;
    loop {
        let bytes = line(reader, limit + 2, idle).await?;
        if bytes.is_empty() {
            break;
        }
        total += bytes.len();
        ensure!(
            total <= limit && pairs.len() < number(&api.limits.header_pairs)?,
            "HTTP header limits"
        );
        let colon = bytes
            .iter()
            .position(|b| *b == b':')
            .context("HTTP header syntax")?;
        let name = std::str::from_utf8(&bytes[..colon])?.to_ascii_lowercase();
        ensure!(header_token(&name), "HTTP field name");
        let value = encode_value(trimmed(&bytes[colon + 1..]));
        decode_value(&value)?;
        pairs.push((name, value));
    }
    check_headers(&pairs, api)?;
    Ok(pairs)
}
fn tokens(headers: &HeaderPairs, field: &str) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for (_, value) in headers.iter().filter(|p| p.0 == field) {
        let bytes = decode_value(value)?;
        for part in std::str::from_utf8(&bytes)?.split(',') {
            let name = part.trim().to_ascii_lowercase();
            ensure!(header_token(&name), "HTTP token list");
            names.push(name);
        }
    }
    Ok(names)
}
fn response_headers(
    headers: &HeaderPairs,
    api: &ApiBindingV2,
    metadata_length: bool,
) -> Result<HeaderPairs> {
    let connection = tokens(headers, "connection")?;
    let mut result = Vec::new();
    for (name, value) in headers {
        let strip = (reserved(name) && !(metadata_length && name == "content-length"))
            || connection.contains(name)
            || api.headers.response_reject.contains(name)
            || wire::response_control_header(name);
        if !strip {
            result.push((name.clone(), value.clone()));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
impl HttpAdapter {
    async fn socket(&self) -> Result<Box<dyn Socket>> {
        let origin = reqwest::Url::parse(&self.config.api.origin)?;
        let host = origin
            .host_str()
            .context("origin host")?
            .trim_matches(['[', ']']);
        let port = origin.port_or_known_default().context("origin port")?;
        let addresses: Vec<_> = tokio::net::lookup_host((host, port)).await?.collect();
        ensure!(
            !addresses.is_empty()
                && addresses.iter().all(|a| if self.local {
                    a.ip().is_loopback()
                } else {
                    crate::proxy::public_ip(a.ip())
                }),
            "origin DNS policy"
        );
        // Exactly one connect attempt. DNS is checked again for every dispatch.
        let socket = tokio::net::TcpStream::connect(addresses[0]).await?;
        socket.set_nodelay(true)?;
        if origin.scheme() == "http" {
            ensure!(self.local, "plaintext forbidden");
            return Ok(Box::new(socket));
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let name = rustls::pki_types::ServerName::try_from(host.to_owned())?;
        Ok(Box::new(connector.connect(name, socket).await?))
    }
    pub(super) async fn dispatch_inner(
        &self,
        request: PreparedRequest,
        relay: &mut Option<mpsc::Sender<Vec<u8>>>,
        observation: &mut Observation,
    ) -> Result<()> {
        ensure!(request.api == self.config.api, "gateway immutable config");
        let api = &self.config.api;
        let idle = Duration::from_secs(wire::uint(&api.limits.idle_seconds)?);
        let header_time = Duration::from_secs(wire::uint(&api.limits.header_seconds)?);
        let (mut reader, status, headers) = tokio::time::timeout(header_time, async {
            let mut socket = self.socket().await?;
            let authority = api.origin.split_once("://").context("origin authority")?.1;
            let mut bytes = format!(
                "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
                request.metadata.method,
                request.metadata.target,
                authority,
                request.body.len()
            )
            .into_bytes();
            let mut headers = request.metadata.headers.clone();
            headers.extend(api.headers.static_request.clone());
            let auth = serde_json::to_value(&api.authentication)?;
            match auth["scheme"].as_str().context("auth scheme")? {
                "none" => {}
                "bearer" => headers.push((
                    "authorization".into(),
                    encode_value(
                        format!("Bearer {}", self.credential.as_ref().context("credential")?)
                            .as_bytes(),
                    ),
                )),
                "api_key_header" => headers.push((
                    auth["header"].as_str().context("auth header")?.into(),
                    encode_value(self.credential.as_ref().context("credential")?.as_bytes()),
                )),
                "basic" => {
                    let secret: serde_json::Value =
                        serde_json::from_str(self.credential.as_ref().context("credential")?)?;
                    let raw = format!(
                        "{}:{}",
                        secret["username"].as_str().context("username")?,
                        secret["password"].as_str().context("password")?
                    );
                    headers.push((
                        "authorization".into(),
                        encode_value(format!("Basic {}", STANDARD.encode(raw)).as_bytes()),
                    ));
                }
                _ => anyhow::bail!("authentication adapter"),
            }
            for (name, value) in headers {
                bytes.extend_from_slice(name.as_bytes());
                bytes.extend_from_slice(b": ");
                bytes.extend_from_slice(&decode_value(&value)?);
                bytes.extend_from_slice(b"\r\n");
            }
            bytes.extend_from_slice(b"\r\n");
            socket.write_all(&bytes).await?;
            socket.write_all(&request.body).await?;
            socket.flush().await?;
            let mut reader = BufReader::with_capacity(8192, socket);
            // The enclosing deadline includes every informational response. Keep
            // interim work bounded as well; only the final response is relayed.
            for _ in 0..=16 {
                let first = line(&mut reader, 8192, idle).await?;
                let text = std::str::from_utf8(&first)?;
                ensure!(
                    text.starts_with("HTTP/1.1 ") || text.starts_with("HTTP/1.0 "),
                    "HTTP version"
                );
                let fields = text.splitn(3, ' ').collect::<Vec<_>>();
                let code = fields.get(1).context("HTTP status")?;
                ensure!(
                    code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit()),
                    "HTTP status syntax"
                );
                let status: u16 = code.parse()?;
                ensure!(
                    (100..=599).contains(&status) && status != 101,
                    "HTTP status range or unsupported upgrade"
                );
                let headers = fields_headers(&mut reader, api, idle).await?;
                if status >= 200 {
                    return Ok::<_, anyhow::Error>((reader, status, headers));
                }
                ensure!(
                    header(&headers, "content-length")?.is_none()
                        && tokens(&headers, "transfer-encoding")?.is_empty()
                        && tokens(&headers, "trailer")?.is_empty(),
                    "informational response framing"
                );
            }
            anyhow::bail!("informational response limit")
        })
        .await??;
        observation.http_status = Some(status);
        let no_body = request.metadata.method == "HEAD" || matches!(status, 204 | 205 | 304);
        let length = header(&headers, "content-length")?
            .map(|v| -> Result<usize> {
                let text = std::str::from_utf8(&v)?;
                ensure!(
                    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
                    "content length"
                );
                Ok(text.parse()?)
            })
            .transpose()?;
        let transfer = tokens(&headers, "transfer-encoding")?;
        ensure!(
            transfer.is_empty() || transfer == ["chunked"],
            "transfer encoding"
        );
        ensure!(
            transfer.is_empty() || length.is_none(),
            "ambiguous response length"
        );
        if matches!(status, 204 | 205) {
            ensure!(length.is_none_or(|n| n == 0), "body forbidden status");
        }
        let declared = tokens(&headers, "trailer")?;
        ensure!(
            declared.iter().all(|n| api.headers.trailers.contains(n))
                && api.headers.trailers.iter().all(|n| declared.contains(n))
                && declared
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == declared.len()
                && (declared.is_empty() || transfer == ["chunked"]),
            "undeclared response trailer"
        );
        let encoding = header(&headers, "content-encoding")?
            .map(String::from_utf8)
            .transpose()?
            .unwrap_or("identity".into());
        ensure!(
            api.representation.response_encodings.contains(&encoding),
            "response encoding policy"
        );
        check_media(
            &headers,
            &api.representation.response_media_types,
            no_body || length == Some(0),
        )?;
        let response_headers = response_headers(
            &headers,
            api,
            request.metadata.method == "HEAD" || status == 304,
        )?;
        emit(
            relay,
            frame(
                1,
                &serde_jcs::to_vec(
                    &serde_json::json!({"status":status,"headers":response_headers}),
                )?,
            ),
        )
        .await;
        let observed_raw = Arc::new(AtomicUsize::new(0));
        let mut shadow = None;
        let mut task = None;
        if api.meter.adapter.id != "fixed_http" {
            let (writer, reader) = tokio::io::duplex(number(&api.limits.relay_buffer_bytes)?);
            shadow = Some(writer);
            let api = api.clone();
            let count = observed_raw.clone();
            let sse = header(&headers, "content-type")?.is_some_and(|v| {
                std::str::from_utf8(&v).is_ok_and(|s| {
                    s.split(';')
                        .next()
                        .unwrap()
                        .trim()
                        .eq_ignore_ascii_case("text/event-stream")
                })
            });
            task = Some(tokio::spawn(async move {
                meter::observe(reader, &api, &encoding, sse, count).await
            }));
        }
        let chunk_limit = 65536.min(number(&api.limits.relay_buffer_bytes)?);
        let mut buffer = vec![0u8; chunk_limit];
        let mut aggregate = 0usize;

        if no_body && request.metadata.method != "HEAD" && status != 304 && !transfer.is_empty() {
            let chunk = line(&mut reader, 8192, idle).await?;
            ensure!(chunk == b"0", "forbidden response data");
            let trailer = fields(&mut reader, api, idle).await?;
            ensure!(
                trailer.is_empty() && declared.is_empty(),
                "forbidden response trailer"
            );
        } else if !no_body {
            let mut remaining = length;
            loop {
                let chunked = !transfer.is_empty();
                let mut chunk_remaining = if chunked {
                    let bytes = line(&mut reader, 8192, idle).await?;
                    let token = std::str::from_utf8(&bytes)?
                        .split(';')
                        .next()
                        .context("chunk length")?;
                    ensure!(
                        !token.is_empty() && token.bytes().all(|b| b.is_ascii_hexdigit()),
                        "chunk length"
                    );
                    usize::from_str_radix(token, 16)?
                } else {
                    remaining.unwrap_or(usize::MAX)
                };
                if chunked && chunk_remaining == 0 {
                    let trailers = fields(&mut reader, api, idle).await?;
                    ensure!(
                        trailers.iter().all(|p| declared.contains(&p.0))
                            && declared.iter().all(|n| trailers.iter().any(|p| &p.0 == n)),
                        "trailer completion"
                    );
                    if !trailers.is_empty() {
                        emit(
                            relay,
                            frame(
                                3,
                                &serde_jcs::to_vec(&serde_json::json!({"headers":trailers}))?,
                            ),
                        )
                        .await;
                    }
                    break;
                }
                if chunk_remaining == 0 {
                    break;
                }
                loop {
                    let capacity = buffer.len().min(chunk_remaining);
                    let read =
                        tokio::time::timeout(idle, reader.read(&mut buffer[..capacity])).await??;
                    if read == 0 {
                        ensure!(!chunked && remaining.is_none(), "truncated response body");
                        break;
                    }
                    aggregate = aggregate.checked_add(read).context("response size")?;
                    ensure!(
                        aggregate <= number(&api.limits.response_bytes)?,
                        "response byte limit"
                    );
                    observed_raw.store(aggregate, Ordering::Relaxed);
                    if let Some(writer) = shadow.as_mut() {
                        if writer.write_all(&buffer[..read]).await.is_err() {
                            shadow = None;
                        }
                    }
                    emit(relay, frame(2, &buffer[..read])).await;
                    chunk_remaining -= read;
                    if let Some(n) = &mut remaining {
                        *n -= read;
                    }
                    if chunk_remaining == 0 {
                        break;
                    }
                }
                if chunked {
                    let mut crlf = [0; 2];
                    tokio::time::timeout(idle, reader.read_exact(&mut crlf)).await??;
                    ensure!(crlf == *b"\r\n", "chunk terminator");
                } else {
                    break;
                }
            }
        } else {
            ensure!(declared.is_empty(), "bodyless trailers");
        }
        drop(shadow);
        // Carrier completeness is independent of accounting completeness.
        emit(relay, frame(4, &[])).await;
        let mut satisfied = api.completion.billable_statuses.contains(&status);
        let usage = if let Some(task) = task {
            match task.await {
                Ok(Ok(measured)) => {
                    satisfied &= measured.succeeded;
                    measured.usage
                }
                _ => return Ok(()),
            }
        } else {
            vec![Usage {
                unit: "requests".into(),
                count: if satisfied { "1" } else { "0" }.into(),
            }]
        };
        observation.evidence_digest = Some(digest(
            &serde_json::json!({"status":status,"usage":usage,"completion":satisfied}),
        )?);
        observation.usage = Some(usage);
        observation.completion = Some(crate::receipts::CompletionEvidence {
            rule_hash: digest(&api.completion)?,
            outcome: if satisfied {
                "satisfied"
            } else {
                "not_satisfied"
            }
            .into(),
            http_status: status,
        });
        Ok(())
    }
}
async fn fields_headers(
    reader: &mut Reader,
    api: &ApiBindingV2,
    idle: Duration,
) -> Result<HeaderPairs> {
    fields(reader, api, idle).await
}
