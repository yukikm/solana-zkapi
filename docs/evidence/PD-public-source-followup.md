# Published public Devnet source followup

Recorded 2026-10-08 JST. GitHub `main` was advanced to
[`6e8ecac61a1ef6f3299f7611efb351c65b7771a9`](https://github.com/yukikm/solana-zkapi/commit/6e8ecac61a1ef6f3299f7611efb351c65b7771a9),
whose sole parent is the immutable client-release source
`5ded36bf39de9b9fb6bf27a10d744437abc6a9c7`. Independent read-only GitHub REST
queries confirmed the remote main commit, parent and tree, and confirmed that
`v0.2.0-devnet.2` still points to the original client source. The
[machine-readable record](PD-public-source-followup.json) retains the exact
joins and redacted observation fields.

The followup publishes 159 reviewed source/documentation/evidence paths: 28
modifications and 131 additions. The complete 1,557-entry tree preserves the
other 1,398 parent entries and the exact upstream gitlink. Every candidate's
bytes and mode were checked, as were all 182 tested Linux inputs: 147
superproject files and 35 upstream files at the pinned vendor commit. Their
source-manifest SHA256 is
`3d2c0edacac02247ee083aad10ce1a3ac83b5827603bca09ffbb00d7bc78e945`.
Private target/environment material and unrelated `work/single-deposit-review`
files were excluded. Local HEAD intentionally remains on `work` at
`eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`; the real index is unchanged from
before isolated commit construction. No checkout reset or broad staging was
used.

This is a later server/documentation source snapshot. The immutable SDK and
macOS native archives were not rebuilt or retagged. The
[client publication](PD-public-client-publication.md) and
[focused hosted client CI](PD-public-client-hosted-ci.md) remain scoped to
`5ded36…`; this record claims no new hosted-CI result for `6e8eca…`.

The [disk-reader candidate](PD-challenger-disk-reader-candidate.md) Linux binary,
SHA256 `c73d58baebb1ad0d992ba63ca0827af4fb9636d93985440c9dffdd98e9fb7ac2`,
is joined to these 182 published inputs. It was built locally with Rust 1.90.0
for Linux x86_64 and requires no GLIBC symbol newer than 2.34. Its local tests,
initial parallel fixture failures, serial passes and ABI smoke remain recorded
in the candidate report; GitHub did not build this binary.

A separately retained host observation completed a read-only cold `status`
against the existing 29,844-block/117-chunk archive in 382.642 seconds, with exit 0
and no stderr. Maximum observed process high-water memory was 31,084,544 bytes;
minimum available host memory was 3,392,995,328 bytes. Archive inventory,
configuration and owner-lock identity were retained, with zero pending jobs or
unknown signatures. This demonstrates cold loading and replay of that retained
archive at that checkpoint. It was not a new migration, and the service was
still stopped. It does not establish resumed catch-up, live steady-state memory
or a long-term 4GiB capacity guarantee.

Source publication and cold validation do not complete funded
browser/native/OpenClaw lifecycle acceptance, provider acceptance, full I10 or
G1–G4. Later service-start and catch-up observations remain separate. This
verification performed no funding, AUTH or provider operation. This evidence
record was written after the source push and is not itself part of the commit
it documents.
