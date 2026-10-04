use std::io::{Read, Write};
fn main() {
    let result = (|| -> anyhow::Result<()> {
        let mut input = Vec::new();
        std::io::stdin()
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut input)?;
        anyhow::ensure!(input.len() <= 64 * 1024 * 1024, "input bound");
        let result = zkapi_client_prover::run(&input)?;
        std::io::stdout().write_all(&result)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::io::stderr().write_all(b"offline prover rejected\n");
        std::process::exit(1);
    }
}
