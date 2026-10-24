# Deploy encrypted client recovery storage

Deploy only the recovery service; it does not require restarting financial
services, changing the Pool/profile, or migrating their databases and journals.
Use the original operator instance and persistent volume. The templates assume
the existing public Devnet host layout and pinned Node 24.22.1.

`scripts/prepare_recovery_deployment.py` performs only read-only AWS checks and
creates a source-authenticated deployment inventory, SSM command parameters and
an additive CloudFront configuration. It does not send a command or update AWS.
The normal mode requires every deployed file to equal the specified Git commit.
The optional working-tree preview adds an unconditional refusal to its host
command; prepare again after committing before deployment.

```sh
python3 scripts/prepare_recovery_deployment.py \
  --source-revision REVIEWED_FULL_COMMIT \
  --account 336670698418 \
  --output target/recovery-deployment
```

Inspect `plan.json` and the generated host changes. Submit `ssm-parameters.json`
to `AWS-RunShellScript` on the exact instance in the plan. Check its completed
status and reported file digests before the CloudFront update. Then submit
`cloudfront-proposed.json` to `update-distribution` using the plan's original
ETag with `--if-match`; a concurrent distribution change must fail rather than
be overwritten. These commands are intentionally separate so a failed host
installation cannot publish an unready route. Retain the deployment plan and
`cloudfront-before.json` privately. Preserve this new behavior in the parent
CloudFormation stack template before any future full-stack update.

1. Run `node --test services/recovery/recovery.test.mjs` and the SDK's browser and
   Node local-loss restoration tests against this service. Preserve their reports
   privately under ignored `target/`. Review the exact release source hash.
2. Verify the actual instance's Node version, mounted persistent `/srv/zka`,
   available space, nginx configuration and current CloudFront distribution.
   Save configuration rollback copies privately. Do not print credentials or
   financial files. Existing service state and old releases remain untouched.
3. Install only `services/recovery/server.mjs` and `store.mjs` in a new
   `/opt/zkapi/recovery/releases/<source-sha>/` directory. Verify their SHA-256
   hashes on the host. Create the independent `zka-recovery` system user/group
   if absent, and its `0700` `/srv/zka/recovery` directory. Do not reuse signer,
   gateway, control or operator-backup directories. Retain existing files if the
   directory already exists; this procedure never initializes over custody.
4. Install a reviewed copy of `config.example.json` as
   `/etc/zkapi-recovery/recovery.json`, owned by root with group `zka-recovery` and
   mode `0640`, in a separate root:`zka-recovery` directory with mode `0750`.
   Do not broaden `/srv/zka/config`, which is private to the existing gateway.
   Point `current` at the reviewed release. Install the supplied
   `zka-recovery.service`, run `systemd-analyze verify`, reload units, and start
   only `zka-recovery`. Verify its actual mount namespace permits durable writes.
   The prepared host command rolls back the unit, release pointer and nginx
   files on syntax, service-start or health-check failure, and restores the
   prior recovery-service active/enabled state. It retains all recovery data.
5. Add `nginx-http.conf.example` in nginx's HTTP context and
   `nginx-location.conf.example` inside the existing private CloudFront-origin
   server, leaving its financial routes and rate limits unchanged. Creation is
   limited to two requests/minute per private origin peer with a burst of ten;
   recovery operations permit twenty/second with a burst of one hundred. Origin
   peer limits can group CloudFront users and must not use spoofable headers.
   The independent 1024-vault/1-GiB service quota additionally bounds disk use.
   Verify
   `nginx -t`, then reload nginx. The Node service port is loopback-only and does
   not need a new security-group ingress grant. Keep access logs off.
6. Add CloudFront behavior `/recovery/v1/*` to the existing distribution,
   targeting its existing private `api` origin. Reuse its zero-TTL API cache
   policy and origin request policy, which already forwards Authorization,
   Origin, Content-Type and CORS preflight headers. Enable the seven HTTP methods
   needed by the CloudFront API behavior. Do not change any other behavior,
   profile, origin, policy or price plan. The service never redirects or caches.
   Wait for deployment and inspect the installed behavior and actual headers.
7. Verify public health and OPTIONS from the exact zkchat HTTPS origin. Use a
   new synthetic vault through the public endpoint to test encrypted commit,
   loss of a temporary local store, restoration, lock conflict, takeover, old
   owner refusal and unchanged ciphertext. Keep credentials and test vault IDs
   out of public logs and reports. There is no deletion API; retain the small
   synthetic record as release evidence.
8. Only after successful remote verification, enable the recovery endpoint in
   zkchat and publish its rebuilt assets. Existing browser-only custody should
   offer an explicit backup setup; loading the new version does not silently
   discard or replace original local keys or journals.

The planned endpoint is
`https://d366buuvadnp3.cloudfront.net/recovery/v1`. The previous service continues
to own its original financial state. Recovery can be made temporarily unavailable
by removing only this new route or stopping only `zka-recovery`; do not delete
its data, restore an older vault snapshot or roll back client journals.

The current durability boundary is fsynced data on persistent EBS. S3 operator
backups are separate; do not put client records into an existing financial backup
format. A future encrypted archival copy needs its own prefix, version retention
and freshness-preserving restoration procedure. It is not required to prove
recovery from deletion of the browser's or Node client's local data.
