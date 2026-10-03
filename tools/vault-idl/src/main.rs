//! Generate the Vault IDL using Anchor's compiler-backed IDL builder.
use anchor_lang::{Discriminator, IdlBuild};
use anchor_lang_idl::types::{Idl, IdlAccount};
use std::{env, fs, path::PathBuf};

fn account<T: IdlBuild + Discriminator>(idl: &mut Idl) {
    // Accounts initialized/validated manually are UncheckedAccount in contexts,
    // so Anchor's instruction walker cannot discover their state schemas.
    // Obtain them from the exact same #[account] derive, never a copied schema.
    let mut ty = T::create_type().expect("account has a compiler-generated schema");
    ty.name = ty.name.rsplit("::").next().unwrap().to_owned();
    assert!(idl.accounts.iter().all(|a| a.name != ty.name));
    idl.accounts.push(IdlAccount {
        name: ty.name.clone(),
        discriminator: T::DISCRIMINATOR.to_vec(),
    });
    idl.types.push(ty);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let output = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("docs/contracts/zkapi_vault.json"));
    // The program's cwd inherits the repository's pinned rust-toolchain.toml.
    // IDL 0.1.4 mistakenly passes the literal "+{toolchain}" when this override
    // is set, so let rustup resolve that file instead of an environment override.
    env::remove_var("RUSTUP_TOOLCHAIN");
    let mut idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(root.join("programs/zkapi-vault"))
        // Anchor's source-parser lint cannot resolve the #[path] modules that
        // reuse the pinned I02 verifier constants. Rust compilation still checks
        // these modules; account validation is covered by the real SBF suite.
        .skip_lint(true)
        .cargo_args(vec!["--locked".into()])
        .build()?;
    account::<zkapi_vault::PoolConfig>(&mut idl);
    account::<zkapi_vault::TreeState>(&mut idl);
    account::<zkapi_vault::Note>(&mut idl);
    account::<zkapi_vault::PendingWithdrawal>(&mut idl);
    account::<zkapi_vault::ExitNullifier>(&mut idl);
    account::<zkapi_vault::PayloadBuffer>(&mut idl);
    idl.accounts.sort_by(|a, b| a.name.cmp(&b.name));
    idl.types.sort_by(|a, b| a.name.cmp(&b.name));
    let mut bytes = serde_json::to_vec_pretty(&idl)?;
    bytes.push(b'\n');
    fs::write(&output, bytes)?;
    println!("Generated {}", output.display());
    Ok(())
}
