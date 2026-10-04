use std::io::{Read, Write};
fn main() {
    // Private witness material is accepted on stdin only, never argv or logs.
    let result = (|| -> anyhow::Result<()> {
        let mut input = Vec::new();
        std::io::stdin()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut input)?;
        anyhow::ensure!(input.len() <= 4 * 1024 * 1024, "input bound");
        let command = serde_json::from_slice(&input)?;
        let value = zkapi_client_verify::execute(command)?;
        serde_json::to_writer(std::io::stdout().lock(), &value)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::io::stderr().write_all(b"client verification rejected\n");
        std::process::exit(1);
    }
}
