# AWS hosting cost review

## Latest budget direction

The user asked whether hosting could cost around USD 50. The working
interpretation is **approximately USD 50 per month**, separate from the already
approved seven-USDC provider acceptance allowance. The previous seven-day /
USD 100 proposal below is superseded as the active cost target; do not continue
asking for that old amount or create its larger configuration by default.

The revised [budget template and qualification plan](aws-budget-host.md) use
US East (N. Virginia), a 4-GiB `t3a.medium` operator and a `t3a.nano` NAT instance,
with 108 GiB total gp3 storage, one public IPv4 address and the same CloudFront
generated HTTPS hostname/private origin. Both instances explicitly use Standard
CPU credits. This removes the managed NAT gateway's hourly charge and reduces
the unmeasured 16-GiB server assumption. It adds responsibility for maintaining
the small NAT instance and increases origin latency for users in Japan.

The existing data volume was expanded from 20 to 40 GiB, then to 80 GiB on
2026-10-08, without replacement. The original 48-GiB / USD 38.369 plan and
the intermediate 68-GiB / USD 39.969 estimate remain historical. The final
40-to-80-GiB increase adds USD 3.20 per full month at the retained rate. See the
[initial storage checkpoint](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-rpc-migration-startup.md) and
[80-GiB capacity record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-preview-capacity-80g.md).
The temporary Unlimited CPU setting was restored to Standard at 18:21:52 UTC.
Storage migration back to 40 GiB remains undecided in the
[root handoff](../../README.md#current-handoff--2026-10-09-jst).

Retained AWS Price List observations, effective 2026-10-01:

| Item | Rate | 730-hour monthly illustration |
|---|---:|---:|
| Operator `t3a.medium`, 2 vCPU / 4 GiB | USD 0.0376/hour | USD 27.448 |
| NAT instance `t3a.nano` | USD 0.0047/hour | USD 3.431 |
| One public IPv4 | USD 0.005/hour | USD 3.650 |
| gp3, 108 GiB total | USD 0.08/GB-month | USD 8.640 |
| **Fixed subtotal** | | **USD 43.169** |

The fixed subtotal is USD 43.8312 for 744 hours using the same monthly storage
illustration. An illustrative 10% tax on that subtotal gives approximately
USD 48.21, leaving about USD 1.79 of a USD 50 target for all remaining charges,
including tax on them. Actual tax follows the account's billing treatment.
CloudFront, S3, requests, backups, logs and transfer still vary with use. No free
tier is assumed, and this is neither unlimited traffic nor an AWS-enforced cap.
External RPC fees and AI provider consumption are separate. Sources:
[EC2 T3/T3a rates and credits](https://aws.amazon.com/ec2/instance-types/t3/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/), and
[public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

The price fit does **not** establish runtime fit. Inspection found unbounded
challenger archive retention/rewrite and an indexer block-digest map. A fresh
Pool alone does not bound ongoing memory, CPU or disk. The
[capacity review](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-runtime-capacity-review.md) records the
required implementation and measured Linux acceptance before a month-long
deployment can be claimed. Neither 4 GiB nor the earlier 16 GiB has proven
sustainable operation. The original cost review changed no services, funded state or AWS resources.
The separately recorded storage extension above does not establish sustained
capacity or change the AI-provider allowance.

## Previous larger proposal — retained for comparison

Read-only review on 2026-10-07 JST. The user selected an AWS-generated HTTPS
hostname. No resources were created, restarted, resized or purchased. The
[CloudFormation template](aws-generated-host.json) is reviewable infrastructure
configuration, not deployment evidence or a hard cost cap.

Use CloudFront's generated hostname, a private EC2 VPC origin in Tokyo and a
separate private S3 artifact origin. A NAT gateway supplies HTTPS egress for
RPC, provider and SSM. No custom domain or ACM certificate purchase is needed.
The existing account's unrelated stopped instance is excluded. New resources
use a dedicated VPC; the EC2 instance has no public IP or SSH ingress.

## Capacity and cost

The initial single-host capacity is Linux `m6i.xlarge` (4 vCPU / 16 GiB), with
20 GiB encrypted gp3 root storage plus 80 GiB encrypted gp3 durable storage.
This assumption needs prover/service measurements; it is not a throughput or
availability promise. Separate private S3 storage holds application-encrypted
backups. A single host remains one failure domain.

AWS Price List API observations have effective date `2026-10-01`:

| Item | Tokyo on-demand observation | 730-hour illustration |
|---|---|---:|
| Linux/shared `m6i.xlarge` | SKU `YS6Q9PHBX8A4B83R`: USD 0.248/hour | USD 181.04 |
| gp3, 100 GB total | SKU `C8Y3GJZBQTH8T5JV`: USD 0.096/GB-month | USD 9.60 |
| NAT gateway | SKU `CA23TN2NAN47KGCF`: USD 0.062/hour | USD 45.26 |
| One NAT public IPv4 | USD 0.005/hour | USD 3.65 |
| **Fixed illustration** | Compute + disk + NAT + IP | **USD 239.55/month** |

NAT processing additionally costs USD 0.062/GB (SKU `3Z2F4ZNXEMZB88ED`).
CloudFront requests/transfer, S3 storage/requests, snapshots, logs, other data
transfer, taxes, third-party RPC and provider usage are additional. Do not assume
a free allowance or flat-rate plan. Sources: [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/),
[VPC/NAT/IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and
[CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/).

Seven days at these fixed rates is approximately **USD 55.13**, including
prorated disk, before variable costs. A proposed initial approval is **seven
days and USD 100 total AWS spending**, including retained storage and cleanup
within that allowance. This is a proposed operating limit, not approval and not
an AWS-enforced hard cap. No automated renewal or new resources beyond this
configuration are implied. Request additional authorization before exceeding
either bound. Stop new admission early enough to settle notes and withdraw
before retirement; retain recovery and durable state if anything is unresolved.

The EC2 instance, data volume and S3 buckets have retention policies. Deleting
the stack can leave billable resources and can remove networking needed for
recovery. Never use stack deletion as the shutdown procedure. Inventory and
price retained resources, settle/recover first, then obtain the required
data-retention decision before destructive cleanup.

## Earlier approval boundary

The hostname choice is settled. This earlier operating window and USD 100
allowance were not approved and are now superseded by the budget direction
above. The separate
[provider acceptance proposal](../../docs/public-devnet-acceptance-plan.md)
has explicit user approval for seven new one-USDC AUTH reservations; no actual
supplemental grant has been initialized. The old ten-USDC ledger cannot admit
another full-cap AUTH and is preserved unchanged. A provider grant does not
authorize infrastructure costs, or vice versa.

VPC origin prerequisites and source security-group procedure are documented in
the [AWS guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).
The internet gateway is attached for CloudFront's requirement; private EC2 has
no direct route to it. Its egress route is through NAT. The CloudFront-managed
private ENI does not create a separately billed public IPv4 address.
