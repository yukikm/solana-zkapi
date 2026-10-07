# Reviewable generated-hostname infrastructure

The user selected CloudFront's AWS-generated HTTPS hostname. This directory
contains the [template](aws-generated-host.json), [private nginx config](nginx.cloudfront.conf.example),
[prices and proposed operating window](aws-cost-options.md), and
[service/bootstrap plan](launch-plan.md). Provisioning remains separate from
application readiness, provider grants and finalized Devnet deployment checks.

## Verified before provisioning

AWS `cloudformation validate-template` accepted the template on 2026-10-07 JST;
`cfn-lint 1.57.2` also passed for `ap-northeast-1`. These are structural checks,
not a created change set or proof that a running endpoint works. No AWS resources
were changed by validation. The private nginx template passed a local nginx
1.30.5 syntax check with only its log path adapted and an `http` wrapper; no
listener was started. Python’s initial source download failed on its local CA
store; the ordinary TLS-verifying curl download succeeded without disabling TLS. An independent source review found and corrected
static CORS/profile-prefix omissions and a missing retained data attachment.

The template creates a dedicated VPC, public NAT subnet and private operator
subnet, one Linux EC2 instance, an encrypted root disk and separate encrypted
durable volume, a CloudFront VPC origin/distribution, and distinct private
artifact/backup buckets. SSM is the management path. There is no public EC2 IP,
SSH rule, public S3 ACL, wildcard origin bucket grant or automatically started
application. Port 8080 initially has no ingress rule, so the origin fails closed.

API cache TTLs and error cache TTLs are zero. The origin request policy forwards
Authorization explicitly along with exact CORS and invitation headers; cookie
forwarding is disabled. This follows the current
[AWS Authorization header guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html).
CloudFront connection attempts are one. nginx disables upstream retries and
clears forwarded headers before setting the exact known viewer Host. Real
recovery still uses exact protocol identities; transport settings do not prove
an uncertain request was never received.

Public profile/assets use `/releases/<revision>/profile.json` and
`/releases/<revision>/assets/*`. Only this distribution can read `releases/*`
through S3 OAC. Static GET/HEAD CORS allows any origin without credentials. This
is appropriate for public immutable files; gateway CORS retains an explicit
application allowlist. Upload neither private preparation directories nor
backups to the artifact bucket. Use exact reviewed file lists and content types
(`application/json`, `application/wasm`, text notices, octet-stream binary keys).
The backup bucket is never a CloudFront origin; the operator role has only
PutObject permission under its `encrypted/*` prefix, besides SSM permissions.

## Provisioning sequence after paid-resource approval

1. Record the approved dates/ceiling and resolve the SSM AMI parameter to its
   exact image ID. Record the source/template SHA and use a unique new stack.
   Review a CREATE change set, with `CAPABILITY_IAM`, in Tokyo; execute it only
   within the approved infrastructure scope. Enable stack termination protection
   immediately after creation. No existing stack/instance/volume is reused.
2. Read the generated `PublicOrigin`, instance, VPC, security group and bucket
   outputs. Discover the **AWS-managed CloudFront VPC Origins Service SG in that
   exact VPC**; verify its identity from the created VPC origin before adding a
   single ingress rule: TCP 8080 from that SG to `OperatorSecurityGroupId`.
   Do not allow `0.0.0.0/0`, a guessed SG or public SSH. AWS explicitly supports
   granting this managed SG after VPC-origin creation in its
   [VPC origin procedure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).
3. Through SSM, identify the dedicated volume by its EC2 volume ID, not guessed
   NVMe numbering. Refuse formatting if a filesystem or existing data is
   detected. Mount durable state and install pinned dependencies/services from
   the launch plan. Copy private configuration through a protected channel;
   command output and public files must never contain credentials or seeds.
4. Substitute the **exact generated CloudFront hostname** in the private nginx
   template and syntax-check the installed config. Gateway remains loopback-only.
   The limiter uses CloudFront origin connection addresses, so it is an aggregate
   ingress bound, not per-user identity or billing. Keep admission suspended.
5. Author fresh staging inputs with the offline preparation tool, then deploy
   and independently verify the finalized program/Pool/authorities before any
   financial service bootstrap. Sign the canonical profile only for this origin.
   Publish the exact reviewed profile/assets under a new immutable prefix.
6. Verify anonymous downloads and all hashes, actual WASM/native proofs,
   cross-origin CORS, strict route/method refusal, authorization forwarding and
   public read-only preflight. Configure and test least-privilege PostgreSQL,
   signer, dispatcher, indexer, challenger and off-host encrypted backup/restore.
   A CloudFront 200 response or `/relay-status` alone does not establish readiness.
7. Initialize a supplemental provider grant only after its distinct approval
   and authority/fencing review. Complete deliberate browser/native lifecycle
   and recovery acceptance before enabling invitations beyond the acceptance
   operator. Publish current evidence and the actual retirement window.

## Retirement and replacement

The instance, data volume, its attachment and both buckets are retained to avoid
automatic deletion of financial state. Other resources are not all retained:
**stack deletion is not a safe shutdown or rollback procedure for a live
operator**. It can remove NAT/management while a retained EC2 ENI prevents
subnet/security-group removal. Termination protection prevents accidental stack
deletion, not unsafe edits. Review every change set for replacement or detachment;
never replace the operator or mount new empty state to fix an error.

Before the approved window/cost bound ends, stop new admissions, complete or
preserve exact recovery for outstanding notes, capture and verify the durable
recovery cut, and record the paid retained-resource inventory. Shut down/unmount
only at the reviewed safe point. Preserve required journals and backups; do not
interpret the spending approval as permission to erase financial history. If
unresolved recovery requires extending paid availability, request that extension
before the limit. An offline retained backup is not an available withdrawal
service and must not be advertised as one.
