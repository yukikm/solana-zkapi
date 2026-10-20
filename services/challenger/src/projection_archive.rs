//! Offline candidate A artifact. No RPC, repository, journal writer or signing
//! interface is constructed here. This format is deliberately not a live archive.
use crate::{bad, journal::ReadOnlyArchive, scan::Scanner, sha, Error, Hash, Result, Trust};
use flate2::{bufread::GzDecoder, write::GzEncoder, Compression};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zkapi_indexer::{projection::ProjectedBlock, FinalizedBlock};

const VERSION: u32 = 1;
const RULES: u32 = 1;
const MAX_INPUT: u64 = 64 * 1024 * 1024;
const MAX_CHUNK: u64 = 32 * 1024 * 1024;
const MAX_MANIFEST: u64 = 16 * 1024 * 1024;
const RESERVE: u64 = 2 * 1024 * 1024 * 1024 + 32 * 1024 * 1024;
const GZIP_LEVEL: u32 = 6;
const MANIFEST: &str = "manifest.json";
const PREPARED: &str = "manifest.prepared.json";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub manifest: PathBuf,
    pub manifest_sha256: String,
    #[serde(default)]
    pub devnet: Option<zkapi_control::config::DevnetConfig>,
    pub start_slot: u64,
    pub source: Source,
    pub output_directory: PathBuf,
    /// Complete projected artifact budget, including its manifest. This is not
    /// permission to consume the source filesystem's recovery headroom.
    pub max_output_bytes: u64,
    #[serde(default = "default_blocks")]
    pub chunk_blocks: usize,
    #[serde(default = "default_bytes")]
    pub chunk_bytes: u64,
}
fn default_blocks() -> usize {
    64
}
fn default_bytes() -> u64 {
    8 * 1024 * 1024
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Source {
    ArchiveV2 {
        directory: PathBuf,
    },
    /// Existing local SBF output: raw RPC-shaped blocks are decoded with the
    /// existing full decoder. Its finality is synthetic, never public Devnet.
    SbfFixture {
        path: PathBuf,
        scenario: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub format: String,
    pub version: u32,
    pub rules_version: u32,
    pub genesis: String,
    pub program: String,
    pub pool: Hash,
    pub manifest_sha256: Hash,
    pub validator_sha256: Hash,
    pub start_slot: u64,
    pub source_kind: String,
    pub source_sha256: Hash,
    pub source_blocks: u64,
    pub first_slot: u64,
    pub tail_slot: u64,
    pub tail_blockhash: Hash,
    pub chunk_blocks: usize,
    pub chunk_bytes: u64,
    pub gzip_level: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Counters {
    pub blocks: u64,
    pub original_transactions: u64,
    pub selected_transactions: u64,
    pub full_decoded_bytes: u64,
    /// Both byte measurements use the same segment envelope and boundaries.
    /// They are estimates for this candidate format, not the existing v2 bytes.
    pub full_equivalent_gzip_bytes: u64,
    pub projected_gzip_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SegmentRef {
    pub sha256: Hash,
    pub sequence: u64,
    pub blocks: u64,
    pub first_slot: u64,
    pub last_slot: u64,
    pub gzip_bytes: u64,
    pub decoded_bytes: u64,
    pub full_equivalent_gzip_bytes: u64,
    pub semantic_sha256: Hash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub binding: Binding,
    pub binding_sha256: Hash,
    pub counters: Counters,
    pub segments: Vec<SegmentRef>,
    pub semantic_sha256: Hash,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Segment<B> {
    version: u32,
    binding_sha256: Hash,
    sequence: u64,
    previous: Option<Hash>,
    blocks: B,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub format: &'static str,
    pub manifest_sha256: String,
    pub blocks_verified: u64,
    pub original_transactions: u64,
    pub selected_transactions: u64,
    pub full_equivalent_gzip_bytes: u64,
    pub projected_gzip_bytes: u64,
    pub manifest_bytes: u64,
    pub artifact_bytes: u64,
    /// Negative means expansion. Includes manifest overhead in the candidate.
    pub saved_bytes: i128,
    pub semantic_sha256: String,
    pub source_preserved: bool,
    pub live_activation: bool,
}

enum Input {
    Archive(Box<ReadOnlyArchive>),
    Fixture {
        scenario: Value,
        path: PathBuf,
        stamp: [u64; 11],
    },
}
impl Input {
    fn visit(
        &self,
        binding: &Binding,
        mut visit: impl FnMut(&FinalizedBlock) -> Result<()>,
    ) -> Result<()> {
        match self {
            Self::Archive(source) => {
                source.replay_range(binding.first_slot, binding.tail_slot, visit)
            }
            Self::Fixture { scenario, .. } => {
                for row in scenario["blocks"].as_array().ok_or(bad("fixture blocks"))? {
                    if row["finalized"] != true {
                        return Err(bad("fixture unfinalized block"));
                    }
                    let slot = row["slot"].as_u64().ok_or(bad("fixture slot"))?;
                    let block = zkapi_indexer::rpc::decode_finalized_block(slot, &row["block"])
                        .map_err(|_| bad("fixture full block decoder"))?;
                    visit(&block)?;
                }
                Ok(())
            }
        }
    }
}

pub fn run(config_path: &Path) -> Result<Report> {
    let config: Config = read_json(config_path, 1024 * 1024)?;
    export(&config)
}

pub fn export(config: &Config) -> Result<Report> {
    validate_options(config)?;
    let manifest: Value = read_json(&config.manifest, 1024 * 1024)?;
    let pin: Hash = hex::decode(&config.manifest_sha256)
        .map_err(|_| bad("projection manifest pin"))?
        .try_into()
        .map_err(|_| bad("projection manifest pin"))?;
    let trust = match &config.devnet {
        Some(devnet) => Trust::from_pinned_devnet_manifest(&manifest, pin, devnet)?,
        None => Trust::from_pinned_manifest(&manifest, pin)?,
    };
    let validator_sha256 = hash_file(&std::env::current_exe()?)?;
    let mut binding = Binding {
        format: "zkapi-pool-history-shadow".into(),
        version: VERSION,
        rules_version: RULES,
        genesis: trust.pool.genesis_hash.clone(),
        program: trust.pool.program_id.clone(),
        pool: trust.pool(),
        manifest_sha256: pin,
        validator_sha256,
        start_slot: config.start_slot,
        source_kind: String::new(),
        source_sha256: [0; 32],
        source_blocks: 0,
        first_slot: 0,
        tail_slot: 0,
        tail_blockhash: [0; 32],
        chunk_blocks: config.chunk_blocks,
        chunk_bytes: config.chunk_bytes,
        gzip_level: GZIP_LEVEL,
    };
    let (source, input_path) = match &config.source {
        Source::ArchiveV2 { directory } => {
            let source = ReadOnlyArchive::open(directory, trust.pool())?;
            let (first, parent) = source
                .archive_first()
                .ok_or(bad("empty projection source"))?;
            if first < config.start_slot || parent >= config.start_slot {
                return Err(bad("projection requires complete retained start"));
            }
            let tail = source
                .archive_tail()
                .ok_or(bad("empty projection source"))?;
            binding.source_kind = "authenticated_archive_v2".into();
            binding.source_sha256 = source.head_digest()?;
            binding.source_blocks = source.archive_len();
            binding.first_slot = first;
            binding.tail_slot = tail.slot;
            binding.tail_blockhash = tail.blockhash;
            (Input::Archive(Box::new(source)), directory)
        }
        Source::SbfFixture { path, scenario } => {
            let stamp = file_stamp(path)?;
            let bytes = read_bytes(path, MAX_INPUT)?;
            if file_stamp(path)? != stamp {
                return Err(bad("fixture changed during read"));
            }
            let fixture: Value = serde_json::from_slice(&bytes)?;
            let matching: Vec<_> = fixture["scenarios"]
                .as_array()
                .ok_or(bad("fixture scenarios"))?
                .iter()
                .filter(|value| value["name"].as_str() == Some(scenario))
                .collect();
            if matching.len() != 1 {
                return Err(bad("fixture scenario must be unique"));
            }
            let scenario = matching[0];
            let rows = scenario["blocks"].as_array().ok_or(bad("fixture blocks"))?;
            let first = rows.first().ok_or(bad("empty projection source"))?;
            let last = rows.last().ok_or(bad("empty projection source"))?;
            binding.first_slot = first["slot"].as_u64().ok_or(bad("fixture first slot"))?;
            binding.tail_slot = last["slot"].as_u64().ok_or(bad("fixture last slot"))?;
            let first =
                zkapi_indexer::rpc::decode_finalized_block(binding.first_slot, &first["block"])
                    .map_err(|_| bad("fixture first block"))?;
            let last =
                zkapi_indexer::rpc::decode_finalized_block(binding.tail_slot, &last["block"])
                    .map_err(|_| bad("fixture last block"))?;
            if first.slot < config.start_slot || first.parent_slot >= config.start_slot {
                return Err(bad("projection requires complete fixture start"));
            }
            binding.source_kind = format!(
                "synthetic_finality_sbf_fixture:{scenario_name}",
                scenario_name = matching[0]["name"].as_str().unwrap()
            );
            binding.source_sha256 = sha(&bytes);
            binding.source_blocks = rows.len() as u64;
            binding.tail_blockhash = last.blockhash;
            (
                Input::Fixture {
                    scenario: scenario.clone(),
                    path: path.clone(),
                    stamp,
                },
                path,
            )
        }
    };
    // Reject a predictably oversized manifest before creating any output or
    // replaying the captured source. Authentication of the v2 source still
    // precedes this check; its declared block count is never trusted alone.
    preflight_manifest_capacity(
        binding.source_blocks,
        binding.chunk_blocks,
        serde_json::to_vec(&binding)?.len() as u64,
    )?;
    let output = prepare_directory(config, input_path)?;
    let mut writer = Projector::new(&output, config.max_output_bytes, binding, trust.clone())?;
    source.visit(&writer.manifest.binding.clone(), |block| writer.push(block))?;
    let (manifest, full) = writer.finish()?;
    // Independent deserialization, compressed-file hashes, chain and complete
    // projected replay. No exporter buffers/state are reused by this reader.
    let expected = sha(&read_bytes(&output.join(PREPARED), MAX_MANIFEST)?);
    let readback = verify_named(&output, PREPARED, &trust, expected)?;
    if !full.projection_equivalent(&readback)? {
        return Err(bad("projection independent replay differs"));
    }
    // Rechecking a zero-width source range also rechecks every immutable file's
    // identity after readback, while leaving a concurrent newer writer head alone.
    if let Input::Archive(source) = &source {
        source.replay_range(
            manifest.binding.tail_slot,
            manifest.binding.tail_slot,
            |_| Ok(()),
        )?;
    }
    if let Input::Fixture { path, stamp, .. } = &source {
        if file_stamp(path)? != *stamp
            || sha(&read_bytes(path, MAX_INPUT)?) != manifest.binding.source_sha256
            || file_stamp(path)? != *stamp
        {
            return Err(bad("fixture source changed before publication"));
        }
    }
    fs::rename(output.join(PREPARED), output.join(MANIFEST))?;
    File::open(&output)?.sync_all()?;
    let manifest_bytes = fs::metadata(output.join(MANIFEST))?.len();
    let artifact_bytes = manifest.counters.projected_gzip_bytes + manifest_bytes;
    Ok(Report {
        format: "zkapi-pool-history-shadow-v1",
        manifest_sha256: hex::encode(expected),
        blocks_verified: manifest.counters.blocks,
        original_transactions: manifest.counters.original_transactions,
        selected_transactions: manifest.counters.selected_transactions,
        full_equivalent_gzip_bytes: manifest.counters.full_equivalent_gzip_bytes,
        projected_gzip_bytes: manifest.counters.projected_gzip_bytes,
        manifest_bytes,
        artifact_bytes,
        saved_bytes: manifest.counters.full_equivalent_gzip_bytes as i128 - artifact_bytes as i128,
        semantic_sha256: hex::encode(manifest.semantic_sha256),
        source_preserved: true,
        live_activation: false,
    })
}

fn validate_options(config: &Config) -> Result<()> {
    if !(1..=256).contains(&config.chunk_blocks)
        || config.chunk_bytes == 0
        || config.chunk_bytes > MAX_CHUNK
        || config.max_output_bytes == 0
        || config.max_output_bytes > 64 * 1024 * 1024 * 1024
        || !config.output_directory.is_absolute()
    {
        return Err(bad("projection bounds/output path"));
    }
    Ok(())
}
/// Conservative planning check, not a promise that the export fits: the byte
/// threshold may split a block-count chunk further. The incremental actual
/// reference bound remains authoritative. Integer/hash fields use their largest
/// encoded widths rather than assuming the source's average compression ratio.
fn preflight_manifest_capacity(
    source_blocks: u64,
    chunk_blocks: usize,
    binding_bytes: u64,
) -> Result<()> {
    if !(1..=256).contains(&chunk_blocks) {
        return Err(bad("projection chunk block bound"));
    }
    let largest_reference = SegmentRef {
        sha256: [255; 32],
        sequence: u64::MAX,
        blocks: u64::MAX,
        first_slot: u64::MAX,
        last_slot: u64::MAX,
        gzip_bytes: u64::MAX,
        decoded_bytes: u64::MAX,
        full_equivalent_gzip_bytes: u64::MAX,
        semantic_sha256: [255; 32],
    };
    let reference_bytes = serde_json::to_vec(&largest_reference)?.len() as u64 + 1;
    let count = source_blocks.div_ceil(chunk_blocks as u64);
    let planned_bytes = count
        .checked_mul(reference_bytes)
        .and_then(|references| references.checked_add(binding_bytes))
        .and_then(|bytes| bytes.checked_add(4096));
    if planned_bytes.is_none_or(|bytes| bytes > MAX_MANIFEST) {
        return Err(bad(
            "projection manifest preflight exceeds 16 MiB; increase chunk_blocks up to 256",
        ));
    }
    Ok(())
}
fn prepare_directory(config: &Config, source: &Path) -> Result<PathBuf> {
    let parent = config
        .output_directory
        .parent()
        .ok_or(bad("projection output parent"))?
        .canonicalize()?;
    let name = config
        .output_directory
        .file_name()
        .ok_or(bad("projection output name"))?;
    let output = parent.join(name);
    let source = source.canonicalize()?;
    if output.starts_with(&source) || source.starts_with(&output) {
        return Err(bad("projection output overlaps source"));
    }
    if fs2::available_space(&parent)? < config.max_output_bytes.saturating_add(RESERVE) {
        return Err(bad("projection output space reserve"));
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&output)?; // Never reuse, overwrite, resume or prune an output.
    File::open(parent)?.sync_all()?;
    Ok(output)
}

struct Projector<'a> {
    output: &'a Path,
    budget: u64,
    manifest: Manifest,
    full: Scanner,
    shadow: Scanner,
    full_blocks: Vec<FinalizedBlock>,
    projected_blocks: Vec<ProjectedBlock>,
    buffered_bytes: u64,
    manifest_reserved_bytes: u64,
    last_slot: Option<u64>,
}
impl<'a> Projector<'a> {
    fn new(output: &'a Path, budget: u64, binding: Binding, trust: Trust) -> Result<Self> {
        let binding_sha256 = domain_hash(b"ZKAPI-POOL-HISTORY-BINDING-V1\0", &binding)?;
        let manifest_reserved_bytes = 4096 + serde_json::to_vec(&binding)?.len() as u64;
        if manifest_reserved_bytes > MAX_MANIFEST {
            return Err(bad("projection binding bound"));
        }
        Ok(Self {
            output,
            budget,
            manifest: Manifest {
                binding,
                binding_sha256,
                counters: Counters::default(),
                segments: vec![],
                semantic_sha256: [0; 32],
            },
            full: Scanner::new(trust.clone()),
            shadow: Scanner::new(trust),
            full_blocks: vec![],
            projected_blocks: vec![],
            buffered_bytes: 0,
            manifest_reserved_bytes,
            last_slot: None,
        })
    }
    fn push(&mut self, block: &FinalizedBlock) -> Result<()> {
        if self.last_slot.is_some_and(|old| block.slot <= old) {
            return Err(bad("projection duplicate/reordered coverage"));
        }
        let mut size = Counter::default();
        serde_json::to_writer(&mut size, block)?;
        if size.0 > MAX_CHUNK {
            return Err(bad("projection single block exceeds offline bound"));
        }
        if !self.full_blocks.is_empty()
            && (self.full_blocks.len() >= self.manifest.binding.chunk_blocks
                || self.buffered_bytes.saturating_add(size.0) > self.manifest.binding.chunk_bytes)
        {
            self.flush()?;
        }
        let projected = self.full.project_finalized(block)?;
        self.shadow.apply_projected(&projected)?;
        if !self.full.projection_equivalent(&self.shadow)? {
            return Err(bad("projection per-block semantic mismatch"));
        }
        let c = &mut self.manifest.counters;
        c.blocks += 1;
        c.original_transactions += block.transactions.len() as u64;
        c.selected_transactions += projected.transactions.len() as u64;
        c.full_decoded_bytes += size.0;
        self.buffered_bytes += size.0;
        self.full_blocks.push(block.clone());
        self.projected_blocks.push(projected);
        self.last_slot = Some(block.slot);
        Ok(())
    }
    fn flush(&mut self) -> Result<()> {
        if self.full_blocks.is_empty() {
            return Ok(());
        }
        let sequence = self.manifest.segments.len() as u64 + 1;
        let previous = self.manifest.segments.last().map(|r| r.sha256);
        let full = Segment {
            version: VERSION,
            binding_sha256: self.manifest.binding_sha256,
            sequence,
            previous,
            blocks: &self.full_blocks,
        };
        let projected = Segment {
            version: VERSION,
            binding_sha256: self.manifest.binding_sha256,
            sequence,
            previous,
            blocks: &self.projected_blocks,
        };
        let mut full_encoder = GzEncoder::new(Counter::default(), Compression::new(GZIP_LEVEL));
        serde_json::to_writer(&mut full_encoder, &full)?;
        let full_bytes = full_encoder.finish()?.0;
        let mut decoded = Counter::default();
        serde_json::to_writer(&mut decoded, &projected)?;
        if decoded.0 > MAX_CHUNK * 2 {
            return Err(bad("projection segment decoded bound"));
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(GZIP_LEVEL));
        serde_json::to_writer(&mut encoder, &projected)?;
        let bytes = encoder.finish()?;
        let gzip_bytes = bytes.len() as u64;
        let next = self
            .manifest
            .counters
            .projected_gzip_bytes
            .checked_add(gzip_bytes)
            .ok_or(bad("projection output overflow"))?;
        if next > self.budget
            || fs2::available_space(self.output)? < gzip_bytes.saturating_add(RESERVE)
        {
            return Err(bad("projection output budget/space"));
        }
        let digest = sha(&bytes);
        let reference = SegmentRef {
            sha256: digest,
            sequence,
            blocks: self.full_blocks.len() as u64,
            first_slot: self.full_blocks.first().unwrap().slot,
            last_slot: self.full_blocks.last().unwrap().slot,
            gzip_bytes,
            decoded_bytes: decoded.0,
            full_equivalent_gzip_bytes: full_bytes,
            semantic_sha256: self.full.projection_digest()?,
        };
        self.manifest_reserved_bytes += serde_json::to_vec(&reference)?.len() as u64 + 1;
        if self.manifest_reserved_bytes > MAX_MANIFEST {
            return Err(bad("projection manifest reference bound"));
        }
        write_atomic(
            self.output,
            &format!("{}.json.gz", hex::encode(digest)),
            &bytes,
        )?;
        self.manifest.segments.push(reference);
        self.manifest.counters.projected_gzip_bytes = next;
        self.manifest.counters.full_equivalent_gzip_bytes += full_bytes;
        self.full_blocks.clear();
        self.projected_blocks.clear();
        self.buffered_bytes = 0;
        Ok(())
    }
    fn finish(mut self) -> Result<(Manifest, Scanner)> {
        self.flush()?;
        let b = &self.manifest.binding;
        let state = self.full.replay_state()?;
        if self.manifest.counters.blocks != b.source_blocks
            || self.manifest.segments.first().map(|r| r.first_slot) != Some(b.first_slot)
            || state.slot != b.tail_slot
            || state.blockhash != b.tail_blockhash
        {
            return Err(bad("projection exact source coverage"));
        }
        self.manifest.semantic_sha256 = self.full.projection_digest()?;
        let bytes = serde_json::to_vec(&self.manifest)?;
        if bytes.len() as u64 > MAX_MANIFEST
            || (bytes.len() as u64).saturating_add(self.manifest.counters.projected_gzip_bytes)
                > self.budget
            || fs2::available_space(self.output)? < bytes.len() as u64 + RESERVE
        {
            return Err(bad("projection manifest budget/space"));
        }
        write_atomic(self.output, PREPARED, &bytes)?;
        Ok((self.manifest, self.full))
    }
}

/// The caller must retain the separately returned manifest pin. Artifact hashes
/// bind local evidence; they do not establish RPC completeness or live readiness.
pub fn verify_artifact(directory: &Path, trust: &Trust, manifest_sha256: Hash) -> Result<()> {
    verify_named(directory, MANIFEST, trust, manifest_sha256).map(|_| ())
}
fn verify_named(directory: &Path, name: &str, trust: &Trust, expected: Hash) -> Result<Scanner> {
    let bytes = read_bytes(&directory.join(name), MAX_MANIFEST)?;
    if sha(&bytes) != expected {
        return Err(bad("projection manifest digest"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if serde_json::to_vec(&manifest)? != bytes {
        return Err(bad("projection manifest canonical encoding"));
    }
    let b = &manifest.binding;
    if b.format != "zkapi-pool-history-shadow"
        || b.version != VERSION
        || b.rules_version != RULES
        || b.genesis != trust.pool.genesis_hash
        || b.program != trust.pool.program_id
        || b.pool != trust.pool()
        || b.manifest_sha256 != trust.manifest_hash
        || b.gzip_level != GZIP_LEVEL
        || !(1..=256).contains(&b.chunk_blocks)
        || b.chunk_bytes == 0
        || b.chunk_bytes > MAX_CHUNK
        || manifest.binding_sha256 != domain_hash(b"ZKAPI-POOL-HISTORY-BINDING-V1\0", b)?
        || manifest.segments.is_empty()
    {
        return Err(bad("projection manifest binding"));
    }
    let mut scanner = Scanner::new(trust.clone());
    let mut counters = Counters::default();
    let mut previous = None;
    let mut last_slot = None;
    for (index, reference) in manifest.segments.iter().enumerate() {
        if reference.sequence != index as u64 + 1
            || reference.blocks == 0
            || reference.blocks > b.chunk_blocks as u64
            || reference.decoded_bytes > MAX_CHUNK * 2
            || reference.gzip_bytes > MAX_CHUNK * 2
            || reference.first_slot > reference.last_slot
        {
            return Err(bad("projection segment bounds"));
        }
        let bytes = read_bytes(
            &directory.join(format!("{}.json.gz", hex::encode(reference.sha256))),
            reference.gzip_bytes,
        )?;
        if bytes.len() as u64 != reference.gzip_bytes || sha(&bytes) != reference.sha256 {
            return Err(bad("projection segment digest"));
        }
        let mut decoded = Vec::new();
        let mut decoder = GzDecoder::new(bytes.as_slice());
        (&mut decoder)
            .take(reference.decoded_bytes + 1)
            .read_to_end(&mut decoded)?;
        if !decoder.into_inner().is_empty() {
            return Err(bad("projection gzip trailing bytes"));
        }
        if decoded.len() as u64 != reference.decoded_bytes {
            return Err(bad("projection segment decoded length"));
        }
        let segment: Segment<Vec<ProjectedBlock>> = serde_json::from_slice(&decoded)?;
        if serde_json::to_vec(&segment)? != decoded
            || segment.version != VERSION
            || segment.binding_sha256 != manifest.binding_sha256
            || segment.sequence != reference.sequence
            || segment.previous != previous
            || segment.blocks.len() as u64 != reference.blocks
            || segment.blocks.first().map(|b| b.slot) != Some(reference.first_slot)
            || segment.blocks.last().map(|b| b.slot) != Some(reference.last_slot)
        {
            return Err(bad("projection segment chain/encoding"));
        }
        for block in &segment.blocks {
            if last_slot.is_some_and(|old| block.slot <= old)
                || (last_slot.is_none()
                    && (block.slot < b.start_slot || block.parent_slot >= b.start_slot))
            {
                return Err(bad("projection duplicate/reordered/start coverage"));
            }
            scanner.apply_projected(block)?;
            last_slot = Some(block.slot);
            counters.blocks += 1;
            counters.original_transactions += block.original_transaction_count as u64;
            counters.selected_transactions += block.transactions.len() as u64;
        }
        if scanner.projection_digest()? != reference.semantic_sha256 {
            return Err(bad("projection segment semantic mismatch"));
        }
        counters.projected_gzip_bytes += reference.gzip_bytes;
        counters.full_equivalent_gzip_bytes = counters
            .full_equivalent_gzip_bytes
            .checked_add(reference.full_equivalent_gzip_bytes)
            .ok_or(bad("projection measurement overflow"))?;
        previous = Some(reference.sha256);
    }
    // Full-byte counts are exporter measurements: the reader cannot reconstruct
    // discarded unrelated payloads. All projected measurements are rederived.
    counters.full_decoded_bytes = manifest.counters.full_decoded_bytes;
    let state = scanner.replay_state()?;
    if counters != manifest.counters
        || counters.blocks != b.source_blocks
        || manifest.segments.first().map(|r| r.first_slot) != Some(b.first_slot)
        || state.slot != b.tail_slot
        || state.blockhash != b.tail_blockhash
        || scanner.projection_digest()? != manifest.semantic_sha256
    {
        return Err(bad("projection manifest coverage/counters"));
    }
    Ok(scanner)
}
fn domain_hash<T: Serialize>(domain: &[u8], value: &T) -> Result<Hash> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(serde_json::to_vec(value)?);
    Ok(hasher.finalize().into())
}
fn file_stamp(path: &Path) -> Result<[u64; 11]> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(bad("projection regular input"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok([
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mode() as u64,
            metadata.uid() as u64,
            metadata.gid() as u64,
            metadata.nlink(),
            metadata.mtime() as u64,
            metadata.mtime_nsec() as u64,
            metadata.ctime() as u64,
            metadata.ctime_nsec() as u64,
        ])
    }
    #[cfg(not(unix))]
    {
        Err(bad("projection requires Unix file identity"))
    }
}
fn open_regular(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(bad("projection regular input"));
    }
    Ok(file)
}
fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut file = open_regular(path)?;
    if file.metadata()?.len() > limit {
        return Err(bad("projection input bound"));
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(bad("projection input bound"));
    }
    Ok(bytes)
}
fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<T> {
    Ok(serde_json::from_slice(&read_bytes(path, limit)?)?)
}
fn hash_file(path: &Path) -> Result<Hash> {
    let mut file = open_regular(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let size = file.read(&mut buf)?;
        if size == 0 {
            break;
        }
        hasher.update(&buf[..size]);
    }
    Ok(hasher.finalize().into())
}
fn write_atomic(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let target = directory.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(Error::Conflict("projection refuses existing output"));
    }
    let temporary = directory.join(format!("{name}.partial"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, target)?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
#[derive(Default)]
struct Counter(u64);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| std::io::Error::other("projection size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "projection_archive_tests.rs"]
mod tests;
