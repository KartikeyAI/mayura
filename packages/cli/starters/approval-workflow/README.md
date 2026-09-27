# Refund approvals on Mayura

A complete, production-shaped starter: a support system asks an **intake agent** to open a refund, a **durable workflow**
checks policy and waits for an **operator to approve the exact payment**, and a **worker** issues it. Runs survive
restarts, never pay twice, and can be moved to a new workflow version while in flight.

It runs offline out of the box: a rule-based stand-in model, SQLite and simulated payment and messaging adapters. One
environment switch uses OpenAI, Anthropic or an OpenAI-compatible provider, and another uses PostgreSQL.

```
support system ──token──▶ server ──▶ intake agent ──▶ refunds.open ──▶ durable run (refunds.approval v2)
                             │                                              │
operator ───token──▶ console / operator API: review, approve, pause,        ▼
                      migrate, hold the fleet                         worker: policy ─▶ [approval] ─▶ issue ─▶ notify
```

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` builds, starts the server and a worker in one process on `.data/refunds.sqlite`, opens three demo refunds
through the intake agent plus one on workflow v1, and prints the console URL and two tokens. Open the console,
paste the **operator** token, and open **Workflows**:

`npm run dev` runs `mayura dev`: it loads `.env` if you have one, and rebuilds and restarts when you save a file. The tokens it prints are kept in `.data/dev-secrets.json`, so they stay the same across restarts.

- A run waiting at `issue` shows the exact payment it will make. **Approve** it; the worker issues it within a second
  and then notifies the customer.
- The run for ticket T-102 (1,299.00 USD) failed at `policy`: it is over the default 500.00 limit.
- The run started on **v1** offers the migration `refunds-approval-1-to-2`. Pause it, review the plan, apply it, resume,
  and it continues on v2.

Submit your own request as the support system:

```ts
import { createClient } from '@mayura/client';
const client = createClient({ baseUrl: 'http://127.0.0.1:8080', token: () => process.env.INTAKE_TOKEN! });
const run = await client.submit('refunds.intake', { ticketId: 'T-200', customerId: 'cus-grace', orderId: 'ord-2001',
  amountCents: 18_450, reason: 'The parcel never arrived.' }, { idempotencyKey: 'T-200' });
```

`npm test` runs the whole flow offline: intake, approval over HTTP, payment, migration of a v1 run, refusals and token
scopes.

## What is where

| File | Purpose |
|---|---|
| `src/intake.ts` | The intake agent, its `refunds.open` tool, the order-directory interface and the offline stand-in model |
| `src/workflow.ts` | The refund workflow (v1 and v2), its tools, the reviewed v1→v2 migration, payment and notifier interfaces |
| `src/server.ts` | HTTP: the intake agent, the operator console at `/inspector` and the operator API |
| `src/worker.ts` | Advances runs, with leadership so replicas never double-drive the fleet |
| `src/auth.ts` | Bearer tokens (digests in config), caller scopes, approval credentials |
| `src/config.ts` | Every setting, from the environment, validated at startup |
| `src/model.ts` | Offline, OpenAI, Anthropic or OpenAI-compatible, chosen by `MAYURA_MODEL_PROVIDER` |
| `src/app.ts` | The entry point for `mayura serve`, `mayura worker` and `mayura migrate` |
| `src/dev.ts` | The one-process local run with demo data |

## Make it yours

1. **Orders.** Replace `sampleOrders` in `src/intake.ts` with a lookup in your order system. The tool trusts it, not
   the model, for who owns an order, its total and its currency.
2. **Payments and messages.** Replace `simulatedPayments` and `simulatedNotifier` in `src/workflow.ts`. Both must be
   idempotent on `refundId`: after a crash, a step that may have run is never repeated automatically, but your provider
   is the last line of defence against double payment.
3. **Model.** Set `MAYURA_MODEL_PROVIDER=openai` (or `anthropic`) with the key, model name, prices and cost limits
   listed in `.env.example`. The same agent, tool and output schema are used; the offline stand-in is not.
4. **Policy.** Adjust `REFUND_LIMIT_CENTS` and the rules in the `refunds.policy` tool.

### Changing the workflow

Never edit a version that has runs in flight. Add a new version in `src/workflow.ts`, keep the old one in
`definitions`, and declare a migration with `defineWorkflowMigration`. New runs start on `latest`; operators move
existing runs when they choose, after reviewing a plan that shows what happens to every step. See the Mayura guide
*Migrating in-flight workflow runs*.

## Production

1. Create tokens with `npm run token`, once per caller. Give each token to its caller's secret store and put only the
   digest in `MAYURA_OPERATOR_TOKEN_SHA256` or `MAYURA_INTAKE_TOKEN_SHA256`. Several comma-separated digests rotate
   without downtime.
2. Use PostgreSQL (`DATABASE_URL`). SQLite is for a single node.
3. Run `npm run migrate` before new code serves traffic, then `npm run serve` and `npm run worker` as separate
   processes. Scale both horizontally; one worker leads at a time.
4. Terminate TLS in front of the server and set `MAYURA_PUBLIC_ORIGIN` to the exact `https://` origin. The server
   refuses requests for any other host. `/healthz` and `/readyz` are unauthenticated and content-free, for your load
   balancer; the worker serves its own on port 9090.

`docker compose up --build` runs this shape locally (PostgreSQL, migrate, server, worker) from `.env`. The image builds
from the npm registry, so it needs published Mayura packages.

## Know the limits

- Approvals are attributed to the service principal: every operator token authenticates as the service scope. For
  per-person attribution and roles, put your identity provider in front of the API.
- The intake token is trusted to act for any customer. If customers call the agent directly, verify the customer in
  `authenticate` and check it in the tool.
- The offline model classifies by keywords. It demonstrates the tool-call protocol; it is not a judgement to rely on.
- An approval request lapses after an hour and is re-issued with a new digest; approve the current one.
