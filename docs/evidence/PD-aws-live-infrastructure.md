# AWS public-preview infrastructure execution

Recorded 2026-10-08 JST. The user authorized the approximately USD50/month
us-east-1 short-preview plan. A new dedicated stack reached `CREATE_COMPLETE`,
its CloudFront distribution reached `Deployed`, and the private operator is
prepared for the separate application and financial bootstrap.

Public origin: **https://d366buuvadnp3.cloudfront.net**.
This hostname is the preview's transport origin; this report does not claim
that a functioning chat or funded lifecycle was available at this checkpoint.
The [machine-readable record](PD-aws-live-infrastructure.json) contains the
sanitized results and hashes of owner-only execution records.

## Created and verified

The reviewed CREATE change set contained exactly 33 additions and no changes or
deletions to existing resources. The dedicated operator is `t3a.medium` with
4 GiB; its separate HTTPS NAT is `t3a.nano` with 0.5 GiB. Both retain Standard
CPU credits. Their three encrypted gp3 volumes total 48 GiB. The fixed
730-hour illustration remains USD38.369 before variable charges and tax;
USD50/month is a target, not an AWS-enforced cap. See the
[cost and access contract](../../deploy/public-devnet/aws-budget-host.md).

The operator has no public IP. Its sole application ingress rule permits TCP
8080 from the CloudFront-managed origin security group in this new VPC.
The NAT accepts forwarded TCP443 only from the private operator subnet.
Both security groups allow outbound TCP443 only, and both instances require
IMDSv2. The operator, retained durable disk/attachment and private versioned
buckets preserve the template's retention controls. Stack termination
protection is enabled. The NAT's public TCP443 connection probe timed out.

SSM management reached both hosts. The operator reached an ordinary HTTPS
endpoint with HTTP200, while an attempted plain HTTP connection timed out.
Stopping the NAT service set IPv4 forwarding to zero and caused nine bounded
private HTTPS probes to fail. Starting it restored forwarding; a later explicit
operator HTTPS probe returned HTTP200. A subsequent clean NAT reboot changed
the boot ID and restored the enabled service and identical bounded nftables
rules. Operator HTTPS again returned HTTP200 after that reboot. These checks
preceded application or financial service startup.

## Preserved bootstrap failure and correction

The first nano bootstrap used `dnf`; repository metadata resolution was
OOM-killed, leaving forwarding disabled. Initial diagnostics and the recovery
reboot are preserved. A temporary 1 GiB swap file used the already allocated
NAT root disk; it was removed after recovery. No instance resize, extra disk or
Unlimited CPU setting was introduced. Actual Standard credit observations were
near zero during first boot, so initialization throughput was limited.

The successful correction downloaded five exact SHA-256-pinned RPMs from the
official Amazon Linux HTTPS blobstore, verified their installed Amazon-key
signatures and performed an RPM dependency dry run before installation.
Installation and canonical NAT configuration completed in 3.435 seconds.
The subsequent source template uses those same pinned packages and a pinned
Amazon-owned AL2023 image instead of invoking the repository solver on the nano.
Shell parsing and AWS CloudFormation validation passed for that correction.
The running host was repaired through SSM; the revised template was not replayed
over its live resources.

The original Tokyo template remains SHA-256
`14d4ae4fb89923058d48607934f919dea426920dc2d81b9e93a239844d8901cc`.
The original low-cost source was `c023450b795728dd4b978d711938498208ddb3777a897fe69f55ff5aef746829`.
The executed copy, with the exact AMI parameter and authorization/readiness
metadata, was `4c324ec70125655338c4471654184193f4424c18210326937a1b27e434a14a37`.
The corrected current source is `05e38287c3e4bdf7a5a87a8eb1eb7a621efa4895f079399e8876c460be33af99`.

## Private host and installed runtime

Before formatting, both EC2 metadata and the operating system identified the
exact newly created 20 GiB data volume: no snapshot source, no filesystem,
no partition, no existing mount and no signature. It was mounted as ext4 at
`/srv/zka`, with UUID-based fstab, `nodev` and `nosuid`. No prior deployment
volume or financial journal was reused. The installed prerequisites are nginx
1.30.5, PostgreSQL16.15, Python3.9.25, OpenSSL3.5.8 and glibc2.34.
`initdb`, `postgres`, `psql` and `pg_isready` are available under `/usr/bin`.

A fresh RSA4096 recipient key stayed within a root-only host directory. Only
its public certificate was returned for encrypted transfer. This is a bootstrap
encryption recipient, not the CloudFront visitor TLS certificate. The runtime
was transferred as CMS ciphertext through the private backup bucket. Its
ciphertext and decrypted gzip-tar SHA-256 pins were both verified before
checking and extracting 12,712 archive members. Absolute/traversing paths,
special files, link ancestors and links escaping the installation were refused.
The installation at `/opt/zkapi` is root-owned and readable by service users,
with executable permissions preserved. The exact-object temporary GetObject
policy was removed after download and its absence was verified.

On the actual target, Node24.19.0 ran and the SDK's declared `dist/client.js`
entry imported with network access disabled. All five Linux executables loaded
and refused missing configuration with their source-defined exit codes:
`controld`, `dispatcherd`, `signerd` and `indexerd` used1; `challengerd` used2.
`systemd-analyze verify` accepted all six staged units. It emitted only a warning
about AL2023's unrelated stock `acpid.socket` legacy `/var/run` path.

The initial smoke helper incorrectly referenced `dist/index.js`, then assumed
the challenger used exit1. Both failed observations are retained. Only the
read-only smoke helper was corrected; installed runtime bytes were unchanged.
The final combined check passed in 0.514 seconds. Idle available memory was
about3.55GB at this checkpoint; this is not a whole-stack peak measurement.

## Scope and owner handoff

Private exact resource IDs, AWS/SSM responses, scripts, certificate, policy and
failure records are under ignored `target/public-devnet-live-20261008/`.
The local `prepare_operator_ssm.py` helper there generates a fresh owner-only
SSM request for this operator; it does not execute AWS operations. Never embed
secrets in SSM command text or print decrypted configuration. The mounted state
disk and runtime installation are ready for the separately reviewed bootstrap.

This scope did not initialize a grant, submit AUTH or inference, start financial
services, or perform a chain transaction. Existing local deployments and their
private state remain separate. Public API behavior, authenticated profiles,
funded browser/native/provider acceptance, settlement, recovery, withdrawal
and encrypted financial backup/restore require their own evidence. Long-term
operation qualification is outside the current short-preview scope; no
indefinite4-GiB capacity or availability claim follows from these checks.
