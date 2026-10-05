#[path = "src/deployment_keys.rs"]
mod deployment_keys;
#[path = "src/key_validation.rs"]
mod key_validation;

fn public_pin(name: &str) -> (String, [u8; 32]) {
    let text = std::env::var(name)
        .unwrap_or_else(|_| panic!("devnet requires the public build pin {name}"));
    let bytes: [u8; 32] = bs58::decode(&text)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .filter(|bytes: &[u8; 32]| *bytes != [0; 32] && bs58::encode(bytes).into_string() == text)
        .unwrap_or_else(|| panic!("{name} must be a canonical nonzero base58 public key"));
    (text, bytes)
}

fn main() {
    println!("cargo:rerun-if-changed=src/deployment_keys.rs");
    println!("cargo:rerun-if-changed=src/key_validation.rs");
    for name in ["ZKAPI_DEVNET_PROGRAM_ID", "ZKAPI_DEVNET_INITIALIZER"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    for (role, key) in [
        ("state", &deployment_keys::STATE_KEY),
        ("clearance", &deployment_keys::CLEARANCE_KEY),
    ] {
        key_validation::validate(key)
            .unwrap_or_else(|error| panic!("invalid {role} deployment signing key: {error:?}"));
    }
    if std::env::var_os("CARGO_FEATURE_DEVNET").is_some()
        && std::env::var_os("CARGO_FEATURE_LOCAL_TEST").is_none()
    {
        // Public addresses only: no key files or runtime secrets enter the build.
        // Anchor's IDL printer requires the declare_id! argument to be a literal.
        let (program, _) = public_pin("ZKAPI_DEVNET_PROGRAM_ID");
        let (_, initializer) = public_pin("ZKAPI_DEVNET_INITIALIZER");
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
        std::fs::write(
            output.join("devnet_pins.rs"),
            format!(
                "declare_id!(\"{program}\");\npub const DEPLOYMENT_AUTHORITY: Pubkey = Pubkey::new_from_array({initializer:?});\n"
            ),
        )
        .expect("write public devnet pins");
    }
}
