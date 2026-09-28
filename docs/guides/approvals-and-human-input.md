---
title: "Approvals and human input"
description: "Stop a durable workflow until a person approves an exact tool call or answers a typed question, and respond from code, CLI or UI."
---

Some steps should not happen until a person says so: paying a refund, deleting an account, publishing a post. Others
need information only a person has: a corrected address, a choice between two plans. Mayura handles both inside
[durable workflows](durable-workflows.md), and the run waits in storage, not in memory, for as long as it takes.

- **Approvals.** Mark a tool step with `approval: true`. The run stops before the tool runs, and a person approves the
  exact call: the tool, its version and its validated input.
- **Human requests.** A `human` step asks a typed question and continues with the validated answer as its output.
- **Standalone requests.** `mayura/workstream/humans` stores the same kind of typed question outside any workflow.

## A complete example

This workflow checks a refund and waits for approval before paying it. The approver is verified by `verifyHuman`.

```ts
import { defineTool } from 'mayura';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { z } from 'zod';

const refund = z.object({ refundId: z.string(), amountCents: z.number().int().positive() });

const policy = defineTool({
  id: 'refunds.policy', version: '1', description: 'Check a refund against the refund policy.',
  input: refund, output: z.object({ ok: z.boolean() }), effects: 'none', capabilities: [],
  execute: request => ({ ok: request.amountCents <= 50_000 }),
});
const issue = defineTool({
  id: 'refunds.issue', version: '1', description: 'Issue the refund.',
  input: refund, output: z.object({ receiptId: z.string() }), effects: 'write', capabilities: ['payments:refund'],
  execute: async request => ({ receiptId: `re_${request.refundId}` }),
});

const refunds = defineWorkflowLifecycle({
  id: 'refunds.approval', version: '1', input: refund, output: z.object({ receiptId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'policy', tool: policy, input: { kind: 'input', path: [] } },
    { kind: 'tool', id: 'issue', tool: issue, input: { kind: 'input', path: [] }, dependsOn: ['policy'], approval: true },
  ],
  result: { kind: 'step', stepId: 'issue', path: [] },
});

// Credentials are objects your authenticated code creates; request data can never forge one.
const approvers = new WeakMap<object, string>();
const credentialFor = (personId: string): object => { const credential = {}; approvers.set(credential, personId); return credential; };

const store = createSqliteStore({ filename: ':memory:' });
await store.initialize();
const runtime = createWorkflowLifecycleRuntime({
  store,
  scope: { principalId: 'refunds-service', projectId: 'shop' },
  permissions: { allow: ['tool:refunds.policy', 'tool:refunds.issue', 'payments:refund', 'effect:write'] },
  policyVersion: '1',
  maxCostMicros: 0,
  verifyHuman: async credential => {
    const id = typeof credential === 'object' && credential !== null ? approvers.get(credential) : undefined;
    if (!id) throw new Error('Unknown approver.');
    return { id, projectId: 'shop', canApprove: true };
  },
});

const run = await runtime.submit(refunds, { input: { refundId: 'rf-1', amountCents: 4_999 }, idempotencyKey: 'rf-1' });
const waiting = await runtime.runUntilSettled(refunds, run.id); // status: 'waiting'

// Show the approver exactly what will run.
const request = await runtime.approvalRequest(refunds, run.id, 'issue');
console.log(request?.toolId, request?.input); // refunds.issue { refundId: 'rf-1', amountCents: 4999 }

if (request) await runtime.approve({ id: run.id, nodeId: 'issue', digest: request.digest, credential: credentialFor('alice') });
const done = await runtime.runUntilSettled(refunds, run.id);
console.log(done.status, done.output); // succeeded { receiptId: 're_rf-1' }

runtime.close();
await store.close();
```

## Approvals

When the run reaches an approval step, it validates the tool input, stores an approval request and ends the wave with
status `waiting`. The request has a `digest` that binds the run, the step, the tool id and version, the exact input and
an expiry time. Nothing runs until someone approves that digest.

- `runtime.approvalRequest(definition, runId, nodeId)` returns what an approver should see: `toolId`, `toolVersion`,
  `input`, `digest` and `expiresAtMs`. The runtime rebuilds it and checks it still matches the digest.
- `runtime.approve({ id, nodeId, digest, credential })` records the approval. `verifyHuman` must return a person in the
  runtime's project with `canApprove: true`; otherwise it fails with `PERMISSION_DENIED`. Approving the same digest
  again is harmless.
