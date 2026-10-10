# Provider budget regression fixture

`historical-budget.json` is the frozen, public, redacted ten-reservation budget
used by the Python budget and TypeScript recovery regression tests. It is an
input for append-only compatibility checks, not a current budget or permission
to spend. Tests copy it into isolated temporary state and never modify it.

Source: [historical record](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-parity-review-live-components/budget-after.json).
SHA-256: `0fcdf6a9927ad6cdea61670128b620053bb4a0ff58f0e64377eb9464485a6a06`.

Preserve all ten rows and the original plan binding. No credentials or private
journal content are included. Runtime output belongs in ignored directories.
