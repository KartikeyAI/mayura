# First-agent API and progressive developer experience

Status: experimental first-agent contract. The basic tools/runtime slice is under development; later profile guarantees and release gates remain requirements, not completed capabilities.

Mayura is an independent, open-source TypeScript framework for developers building their own agents. A developer should be able to understand the smallest complete agent without learning storage, deployment, orchestration, or Mayura's internal package graph first. Small examples must preserve the same schema, authorization, bounded-execution, and result contracts used by larger applications.

## 1. Product boundaries

- The basic SDK must install without a native build, database, Docker, browser download, server, or an unused model provider SDK.
- The reference execution runtime targets the documented Node.js support range. Browser clients are separate entry points and do not import privileged runtime code.
- Model adapters, persistence, memory, sandbox workers, and UI packages are explicit optional dependencies.
- Local development requires neither a Mayura account nor a Mayura-hosted service. Telemetry is off unless the application configures an exporter.
- Agent and tool definitions do not change when the application changes execution profile. Configuration adds guarantees; it must not silently change their business behavior.
- `ephemeral` means process-local and non-durable. It is not a production durability shortcut. No durable wait, restart-safe approval, persistent audit, or external-effect recovery guarantee may be inferred from it.
- Package names in examples are proposed workspace names, not an assertion of npm namespace ownership or a publication commitment.

## 2. Smallest complete, credential-free recipe

This recipe tests the runtime protocol using a deterministic fixture. It is not a real language model, does not interpret the instructions, and must never be presented as evidence of agent reasoning quality. A separate real-provider recipe follows in Section 6.

```ts
import { createRuntime, defineAgent } from "@mayura/runtime";
import { defineTool } from "@mayura/tools";
import { scriptedModel } from "@mayura/testing";
import { z } from "zod";

const add = defineTool({
  id: "math.add",
  version: "1.0.0",
  description: "Add two finite numbers.",
  input: z.object({ left: z.number().finite(), right: z.number().finite() }),
  output: z.object({ sum: z.number().finite() }),
  effects: "none",
  capabilities: [],
  execute: async ({ left, right }) => ({ sum: left + right }),
});

const calculator = defineAgent({
  id: "calculator",
  version: "1.0.0",
  instructions: "Use math.add to calculate the requested sum.",
  input: z.object({ request: z.string() }),
  output: z.object({ answer: z.number().finite() }),
  tools: [add],
  model: scriptedModel([
    {
      type: "tool_calls",
      calls: [{ id: "add-1", toolId: "math.add", input: { left: 2, right: 3 } }],
      usage: { costMicros: 0 },
    },
    { type: "final", output: { answer: 5 }, usage: { costMicros: 0 } },
  ]),
});

const runtime = createRuntime({
  profile: "ephemeral",
  permissions: { allow: ["model:scripted", "tool:math.add"] },
  limits: {
    maxSteps: 8,
    maxModelCalls: 4,
    maxToolCalls: 4,
    maxDurationMs: 10_000,
    maxOutputBytes: 65_536,
    maxCostMicros: 0,
  },
});

const run = runtime.submit(calculator, {
  input: { request: "What is 2 + 3?" },
});
const result = await run.result();

if (result.status === "succeeded") {
  console.log(result.output.answer); // Inferred number; prints 5.
} else {
  console.error(result.status, result.error.code);
}
```

The recipe uses only public exports. Zod is the application's schema library, not a required dependency of the basic Mayura runtime. Another Standard Schema-compatible validator can replace it without changing the runtime contract.

The runtime validates the expected tool's availability, executes it through the ordinary broker, and validates its output. Script exhaustion, unavailable tools, invalid arguments, or invalid final output are errors; the fixture must not manufacture a successful run. The fixture does not consume paid-model credits, open network connections, or need credentials. Even this fixture requires an explicit `model:scripted` grant. Scripted responses form a consumable test sequence; create a fresh fixture for an independent test scenario.

## 3. Definition contracts

### `defineTool`

