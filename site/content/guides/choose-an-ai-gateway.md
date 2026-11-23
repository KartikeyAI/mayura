---
title: "Put an AI gateway behind explicit agent budgets"
description: "Connect Vercel, Cloudflare, OpenRouter, Portkey, Helicone or LiteLLM while keeping model identity, credentials, permissions and cost bounds on the host."
date: 2026-10-23
tags: gateways, providers, budgets, authorization
---

A gateway can centralize access to models, but the application still needs to decide who may call which model and
how much a run may spend. Mayura 1.2 ships six optional gateway packages alongside its provider adapters.
The gateway does not replace the runtime's scope, grants, schemas or budget.

## Choose the connection boundary

| Gateway | Mayura package |
| --- | --- |
| Vercel AI Gateway | `@mayurajs/gateway-vercel` |
| Cloudflare AI Gateway | `@mayurajs/gateway-cloudflare` |
| OpenRouter | `@mayurajs/gateway-openrouter` |
| Portkey | `@mayurajs/gateway-portkey` |
| Helicone | `@mayurajs/gateway-helicone` |
| LiteLLM | `@mayurajs/gateway-litellm` |

Select a package from the [gateway configuration guide](../../../docs/guides/ai-gateways.md), then configure its
credential, model identity and any supported bounded discovery explicitly. Credentials belong on the host.
An endpoint or model name supplied by conversation text is not a reviewed routing decision.

## Keep a local accounting ceiling

Declare prices and a finite per-call cost bound before admission. The runtime reserves the maximum before starting
the call; a call that does not fit cannot begin. Gateway-compatible usage accounting takes the maximum of host-priced
token usage and gateway-reported USD cost rather than trusting the smaller number.

Review long-context pricing, output limits and discovery bounds for the selected adapter. A gateway's account
balance is not a tenant budget, and a fallback route must not quietly widen destination permissions.

## Test the application before the provider

Keep the [offline notebook](choose-a-starter.md) or a scripted agent case as a regression fixture while replacing
its model. Give the new model an explicit grant and a finite run budget. Test rejection, malformed responses,
cancellation and timeouts with fake transports before spending against a real endpoint.

The gateway adapters passed offline conformance and package checks. Paid inference, live gateway accounting and
remote discovery remain separate [release qualifications](../../../docs/guides/release-readiness.md).
Repeat those checks for the exact gateway configuration and deployed model you will operate.

## Follow the detailed contracts

- [AI gateways](../../../docs/guides/ai-gateways.md): adapter setup and cost/discovery boundaries.
- [Model registry](../../../docs/guides/model-registry.md): names, prices and fallback chains.
- [Costs and budgets](../../../docs/concepts/costs-and-budgets.md): admission and accounting.
- [Authorization](../../../docs/guides/authorization.md): who may run a model or disclose its result.