- An approval request lapses after `approvalTtlMs` (1 hour by default). On the next pass the run issues a fresh request
  with a new digest, so always approve the digest you just read. An old digest is refused with `CONFLICT`.
- After approval, call `runUntilSettled` again (a worker does this in production) and the tool runs once.

An approval does not grant permissions. The workflow runtime must still allow the tool, its capabilities and its
effect. See [Permissions](../concepts/permissions.md).

## Verifying who responds

`verifyHuman` is the boundary between your authentication and the workflow. It receives an opaque credential and
returns `{ id, projectId, canApprove }`, or throws. Mayura stores only the returned `id`, never the credential. Build
the credential in trusted code after you have authenticated the person, as the example does, and never accept one
that came from request JSON. The `mayura init` approval starter uses the same pattern.

## Human requests

A `human` step asks a person for a typed answer. The answer is validated with the step's `response` schema and becomes
the step's output, which later steps can bind to.

```ts
import type { WorkflowLifecycleNode } from 'mayura/workflows/lifecycle';
import { z } from 'zod';

const pickPlan: WorkflowLifecycleNode = {
  kind: 'human', id: 'pick-plan', dependsOn: ['propose'],
  request: {
    kind: 'plan_selection',
    schemaId: 'migrations.plan-choice', // schemaDigest is derived from the Zod response below
    prompt: 'Choose how to run the database migration.',
    response: z.object({ plan: z.enum(['online', 'maintenance-window']) }),
    context: { kind: 'step', stepId: 'propose', path: ['options'] },
    deadlineAtMs: { kind: 'input', path: ['decideBy'] },
  },
};
```

