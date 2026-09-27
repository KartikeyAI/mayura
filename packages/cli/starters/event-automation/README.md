# Ticket automation on Mayura

A complete, production-shaped starter for event-driven agents: a ticket tracker sends **signed webhooks**, each
verified delivery starts one **durable workflow run**, and in it a **triage agent** labels and comments on the ticket
through the tracker's **MCP tools**, under **explicit capability grants**. Assigning an urgent ticket to on-call is a
separate workflow step that **waits for an operator to approve the exact call**. Forged, stale and replayed deliveries
start nothing.

It runs offline out of the box: a rule-based stand-in model, SQLite, and a small local tracker that speaks MCP. One
environment switch uses OpenAI or Anthropic, another uses PostgreSQL, and a URL points it at your real tracker.

```
tracker ──signed POST──▶ webhook ingress ──▶ verify HMAC, replay window, schema; record the delivery once
                         (:8081)                 │
                                                 ▼
                                   durable run  tickets.intake v1 ──▶ worker: triage agent
                                                                        ├─ tickets.label   ─┐
                                                                        ├─ tickets.comment ─┼─MCP─▶ tracker
                                                                        └─ tickets.escalate │
                                                                              ▼             │
                                   durable run  tickets.escalation v1: [approval] ─▶ assign ┘ ─▶ announce
operator ──token──▶ console / operator API (:8080): runs, pending approvals with their exact tool call, approve, pause, hold
```

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` builds and starts, in one process: the local tracker (an MCP server with four sample tickets), the API
and console, the webhook ingress and a worker, on `.data/event-automation.sqlite`. It sends three signed sample
deliveries and prints the console URL, an operator token, the webhook URL and the webhook secret.

`npm run dev` runs `mayura dev`: it loads `.env` if you have one, and rebuilds and restarts when you save a file. The tokens it prints are kept in `.data/dev-secrets.json`, so they stay the same across restarts.

Open the console, paste the **operator** token and open **Workflows**:

- The billing and docs tickets were triaged: labelled `triaged`, `priority:<level>` and an area, with one comment each.
- The outage ticket (T-1001) was urgent, so the agent asked for an escalation. Its `tickets.escalation` run waits at
  `assign` and shows the exact call: `tickets.assign` with `{ "ticketId": "T-1001", "assignee": "oncall" }`.
  **Approve** it; the worker assigns the ticket and posts a note within a second.

Play the tracker from another terminal (it reads the URL and secret `npm run dev` saved in `.data/dev-webhook.json`):

```bash
npm run send-sample -- feature                  # a new delivery: 202 and a run id
npm run send-sample -- feature --delivery abc   # then run it twice: the same run id, nothing new starts
npm run send-sample -- outage --forged          # signed with the wrong secret: 401
npm run send-sample -- outage --stale           # signed ten minutes ago: 401
```

`npm test` runs the whole flow offline over real HTTP: delivery to MCP tool calls in the tracker, refused forged,
stale, unsigned and malformed deliveries, replays, refused tools without their grant, approval over the operator API,
caller scopes and configuration.

## What is where

| File | Purpose |
|---|---|
| `src/ingress.ts` | The webhook listener: one bounded route, `POST /webhooks/tickets`, on the Mayura webhook runtime |
| `src/signing.ts` | The signature contract (headers and signed bytes) and the sender used by dev, samples and tests |
| `src/triage.ts` | The triage agent, its grants and limits, the step that runs it in a workflow, the offline stand-in model |
| `src/tracker-tools.ts` | The tracker's MCP operations as Mayura tools, each with its capability |
| `src/mcp.ts` | The MCP client transport (Streamable HTTP) the MCP adapter calls |
| `src/workflows.ts` | `tickets.intake` (one run per delivery) and `tickets.escalation` (approval before assigning) |
| `src/server.ts` | The API, console and operator API, plus the ingress, as one handle |
| `src/worker.ts` | Advances runs, with leadership so replicas never double-drive the fleet |
| `src/tracker/` | The local stand-in tracker: `TicketTracker`, an in-memory store and a minimal MCP server (`npm run tracker`) |
| `src/auth.ts`, `src/config.ts`, `src/model.ts` | Operator tokens and approvals; settings; offline, OpenAI or Anthropic |
| `src/app.ts`, `src/dev.ts`, `src/send-sample.ts` | `mayura serve`/`worker`/`migrate`; the one-process local run; the sample sender |

## How the pieces keep each other honest

- **Signatures.** The tracker signs `<timestamp>.<delivery id>.<raw body>` with HMAC-SHA256 and the shared
  `WEBHOOK_SECRET`. The ingress passes the exact raw bytes to `@mayura/workstream/webhooks`, which checks the signature
  in constant time, refuses timestamps more than five minutes from its clock, and only then parses and validates the
  JSON against a strict schema. A refused request changes nothing, not even the delivery record.
- **Replays and retries.** Each verified delivery is recorded durably in the same store as the runs, keyed by delivery
  id, before it is dispatched. A retry or replay of that delivery finds the record and gets the same answer (202 and
  the same run id); the same id with a different body is a 409. The intake run's idempotency key comes from the
  delivery too, so even a dispatch retried after a crash cannot start a second run.
- **Grants.** The triage agent is granted its model, `tickets.label` and `tickets.comment` (`tickets:write`),
  `tickets.escalate` (`tickets:escalate`) and the write effect, and nothing else. It has no `tickets:assign`: assigning
  is the escalation workflow's `assign` step, and that step has `approval: true`. The broker checks grants before a
  tool runs, so an ungranted call never reaches the tracker. The workflow runtime has its own explicit list in
  `ticketWorkflows().permissions`.
- **Approval.** The operator approves a digest of the exact tool call (tool, version, input). If the input changed, the
  approval would not match. Who gets assigned comes from `ONCALL_ASSIGNEE`, not from the model.

## Make it yours

1. **Your tracker.** Set `TRACKER_MCP_URL` to your tracker's MCP server (Streamable HTTP) and `TRACKER_MCP_TOKEN` to a
   token it accepts. Then map its tools in `src/tracker-tools.ts`: set each `remoteName` to the server's tool name and
   adjust the input and output schemas to what it expects and returns. The adapter requires the server to return
   `structuredContent`; a tool that only returns text needs a small wrapper server or a different output mapping.
   `src/mcp.ts` implements only what tool calls need (no OAuth discovery, no server-initiated requests); swap in a full
   MCP client library if your server needs more. Delete `src/tracker/` when you no longer need the stand-in.
2. **Your webhook format.** Adapt the header names in `src/signing.ts` and the payload schema in `src/triage.ts`
   (`ticketCreated`). The Mayura webhook runtime expects the signature over `<timestamp ms>.<delivery id>.<body>` as
   `sha256=<hex>`; if your tracker signs differently, verify its format in `src/ingress.ts` first and then hand the
   runtime a delivery it can check. Changing the payload schema changes the trigger's schema digest: bump the trigger
   version.
3. **Model.** Set `MAYURA_MODEL_PROVIDER=openai` (or `anthropic`) with the key, model name, prices and cost limits
   listed in `.env.example`. The same agent, tools, grants and output schema are used; the offline stand-in is not.
4. **More actions.** Add a tool in `src/tracker-tools.ts`, give it its own capability, and decide who holds it: the
   agent (add it to `grants` in `src/triage.ts`) or an approval-gated workflow step (add it to
   `ticketWorkflows().permissions`). List it in `mayura.project.json`.

## Production

1. Create the operator token with `npm run token`; give the token to the operator and put only the digest in
   `MAYURA_OPERATOR_TOKEN_SHA256`. Several comma-separated digests rotate without downtime.
2. Set `WEBHOOK_SECRET` (32+ characters; `npm run token` prints a good one) and configure the same secret in the
   tracker. `mayura serve` refuses to start in production without it.
3. Use PostgreSQL (`DATABASE_URL`). SQLite is for a single node.
4. Run `npm run migrate` before new code serves traffic, then `npm run serve` (API on `PORT`, webhooks on
   `WEBHOOK_PORT`) and `npm run worker` as separate processes. The worker is the process that calls the tracker's MCP
   server. Scale both horizontally; one worker leads at a time, and deliveries are deduplicated across servers.
5. Terminate TLS in front of both ports. Set `MAYURA_PUBLIC_ORIGIN` to the API's exact `https://` origin; the API
   refuses other hosts. Route only `POST /webhooks/tickets` to the ingress and rate-limit it at the proxy.
   `/healthz` and `/readyz` are on the API port; the worker serves its own on port 9090.

