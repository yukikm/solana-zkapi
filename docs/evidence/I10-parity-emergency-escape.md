# Same-journal emergency escape after unresolved inference

The previous wallet API required `pending === null` for every withdrawal. An accepted AUTH followed by a lost inference response and an unavailable close endpoint therefore blocked the customer's own journal from initiating escape. Earlier public challenge evidence used a separate pre-AUTH journal and did not establish this recovery path.

`WalletClient.beginEmergencyEscape` now explicitly starts a challengeable escape from the last verified private state. It checks the original AUTH deployment, pool, origins, mode and state nullifier, then atomically preserves the entire pending session and previous state in an append-only `wallet.emergencyEscapes` archive before building a transaction. The archive includes exact AUTH bytes, credentials and all original inference intents. It remains encrypted with the note. This is a distinct archive from signed permanent clearance; no unsigned request is represented as clearance, settlement or proof of non-admission.

The unresolved archive fences new authorization, inference, ordinary withdrawal and settlement. Wallet proof creation and the existing exact-signature recovery continue to use the unchanged private state. After the finalized escape receipt and matching Pending account, ordinary deadline checks and finalization apply. Finalization retains the archive and does not manufacture a successor or erase uncertain usage.

If a challenger restores the active Note, explicit `reconcileChallengedEscape` re-verifies the exact saved escape execution receipt and an authenticated finalized Active/absent-Pending account cut at or after that receipt, with an increased tree sequence. It also handles a challenge arriving before the escape execution acknowledgement. It restores a closing-only copy of the saved session; recovery uses status/close calls and the existing receipt and successor verifier, never another AUTH or inference submission. Only a verified terminal successor marks that archive settled. Later sessions can run while prior archive entries remain intact.

A prepared finalization can be cancelled during challenge reconciliation only when unsigned or every saved finalization signature is conclusively finalized rejected. Unknown, expired or successful signed finalizations remain fenced. Cancelled finalizations and their exact signed bytes stay in financial history. Missing accounts, elapsed wall time and a missing receipt cannot release this fence.

Journal validation joins each archive phase to its original request/state, unique financial operation, saved receipt history and challenge barrier. It rejects duplicate archives, premature settled markers, missing or duplicate successor history, modified restored operation bytes and incompatible wallet phases. Existing schema 1 journals without archives retain their meaning; schema 2 explicitly permits the new field. Control and wallet mutations use the existing shared note lock and encrypted CAS rather than a second state machine.

## Local verification

Commands:

```sh
npm run typecheck
node --test --test-reporter=spec packages/sdk/test/wallet-emergency-escape.test.ts packages/sdk/test/wallet-clearance.test.ts packages/sdk/test/wallet-recovery.test.ts packages/sdk/test/control*.test.ts
```

The typecheck and 110 tests passed with zero failures/skips. [Result and input hashes](I10-parity-emergency-escape-results.json) and [test log](I10-parity-emergency-escape-components/focused.txt) are retained. The regression uses real journal encryption, restart, v0 signing and exact signed-message/receipt matching; proof, chain, HTTP and successor responses in this suite are explicit fixtures. It covers:

- Accepted AUTH, one inference with a lost response, close 503, same-journal emergency escape and deadline-gated finalization.
- Archive preservation on reopen, no extra authorization/inference, and native daemon rejection before quote/proof or HTTP dispatch.
- Finalized challenge recovery, invalid successor rejection, receipt/slot/sequence barriers and challenge before execute acknowledgement.
- An original `send_unknown` AUTH recovering through status only after a challenge.
- Unsigned, unknown, successful and finalized-rejected finalization attempts.
- Malformed archive/state/request/operation/receipt relationships and duplicate settlement history.

Separate real-proof/SBF verification is recorded in [I10-parity-pending-escape-sbf.md](I10-parity-pending-escape-sbf.md). This change does not add public RPC, real-provider, Phantom, mainnet or third-party audit acceptance, and it does not alter funded journals, deployment pins or historical receipts. Pool pause/expiry and the existing upgrade, RPC and USDC-issuer trust boundaries still apply.

## Expired buffer-create follow-up

Independent review found a further recovery gap: a signed `initiate_escape` buffer-create transaction that never landed and expired could not enter the existing expired-create reconciliation path. `advance` correctly refused to create another buffer without finalized absence, leaving the setup unresolved.

`reconcileExpiredCreation` now accepts ordinary and emergency escape setup under the same strict all-create, finalized-expiry and anchored absent-buffer checks as deposit and mutual close. It requires an Active matching Note with no Pending account. Before any write, it validates the current private state with the prover and matches the note ID, balance, nullifier, destination binding, no-clearance flag and witness fields against every saved signed escape payload. It also checks the existing destination and financial role/account bindings. Interrupted reproof repeats these state checks and retains the durable finalized cutoff. The operation UUID, state, witness, roles, destination, every original signed attempt and emergency archive remain intact. Reconciliation proves a new buffer plan but signs and sends nothing; AUTH and inference are never resubmitted.

The [expanded follow-up report](I10-parity-emergency-escape-expired-create-results.json) records a successful typecheck and **125 tests, zero failures/skips**, including the existing control, clearance, wallet recovery and expired-create suites. The [follow-up log](I10-parity-emergency-escape-components/expired-create-followup.txt) extends the old expiry failure matrix to both ordinary and emergency escape: unknown/pending/non-expired signatures, success/rejection receipts, changed receipt status, present/wrong/non-finalized buffers, invalid block cutoffs, repeated expiry and non-create attempts are refused. New tests check unchanged signed state/roles/destination/archive, crash-resumed reproof, and native status showing withdrawn funds as closed while retaining the archive. The earlier 110-test result remains historical evidence of its exact source snapshot.
