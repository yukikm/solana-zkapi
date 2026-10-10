# Operations configuration

Begin with [operator setup](../../docs/getting-started/proxy-operator.md).
Monitoring, isolation and restoration procedures are in
[the operations manual](../../docs/getting-started/operators/operations.md);
preview incidents and maintenance are in the
[operator guide index](../../docs/getting-started/operators/README.md).

[`monitoring.json`](monitoring.json) is the tracked metrics/threshold inventory.
The `opsd` binary is built from `services/control`; the local drill is
`python3 scripts/run_i09_operations.py`. Private monitor/admin configurations,
health output and recovery witnesses belong in the operator's protected state
directory, outside source control.