| Field | Meaning |
|---|---|
| `kind` | `information` (a fact or note), `correction` (a fix to a specific thing) or `plan_selection` (a choice). |
| `schemaId`, `schemaDigest` | A stable name and a 64-hex SHA-256 of your response contract. Forms and clients use them to show the right fields. Leave `schemaDigest` out to derive it from `response` (see [Schema digests](#schema-digests)). |
| `prompt` | What the person sees, up to 1 KiB. |
| `response` | The schema the answer must pass. |
| `context` | Optional binding to JSON shown with the request. It is stored, so include only what the responder may see. |
| `subjectDigest` | Required for `correction`, not allowed otherwise: a binding to the 64-hex digest of the exact thing being corrected. |
| `deadlineAtMs` | Optional binding to an absolute time. If no answer arrives by then, the step is `timed_out` and the run fails. |

To answer from code, read the request, then respond with its digest:

```ts
const request = await runtime.humanRequest(definition, runId, 'pick-plan');
if (request?.status === 'waiting') {
  await runtime.respond(definition, {
    id: runId, nodeId: 'pick-plan', requestDigest: request.digest,
    commandId: 'pick-plan-1', credential, value: { plan: 'online' },
  });
}
```

### Schema digests

A schema digest pins the response contract into the request, so a form built for another version of it cannot answer.
When the `response` validator can describe itself as JSON Schema (Zod 4.2 and later can), leave `schemaDigest` out and
the definition derives it. For a validator that cannot, pass the digest yourself; `schemaDigest` computes it from a
JSON Schema object, and gives your UI the same value:

```ts
import { schemaDigest } from 'mayura/workflows/lifecycle';

const planChoiceDigest = schemaDigest(planChoiceJsonSchema); // 64 hex characters
```

A derived digest follows the JSON Schema the validator produces. If a library upgrade changes that JSON Schema, the
digest changes too, and with it the definition's digest: register the new definition as a new `version`, as for any
other change, or pass the digest explicitly to keep it fixed.

`respond` checks the credential with `verifyHuman` (it does not need `canApprove`). If you have already authenticated
the person yourself, `respondVerified` takes `actor: { id, projectId }` instead of a credential. Repeating the same
command id, person and value is harmless; a different answer to an answered request is refused with `CONFLICT`, and so
is an answer after the deadline. An answer is only data: it never grants a tool permission or approves a step.

## Responding over HTTP, CLI and UI

The [HTTP server](server-and-client.md) exposes both kinds of wait to authenticated callers.

**Approvals** come with the workflow operator API. Pass `approvalCredential` to `lifecycleOperatorTarget`, a function
that turns the authenticated operator's id into a credential your `verifyHuman` accepts (see
[Operating workflows](workflow-operations.md)). A waiting step in the run view then carries `approval.digest`,
`approval.expiresAtMs` and `approval.subject`, the exact tool call. Approving needs the `workflows:control` capability:

```ts
const view = await client.workflow(runId);
const step = view.steps.find(item => item.id === 'issue');
if (step?.approval) {
  await client.approveWorkflow(runId, { revision: view.revision, nodeId: 'issue', approvalDigest: step.approval.digest },
    { commandId: crypto.randomUUID() });
}
```

**Human requests** are served by `createWorkflowLifecycleHumanTransport`. Give it the fleet runtime and the
definitions whose requests it serves, and pass `controller.transport` to the server as `humanRequests`. It finds
pending requests in storage through the fleet index, so nothing is registered and a restart loses nothing. Listing
needs `humans:read`, answering needs `humans:respond`, and the verified caller becomes the responder.

```ts
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHumanTransport } from 'mayura/workflows/lifecycle';

const runtime = createWorkflowLifecycleFleetRuntime(options);
const humans = createWorkflowLifecycleHumanTransport({
  scope: options.scope, runtime,
  // Every version with runs in flight, and the agent whose callers may see and answer its requests.
  definitions: [{ agentId: 'planner', definition }],
});
// Pass humans.transport to the server as `humanRequests`.

const page = await client.humanRequests();
const pending = page.items.find(item => item.status === 'waiting');
if (pending) await client.respondHumanRequest(pending.id, pending.digest, { plan: 'online' }, { commandId: crypto.randomUUID() });
```

- A caller sees a request only in the transport's scope, and only if its identity lists the request's `agentId`.
- The transport lists the requests of active runs (running, waiting or paused), including answered and timed-out ones.
  A run that has finished leaves the index, and its requests with it.
- The runtime must serve the same scope as the transport; a mismatch is refused with `INVALID_CONFIG`.
- Request ids are opaque 64-hex strings, stable for a run and step.
- Without a fleet runtime, create the transport with only `scope` and call `register({ agentId, definition, runtime,
  runId })` for each run instead. Those registrations live in memory: register again after a restart, and call
  `unregister(runId)` when a run finishes.

- **CLI.** `mayura workflow-approve`, `mayura human-list`, `mayura human-get` and `mayura human-respond`. See
  [Operations commands](../cli/operations.md).
- **Operator console.** Shows pending approvals with the exact tool call, and open human requests. See
  [Operator console](operator-console.md).
- **React.** Ready-made typed response forms that bind to `schemaId` and `schemaDigest`. See [React](react.md).

Keep one command id per logical attempt. If a request times out, retry with the same command id; the server returns
the recorded outcome instead of acting twice.

## Human requests outside a workflow

`mayura/workstream/humans` stores a typed request and its answer durably without a workflow run, for example when an
agent tool needs a person's input that your own code will act on later.

```ts
import { createHumanWorkStream } from 'mayura/workstream/humans';
import { z } from 'zod';

const humans = createHumanWorkStream({
  store, scope, streamId: 'address-checks',
  // Decide whether an already authenticated person may answer this request.
  authorize: async ({ actor, request }) => actor.id.startsWith('support-') && request.kind === 'correction',
});
await humans.initialize();

const fixAddress = {
  id: 'order-1001-address', kind: 'correction' as const,
  schemaId: 'orders.address', // schemaDigest is derived from the Zod response below
  prompt: 'The courier rejected this address. Please correct it.',
  response: z.object({ line1: z.string(), postcode: z.string() }),
  subjectDigest: rejectedAddressDigest,
};

await humans.request(fixAddress); // idempotent: the same definition returns the same request
const answered = await humans.respond(fixAddress, {
  commandId: 'fix-1', actor: { id: 'support-7' }, value: { line1: '1 High St', postcode: 'AB1 2CD' },
});
console.log(answered.status, answered.response?.value);
```

`inspect(definition)` returns the current state (`waiting`, `answered`, `cancelled` or `timed_out`), `cancel(id)` closes
a request, and `sweepDeadlines()` expires overdue ones; call it on a schedule. A stream holds at most 128 requests,
and each request or answer is at most 3.5 KiB.

## Good to know

- Approvals are attributed to whatever `id` your verifier returns. If every operator token maps to one service
  identity, every approval is attributed to that identity; put your identity provider in front for per-person records.
- A waiting approval or human request keeps the run `waiting`. The worker wakes it when an approval lapses or a deadline
  passes, and `nextWakeAtMs` tells you when that is.
- In production, approve and respond through the fleet runtime (or the operator API), so the worker's index sees the
  change at once.

## Related

- [Durable workflows](durable-workflows.md)
- [Operating workflows](workflow-operations.md)
- [Operations commands](../cli/operations.md)
- [React](react.md)
- [Operator console](operator-console.md)
