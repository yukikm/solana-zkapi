use super::*;
use serde_json::json;
use std::time::{Duration, Instant};
const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramPin {
    pub program_file: PathBuf,
    pub sha256: String,
    pub deployment_slot: u64,
    pub authority: Option<String>,
    pub programdata_len: usize,
}
pub struct IdentityGuard {
    rpc: StateRpc,
    program: String,
    genesis: String,
    programdata: String,
    pin: ProgramPin,
    elf: Vec<u8>,
    checked: Option<Instant>,
    verified: bool,
    fenced: bool,
}
impl IdentityGuard {
    pub fn new(rpc: StateRpc, program: String, genesis: String, pin: ProgramPin) -> Result<Self> {
        let elf = std::fs::read(&pin.program_file)?;
        if !pin.program_file.is_absolute()
            || !elf.starts_with(b"\x7fELF")
            || hex::encode(crate::sha(&elf)) != pin.sha256
            || pin.programdata_len < 45 + elf.len()
            || pin.programdata_len > 16 * 1024 * 1024
        {
            return Err("program build pin".into());
        }
        key(&genesis)?;
        if let Some(a) = &pin.authority {
            key(a)?;
        }
        let programdata = bs58::encode(pda(&key(LOADER)?, &[&key(&program)?]).0).into_string();
        Ok(Self {
            rpc,
            program,
            genesis,
            programdata,
            pin,
            elf,
            checked: None,
            verified: false,
            fenced: false,
        })
    }
    pub fn healthy(&self) -> bool {
        self.verified
            && !self.fenced
            && self
                .checked
                .is_some_and(|at| at.elapsed() <= Duration::from_secs(70))
    }
    pub async fn ensure(&mut self, minimum: u64, max_age: Duration) -> Result<()> {
        if self.fenced {
            return Err("program identity fenced".into());
        }
        if self.verified && self.checked.is_some_and(|at| at.elapsed() < max_age) {
            return Ok(());
        }
        if !self.verified && self.rpc.call("getGenesisHash", json!([])).await? != self.genesis {
            self.fenced = true;
            return Err("genesis identity mismatch".into());
        }
        let full = !self.verified;
        let mut options =
            json!({"commitment":"finalized","encoding":"base64","minContextSlot":minimum});
        if !full {
            options["dataSlice"] = json!({"offset":0,"length":45});
        }
        let result = self
            .rpc
            .call(
                "getMultipleAccounts",
                json!([[self.program, self.programdata], options]),
            )
            .await?;
        // Transport failure may recover. An observed identity mismatch latches.
        let checked = self.validate(&result, minimum, full);
        if checked.is_err() {
            self.fenced = true;
            return checked;
        }
        self.verified = true;
        self.checked = Some(Instant::now());
        Ok(())
    }
    fn validate(&self, result: &Value, minimum: u64, full: bool) -> Result<()> {
        if result["context"]["slot"]
            .as_u64()
            .is_none_or(|s| s < minimum)
            || result["value"].as_array().is_none_or(|v| v.len() != 2)
        {
            return Err("program identity context".into());
        }
        let p = bytes(&result["value"][0], LOADER, true)?;
        let d = bytes(&result["value"][1], LOADER, false)?;
        if p.len() != 36
            || p[..4] != 2u32.to_le_bytes()
            || p[4..] != key(&self.programdata)?
            || result["value"][0]["space"].as_u64() != Some(36)
            || result["value"][1]["space"].as_u64() != Some(self.pin.programdata_len as u64)
            || d.len() != if full { self.pin.programdata_len } else { 45 }
            || d[..4] != 3u32.to_le_bytes()
            || u64_at(&d, 4)? != self.pin.deployment_slot
        {
            return Err("program identity changed".into());
        }
        match &self.pin.authority {
            Some(a) if d[12] == 1 && d[13..45] == key(a)? => (),
            None if d[12] == 0 => (),
            _ => return Err("program authority changed".into()),
        }
        if full
            && (d[45..45 + self.elf.len()] != self.elf
                || d[45 + self.elf.len()..].iter().any(|b| *b != 0))
        {
            return Err("deployed ELF mismatch".into());
        }
        Ok(())
    }
}
