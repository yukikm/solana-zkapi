# Operator guides

First installation starts with [proxy/operator setup](../proxy-operator.md).
It walks through prerequisites, public deployment inputs, server installation,
configuration, startup and a usable client connection. For credentials, models
and tariffs, use [API provider setup](../api-provider.md).

| Task | Detailed procedure |
|---|---|
| Install the public direct OpenRouter operator | [Direct OpenRouter setup](direct-openrouter.md) |
| Create a fresh setup and deploy/initialize a Devnet Vault and Pool | [Chain deployment](chain-deployment.md) |
| Prepare a new program/Pool profile and service deployment | [Deployment inputs](deployment.md) |
| Assemble the private first-start input inventory | [Bootstrap inputs](bootstrap-inputs.md) |
| Select AWS resources and configure ingress | [Hosting](hosting.md) |
| Configure gateway routes, browser access and invitations | [Gateway](gateway.md) |
| Run an existing local browser application's relay | [Browser relay](browser-relay.md) |
| Select provider spending policy | [Budget](budget.md) |
| Install and supervise the Linux daemons | [Service units](service-units.md) |
| Configure monitoring, isolation and recovery verification | [Operations](operations.md) |
| Investigate a preview outage | [Incidents](incidents.md) |
| Back up and restart the same financial state | [Maintenance](same-state-restart.md) |
| Manage archive growth and recover disk headroom | [Archive storage](archive-storage.md) |

Deployment templates and service-unit files remain under
[`deploy/public-devnet`](../../../deploy/public-devnet/).
Use [support status](../../status.md) to distinguish recorded Devnet acceptance
from production, provider and browser coverage that remains incomplete.
