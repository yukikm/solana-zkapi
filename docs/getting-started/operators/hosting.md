# AWS hosting and capacity

The public preview uses a private Linux operator in `us-east-1`, with
CloudFront's generated HTTPS hostname, immutable public assets in private S3
through origin access control (OAC), and a private CloudFront VPC API origin.
Applications are hosted independently. See [deployment](deployment.md) for
service and profile preparation and [current status](../../status.md) for
dated observations.

The maintained infrastructure source is [aws-budget-host.json](../../../deploy/public-devnet/aws-budget-host.json).
The older [aws-generated-host.json](../../../deploy/public-devnet/aws-generated-host.json) describes a larger
Tokyo configuration with managed NAT; it is not the current preview sizing.
Review a change set against the actual deployed stack before applying either
template. Source files do not establish the live resource configuration.

## Resources and cost

| Resource | Preview configuration |
|---|---|
| Operator | `t3a.medium`, 2 vCPU / 4 GiB, no public IP |
| Outbound HTTPS | Separate `t3a.nano` NAT instance and one Elastic IP |
| Root storage | 20 GiB operator and 8 GiB NAT, encrypted gp3 |
| Durable data | Retained 80 GiB volume at the latest recorded checkpoint |
| Public ingress | CloudFront HTTPS to private nginx port 8080 |
| Public assets | Versioned immutable release files in S3 through OAC |
| Backups | Separate private encrypted-object bucket; never a public origin |

The approximately USD50/month hosting target is an estimate, not an enforced
AWS cap. The source template retains a 40 GiB data allocation; the deployed
volume was subsequently expanded to 80 GiB. Do not apply the smaller value to
an existing volume. Returning to 40 GiB needs a separately verified migration.

Using the retained 2026-10-01 price observations and 730 hours, operator compute
was USD27.448, NAT compute USD3.431, one public IPv4 USD3.650 and 108 GiB of gp3
USD8.640: approximately **USD43.17/month before tax and variable costs**.
CloudFront/S3 requests and transfer, snapshots, backups, logs and all retained
resources add cost. Recheck [EC2](https://aws.amazon.com/ec2/instance-types/t3/),
[EBS](https://aws.amazon.com/ebs/pricing/),
[IPv4](https://aws.amazon.com/vpc/pricing/) and
[CloudFront](https://aws.amazon.com/cloudfront/pricing/) prices for the actual
region and billing period. Provider charges are separate from hosting.

Both instances use Standard CPU credits. Exhaustion reduces throughput rather
than enabling automatic Unlimited surcharges. Measure CPU credits, memory,
archive growth, free disk, finalized-chain lag and challenge deadlines. A 4 GiB
host is not qualified for indefinite operation by these resource choices.
History grows even without new AI usage. Follow [archive storage](archive-storage.md)
and suspend new admission before exhaustion while preserving funded recovery.
Build Linux binaries elsewhere; the root disk is for installed services.

## Network and persistence controls

The operator has IMDSv2 required, no SSH key/ingress and HTTPS-only egress.
SSM is the management path. Its security group initially has no inbound rule.
After creating the VPC origin, identify the AWS-managed VPC Origins Service
security group in that exact VPC and permit TCP8080 only from that group.
Do not substitute public, whole-VPC or NAT ingress. See the
[AWS VPC origin procedure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).

CloudFront API and error cache TTLs are zero. The request policy forwards the
reviewed Authorization, Origin, content-type, invitation and Fetch Metadata
headers without cookies. Origin connection attempts are one; nginx disables
upstream retries and sets the exact known viewer Host after clearing untrusted
forwarded headers. Preserve these settings when changing distributions.

Publish only exact reviewed files under `/releases/<revision>/profile.json`
and `/releases/<revision>/assets/*`, with appropriate JSON/WASM/text/binary
content types. Static GET/HEAD CORS is credential-free. S3 access is limited to
the designated distributions and `releases/*`; private preparation directories,
backups and financial state do not belong there. The backup bucket accepts
encrypted objects under its separate `encrypted/*` prefix.

The operator, durable volume/attachment and buckets have retention protections.
The templates do not initialize a Pool, database, journal or budget or start
financial services. Identify a data disk by its EC2 volume ID and refuse
formatting if existing data or a filesystem is present. Preserve filesystem
ownership and original authority identities. Review every change set for
resource replacement, disk detachment and differences from live state.

## NAT instance

The template pins an Amazon Linux 2023 x86-64 AMI and official signed RPMs.
Review image and package pins together when updating them. Its default
Availability Zone ID is `use1-az2`; `use1-az3` is excluded because of CloudFront
VPC-origin support. Confirm availability in the selected account.

The NAT has no public ingress. It accepts TCP443 forwarding from the dedicated
private subnet `10.79.1.0/24` and permits outbound TCP443 only. Source/destination
checking is disabled only for this NAT instance, and the private route targets
it after Elastic IP association. This limits ports, not DNS destinations;
application destination checks remain necessary.

Bootstrap verifies five exact package hashes, installed Amazon signatures and
RPM dependencies before installation. It avoids the metadata solver that
exceeded the nano's memory during initial bootstrap. The persistent
`zkapi-preview-nat.service` disables forwarding while replacing only its own
nftables table, drops forwarding by default, accepts established return traffic
and permits new private-subnet HTTPS traffic outside the VPC. MASQUERADE handles
return routing. Startup enables forwarding only after loading the rules; stop
disables it. Provider/RPC TLS remains end to end.

Verify through SSM after provisioning:

1. Pinned packages, service and exact forwarding/MASQUERADE rules are present.
2. The operator reaches required HTTPS RPC, provider and SSM destinations;
   public ingress and private HTTP forwarding remain refused.
3. A NAT restart restores SSM and forwarding without changing financial state.
4. The operator has no public IP, and API ingress is restricted to the exact
   CloudFront service security group. Verify actual public TLS, API CORS,
   authorization forwarding and no-cache behavior separately.

The NAT is a single-AZ dependency. Its failure can delay settlement and
challenges; it must not trigger inference replay or replacement service state.
The deployed template metadata and repaired source bootstrap have differed
historically because a repair was applied through SSM. Compare actual state
before any stack update; source promotion alone is not a host repair.

## Maintenance and retirement

Use [same-state maintenance](same-state-restart.md), verify encrypted off-host
backups and independently retain decryption capability. Stack deletion can
remove the networking needed for recovery and leave billable retained resources;
it is not an operator shutdown procedure. Termination protection does not
protect against unsafe updates.

Suspend new admission before retirement. Complete or explicitly preserve exact
recovery for outstanding notes, verify the durable recovery cut and inventory
retained resources and costs. An offline backup is not an available withdrawal
service. Preserve funded users' profiles, authority, journals and recovery path
through the required withdrawal window.
