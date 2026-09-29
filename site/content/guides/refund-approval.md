---
title: "Build a refund agent that pays only after a person approves"
description: "An AI agent triages refund requests, a durable workflow checks policy, and nothing is paid until an operator approves the exact payment. Built from the approval-workflow starter."
date: 2026-09-29
tags: approvals, durable workflows, permissions, starter
---

Refunds are a good first job for an agent with real side effects. Reading a request, sorting it into a category and
judging how risky it is: a model does that well. Moving money is different. You want a person to see the exact
payment before it goes out, the payment to go out exactly once, and a restart halfway through never to lose a
refund or pay one twice.

This guide builds that system from Mayura's `approval-workflow` starter. It runs offline, with no API key, and by the
end you'll have approved a refund in the operator console and know which lines of code make each guarantee hold.

## What you'll build

1. Your support system sends a refund request to an **intake agent**.
2. The agent classifies it, rates its risk and calls one tool, `refunds.open`, which checks the order and starts a
   **durable workflow**.
3. The workflow's `policy` step checks the refund against your limit. Its `issue` step is marked `approval: true`: the
   run stops there and waits.
4. An **operator** sees the exact payment (refund id, amount and currency) and approves it.
5. A worker issues the refund once, then notifies the customer.

The agent can't pay anything. It has no payment tool and no permission to use one. The workflow holds the payment
step, and the workflow only moves past it with a person's approval.

## 1. Create the project

```bash
npx mayura init --starter approval-workflow --directory ./refunds --apply
cd refunds
npm install
npm run dev
```

`npm run dev` builds the project, starts a server and a worker on a local SQLite database, and submits three demo
refunds through the intake agent. It prints the URL of the operator console and two tokens: one for operators and one
for your support system. The tokens are stored in `.data/dev-secrets.json`, so they stay the same across restarts.

It runs offline by default: a small keyword-based stand-in plays the model, so you can follow the whole flow before
choosing a provider. The files you'll look at:

| File | What it holds |
|---|---|
| `src/intake.ts` | The intake agent and its one tool, `refunds.open` |
| `src/workflow.ts` | The refund workflow: its tools, the approval step and a second version |
| `src/auth.ts` | The two kinds of token, and who can approve |
| `src/server.ts` | The server, the workflow runtime and the operator API |
| `test/refunds.test.ts` | The whole flow, run offline |

## 2. The intake agent

The agent's job is judgment, not action: classify the reason, rate the risk, write one sentence for the reviewer, and
open the refund.

```ts
const agent = defineAgent({
  id: 'refunds.intake', version: '1', input: intakeInput, output: intakeOutput, tools: [open], model,
  instructions: [
    'You triage refund requests for a support team.',
    'Classify the reason as damaged, not_received, wrong_item, changed_mind or other.',
    'Rate risk low, medium or high: larger amounts, vague reasons and repeat requests are riskier.',
    'Call refunds.open exactly once with the request fields unchanged plus your category, risk tier and a one-sentence summary for the human reviewer.',
    'Then answer with the refundId and runId it returned and the same category, risk tier and summary.',
  ].join('\n'),
});
```

Its input and output are strict schemas: the request carries a ticket id, customer id, order id, amount in cents and a
reason, and the agent's answer must include the refund id, run id, category, risk tier and summary. A reply in any
other shape is rejected, not passed on.

## 3. The tool that opens a refund

This is the only tool the agent has. It doesn't pay. It checks the request against your order system and starts the
workflow:

```ts
const open = defineTool({
  id: 'refunds.open', version: '1', effects: 'write', capabilities: ['refunds:open'],
  description: 'Open the durable refund approval for one order. Call exactly once, with your category, risk tier and a one-sentence summary for the reviewer.',
  input: openInput, inputJsonSchema: jsonSchema(openInput), output: z.strictObject({ refundId: identifier, runId: z.string() }),
  execute: async request => {
    const order = await dependencies.orders.find(request.orderId);
    if (!order || order.customerId !== request.customerId) throw new Error('The order does not belong to this customer.');
    if (request.amountCents > order.totalCents) throw new Error('The refund exceeds the order total.');
    const refundId = `rf-${request.ticketId}`;
    const { runId } = await dependencies.openRefund({ refundId, customerId: order.customerId, orderId: order.orderId, amountCents: request.amountCents,
      currency: order.currency, reason: request.reason, category: request.category, riskTier: request.riskTier, summary: request.summary });
    return { refundId, runId };
  },
});
```

