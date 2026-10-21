---
title: "Portkey"
description: "Use Portkey as a bounded Mayura model-registry provider with explicit credentials and gateway billing."
package: "@mayurajs/gateway-portkey"
vendor: "Portkey"
logo: "portkey"
website: "https://portkey.ai"
area: "gateways"
---

Install `mayura` and `@mayurajs/gateway-portkey`. The package uses the shared compatible transport from
`@mayurajs/provider-openai`; its dependencies stay outside the core package.

```ts
import { createModels } from 'mayura';
import { portkey } from '@mayurajs/gateway-portkey';

const gateway = portkey({ apiKey: 'your-portkey-key', provider: '@openai' });
const models = createModels({ providers: [gateway], maxCallCostMicros: 50_000 });
// Set these example rates to conservative rates for your gateway model and routing configuration.
const model = models.model('portkey/your-model', { pricing: {
  inputMicrosPerMillionTokens: 3_000_000,
  outputMicrosPerMillionTokens: 15_000_000,
} });
void model;
```

Credentials: `x-portkey-api-key` and a saved `x-portkey-provider` integration. No environment variables are read by the package. `baseURL` is an explicit HTTPS egress
choice; credentials, query strings and fragments in URLs are refused. Never send gateway credentials to a browser.
`headers` cannot replace the package's credential headers or transport headers.

Model calls need the runtime permission `model:portkey/your-model` and a reserved call budget. Native Mayura tool
permissions, authorizers and approvals still apply to any returned tool calls. A gateway cannot grant a tool.
History and native tools use Chat Completions; strict structured output and streaming require a model and route
that forward those features. `output: 'json_object'` explicitly selects JSON mode if needed. Set
`tokenLimitField: 'max_completion_tokens'` when your model requires it. Media is disabled until the host explicitly
sets `media`; support depends on the selected model and route.

Discovery: `GET /models`, scoped to the saved provider integration. `gateway.discovery` indicates whether this profile supports it.
`gateway.listModels({ permissions: { allow: ['gateway:portkey:models'] }, signal })` makes one explicit bounded
request, with no pagination or retry, and returns names only. The response is limited to 1,000 models and 256 KiB,
within the configured timeout. Listing does not install prices, populate the registry or grant model execution.
Do not offer unfiltered discovery results to tenants as an authorization decision.

Billing uses the maximum of configured token pricing and `usage.cost` when the response reports it, rounded up to
whole USD micros. LiteLLM also uses `x-litellm-response-cost`. A present malformed cost refuses the response.
Known usage remains charged if output parsing fails or a stream ends after reporting usage. Token usage is
required even when cost is reported. Optional host `catalog` prices are used only with `prices: 'catalog'`;
this package ships no static gateway price list. Long-context host prices are supported.

Gateway routing, server-side retries, paid plugins and provider surcharges must be bounded by your gateway
configuration and conservative host prices. Mayura adds no transport retry. A reported charge can exceed the
pre-admitted bound; the runtime accounts it and fails the call, but cannot undo upstream spending. A dashboard
estimate or a streaming header unavailable at completion is not a provider billing guarantee.

The common [gateway guide](../guides/ai-gateways.md) describes scope, cost accounting and the owner-run qualification
harness. Offline regression tests, builds and package checks passed locally. The paid harness has not been run; live gateway behavior remains unqualified. See [release validation status](../guides/release-readiness.md).