Required fields are `id`, `version`, `description`, `input`, `output`, `effects`, `capabilities`, and `execute`. Definition IDs are stable application-owned identifiers. A version identifies immutable behavior/schema metadata for a registered deployment; developers must change it when compatibility-relevant behavior changes.

`input` and `output` implement Standard Schema validation and type inference. The executor receives the validated input, not the original unchecked input. Its resolved value is validated against the output schema before any consumer receives it. The final runtime value must also satisfy Mayura's JSON serialization contract: finite JSON primitives, arrays, and plain string-keyed objects; no cycles, functions, `undefined`, bigint, dates, class instances, or implicit `toJSON` execution. Schemas and values are subject to depth and byte limits.

Validation may be asynchronous. Validation issues become stable framework error codes with a safe explanation; raw secrets and schema-library exception internals are not copied into public errors. Safe field-path diagnostics are a later release requirement. Standard Schema alone does not guarantee JSON Schema export. The basic contract accepts separately supplied `inputJsonSchema` metadata. A provider's required JSON Schema must be explicitly supplied and qualified; automatic schema conversion is not part of the initial tool slice. Later exporter support must reject unsupported transformations or constraints rather than silently weakening them.

`effects` is one of `"none"`, `"read"`, `"write"`, or `"host"`; `capabilities` declares additional authority needed to perform the operation. Every invocation requires `tool:<id>`, every declared capability, and `effect:<effects>` unless its effect is `"none"`. Thus the example grants the exact pure tool, not all pure tools. The effect category does not grant permission on its own. Unknown capabilities and undeclared tool calls are denied. Effect/resource-specific restrictions remain part of the broker policy rather than being inferred from a tool description.

The executor's second argument is a bounded execution context: cancellation signal, run/step identity, and approved broker facilities where supported. It must not expose credentials, database handles, the entire registry, or an unrestricted parent runtime by default. The exact context interface belongs to the core contract specification.

Important trust boundary: an in-process JavaScript callback is trusted application code. Its declaration is not a sandbox, and Mayura cannot prevent a malicious callback from importing Node APIs itself. Only qualified isolated workers can enforce operating-system restrictions for untrusted code. Documentation must state this next to custom-tool examples.

The tool definition contains no public executor method. `invokeTool` is the standalone broker path and preserves the same permission, validation, guard, budget, and timeout gates as an agent invocation. A trusted executor may call `context.reportUsage({ knownCostMicros, unknownCostMicros })` exactly once inside its declared `costMicros` bound; omission conservatively uses the full declared cost, while unresolved usage withholds success. The experimental internal composition options `beforeDispatch` and `onExecutionReceipt` let a trusted durable adapter verify a stored claim against the exact immutable processed input, then atomically record the receipt and settlement before output validation or disclosure. They cannot modify input or grant denied authority. A failed claim check prevents execution; failed or timed-out receipt persistence withholds output and reports an uncertain outcome without repeating the handler. These are mandatory admission/persistence seams, not observational hooks.

### `defineAgent`

Required fields are `id`, `version`, `model`, `instructions`, `tools`, `input`, and `output`. The model is an explicit adapter, not a hidden globally selected vendor. Tools are an explicit registry local to the agent definition, not everything installed in the application.

The initial API accepts a fixed instruction string and a typed JSON input. Instruction-building hooks and additional convenience overloads are deferred until the basic contract is validated. The instructions are guidance, never an authorization mechanism or a safe place to store secrets.

The runtime validates submitted input before model invocation, validates tool arguments before execution, validates tool output before returning it to the model, and validates final agent output before success. Input, retrieved material, and tool output retain their lower-trust origin; they cannot turn themselves into system instructions or grant capabilities.

The model adapter declares capabilities such as structured output and tool calls. Unsupported required behavior fails explicitly. A model response containing multiple calls follows the shared broker's batch admission rules; parallel execution cannot exceed the same run's permissions or limits.

