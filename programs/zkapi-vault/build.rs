#[path = "src/deployment_keys.rs"]
mod deployment_keys;
#[path = "src/key_validation.rs"]
mod key_validation;

fn main() {
    println!("cargo:rerun-if-changed=src/deployment_keys.rs");
    println!("cargo:rerun-if-changed=src/key_validation.rs");
    for (role, key) in [
        ("state", &deployment_keys::STATE_KEY),
        ("clearance", &deployment_keys::CLEARANCE_KEY),
    ] {
        key_validation::validate(key)
            .unwrap_or_else(|error| panic!("invalid {role} deployment signing key: {error:?}"));
    }
}
