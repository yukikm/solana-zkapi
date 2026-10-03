#!/usr/bin/env python3
"""Prove the unmodified Vault build script rejects invalid fixed keys."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
VAULT = ROOT / "programs/zkapi-vault"
MANIFEST = """[workspace]
[package]
name = "zkapi-key-build-negative-control"
version = "0.1.0"
edition = "2021"
[lib]
path = "lib.rs"
[build-dependencies]
ark-ed-on-bn254 = { version = "=0.5.0", default-features = false }
ark-ec = { version = "=0.5.0", default-features = false }
ark-ff = { version = "=0.5.0", default-features = false }
"""

rows = []
with tempfile.TemporaryDirectory(prefix="zkapi-key-build-rejection-") as directory:
    scratch = Path(directory)
    (scratch / "src").mkdir()
    shutil.copyfile(VAULT / "build.rs", scratch / "build.rs")
    shutil.copyfile(VAULT / "src/key_validation.rs", scratch / "src/key_validation.rs")
    (scratch / "Cargo.toml").write_text(MANIFEST)
    (scratch / "lib.rs").write_text("// The build script must reject this build.\n")
    original = (VAULT / "src/deployment_keys.rs").read_text()
    environment = os.environ.copy()
    environment.setdefault("CARGO_TARGET_DIR", str(VAULT / "target"))
    for role in ("state", "clearance"):
        changed, count = re.subn(
            r"pub const " + role.upper() + r"_KEY: \[u8; 64\] = \[.*?\];",
            "pub const " + role.upper() + "_KEY: [u8; 64] = [0; 64];",
            original,
            flags=re.S,
        )
        assert count == 1
        (scratch / "src/deployment_keys.rs").write_text(changed)
        result = subprocess.run(
            ["cargo", "check", "--manifest-path", str(scratch / "Cargo.toml")],
            capture_output=True,
            text=True,
            env=environment,
        )
        expected = f"invalid {role} deployment signing key: InvalidPoint"
        assert result.returncode != 0 and expected in result.stdout + result.stderr, result.stderr
        rows.append({"role": role, "exit_code": result.returncode, "error": expected})
    assert (VAULT / "src/deployment_keys.rs").read_text() == original
print(json.dumps({
    "build_rs_sha256": hashlib.sha256((VAULT / "build.rs").read_bytes()).hexdigest(),
    "cases": rows,
}, indent=2))
