# AWS candidate targeting USD 50 per month

Prepared 2026-10-07 JST in response to the user's lower hosting-cost target.
[aws-budget-host.json](aws-budget-host.json) is a new reviewable infrastructure
candidate. The original preparation and validation were read-only. On
2026-10-08 JST, the user authorized the approximately USD50/month short preview
and a dedicated stack was created in us-east-1. Live execution and its distinct
application-readiness checks are recorded in
[the infrastructure evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-aws-live-infrastructure.md).
The target is not an AWS-enforced cap or a claim that the current application
can operate indefinitely on 4 GiB. Long-term operation qualification is outside the current short-preview scope.
Current resource headroom and preservation of recovery remain required.

This candidate preserves AWS-generated HTTPS without purchasing a domain:
CloudFront serves its default hostname, private S3 supplies immutable public
artifacts through OAC, and a VPC origin connects privately to the operator.
The operator has no public IP. A small separate EC2 NAT instance provides its
outbound HTTPS access; it replaces the hourly managed NAT gateway charge.

The original 29-resource Tokyo template remains byte-identical at SHA-256
`14d4ae4fb89923058d48607934f919dea426920dc2d81b9e93a239844d8901cc`.
Its larger m6i.xlarge/managed-NAT estimate remains historical. The new template
has 33 resources, is scoped to `us-east-1`, and has SHA-256
`05e38287c3e4bdf7a5a87a8eb1eb7a621efa4895f079399e8876c460be33af99`. The originally reviewed low-cost template was
`c023450b795728dd4b978d711938498208ddb3777a897fe69f55ff5aef746829`;
the live CREATE used a separately recorded copy with the same exact AMI pin.
The subsequent bootstrap fix below preserved its resource sizes and network rules.
The 2026-10-08 02:31 UTC operational follow-up expanded only the existing data
volume from 20 to 40 GiB, preserving its identity and mounted filesystem. The
source template at that checkpoint was SHA-256 `087453dc26c3359f59562dd49bc8a6cd8154fbcc0bf17d8c8db9906b2a55fd25`;
the earlier template hashes and 48-GiB validation below remain historical.
See the [migration and storage checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-migration-startup.md)
for the actual change-set and host receipts; storage growth is not service readiness.

The subsequent [independent static-origin update](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-runtime-origin-followup.md)
adds one CloudFront distribution, its bounded S3 policy grant and two outputs,
without another compute or NAT resource. The current source template is
`c49a35cb497d653f9035b1e4cb9a9c179c93d4562daee05bc4da30c0f57d4391`;
the exact deployed template is
`60ba2b14c2d6f9ab46fdbb34a305d3679c3278cfa017a805f17ad76601d9aff8`.
Both retain 40 GiB of data. Source preserves the repaired pinned-RPM NAT
bootstrap; deployed metadata still contains the earlier dnf bootstrap because
the actual NAT repair used SSM. Any later stack application must account for
that known difference. Source promotion alone performed no AWS action.

## Cost and operating tradeoffs

The read-only AWS Price List observations have effective date 2026-10-01.
They are retained in
`target/public-devnet-budget-review-20261007/price-summary.json`.

| Item | Configuration/rate | 730-hour month |
|---|---|---:|
| Operator | `t3a.medium`, 2 vCPU / 4 GiB, USD 0.0376/hour; SKU `CEC547W2ASCGJKER` | USD 27.448 |
| HTTPS NAT | `t3a.nano`, 2 vCPU / 0.5 GiB, USD 0.0047/hour; SKU `3NY3EX7YAET2WWYZ` | USD 3.431 |
| One public IPv4 | NAT Elastic IP, USD 0.005/hour | USD 3.650 |
| Encrypted gp3 | 20 GiB operator root + 40 GiB durable state + 8 GiB NAT root, USD 0.08/GB-month; SKU `JG3KUJMBRGHV3N8G` | USD 5.440 |
| **Fixed illustration** | Compute, disk and one IP | **USD 39.969** |

