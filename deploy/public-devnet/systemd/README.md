# Public Devnet service units

These unit files are installed by the explicit first-time operator bootstrap.
Follow [operator setup](../../../docs/getting-started/proxy-operator.md) and the
[service-unit manual](../../../docs/getting-started/operators/service-units.md)
for paths, identities, startup ordering and validation. Existing installations
use [same-state maintenance](../../../docs/getting-started/operators/same-state-restart.md).

The units expect the pinned Linux installation in `/opt/zkapi` and existing
durable state mounted at `/srv/zka`. They do not initialize missing state or
automatically restart failed services.