`docker compose up --build` runs this shape locally (PostgreSQL, migrate, server, worker and the stand-in tracker)
from `.env`. The image builds from the npm registry, so it needs published Mayura packages.

## Know the limits

- If the triage agent stops part-way (a refused tool, a model error, a timeout, a crash), the tracker may already have
  some of its labels or comments, so the intake run ends `outcome_unknown` and is never re-run automatically. Check the
  ticket and reconcile it by hand. The console's run list shows active runs only; open a finished run by its id (the
  ingress returns it to the tracker in its 202 response) with `GET /v1/workflow-runs/<run id>` (or `client.workflow(runId)`).
- A delivery whose dispatch failed part-way is answered `500 unconfirmed` and stays that way; the tracker's retries
  will not start it. A delivery that was being dispatched when a server process died is answered `503 in_progress`
  until an operator resolves it with the webhook runtime's `recoverAbandoned`. Neither is re-dispatched automatically.
  Because the intake run's idempotency key is derived from the delivery, you can check whether its run exists and
  resubmit it safely; this starter ships no tooling for that yet.
- Deduplication is by delivery id. If your tracker sends the same event twice under different ids, two intake runs
  start; labels are idempotent, comments are not. Escalations are idempotent per ticket.
- The webhook secret is a single value read at startup. To rotate, make `resolveSecret` in `src/ingress.ts` read your
  secret manager, or restart with the new secret when the tracker switches.
- The ingress bounds body size, time and concurrency per process but does not rate-limit per sender; do that at your
  proxy.
- Approvals are attributed to the service principal: every operator token authenticates as the service scope. For
  per-person attribution and roles, put your identity provider in front of the API. An approval request lapses after an
  hour and is re-issued with a new digest; approve the current one.
- The MCP client handles JSON and event-stream replies to a request, sessions and bearer tokens, and nothing more.
- The offline model classifies by keywords. It demonstrates the tool-call protocol; it is not a judgement to rely on.
  Ticket text comes from customers: with a real model, keep the agent's grants as narrow as they are here.