Three details carry the weight:

- **The facts come from your systems, not the model.** The tool checks that the order belongs to the customer and that
  the amount fits the order total, and it takes the currency from the order. The model can't talk its way into
  someone else's order.
- **The refund id is derived from the ticket.** `openRefund` submits the workflow with `idempotencyKey: refundId`. If
  the agent, the network or your support system retries, the same ticket finds the run it already started.
- **The tool declares what it does.** `effects: 'write'` and the capability `refunds:open` must both be granted, or the
  call is refused before it runs (see step 6).

## 4. The workflow and its approval step

The workflow is a graph of steps. `policy` runs first; `issue`, which calls the payment gateway, depends on it and is
marked `approval: true`:

```ts
const whole = { kind: 'input', path: [] } as const;
const steps = [
  { kind: 'tool', id: 'policy', tool: policy, input: whole },
  // `approval: true` stops the run until an operator approves this exact request; nothing is paid before that.
  { kind: 'tool', id: 'issue', tool: issue, input: whole, dependsOn: ['policy'], approval: true },
] as const;
const output = z.strictObject({ receiptId: z.string() });
const v1 = defineWorkflowLifecycle({ id: 'refunds.approval', version: '1', input: refundRequest, output, nodes: [...steps],
  result: { kind: 'step', stepId: 'issue', path: [] } });
```

When a run reaches `issue`, Mayura validates the tool's input and records an approval request, and the run's status
becomes `waiting`. The request carries a **digest** that binds the run, the step, the tool and its version, the exact
input and an expiry time. Approving means approving that digest, so the payment that goes out is exactly the payment
the operator saw.

A request lapses after an hour by default. The run then issues a fresh one with a new digest, and an approval of the
old digest is refused. Nobody can approve a request they didn't just read.

The `policy` step throws when the amount is over your limit (`REFUND_LIMIT_CENTS`, 500.00 by default), so an oversized
refund fails before anyone is asked to approve it.

## 5. Who can approve

An approval is only as good as the check on who gave it. The workflow runtime takes a `verifyHuman` function, and the
starter builds approval credentials only in trusted code, after the operator has authenticated:

```ts
// Approvals: the operator API turns the authenticated operator into a credential, and the workflow runtime verifies it.
// Only credentials minted here in this process verify, so an approval cannot be forged from request data.
const minted = new WeakSet<object>();
export function approvalCredential(actorId: string): object {
  const credential = Object.freeze({ actorId }); minted.add(credential); return credential;
}
export function verifyApprover(projectId: string) {
  return async (credential: unknown): Promise<{ readonly id: string; readonly projectId: string; readonly canApprove: boolean }> => {
    if (typeof credential !== 'object' || credential === null || !minted.has(credential)) throw new Error('Unverified approval credential.');
    return { id: (credential as { readonly actorId: string }).actorId, projectId, canApprove: true };
  };
}
```

Something that arrives as JSON in a request can never pass this check: only objects created by `approvalCredential` in
this process verify. And approving grants no permissions: the workflow runtime must still allow the payment tool, its
capability and its effect.

## 6. Approve a refund

Open the console URL `npm run dev` printed, paste the **operator** token and open **Workflows**. The run waiting at
`issue` shows the exact payment it will make. Click **Approve**, and the worker issues the refund within a second and
then notifies the customer.

Two other demo runs are worth a look. The refund for 1,299.00 USD failed at `policy`, over the 500.00 limit, and
nobody was asked to approve it. The run started on an older version of the workflow offers a migration, covered in the
[workflow operations guide](../../../docs/guides/workflow-operations.md).

Your code can approve too, with an operator's token. Read the run, take the digest of the waiting step, and approve that
digest:

```ts
import { createClient } from 'mayura/client';

const operator = createClient({ baseUrl: 'http://127.0.0.1:8080', token: () => process.env['OPERATOR_TOKEN']! });
const run = await operator.workflow(runId);
const issue = run.steps.find(step => step.id === 'issue');
await operator.approveWorkflow(runId, { revision: run.revision, nodeId: 'issue', approvalDigest: issue!.approval!.digest },
  { commandId: `approve-${runId}` });
```