The experimental runtime validates the entire model-response envelope and preflights all tool names, unique call IDs, permission grants, input schemas, and declared batch cost before starting its first tool. Calls then execute sequentially; parallel execution is not yet an implemented guarantee. Tool-specific guards run inside each broker invocation and can stop a later call after an earlier authorized call has completed. Agent `guards.input` run before the initial model dispatch. Agent `guards.output` run before releasing the final answer and before returning any tool result to the model; tool-specific guards are additional checks, not replacements.

## 4. Runtime and handle contracts

### `createRuntime`

An execution profile is required. The initial basic implementation supports only `profile: "ephemeral"`; unsupported profiles throw a configuration error before any effect. A durable adapter must never silently degrade to ephemeral behavior after a connection or storage failure.

`permissions` is default-deny for tool invocation and effects. Omitting a grant never means “allow everything.” Requested authority is intersected with the runtime's policy; agents, model output, tools, and child work cannot expand it. Provider network calls require a scoped model capability just as filesystem, infrastructure, or message-sending tools require their own capabilities. A test fixture has no external model effect.

Limits are finite and validated when the runtime is created. The first implementation must bound steps, model calls, tool calls, elapsed time, input/output size, event retention, and concurrent work. Documentation supplies sensible safe defaults while showing explicit values in the first-agent recipe. A provider-backed runtime additionally requires a priced budget or an explicitly documented non-monetary usage cap; the runtime must not advertise hard currency enforcement without reliable admission estimates and accounting.

Runtime limits in the in-process profile are cooperative. An `AbortSignal` and elapsed-time rejection do not kill an arbitrary callback or undo an external operation. The runtime stops dispatching new work, reports the proper outcome, and never claims cancellation proves a transmitted effect did not happen. Hard CPU/memory termination requires a separately qualified worker profile.

### `runtime.submit(definition, { input })`

Submission validates the registered definition and the input JSON boundary, takes a stable execution snapshot, admits the run against capacity, and returns a handle. Invalid configuration, malformed JSON, or an impossible submission is rejected immediately with a structured error. Asynchronous schema/policy admission and errors arising after acceptance appear in the run result and events, always before an unauthorized effect. Concurrent submissions do not share mutable agent-loop state, although an application-supplied adapter may deliberately be stateful and must meet its own concurrency contract.

### Handle: `id`, `result()`, `observe()`, `cancel()`

`result()` awaits a terminal result and can be called repeatedly. It resolves to a discriminated union; it does not throw for ordinary failed/blocked/cancelled execution outcomes. Programmer misuse and transport failures remain exceptions. The initial terminal statuses are `succeeded`, `failed`, `blocked`, `cancelled`, and `outcome_unknown`. Only `succeeded` contains the validated, inferred output. Other outcomes contain a redacted structured error.

`outcome_unknown` is not success or an automatic retry invitation. It indicates that the framework cannot establish an external operation's outcome or confirm its required persistence. A separate execution receipt preserves known handler success even if persistence or output disclosure fails. Durable profiles add reconciliation evidence; an ephemeral process crash may lose even the local record, which is why that profile cannot promise recovery.

`observe()` returns an async iterable of versioned, monotonically sequenced public run events. Events expose progress, tool lifecycle, policy decisions, and terminal outcome without raw credentials, system instructions, or unapproved output. Terminal observation completes. Iteration is cancellable and bounded; slow consumers cannot create an unbounded memory queue. A lost sequence range is explicitly reported instead of pretending replay is complete. Ephemeral retention and cursors are valid only for the process lifetime.

`cancel()` requests cancellation idempotently. It does not erase history or bypass effect reconciliation. Observer disconnect does not implicitly cancel a run. Cancellation racing with completion follows a single defined terminal-state transition; repeated `result()` calls see the same result.

### Errors

Public errors contain stable `code` and safe `message`; run/call identity is available from the handle, events, and receipts. Examples include `INVALID_INPUT`, `INVALID_OUTPUT`, `NOT_FOUND`, `PERMISSION_DENIED`, `LIMIT_EXCEEDED`, `UNSUPPORTED_PROFILE`, and `OUTCOME_UNKNOWN`. Codes are part of the versioned public API. A retriable error does not authorize replay of an effect whose outcome is unknown.

