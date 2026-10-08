# N-01 operator authority and settlement join

At 2026-10-08 07:43:48 UTC, the read-only operator collector joined the completed [native N-01 settlement](PD-native-public-N01.md) to the existing grant reservation and selected signed operator settlement. The collector succeeded; the subsequent local draft assembly failed, so this observation is **not an approved suspension or maintenance cut**. [Machine-readable evidence](PD-N01-operator-join.json) records the exact input hashes.

The request ID, exact AUTH digest `395719fc…662ef`, verified 96-byte successor-signature hash `275b5fdd…eb738`, and 6-micro-USDC charge all match the earlier SDK observation. The exact AUTH digest comes from the retained pending journal and reservation, not the settled history's canonical object digest. The operator additionally supplied message digest `bb55c205…27bbc`; native history does not retain that field, so the join uses the matching request, signature hash and charge rather than claiming an independent SDK digest computation.

The detached grant has one retained 1,000,000-micro-USDC reservation, state SHA `653f4fd1…d61e8`. Its cap reservation is separate from the verified 5,850-nano-USDC receipt, rounded to 6 micro-USDC. The collector wrote no state, submitted no AUTH or inference, changed no service, and transferred no original budget capacity.

The raw outbox query still returns seven rows. The narrowly scoped v9 classifier authenticates all seven as retained terminal checkpoints for this exact settled N-01 and reports zero unresolved work. Session, operation, dispatch and chain unfinished counts are also zero. Full ordered-row and terminal-checkpoint digests are retained; no row was deleted or relabeled in the database. Unknown, extra, orphaned or nonterminal rows remain failures. This operational helper change does not alter production financial runtime behavior.

Five versioned helper sources were installed before collection, with all 61 historical guards preserved. Installation executed none of the delivered helpers and changed no runtime, admission or financial state. The report joins their installed hashes to all 19 frozen local source inputs. Existing helpers and earlier failures remain preserved.

Local assembly then refused its certificate check because it incorrectly required the backup recipient pin in the suspend phase. The original exit-1 report and error hash are retained. A separate local correction is outside this checkpoint; neither approval nor a successful suspension follows from the collector's success. Admission was enabled at the recorded cut.

An earlier 07:30:29 UTC read-only resource sample observed six active services, 3,154,919,424 bytes of available memory, no swap, 18,377,363,456 bytes available on the root filesystem and 17,205,989,376 on the data filesystem. This is one observation, not sustained-capacity qualification.

Funds remain active: the last verified native off-chain balance is 4,999,994 micro-USDC. This report does not establish encrypted backup, same-state restart, withdrawal, OpenClaw N-02/N-03, N-04, or funded browser acceptance. It does not count upstream AUTH or inference packets.
