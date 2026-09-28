---
title: "Code Mode"
description: "Run small JavaScript programs, including model-written ones, in a sandbox that can call only the tools you allow."
---

Code Mode runs a small JavaScript program in a sandbox instead of in your process. The program gets a JSON input,
may call the tools you list for it, and returns a JSON output. Use it when a model should write a short program that
calls tools in a loop or combines their results, instead of making one tool call per model step, or when you need to
run code you do not fully trust. The program never touches your process: every tool call goes back through your own
tool broker, with its permissions, budget and guards.

```ts
import { createQuickJsSandboxAdapter } from 'mayura/adapter-code-quickjs';
import { createCodeMode, defineCodeProgram } from 'mayura/code-mode';
import { Budget, defineTool, invokeTool, type JsonValue, type Outcome } from 'mayura';
import { z } from 'zod';

const price = defineTool({
  id: 'catalog.price', version: '1', description: 'Price of one product in cents.',
  input: z.object({ sku: z.string() }), output: z.object({ cents: z.number().int() }),
  effects: 'read', capabilities: [], costMicros: 0,
  execute: async ({ sku }) => ({ cents: sku.length * 100 }),
});

const program = defineCodeProgram({
  id: 'catalog.total', version: '1', intent: 'Add up the prices of several products.', language: 'javascript',
  source: `async (input, tools) => {
    let total = 0;
    for (const sku of input.skus) {
      const result = await tools.call('catalog.price', { sku });
      if (result.status !== 'succeeded') throw new Error('price lookup failed');
      total += result.output.cents;
    }
    return { totalCents: total };
  }`,
  input: z.object({ skus: z.array(z.string()).max(20) }),
  output: z.object({ totalCents: z.number().int() }),
  inputSchemaId: 'catalog.skus.v1',
  outputSchemaId: 'catalog.total.v1',
  tools: [price],
  limits: { cpuMillis: 200, wallTimeMillis: 5_000, memoryBytes: 32 * 1024 * 1024, scratchBytes: 1_024,
    maxInputBytes: 4_096, maxOutputBytes: 4_096, maxToolInputBytes: 1_024, maxToolCalls: 20, maxToolConcurrency: 1 },
});

const budget = new Budget(0, 20);
const mode = createCodeMode({
  adapter: createQuickJsSandboxAdapter(),
  allowTestAdapter: true,
  invokeTool: (tool, input, context) => invokeTool(tool, input, {
    runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
    permissions: { allow: [`tool:${tool.id}`, 'effect:read'] }, budget,
  }) as Promise<Outcome<JsonValue>>,
});

const outcome = await mode.execute(program, { skus: ['ab', 'cde'] }, {
  runId: 'run-1', executionId: 'run-1:total', scope: { principalId: 'local', projectId: 'demo' },
  signal: AbortSignal.timeout(10_000),
});
console.log(outcome.status, outcome.status === 'succeeded' ? outcome.output : outcome.error.code, outcome.usage);
```

The QuickJS adapter needs two optional packages: `npm install quickjs-emscripten-core @jitl/quickjs-wasmfile-release-sync`.

## Programs

`defineCodeProgram` captures a program without running it. The definition gets a SHA-256 `digest` over its source,
tools, limits and metadata; approvals and audit records refer to that exact digest.

| Option | Notes |
| --- | --- |
| `id`, `version`, `intent` | Identity, and a short description of what the program is for (shown to approvers). |
| `language` | `'javascript'`. The QuickJS sandbox runs JavaScript only. |
| `source` | A function expression `(input, tools) => output`, sync or async. Up to 1 MiB. |
| `input`, `output` | Schemas for the program's input and result. The result is validated before you receive it. |
| `inputSchemaId`, `outputSchemaId` | Stable names for those schemas, recorded in the manifest. |
| `tools` | The only tools the program may call, up to 128. |
| `limits` | Required; see below. |

Inside the sandbox, `tools.call(toolId, input)` returns `{ status, output }` on success or `{ status, error }` with a
public error code otherwise. It never throws for a tool failure, so the program decides what to do. Calling a tool
that is not in `tools` returns `PERMISSION_DENIED`. There are no imports, no network, no filesystem and no clock
beyond what the sandbox provides.

## Limits

Every limit is required, so each program states its own ceiling.

| Limit | Meaning | Maximum |
| --- | --- | --- |
| `cpuMillis` | CPU time inside the interpreter | 1 hour |
| `wallTimeMillis` | Total time, including tool calls; then `TIMEOUT` | 1 hour |
| `memoryBytes` | Interpreter heap | 2 GiB |
| `scratchBytes` | Temporary disk (Docker sandbox) | 2 GiB |
| `maxInputBytes`, `maxOutputBytes` | Program input and output as JSON | 16 MiB |
| `maxToolInputBytes` | Each tool call's input | 16 MiB |
| `maxToolCalls` | Tool calls per execution | 10,000 |
| `maxToolConcurrency` | Tool calls in flight at once; at most `maxToolCalls` | 128 |

