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
import { Budget, defineTool, invokeTool, type JsonValue, type Outcome, z } from 'mayura';

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
| `language` | `'javascript'`. The built-in sandboxes run JavaScript only and report `UNSUPPORTED_PROFILE` for `'typescript'`, which exists for custom sandboxes. |
| `source` | One function expression, `(input, tools) => output`, sync or async. Up to 1 MiB. It runs in strict mode. |
| `input`, `output` | Schemas for the program's input and result. The result is validated before you receive it. |
| `inputSchemaId`, `outputSchemaId` | Stable names for those schemas, recorded in the manifest. |
| `tools` | The only tools the program may call, up to 128. |
| `approvedImports` | Module specifiers for custom sandboxes that support imports. The built-in sandboxes support none and report `UNSUPPORTED_PROFILE` if you list any. |
| `limits` | Required; see below. |

Inside the sandbox, `tools.call(toolId, input)` returns `{ status, output }` on success or `{ status, error }` with a
public error code otherwise. It does not throw for a tool failure, so the program decides what to do; it throws only if
`input` cannot be serialized as JSON. Calling a tool that is not in `tools` returns `PERMISSION_DENIED`, and calls past
`maxToolCalls` return `LIMIT_EXCEEDED`. The program sees standard JavaScript (including `Date` and `Math.random`) and
`tools`, nothing else: no imports, network, file system, timers, `console` or `process`.

## Limits

Every limit is required, so each program states its own ceiling.

| Limit | Meaning | Maximum |
| --- | --- | --- |
| `cpuMillis` | Time the interpreter spends running the program. Time spent waiting for tool calls does not count. Then `LIMIT_EXCEEDED`. | 1 hour |
| `wallTimeMillis` | Total time, including tool calls. Then `TIMEOUT`. | 1 hour |
| `memoryBytes` | The program's heap. The interpreter adds a fixed 16 MiB for itself. Then `LIMIT_EXCEEDED`. | 2 GiB |
| `scratchBytes` | Size of the Docker sandbox's `/tmp`. The QuickJS sandbox has no file system and ignores it. | 2 GiB |
| `maxInputBytes`, `maxOutputBytes` | Program input and result as JSON. | 16 MiB |
| `maxToolInputBytes` | Each tool call's input. | 16 MiB |
| `maxToolCalls` | Tool calls per execution. | 10,000 |
| `maxToolConcurrency` | Tool calls in flight at once; at most `maxToolCalls`. | 128 |

JSON values crossing the sandbox boundary may nest at most 32 levels deep and hold at most 100,000 values. Recursion is
limited to roughly 1,500 plain JavaScript frames; deeper recursion throws a catchable `InternalError: stack overflow`.

## Running a program

`createCodeMode({ adapter, invokeTool })` returns an executor. `invokeTool` is your broker: it receives the tool, the
input the program sent and a context with `runId`, `callId`, `scope`, `signal` and the program digest, and returns the
tool's outcome. Calling `invokeTool` from `mayura` (as above) applies the tool's schemas, guards, permissions and
budget. Honour `context.signal`: an execution returns only after every tool call it started has settled.

`mode.execute(program, input, { runId, executionId, scope, signal })` never throws. It returns an outcome plus
`usage`: tool calls made, known cost, unresolved cost and the program's maximum possible cost. Use a new `executionId`
for each execution; the executor rejects one that is running or among the last 100,000 it finished.

| Result | When |
| --- | --- |
| `succeeded` | The program returned a value that passed the output schema. |
| `failed` with `TOOL_FAILED` | The program threw, did not compile, or returned a promise that can never settle; or the sandbox itself failed. |
| `failed` with `LIMIT_EXCEEDED` | The program used more than `cpuMillis` or `memoryBytes`. |
| `failed` with `INVALID_INPUT` or `INVALID_OUTPUT` | Input or result is not plain JSON within its size limit, or does not match its schema. |
| `failed` with `TIMEOUT` | `wallTimeMillis` passed. |
| `cancelled` with `CANCELLED` | Your `signal` aborted. |
| `outcome_unknown` | A tool call's result is unknown (for example it timed out mid-effect). The program's return value is discarded; reconcile the effect. |
| `failed` with `UNSUPPORTED_PROFILE` | The sandbox is not available on this machine, or cannot run the program's language or imports. Mayura never falls back to running code in-process. |
| `failed` with `CONFLICT` | The `executionId` was already used. |
| `failed` with `INVALID_CONFIG` | The program or execute options are invalid; the message names the field. |

