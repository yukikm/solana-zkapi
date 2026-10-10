# Public preview service units

Follow [direct OpenRouter setup](direct-openrouter.md) for the complete
installation sequence. The unit files remain in
[`deploy/public-devnet/systemd`](../../../deploy/public-devnet/systemd/).

These units run the existing Devnet daemons with separate database roles and
persistent state under the mounted `/srv/zka` volume. Install the reviewed
Linux bundle at `/opt/zkapi`; the macOS client distribution is not a server bundle.
`bootstrap_public_devnet_operator.py` explicitly initializes a new operator from
an independently pinned, decrypted input inventory. It refuses occupied state
and writes a durable initialization marker before creating a database or journal.
An interrupted initialization requires inspection of the exact retained state.
There is no reset, replacement-ledger or replacement-journal path.

The bootstrap does not initialize a provider grant, open public
admission, issue a provider key or send a chain transaction. It installs units
but initially starts only PostgreSQL. Start the signer and indexer, verify signer
reconciliation and finalized indexer catch-up, then start control and challenger.
Enable the gateway only after the explicit spending policy and
exact public profile have been installed. The units are not enabled at boot by
the initializer; enable them only after actual start/restart acceptance.

The database uses Unix sockets with SCRAM authentication for writer, signer,
provider and challenger logins. A root peer mapping is limited to the migration
owner. Writer and signer use distinct database privileges. Control, signer and
the spawned dispatcher retain one OS identity because the existing signer uses
an owner-only socket and dispatcher process boundary. This does not claim
production isolation between those processes. Indexer, challenger and the API
budget gateway have separate OS identities. No private directory is a web root.

There is no automatic process restart. A service failure preserves its state for
inspection. Systemd owns the signer's volatile `/run/zkapi-signer` directory and
removes it only after stopping the managed service; the durable journal remains
under `/srv/zka/signer`. Control stops with SIGINT to invoke its existing graceful
shutdown. Challenger uses its existing SIGTERM handler. Stop control and its
provider children before stopping signer/PostgreSQL; retain all dispatcher claims.
An exact daemon restart is not permission to replay uncertain inference.

These files require target-host `systemd-analyze verify`, actual permissions and
role checks, reconciled startup and same-state recovery verification. Static unit
files or a successful syntax check alone are not live acceptance. Long-term
archive capacity remains outside the currently approved preview qualification.
