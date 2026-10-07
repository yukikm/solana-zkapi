# Independent zkchat public-profile integration

On 2026-10-07, eleven reviewed files were applied to the independent application at `/Users/yukikimura/work/zkchat`. The application now consumes the exact local SDK `0.2.0-devnet.2` candidate, authenticates a public deployment profile, and keeps invitations in memory for one connection. This is local application integration evidence, with no new funded or public acceptance claim.

The [machine-readable report](PD-zkchat-integration.json) records every transferred file's original and final SHA-256, verification logs and preserved inputs. The privately retained `zkchat-transfer-manifest.json` SHA-256, also recorded in that report, is `31c82d2e7312a0ea6f4cfba2e10e46ee1ed400fbf881f7bd4e2941032e4f2c2d`. All eleven destination files match both that manifest and the frozen staging source. All thirty before-image files were rechecked against the original inventory.

The SDK archive SHA-256 is `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`; all 65 installed package files match the archive. This is an **unreleased local candidate**, not a newly published SDK release. The previous `.1` archive, original Japanese integration report and historical screenshots remain byte-identical. The checked-in public configuration remains literal `null`.

## Behavior and continuity

Schema 2 accepts only the application label, Devnet chain and independently installed profile URL/hash. Models, capabilities, RPC, indexer and provider settings come from the authenticated profile. The invitation transport strips supplied admission headers, omits browser credentials, refuses redirects, and injects its memory-only invitation solely on the authenticated control origin's exact session-creation POST without a query. Connecting submits no AUTH, inference or transaction.

New deposits and requests require an invitation and successful refreshed chain/catalog checks. Unsupported streaming and output limits above the preview's 128 tokens are refused before SDK admission. Failed or paused preflight blocks new work while original-profile recovery and withdrawal remain explicit. Operator admission is still unverified until the user submits AUTH.

The existing custody namespace, note ID and account guards remain. A missing profile binding with existing custody is refused even with initialization requested; a different binding is never silently adopted. Legacy schema 1 recovery retains its original configuration. There is no automatic migration, custody reset or inference replay.

## Verification

On the actual destination, pinned Node 24.19.0 completed SDK digest verification, TypeScript checking, all **62 unit tests** (49 existing and 13 new public-profile cases), and the production build. The transferred files remained unchanged. A separate isolated Chromium run on the identical frozen staging source passed **12 browser tests in 8.0 seconds**, including invitation form clearing and absence from persistent browser storage. The browser suite uses synthetic wallet/SDK adapters for financial flows. Independent read-only review found no blocking issue.

The first browser attempt failed all twelve launches before test bodies because the matching `chromium_headless_shell-1243` executable was absent. The matching Playwright Chrome, headless shell and FFmpeg installation succeeded using normal HTTPS downloads, without bypassing browser protections. The initial failure and installation log remain preserved. A test-only generated-module fix anchored a closing-brace replacement to the fixture's end; UI wording was also made precise. An intermediate run passed twelve tests in 8.3 seconds but overlapped those edits, so the separate frozen run supplies final browser evidence. Screenshots now go to test output directories rather than overwriting historical evidence.

The privately retained destination verification receipt `checks/zkchat-applied.json`, transfer receipt `checks/zkchat-transfer.json`, and their [published receipt and log digests](PD-zkchat-integration.json) retain these separate scopes. This work performed no provider inference, public-chain transaction or funding action. Live Phantom, hosted public-profile delivery, real provider/CORS acceptance, and PD-09 native public transport remain separate requirements.