Every `error.message` is written by Mayura and names the limit or rule involved; it never contains program text or
tool data. When the program itself threw, the outcome also has `programError: { name, message }`, the error it threw
(at most 128 and 1,024 characters). Show it to the model that wrote the program so it can fix it, but treat it like the
program's output: the program chose that text, and it may contain tool data.

```ts
import type { CodeExecutionOutcome } from 'mayura/code-mode';

function feedback(outcome: CodeExecutionOutcome<unknown>): string {
  if (outcome.status === 'succeeded') return 'ok';
  if (outcome.programError) return `Your program threw ${outcome.programError.name}: ${outcome.programError.message}`;
  return `${outcome.error.code}: ${outcome.error.message}`;
}
```

## Sandboxes

Both built-in adapters are qualified `production`: they meet the guarantees below, and `createCodeMode` accepts them
directly. [Security](../project/security.md#code-mode-sandboxing) explains what each one does and does not protect
against.

| Adapter | Import | Isolation |
| --- | --- | --- |
| QuickJS | `createQuickJsSandboxAdapter()` from `mayura/adapter-code-quickjs` | A QuickJS WebAssembly interpreter in a new Node.js child process per execution, under the Node.js permission model, with hard CPU, memory and stack limits. |
| Docker | `createDockerQuickJsSandboxAdapter({ dockerPath, image, provenance })` from `mayura/adapter-code-docker` | The same worker inside a new container per execution: no network, read-only root, non-root user, no capabilities, limits on processes, memory, CPU and files, a small `tmpfs`, no logs. |

Use QuickJS for programs from a model working for your own users. For programs from many tenants, or when a
sandbox escape must not reach the host's files or network, use Docker, ideally with gVisor (`runtime: 'runsc'`).

### Your own sandbox

`defineSandboxAdapter({ id, version, qualification, isAvailable, execute })` wraps any sandbox. `execute` receives the
program, its input and a `tools` bridge, and returns `{ status: 'succeeded', output }` or
`{ status: 'failed', reason?, programError? }`, where `reason` is one of `program_error`, `cpu_limit`, `memory_limit`,
`invalid_output`, `unsupported_program` or `sandbox_error`. To run Mayura's QuickJS worker inside your own outer sandbox,
use `createQuickJsProtocolAdapter({ id, version, qualification, launch })`.

Declare `qualification: 'production'` only for a sandbox that meets guarantees you have documented and tested.
An adapter declared `'test'` (the default for `createQuickJsProtocolAdapter`) is for fixtures and experiments:
`createCodeMode` throws `UNSUPPORTED_PROFILE` for it unless you pass `allowTestAdapter: true`.

### Docker

The Docker adapter takes an absolute path to the Docker CLI and exact `sha256:` digests for a locally built image and
its SPDX provenance document; it never pulls images or looks up `docker` on the `PATH`. Two options are optional:
`host`, a local daemon socket such as a rootless daemon's (`unix:///run/user/1000/docker.sock` or
`npipe:////./pipe/<name>`), and `runtime`, an OCI runtime such as `runsc`.
`createPromotedDockerQuickJsSandboxAdapter` additionally requires a signed statement that the image passed a clean
vulnerability scan, and checks it before every run.

Build the image from the files in the installed package, and rebuild it whenever you upgrade `mayura`, because the
worker inside must match the adapter:

1. Make a build directory with a `root/` folder. Copy `node_modules/mayura/lib/adapter-code-quickjs/dist/worker.js` to
   `root/worker.mjs`, write `{"type":"module"}` to `root/package.json`, and copy the installed
   `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` and `@jitl/quickjs-ffi-types` packages into
   `root/node_modules/`.
2. Generate an SPDX document for `root/` with your SBOM tool, keep it, and save it as `root/sbom.spdx.json`. Its
   `sha256:` digest is your `provenance`.
3. Copy `node_modules/mayura/lib/adapter-code-docker/image/Dockerfile` into the build directory and run
   `docker build --network=none --build-arg MAYURA_PROVENANCE=sha256:<digest> --tag mayura-code-sandbox .`
4. `docker image inspect --format '{{.Id}}' mayura-code-sandbox` prints the `image` value to configure.

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
most 64 tool calls. `audit.inspect(runId, phaseId)` returns the stored record, which never includes `programError`.

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
- [Security](../project/security.md)
