# N01 backup: independent archive and logical database verification

On 2026-10-08, the exact uploaded backup version was downloaded, decrypted and checked independently. Its logical PostgreSQL dump then restored successfully into an isolated PG16 cluster. This verifies the **historical N01 capture: one settled session, six micro-USDC charged and seven retained checkpoint rows**. It does not cover the later four-session state in [N04](PD-native-public-N04.md).

The single exact-version download matched the stored version, checksum and **3,531,572,566-byte** ciphertext SHA. The first local verifier failed with `ReadError` before reading a tar member: OpenSSL rejected its large embedded CMS ASN.1 input buffer. That attempt and error remain preserved. A separately reviewed successor retained the original recipient/cipher metadata in a 544-byte detached envelope and streamed the unchanged encrypted content to OpenSSL. Six synthetic tests passed; the earlier synthetic prefix-comparison failure also remains recorded.

Actual verification checked the complete original ciphertext hash, CMS framing/EOF, OpenSSL exit status, gzip EOF and **12,873 tar members** against the pinned inventory. It covered 12,823 inventoried files totaling 23,862,386,952 logical bytes, file hashes and metadata, hardlink identities, all original stopped-prefix records and empty `lost+found`. Only the inventory and three small SQL/dump files were saved privately; no plaintext tar or full extraction was written. ACL/xattr bytes were retained, but were not independently inventoried or applied.

The cached **PostgreSQL 16.14** image ran with networking disabled, no host mounts, a read-only root filesystem and bounded memory/scratch storage. All **16 public tables**, complete columns, duplicate rows and full COPY-row hashes matched the authenticated dump. Migration checksums, N01 signature/charge and the canonical seven-row outbox history matched the captured cut. The new cluster had a distinct system identifier. Globals, role credentials and ownership/ACL restoration were excluded.

| Retained receipt | SHA256 |
|---|---|
| Exact-version download | `b00a2493adfa0a4b6fe45dd84ea00152ed96e6810cac0cf469a0209fb24f8faa` |
| Streamed archive verification | `f993f6417507142931ba2a8f462438b00e414c3c37798a6e9aa2ff484232e074` |
| Isolated logical restore | `4542657ec7e8e055b03f4a9c9194b3a831574cdb5ad95d35a9083507c0fbc08f` |

[Machine-readable results](PD-N01-backup-independent-verify.json) retain source/failure pins and per-table counts/hashes. Private dumps, raw database rows, recipient keys and configurations are excluded. This adds independent archive integrity and logical-data restoration to the earlier [same-state restart evidence](PD-N01-service-recovery.md); it does not establish physical-cluster/WAL recovery, a v2 recovery witness, signer/service restoration, latest-state recovery or mainnet qualification. No live services or financial state changed.