## Running a program

`createCodeMode({ adapter, invokeTool })` returns an executor. `invokeTool` is your broker: it receives the tool, the
input the program sent and a context with `runId`, `callId`, `scope`, `signal` and the program digest, and returns the
tool's outcome. Calling `invokeTool` from `mayura` (as above) applies the tool's schemas, guards, permissions and
budget.

`mode.execute(program, input, { runId, executionId, scope, signal })` returns an outcome plus `usage`: tool calls made,
known cost, unresolved cost and the program's maximum possible cost. `executionId` must be unique for the executor.

| Result | When |
| --- | --- |
| `succeeded` | The program returned a value that passed the output schema. |
| `failed` with `TOOL_FAILED` | The program threw, or the sandbox failed. Details are withheld. |
| `failed` with `INVALID_INPUT` or `INVALID_OUTPUT` | Input or result did not match its schema or size limit. |
| `failed` with `TIMEOUT` | `wallTimeMillis` passed. |
| `outcome_unknown` | A tool call's result is unknown (for example it timed out mid-effect). The program's return value is discarded; reconcile the effect. |
| `failed` with `UNSUPPORTED_PROFILE` | The sandbox is not available on this machine. Mayura never falls back to running code in-process. |

## Sandboxes

| Adapter | Import | Isolation |
| --- | --- | --- |
| QuickJS | `createQuickJsSandboxAdapter()` from `mayura/adapter-code-quickjs` | A QuickJS WebAssembly interpreter in a separate Node.js child process with an empty environment, memory and CPU limits. |
| Docker | `createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance })` from `mayura/adapter-code-docker` | The same interpreter inside a container: no network, read-only root, non-root user, no capabilities, PID, memory, CPU and file limits, a small `tmpfs`. |

Both adapters are marked `test`. `createCodeMode` refuses a `test` adapter unless you pass `allowTestAdapter: true`,
which is your explicit decision that this isolation is enough for the code you run. Mayura does not currently ship an
adapter marked `production`; for hostile code, run the Docker adapter on hardened hosts you control, or wrap your own
sandbox with `defineSandboxAdapter({ id, version, qualification, isAvailable, execute })`.

The Docker adapter takes an absolute path to the Docker CLI and exact `sha256:` digests for a locally built image and
its SPDX provenance document; it never pulls images or looks up `docker` on the `PATH`. Build the image from the
[Dockerfile in the repository](https://github.com/KartikeyAI/mayura/blob/main/packages/adapter-code-docker/image/Dockerfile).
`createPromotedDockerQuickJsSandboxAdapter` additionally requires a signed statement that the image passed a clean
vulnerability scan, and checks it before every run.

## Approvals and durable phases

`mayura/code-mode-workflows` turns programs into steps of a [durable workflow](durable-workflows.md). Every phase
requires a human to approve the exact program digest before it runs, and every execution writes an audit record of
the nested tool calls.

```ts
import { createDurableCodeAudit, defineDurableCodeWorkflow } from 'mayura/code-mode-workflows';

const audit = createDurableCodeAudit({ store, scope: { principalId: 'local', projectId: 'demo' } });
const workflow = defineDurableCodeWorkflow({
  id: 'catalog.quote', version: '1', input: program.input, output: program.output,
  codeMode: mode, audit,
  phases: [{ id: 'total', program, input: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'total', path: [] },
});
```

Run it with `createScheduledWorkflowRuntime` from `mayura/workflows`. The run waits at each phase until someone calls
`runtime.approve` with that phase's approval digest; see [approvals and human input](approvals-and-human-input.md).
Each phase becomes a tool whose `capabilities` (`code:execute`, `code:audit:v2`, the audit scope and the program
digest) you grant to the runtime, together with `tool:<phase tool id>`. The phase takes the strongest effect of its
nested tools and reserves the program's maximum tool cost up front, releasing what it did not use. A phase allows at
most 64 tool calls. `audit.inspect(runId, phaseId)` returns the stored record.

The [`code-mode-workflow` template](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/templates/code-mode-workflow.ts)
is a complete, runnable version.

## Good to know

- The program cannot hide an uncertain tool call: if any call's result is unknown, the execution is `outcome_unknown`
  whatever the program returns.
- Durable phases persist only JSON input, output and evidence. A crash mid-phase does not resume the program; a phase
  with write effects that was interrupted is reported as `outcome_unknown` and is not replayed automatically.
- Nothing in Code Mode decides whether generated code is correct or safe to approve. The approver sees the program's
  `intent`, tools, limits and source; review them.

## Related

- [Tools](../concepts/tools.md)
- [Durable workflows](durable-workflows.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Permissions](../concepts/permissions.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
