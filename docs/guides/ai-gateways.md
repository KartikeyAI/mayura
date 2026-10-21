---
title: "AI gateways"
description: "Registry providers for Vercel, Cloudflare, OpenRouter, Portkey, Helicone and LiteLLM, with explicit credentials and bounded billing."
---

Gateway packages implement the [model registry](model-registry.md) provider contract. Each model keeps its own
`model:<gateway>/<model>` permission, the runtime reserves a finite call bound before sending it, and gateway tool
calls pass through the same scoped permissions, authorizer and approval boundaries as direct providers.

| Package | Factory | Registry prefix |
| --- | --- | --- |
| [Vercel](../integrations/gateway-vercel.md) | `vercelGateway` | `vercel/` |
| [Cloudflare](../integrations/gateway-cloudflare.md) | `cloudflareGateway` | `cloudflare/` |
| [OpenRouter](../integrations/gateway-openrouter.md) | `openrouter` | `openrouter/` |
| [Portkey](../integrations/gateway-portkey.md) | `portkey` | `portkey/` |
| [Helicone](../integrations/gateway-helicone.md) | `helicone` | `helicone/` |
| [LiteLLM](../integrations/gateway-litellm.md) | `litellm` | `litellm/` |

## Prices and scope

Supply host prices or an explicitly opted-in dated host catalog. Discovery returns bounded model names only; it
cannot change prices, permission grants or model selection. The discovery permission is `gateway:<id>:models`.
Cloudflare's unified inference profile currently has no discovery route in this adapter. Other profiles support
one bounded GET against their documented model endpoint; large or paginated listings require a separate host catalog.

The adapters charge at least the configured token cost and any returned USD `usage.cost`; LiteLLM also reports a
native `x-litellm-response-cost` header. These are alternative views of a single call, so accounting takes their
maximum instead of adding them. Decimal charges round up to micros, including scientific notation. Invalid charges
refuse the response; there is no assumption that missing token counts mean free work. Long-context prices are applied
to the whole call once the host threshold is exceeded. Known usage survives malformed output and truncated streams.

The runtime enforces its own reservation and usage accounting; the gateway must also be configured to bound server-side
fallbacks, retries and surcharges. Mayura sends one inference request per attempt, performs no result lookup that could
repeat paid work, and does not enable remote tools or plugins. OpenRouter parameter forwarding is required and its
provider fallback is disabled. Other gateways retain their server-side policies, which the host must review.

Use a separate registry/provider instance per credential scope. Prompts, history, tools and admitted media leave the
host for the configured HTTPS gateway. Keys are explicit and remain on the server. No gateway settings are inferred
from model output. Native model/history/output/approval guards still apply; reasoning and partial tool arguments are
not released as output deltas.

## Qualification harness and current status

`scripts/gateway-live-check.mjs` selects exactly one gateway. It requires an explicit `--allow-paid` flag and reads
only that gateway's named variables under `MAYURA_LIVE_GATEWAY_<ID>_`:

- `MODEL`, `API_KEY`, `INPUT_MICROS_PER_MILLION_TOKENS`, `OUTPUT_MICROS_PER_MILLION_TOKENS`;
- `MAX_CALL_COST_MICROS` and `MAX_TOTAL_COST_MICROS` (at least five call bounds);
- `BASE_URL` for LiteLLM, optional HTTPS override for the others;
- `ACCOUNT_ID` and `GATEWAY_ID` for Cloudflare, or `PROVIDER` for Portkey.

The three checks exercise structured output, a local no-effect tool, and guarded streaming through real Mayura runs.
They admit at most five paid model calls, never retry, stop after the first failed check, and print fixed status
metadata only. The total admission ledger retains each check's full bound. It cannot guarantee a gateway bill below
that bound when host prices or remote policies are incorrect. Run it only after the development phase, dependency
installation and the normal build, with a dedicated bounded gateway key. No live check has been run for this slice.

Offline tests use fake transports and fixture credentials, covering denied model/discovery grants, cancellation,
timeouts, response bounds, authentication, tool/history projection, cost floors and failed or truncated responses.
Offline tests, type checks, builds and package compatibility passed locally. The paid gateway harness and live gateway qualification have not been run. See [release validation status](release-readiness.md).