The original 48-GiB fixed illustration was USD 38.369 at 730 hours. The extra
20 GiB adds USD 1.600 per full month using the same retained rate.
At 744 hours, the current fixed illustration is USD 40.6312. Applying an
illustrative 10% tax gives USD 43.9659–44.6943, leaving approximately
**USD 5.31–6.03** within the USD 50 target for all other AWS charges and their
tax. Actual tax depends on account billing. CloudFront/S3 requests and transfer,
artifact and encrypted backup storage, snapshots, logs and any other retained
resources must fit that remaining allocation. Do not assume a free allowance
or omit these charges from the final estimate. Pricing sources:
[EC2 T3/T3a](https://aws.amazon.com/ec2/instance-types/t3/),
[EBS](https://aws.amazon.com/ebs/pricing/),
[public IPv4](https://aws.amazon.com/vpc/pricing/) and
[CloudFront](https://aws.amazon.com/cloudfront/pricing/).

Both instances explicitly use **Standard CPU credits**, so this template does
not enable automatic Unlimited CPU surcharges. Exhausted credits instead limit
CPU throughput. Baseline throughput and history catch-up must be measured;
financial recovery/challenge work cannot be treated as an optional background
job when CPU is throttled. Do not silently enable Unlimited, resize, add a
second writer or purchase reserved commitments to finish a case.

Northern Virginia is cheaper than the previous Tokyo allocation. Requests from
Japan may take longer; CloudFront terminates viewer TLS near the user, while
uncached API calls still reach the US operator. Direct model inference remains
client-to-OpenRouter. The backend archives and application-encrypted backups
would reside in the US region. This is a proposed region change for new state,
not migration of existing local financial state.

The separately approved seven-USDC provider grant is not part of this hosting
table. The USD 50 target describes AWS hosting, not a renewal of provider
allowance or permission for more than seven full-cap AUTH reservations.

## Preserved access and persistence controls

The template retains the original API route selection, exact forwarded
Authorization/Origin/admission/Fetch Metadata headers, no API/error caching,
one origin connection attempt, bounded origin deadlines, HTTPS-only viewer
behavior and default CloudFront certificate. Static files retain credential-free
GET/HEAD CORS and private S3 OAC access limited to this distribution's
`releases/*` objects. Private files and backups are not exposed through that
policy. Use the reviewed [private nginx configuration](nginx.cloudfront.conf.example)
with the actual generated viewer hostname and the bounded gateway.

The operator security group initially has **no inbound rule**. After the VPC
origin is created, identify the CloudFront-managed VPC-origin service security
group in this exact VPC and allow TCP 8080 only from it, as described in the
[existing generated-host procedure](aws-generated-host.md). Do not open it to
the public internet, the NAT instance or the whole VPC. A template-created
instance or CloudFront distribution is not application readiness.

The operator has IMDSv2 required, no SSH key or SSH ingress, and only HTTPS
egress. SSM uses its existing narrowly scoped instance role. A separate NAT
role has only SSM managed-instance permissions and no artifact, backup or
financial-data policy. No credential or private journal is placed in user data.
The template does not create application users, format/mount the data disk,
start financial services, issue keys, initialize budgets or deploy a Pool.

Operator instance, durable volume/attachment, artifacts and backup buckets keep
their Retain/UpdateReplace Retain protections. The NAT instance is stateless;
its disposable root contains only its OS and forwarding configuration. Deleting
the stack can still remove networking needed for recovery and leave billable
retained resources. Stop new admission, finish or explicitly preserve unresolved
recovery and review retained state/cost before any destructive teardown.

Use the [detached V2 seven-cap authority](detached-budget.md) for new approved
state. Keep the original 17-row ledger and local recovery untouched. No copied
ledger, empty replacement database, signer journal reset, autoscaling or
second financial writer is introduced by this cost reduction.

## NAT implementation and bootstrap checks

AWS documents [NAT instances](https://docs.aws.amazon.com/vpc/latest/userguide/work-with-nat-instances.html)
as an alternative to managed NAT. The new `t3a.nano` uses the same reviewed
Amazon Linux 2023 x86-64 image as the operator. The default is now the reviewed
Amazon-owned `ami-0d27e0fb3bac4d724` in us-east-1, AL2023 2023.12.20260930.
Review the image and package pins together before changing this default. `AvailabilityZoneId` defaults to `use1-az2`; confirm account access.
`use1-az3` is excluded because CloudFront VPC origins do not support that zone.

The NAT has an Elastic IP but **no public ingress**. Its only incoming rule is
TCP 443 from the dedicated private subnet `10.79.1.0/24`; outgoing traffic is
TCP 443 only. Source/destination checking is disabled solely for that NAT
instance. The private route targets this instance after EIP association.
There is no managed NAT gateway and no publicly routed operator origin.

The initial live `dnf` metadata solver was OOM-killed on the nano. That failed
observation, temporary swap recovery and stateless NAT reboot are retained.
The successful correction installed five exact SHA-256-pinned official Amazon
RPMs after `rpmkeys --checksig` and an RPM dependency dry run; it completed in
3.435 seconds. Temporary disk swap was removed. No instance resize, extra disk
or Unlimited CPU credit setting was used.

Current user data disables IPv4 forwarding and downloads those five pinned RPMs
from the official HTTPS blobstore with bounded retries for EIP association.
It verifies every hash and installed Amazon trust-key signature, checks all RPM
dependencies before installation, then creates the persistent
`zkapi-preview-nat.service`. It does not run the repository metadata solver on
the nano. This source correction has shell/schema checks; the live correction
was applied through SSM, not by replaying CloudFormation over the running host. Its forwarding chain drops by default,
accepts established/related return traffic, and admits new TCP 443 forwarding
only from the private subnet to destinations outside this VPC. The matching
postrouting rule uses MASQUERADE. Startup disables forwarding while replacing
only its own nftables table, then enables forwarding after the rules load;
service stop disables forwarding. It does not flush unrelated tables or expose
a listening proxy. Provider/RPC TLS remains end-to-end through this routing hop.

Before relying on it, verify on the new host through SSM:

1. Package setup completed; `zkapi-preview-nat.service` is active and the exact
   forwarding/MASQUERADE rules match the reviewed template.
2. The private operator can reach the required HTTPS RPC/provider/SSM
   destinations, while public connection attempts and private HTTP forwarding
   are refused. No browser credential, key or request body is logged for this
   check. This routing/security-group layer limits destination ports, not a
   DNS-domain allowlist; application destination validation is separate.
3. A deliberate NAT reboot restores the forwarding service/rules and SSM.
   A service stop blocks new external connections; restart restores connectivity
   without changing any budget, journal or financial process state.
4. The operator still has no public IP, and the only application ingress is
   the exact CloudFront VPC-origin service security group. Verify real API
   authentication/CORS/OPTIONS and no-cache behavior separately.

NAT-instance maintenance and availability are now the operator's responsibility.
Its failure interrupts RPC/provider access and may delay settlement or challenge
work; this is a single-AZ Devnet limitation, not managed-NAT availability.
Do not automatically replay inference or recreate financial services after an
egress outage. Live bootstrap, SSM and recovery outcomes are reported separately in the
linked infrastructure evidence; stack creation alone is not acceptance.

## Memory and archive qualification is still required

The earlier 16-GiB choice was a conservative allocation, not a measured minimum.
The saved I09 challenger fixture observed about 295–298 MiB resident memory after
each case, including its test harness, but did not measure a whole-stack peak.
The currently running PostgreSQL idle sample likewise does not establish the
active service requirement. **Neither result proves that 4 GiB is sufficient.**

More significantly, the current challenger retains full decoded Devnet blocks,
clones its complete state and serializes a growing journal. The 64-block/8-MiB
batch limit is not an archive-size limit. A preserved historical batched journal
was already approximately 833 MiB by filesystem metadata. History can grow even
when no AI request runs. A fresh Pool reduces initial history, but does not
establish sustainable memory/disk usage for a month.

Do not advertise this as a qualified month-long USD 50 service until archive
growth is bounded with recovery-preserving storage and the complete stack is
tested on the target limits. A separately scoped short seven-case trial still
requires measured headroom and monitoring of memory, disk, CPU credits, history
lag and unresolved recovery. Disable new admission before resource exhaustion;
do not delete required history or abandon funded recovery to hit a cost target.

Build and package Linux x86-64 binaries off this small runtime host. The
20-GiB root allocation is for installed services, not an unbounded Cargo/toolchain
workspace. The original 20-GiB durable allocation was expanded to 40 GiB for
current preview headroom. It still requires actual growth measurements and
safe stop thresholds, not permission to prune state. Data expansion does not
increase the separate root-filesystem space used for local encrypted backup.
Increasing storage or retaining backups adds cost and requires updating the
whole estimate rather than claiming the fixed figure remains complete.

## Validation completed and remaining

The original local review parsed the then-current JSON and checked every
Ref/GetAtt/Sub/DependsOn target, all 33 resources, 48 GiB of encrypted gp3, Standard credits on both
instances, absence of managed NAT and public ingress, and all financial-state
retention policies. Sixteen unchanged security/API/storage resource definitions
were compared exactly to the original template. The outer bootstrap and inner
NAT-start shell scripts passed `bash -n`. The original template hash remained
unchanged.

These are static checks only. CloudFormation service validation, current schema
linting, Linux nftables loading, AMI/package availability, actual NAT reboot,
service memory/archive limits and public TLS/lifecycle acceptance must be
recorded separately. The pricing target has no automatic hard spending cap;
budget alerts, a bounded operating window and measured low-volume usage inform
the final deployment decision. The actual resource creation is covered by the separate 2026-10-08 user
authorization; tests themselves do not confer spending authority.
