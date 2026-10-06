mod build_profile;
#[path = "src/deployment_keys.rs"]
mod deployment_keys;
#[path = "src/key_validation.rs"]
mod key_validation;
#[path = "src/profile.rs"]
mod legacy_profile;

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
    for name in [
        "ZKAPI_DEVNET_PROGRAM_ID",
        "ZKAPI_DEVNET_INITIALIZER",
        "ZKAPI_PUBLIC_DEVNET_PROFILE",
        "ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256",
        "ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES",
    ] {
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
        match std::env::var_os("ZKAPI_PUBLIC_DEVNET_PROFILE") {
            Some(directory) => {
                assert!(
                    std::env::var_os("ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES").is_none(),
                    "public and legacy devnet profiles are mutually exclusive"
                );
                let expected = std::env::var("ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256")
                    .expect("independent public profile SHA256 required");
                build_profile::generate(std::path::Path::new(&directory), &expected, &output);
            }
            None => {
                assert_eq!(
                    std::env::var("ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES").as_deref(),
                    Ok("1"),
                    "devnet requires a fresh public profile or explicit legacy fixture opt-in"
                );
                assert!(
                    std::env::var_os("ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256").is_none(),
                    "profile hash without profile directory"
                );
                for (source, target) in [
                    ("src/deployment_keys.rs", "selected_deployment_keys.rs"),
                    ("src/profile.rs", "selected_profile.rs"),
                    ("../i02-harness/src/tree_vk.rs", "selected_tree_vk.rs"),
                ] {
                    println!("cargo:rerun-if-changed={source}");
                    // Strip module-level doc comments because the source is included inside a module.
                    let data = std::fs::read_to_string(source)
                        .expect("legacy fixture source")
                        .lines()
                        .map(|line| {
                            line.strip_prefix("//!")
                                .map_or(line.to_owned(), |rest| format!("//{rest}"))
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    std::fs::write(output.join(target), data).expect("legacy fixture output");
                }
            }
        }
        std::fs::write(
            output.join("devnet_pins.rs"),
            format!(
                "declare_id!(\"{program}\");\npub const DEPLOYMENT_AUTHORITY: Pubkey = Pubkey::new_from_array({initializer:?});\n"
            ),
        )
        .expect("write public devnet pins");
    }
}