## 5. Progress without a second execution API

```ts
const run = runtime.submit(calculator, {
  input: { request: "What is 2 + 3?" },
});

for await (const event of run.observe()) {
  console.log(event.sequence, event.type);
}

const result = await run.result();
```

This is the same run handle, not a separate “streaming agent” definition. A browser client uses the equivalent authenticated server transport later; privileged agent definitions and credentials stay on the server.

## 6. Real-provider journey

The second tutorial must use an actual supported provider adapter, clearly separated from the scripted fixture. It changes the `model` configuration and adds the provider's scoped permission and usage budget; it does not rewrite the tool or agent contracts. The exact adapter factory and authentication fields are specified in the provider adapter contract rather than invented here.

The tutorial must cover obtaining/configuring a credential without embedding it in source, selecting a tool-capable model, expected cost exposure, timeouts, cancellation limitations, structured-output support, and actionable authentication/rate-limit errors. Credentials are provided to the adapter by the application and never serialized into definitions, events, or fixtures. No fake successful fallback is permitted when the provider is unavailable.

The release gate requires both tutorials to execute against packed release artifacts: the first offline and credential-free, the second in a controlled opt-in integration environment. No live paid call runs in ordinary unit tests.

## 7. Progressive infrastructure journey

| Step | Developer change | Guarantee change |
| --- | --- | --- |
| Basic agent | Install core, chosen schema library, and chosen model adapter | Typed, bounded, authorized execution; process-local state only. |
| Durable local | Add a qualified local storage/worker adapter and select its explicit profile | Durable events, supported checkpoint boundaries, restart-safe waits, and recorded effects. |
| Self-hosted server | Configure server authentication, PostgreSQL, workers, and client | Authenticated multi-client access, shared scheduling, and scoped durable state. |
| Optional capability | Add memory, context, Code Mode, integrations, or UI | Only that capability's documented and tested guarantees. |

Do not show a durable configuration example before its adapter contract is implemented and tested. The same definition must pass cross-profile conformance tests; only the runtime construction and transport change. Profile-specific operations fail clearly where unsupported.

## 8. Developer-experience release gates

1. The complete first recipe type-checks and runs from a clean install using only public package exports and no unsafe casts.
2. Tool argument inference, executor return checking, submitted agent input, and final result inference have positive and negative consumer type tests.
3. Invalid input never invokes a model or tool. Invalid tool output never reaches the model. Invalid agent output never reports success.
4. An effectful tool without a grant is rejected before its callback is invoked. A model cannot request an unregistered tool or grant itself authority.
5. The fixture tutorial runs offline with no secrets, database, Docker, native modules, implicit downloads, or telemetry.
6. Cancel, timeout, output-size limits, model-call limits, tool-call limits, event overflow, and concurrent submissions have deterministic tests.
7. In-process cancellation limitations and non-durability appear in the quickstart, not only in an advanced security page.
8. Packed-package import tests verify ESM entry points, declarations, package exports, optional dependency isolation, and the declared operating-system support matrix.
9. The real-provider recipe has recorded opt-in integration evidence and does not disguise a fixture as a real agent.
10. Beginner walkthroughs measure clean-install success, time to first run, and common error recovery. Dependency size, import time, and consumer type-check cost receive explicit budgets before stable release; unmeasured targets are not marketing claims.
11. Documentation separates implemented stable, implemented experimental, planned, and unsupported features. A small initial package is never labeled fully enterprise-grade merely because this specification exists.

## 9. Next specification boundary

Freeze the shared JSON value, schema, effect/capability, model request/response, error, event, and terminal-result types. Then implement the smallest recipe with tests before adding ergonomic overloads. Durable storage, approvals, workflow graphs, and server transports must reuse these contracts instead of creating parallel agent APIs.