The `commandId` makes the command safe to retry: sending it twice applies it once. `mayura workflow-approve` does the
same from a shell (see [Operations](../../../docs/cli/operations.md)).

To turn a refund down, cancel its run from the console, the client or `mayura workflow-cancel`. There is no separate
reject step, and a request nobody approves simply waits.

## 7. Permissions and budgets

Nothing in Mayura is allowed by default. The intake agent is served with exactly what it needs: its model, its one
tool, that tool's capability and the write effect. Its limits bound every run:

```ts
// src/server.ts: the agent the server serves, with its permissions and limits
const agents = [{ agent: intake.agent, permissions: { allow: [modelPermission(intake.model), ...intake.permissions] },
  limits: { maxSteps: 4, maxModelCalls: 3, maxToolCalls: 1, maxDurationMs: 60_000, maxCostMicros: config.maxRunCostMicros } }];
```

`maxToolCalls: 1` matches the instruction to call `refunds.open` exactly once, so a confused model can't open two
refunds. The workflow runtime has its own list, `tool:refunds.issue`, `payments:refund`, `effect:write` and the rest,
and that is the only place the payment is allowed. See [Permissions](../../../docs/concepts/permissions.md) and
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

## 8. What happens when something fails

- **The process dies while waiting for approval.** Nothing is lost: the waiting run is in the database, and after a
  restart it's still waiting for the same approval.
- **The process dies while paying.** Mayura records the step as started before it calls the payment gateway, so it
  never calls the gateway again for that step. Once the step's deadline has passed (the tool's timeout plus a
  minute), the worker settles it and the run ends as `outcome_unknown`: check your payment provider for refund id
  `rf-…` before doing anything else. That's why the starter's payment gateway must be
  idempotent on the refund id. [Never twice](../research/side-effects-never-twice.md) explains the
  mechanism.
- **The model misbehaves.** It can't pay, can't exceed one tool call, and can't open a refund for an order that
  isn't the customer's.

## 9. Run the tests

```bash
npm test
```

The starter's tests run the whole flow offline:

- a refund is opened through the intake agent and paid only after an operator approves it over HTTP;
- a run started on version 1 is migrated in place to version 2 after the operator reviews the plan;
- a refund for someone else's order is refused before any workflow starts, and one over the limit before any payment;
- each token can do only what its capabilities allow.

## 10. Go to production

- **Choose a model.** Set `MAYURA_MODEL_PROVIDER` (`openai`, `anthropic` or `compatible`), its API key, `MAYURA_MODEL`,
  the two token prices and a per-call cost cap in `.env`. Mayura refuses to spend money without prices and a cap.
  See [Model providers](../../../docs/guides/model-providers.md).
- **Use PostgreSQL.** Set `DATABASE_URL`, and the same code runs on it instead of SQLite.
- **Create real tokens.** `npm run token` prints a token and its SHA-256 digest; configure the digests, not the tokens.
- **Run three commands.** `npm run migrate` once per release, then `npm run serve` and `npm run worker` as separate
  processes. `docker compose up --build` runs that shape locally. The [Deployment guide](../../../docs/guides/deployment.md)
  covers every target.
- **Replace the stand-ins.** The simulated payment gateway and customer notifier go, and your own go in. Both must be
  idempotent on the refund id.

## Know the limits

- Every operator token authenticates as the same service identity, so approvals are recorded against the service,
  not a named person. For per-person attribution and roles, put your identity provider in front of the API.
- The intake token may act for any customer. If customers talk to the agent directly, verify the customer in
  `authenticate` and check it in the tool.
- The offline model classifies by keyword. It shows the tool-call protocol, and it isn't a judgment to rely on.

## Next steps

- [Approvals and human input](../../../docs/guides/approvals-and-human-input.md): approvals, typed human requests and
  `verifyHuman` in depth.
- [Durable workflows](../../../docs/guides/durable-workflows.md): timers, retries and child workflows.
- [Operator console](../../../docs/guides/operator-console.md): everything operators can see and do.
