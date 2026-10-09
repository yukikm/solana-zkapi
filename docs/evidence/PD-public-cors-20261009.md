# Public API CORS opening — 2026-10-09

The requested **ZKAPI-only** change is installed. The public gateway now uses
`allowedBrowserOrigins: ["*"]`, allowing independent browser applications to
connect without registering their origin. HTTP localhost development is included.
No chat application was edited. [Machine-readable evidence](PD-public-cors-20261009.json)
records the rollout, tests and public browser results.

The gateway returns `Access-Control-Allow-Origin: *` for requests with Origin.
Browser callers use `credentials: "omit"`, as the existing SDK already does.
Explicit Authorization and Content-Type headers remain supported by preflight.
The wildcard must be the sole configured entry; existing exact HTTPS allowlists
retain their restrictive behavior. Cookie rejection, route/method/header checks,
session authentication, proof validation and the existing durable budget remain
in place. This is not a provider, wallet, browser-extension or secure-context fix.

## Verified deployment

SSM `6cda5d62-d6bd-43d2-a868-3cab4ba6ec83` completed the guarded gateway-only
rollout at **04:12:34 UTC / 13:12:34 JST**. The gateway stopped and started once,
becoming PID **122486**. All five other process identities and unit policies
were preserved. Of **106 protected files**, only the two gateway sources and
`/srv/zka/config/gateway.json` changed. The only configuration field changed was
`allowedBrowserOrigins`; invitation-free admission and recovery remain enabled.

The complete **49,039-byte** private receipt was independently fetched and
verified against SHA256
`23b935c61e62ae7b9c78a157a849bc9e1a5dd469953605be81fda2970e2bbf12`.
Complete database `49c3b138…60f16` and reservations `29be8a5b…337706` remained
unchanged: four settled sessions, four reservations and all 25 recovery
checkpoints. No AUTH, inference, wallet transaction, grant initialization,
reservation reset or historical replay was performed.

## Validation and limits

All **51** local gateway/relay tests passed with zero skips under pinned Node
**24.19.0**. Added cases cover wildcard configuration, HTTPS/localhost/IPv6/opaque
origins, preflight, readable API errors, unchanged credential rejection, native
opt-in and invitation authorization. Production Node syntax checks passed.
These local tests use fixtures and establish no funded acceptance.

Before deployment, localhost RPC preflight returned HTTP400 without CORS
headers, and actual Chromium config fetch failed. After deployment, **nine**
public OPTIONS checks passed with HTTP204, wildcard allow-origin and no
allow-credentials header, across independent HTTPS, localhost and opaque origins.
Checks covered RPC, session AUTH preflight and shared snapshot preflight;
no live AUTH POST was sent.

Actual Chromium fetches from `http://127.0.0.1:4391`, `http://localhost:4391` and
`https://example.com` successfully read HTTP200 config, catalog, readiness,
relay status, the immutable SDK `.3` profile and bundle descriptor, and a
preflighted read-only `getGenesisHash` RPC response. The static profile and
bundle already supported wildcard CORS and were not changed.

The first tree-root fetch returned HTTP200, but subsequent tree-root fetches
from localhost and example.com returned **HTTP503**. A separate example.com
follow-up at **04:16:05 UTC** again received `configured upstream unavailable`
after about 24.5 seconds. Each error was readable by JavaScript, confirming
CORS worked for it. The upstream failure's cause remains unproven; separate
HTTP200 readiness observations do not establish successful tree-root forwarding.
No additional service restart or backend repair is included in this change.

The first read-only host inspection exceeded SSM's inline output limit, causing
local JSON parsing to fail. Its original output is retained; a fresh compressed
read-only inspection succeeded before deployment. Original journals, earlier
failures, E01 closure, financial history and immutable releases remain preserved.
SDK/native `.3` remain unchanged. No new source release, hosted CI pass, funded
browser lifecycle or continuous-availability claim is made.

Publication follow-up: the requested commit and push completed, and
[v0.2.0-devnet.5 was published and verified](PD-cors-release-20261009.md) at
04:27:07 UTC. The operational checkpoint above is preserved unchanged.
