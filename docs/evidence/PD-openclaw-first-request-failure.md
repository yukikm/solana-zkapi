# First public OpenClaw request — HTTP 400 checkpoint

Date: 2026-10-08 UTC. The sole planned OpenClaw launch began at 11:48:31 UTC.
Its first request returned **HTTP 400**, with surfaced error `400 terminated`.
There was no successful read-tool call or second forwarded request, so N-02 and
N-03 are not successful acceptance cases. The original launch fence and durable
first-forward record remain preserved. See the [receipt index](PD-openclaw-first-request-failure.json).

The error-body handling defect is under investigation. The surfaced message does
not establish whether the original failure was caused by schema validation,
tool content or an upstream provider. OpenClaw separately warned about a
configured 4,096-token context, estimated input of 4,529 tokens and computed
output allowance of one token. These estimates are neither billing evidence
nor a confirmed explanation of the HTTP 400.

The before/after native status bytes were identical: journal revision **371**,
head `bf4e9052a2edd80c34bfe2654b2b578ae2ffc0ce2c5bc754125987eb630c55b8`,
ready state, no unresolved operation, and active balance **4,999,994 micro-USDC**.
The read-only operator observation at **12:04:14 UTC** validated the unchanged
reservation SHA `653f4fd10b716d5cbebedc794665d1c7313d346a17ce080ac8935827c71d61e8`.
It found one reservation, one N-01 session, one settlement, one receipt, one
dispatch attempt and zero operation rows. All ten bounded tables fit completely;
seven outbox rows were retained. No new AUTH, reservation, session or charge is
evidenced by these cuts. This is not an independent count of AUTH or provider
network packets. N-01's previously verified six-micro-USDC charge remains separate.

Root stopped only the owned scheduling gate with SIGTERM; the saved observation
records its PID absent and the existing native supervisor untouched. Root also
observed the gate session exit with code zero. Original request/state files were
not reset or replaced. No successful tool continuation, new settlement, withdrawal
or expanded lifecycle acceptance is claimed by this report.
