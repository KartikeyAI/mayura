# First agent, without an account

This development preview runs from the checkout; package names are private placeholders and are not published npm install instructions. Use Node 24.14.1 and pnpm 10.17.1, then run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm example
```

The executed [example](../examples/first-agent.mjs) uses only public package exports. It defines a typed addition tool, grants that tool to an agent, executes a deterministic test model, and returns `{"status":"succeeded","output":{"answer":5}}`. No provider credential, Docker service or network request is needed to execute the example after installation. The full maintainer checkout includes optional database dependencies for testing; those are not dependencies of the base agent packages.

## Authoring model

The small `@mayura/sdk` facade provides tools, agents and core contracts through one import. It adds no infrastructure dependency and uses the same definitions and admission broker as direct package imports.

1. `defineTool` declares input/output schemas, effects, capabilities and a trusted handler.
2. `defineAgent` declares instructions, a model adapter, tools and result schemas.
3. `createRuntime({profile:'ephemeral', permissions})` configures bounded process-local execution. No grants are implied by registering a tool.
4. `runtime.submit(agent,{input})` returns a handle immediately. `result()` returns a discriminated outcome; `observe()` exposes bounded metadata events, and `cancel()` requests cooperative cancellation.
5. `runtime.close()` stops admissions, requests cancellation and waits for accepted runs to reach reported terminal outcomes. It cannot kill arbitrary trusted synchronous JavaScript or undo a remote effect.

Zod is the reference validator, not a mandatory framework runtime dependency. Other Standard Schema-compatible validators can be used. TypeScript inference is backed by runtime validation at input, tool and result boundaries. Schemas must produce bounded plain JSON; unsupported values fail before disclosure.

## Adding a real model

The optional `@mayura/provider-openai` Responses adapter is implemented and tested with mocked HTTP. It has not been qualified against a live model in this checkout. Select a model supporting both function calls and strict structured output; supply its exact model ID, your API key, a strict portable output JSON Schema and explicit pricing/budget bounds. Do not reuse the zero-cost fixture configuration for a paid model.

The adapter constructor is `openAIResponses({apiKey, model, outputJsonSchema, maxCostMicros, pricing})`. Pricing fields are `inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens`. Configure the runtime's `limits.maxCostMicros` too, and grant `model:openai.responses`. Every exposed tool needs `inputJsonSchema` as well as its local runtime validator. See [provider contract](specs/model-provider-contract.md) for schema constraints, accounting, private continuation and official protocol references.

Credentials stay in trusted server-side configuration. There is no automatic key discovery, automatic provider fallback, ambient network destination change, public raw reasoning stream or claim that application-calculated costs equal an invoice. Real provider use incurs external charges and requires separate testing authorization/configuration.

## Progressive adoption

| Need | Select | Important boundary |
| --- | --- | --- |
| One bounded agent | `@mayura/runtime` + tools and a model adapter | Explicitly non-durable. |
| Parallel or dependent tools | `invokeBatch` + `batchOutput` from `@mayura/tools` | Exact predecessor JSON paths are revalidated by the broker; handles are process-local and resource keys are not distributed locks. |
| Restartable tool graph and approvals | `@mayura/workflows` + selected SQLite/PostgreSQL adapter | Current conservative engine never automatically replays an uncertain effect. |
| Durable event waits | `@mayura/workstream` + storage | Register and exit; no timer service or signal-to-graph integration yet. |
| Existing scheduled-run completion joins | `@mayura/workstream/executions` + the same selected store | Finite drains return terminal metadata, including explicit unknown outcomes, not source output. |
| Wait inside a scheduled workflow | `@mayura/workflows/graphs` + selected storage | [Format-3 graphs](how-to/workflow-graph-waits.md) pin existing references at submission; explicit driving resumes without holding a waiting worker. |
| Find unfinished graphs after restart | `createWorkflowGraphDiscovery` from `@mayura/workflows/graphs` | [Bounded candidate pages](how-to/workflow-graph-discovery.md), not readiness promises or automatic dispatch; the application owns its page budget and definition registry. |
| Continue a trusted graph catalog | `createWorkflowGraphCoordinator` from `@mayura/workflows/graphs` | [One shared driver](how-to/workflow-graph-coordinator.md), finite pages and original-cursor retry reports; no submissions, approvals or polling service. |
| Run durable workflow trees | `createWorkflowTreeRuntime` from `@mayura/workflows/children` | [Root-local tools and one-level owned children](how-to/workflow-tree-children.md), narrowed authority, exact verified approvals and joins. |
| Persist shared financial accounting | Selected store's `durableBudgets` capability | [Root-transaction reservations](how-to/durable-budgets.md) and exact late evidence; standalone trusted-host primitive, not automatic workflow/child dispatch enforcement. |
| Native content checks | `@mayura/guardrails` | Required parallel barrier; native PII/literal helpers have documented limits. |
| Runtime-owned moderation | `defineModerationGuard` with agent guards | [Shared limits and protected output-check capacity](how-to/managed-guardrails.md); model verdicts remain fallible. |
| Required lifecycle control | `defineHook` + `defineAgent({ hooks })` | [Four awaited stages](how-to/lifecycle-hooks.md), no transforms or permission escalation; action tools use the owning run's broker. |

These packages are experimental surfaces. Self-hosted HTTP, browser clients, child-agent orchestration, provider integrations, full memory/context and qualified Code Mode remain governed by the release ledger. A convenient import is not a promise that an unimplemented deployment profile exists.

The [storage installation guide](how-to/storage-installation.md) separates `@mayura/storage-sqlite` from `@mayura/storage-postgres`. Existing `@mayura/storage` imports continue to select both adapters; custom storage implementations use only the driver-free contracts.

## Interpreting outcomes

Always switch on `status` before reading `output`. `blocked` is a denied admission/disclosure, not a successful empty response. A tool can execute successfully while its output is withheld; inspect its receipt before deciding whether to retry. `outcome_unknown` means the application must reconcile the original operation instead of blindly executing it again. `cancelled` does not promise that an in-flight external action was undone.
