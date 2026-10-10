# License scope and third-party notices

The root MIT LICENSE covers newly authored Solana zkAPI code and documentation.
It does not replace the licenses or notices of dependencies, vendored material,
generated third-party material or the separately pinned upstream repository.

- `vendor/ethereum-zkapi` is an unmodified Git submodule at
  `045b444ea1b52538d1b40273c7cb6ed09468a052`. Its Rust workspace declares
  `MIT OR Apache-2.0`; the proof, core and types crates inherit that declaration.
  Its clientd MIT notice credits the Open Anonymity Team and is preserved at
  `vendor/ethereum-zkapi/zkapi-clientd/LICENSE`.
- That upstream tree has no root LICENSE. The clientd notice and Rust workspace
  declaration must not be presented as licensing every upstream directory.
- npm dependencies keep their original package notices. Native distributions
  include the bundled Node.js LICENSE, Go LICENSE/PATENTS, and an inventory of
  Rust dependency license declarations and available notices. Declaration-only
  crate entries are identified explicitly; no copyright holders are invented.
- The exact four upstream request/withdrawal PK/VK files under
  `protocol/setup/v2` are now reviewed under the Apache-2.0 option of their
  original upstream `MIT OR Apache-2.0` declaration. The
  [four-file distribution record](deploy/public-devnet/upstream-setup-distribution.json)
  pins their unchanged bytes, upstream revisions and required notices. This
  decision does not license other upstream directories or establish a new
  setup ceremony.

The SDK tarball includes its MIT LICENSE. A deployment operator must supply
reviewed, appropriately licensed proof assets and configuration separately.
See [source provenance](vendor/README.md).
