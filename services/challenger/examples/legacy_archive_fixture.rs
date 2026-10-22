//! Test-only process harness for retained archive/SBF regressions.
//! Production challengerd continues to require config v2 and current-state journals.
use std::path::Path;
use zkapi_challenger::{runtime, Error, Result};

fn allowed(command: &str, devnet: bool, rpc: &str) -> bool {
    match command {
        // These commands validate pinned inputs and local journals without RPC,
        // DB access, fee-key reads, signing, or sending. Synthetic Devnet build
        // pins remain covered by the offline launcher fixture.
        "init" | "status" => true,
        "once" | "recover" if !devnet => reqwest::Url::parse(rpc).is_ok_and(|url| {
            url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url.host_str().is_some_and(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
                })
        }),
        _ => false,
    }
}

async fn run(args: &[String]) -> Result<()> {
    if args.len() != 3 {
        return Err(Error::Evidence("archive fixture arguments"));
    }
    let config = runtime::read_config(Path::new(&args[2]))?;
    if !allowed(&args[1], config.devnet.is_some(), &config.rpc_url) {
        return Err(Error::Evidence("archive fixture command or RPC scope"));
    }
    runtime::run(config, &args[1]).await
}

#[tokio::main]
async fn main() {
    if run(&std::env::args().collect::<Vec<_>>()).await.is_err() {
        eprintln!("local archive fixture rejected configuration or recovery");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn offline_commands_allow_synthetic_devnet_pin_validation() {
        for command in ["init", "status"] {
            assert!(allowed(command, true, "https://primary.invalid"));
            assert!(allowed(command, false, "http://127.0.0.1:1234"));
        }
    }

    #[test]
    fn transport_commands_require_local_numeric_loopback_fixtures() {
        for command in ["once", "recover"] {
            for rpc in ["http://127.0.0.1:1234", "http://[::1]:1234"] {
                assert!(allowed(command, false, rpc));
                assert!(!allowed(command, true, rpc));
            }
            for rpc in [
                "https://api.devnet.solana.com",
                "http://192.0.2.1:1234",
                "http://localhost:1234",
                "http://user:pass@127.0.0.1:1234",
                "http://127.0.0.1:1234/#fragment",
            ] {
                assert!(!allowed(command, false, rpc));
            }
        }
    }

    #[test]
    fn fixture_harness_has_no_general_daemon_or_migration_commands() {
        for command in ["run", "scan", "prove", "cleanup", "migrate-archive"] {
            assert!(!allowed(command, false, "http://127.0.0.1:1234"));
        }
    }
}
