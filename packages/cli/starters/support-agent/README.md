# Customer support chat on Mayura

A production-shaped starter for an online store's support assistant: customers chat in a **React chat UI**, a
**support agent** answers with **order tools that only ever see the signed-in customer's own data**, remembers
preferences in **per-customer native memory**, and **redacts card numbers, emails and phone numbers** on the way in and
out. Opening a return starts a small **durable follow-up workflow** that a **worker** advances, and operators watch
everything in the **console**.

It runs offline out of the box: a rule-based stand-in model, SQLite, sample orders and a simulated returns desk. One
environment switch uses OpenAI or Anthropic, and another uses PostgreSQL.

```
browser (web/) ──session token──▶ server ──▶ support.assistant ──▶ orders.list / orders.track   (read, own orders only)
   ▲                                │            │                 returns.start ──▶ durable run returns.follow-up
   │ your backend mints sessions    │            │                 memory.remember / memory.recall (native memory, own scope)
   │ (mintSessionToken)             │            └─ guardrails: redact PII in input and reply, block any leftover
operator ──token──▶ console /inspector: agents, tools, follow-ups (pause, resume, cancel, fleet hold)
                                                          worker: schedule ─▶ [timer] ─▶ remind
```

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` compiles the server, builds the chat UI (`web/`), and starts in one process: the Mayura server and a worker
on `.data/support.sqlite`, plus a small front server for the chat. It prints:

- **chat**: `http://127.0.0.1:5173`. Pick a demo customer (Ada or Grace) and try:
  - "Where is my order?": the assistant lists your orders, then tracks the most recent undelivered one. The chips
    above each reply show the tools it used, live, as the run's events stream in.
  - "I want to return my mug set": opens a return for your latest delivered order. Asking again finds the same return.
  - "Remember that I prefer weekend deliveries", then later "What do you remember about me?". Sign in as the other
    customer: they see none of it.
  - Type a card number or an email address: the assistant never sees it, and neither does memory.
- **console**: `http://127.0.0.1:8080/inspector` with a fresh **operator token**. Open **Workflows** to see each return's
  follow-up waiting on its timer (`RETURN_REMINDER_HOURS`, default 72).

The front server serves `web/dist`, forwards `/v1/*` to the Mayura server (so the browser talks to one origin) and
offers `POST /dev/session`, which signs a session for a demo customer without a login. That endpoint is the stand-in for
your backend and exists only in `npm run dev`. Set `PORT` and `DEV_WEB_PORT` to move the ports.

`npm test` runs everything offline over real HTTP: sessions (tampered, expired, wrong key), a hostile model trying to
read and return another customer's order, the tracking conversation, idempotent returns and their durable follow-up,
memory across runs and restarts and between customers, PII redaction, caller scopes and configuration.

## What is where

| File | Purpose |
|---|---|
| `src/assistant.ts` | The agent, its five tools, input/output schemas and the offline stand-in model |
| `src/orders.ts` | The order-directory interface (orders *of a customer*, nothing else) and the sample data |
| `src/returns.ts` | The returns-desk interface, the simulated desk and the `returns.follow-up` workflow |
| `src/guardrails.ts` | PII redaction (a `@mayura/guardrails` pipeline) and the output guard that backs it up |
| `src/session.ts` | Customer session tokens: `mintSessionToken` for your backend, verification for the server |
| `src/auth.ts` | Who may do what: customers (own runs only) and operators (console) |
| `src/server.ts` | HTTP: the agent, the console at `/inspector` and the operator API |
| `src/worker.ts` | Advances follow-ups, with leadership so replicas never double-drive the fleet |
| `src/config.ts` | Every setting, from the environment, validated at startup |
| `src/model.ts` | Offline, OpenAI or Anthropic, chosen by `MAYURA_MODEL_PROVIDER` |
| `src/app.ts` | The entry point for `mayura serve`, `mayura worker` and `mayura migrate` |
| `src/dev.ts` | The one-process local run with the chat front server and demo data |
| `web/` | The chat UI: Vite, React, Tailwind and shadcn-style components, `@mayura/client` and `@mayura/client-react` |

## How customers are kept apart

- Your backend signs the shopper in (your login, your cookies) and calls `mintSessionToken(secret, customerId, ttlMs)`.
  The browser holds only that short-lived token.
- The server verifies it (HMAC-SHA256, constant-time, expiry) and runs the chat in the scope
  `customer/<id>`. Runs are keyed by scope, so one customer cannot read another's run.
- Every tool takes the customer from that verified scope, never from its arguments. Tool inputs are strict and have
  no customer field, so a model that tries to name another customer makes an invalid call and the run stops. Asking
  for someone else's order number returns "not found", exactly like an order that does not exist.
- Native memory is created per call in the customer's scope, so other customers' notes are not filtered out: they
  are in a different partition. Notes carry provenance (which conversation, who said it).

## Make it yours

1. **Orders.** Replace `sampleOrders` in `src/orders.ts` with your order system. Keep the one query, "orders of this
   customer"; do not add a lookup by order id alone.
2. **Returns.** Replace `simulatedReturnsDesk` in `src/returns.ts`. `open` must be idempotent per (customer, order) and
   `remind` per return id.
3. **Sessions.** In your backend, sign shoppers in as you do today and return `mintSessionToken(...)` to the page.
   Replace `demoCustomers` and `signIn` in `web/src/lib/api.ts` with that call, and remove the sign-in screen.
4. **Model.** Set `MAYURA_MODEL_PROVIDER=openai` (or `anthropic`) with the key, model name, prices and cost limits
   listed in `.env.example`. The same agent, tools, guardrails and output schema are used; the offline stand-in is not.
5. **Look and feel.** The components in `web/src/components` are yours to restyle; colors live in `web/src/styles.css`.

## Production

1. Run `npm run token`: it prints an operator token with its digest, and a session secret. Put the digest in
   `MAYURA_OPERATOR_TOKEN_SHA256`, and the session secret in `MAYURA_SESSION_SECRET` on every server replica **and** in
   your application backend. Several comma-separated operator digests rotate without downtime.
2. Use PostgreSQL (`DATABASE_URL`). SQLite is for a single node.
3. Run `npm run migrate` before new code serves traffic (it also creates the native-memory tables), then
   `npm run serve` and `npm run worker` as separate processes.
4. Terminate TLS in front of the server and set `MAYURA_PUBLIC_ORIGIN` to the exact `https://` origin.
5. **The chat UI** is static: `npx vite build web` produces `web/dist`. Serve it from any static host. Simplest is the
   same origin as the API (your reverse proxy sends `/v1/*` to the Mayura server and everything else to `web/dist`); a
   separate origin works too if you list it in `MAYURA_ALLOWED_ORIGINS` and point `apiOrigin` in `web/src/lib/api.ts`
   at the API. The bundle contains no secrets.

`docker compose up --build` runs the server side locally (PostgreSQL, migrate, server, worker) from `.env`. The image
builds from the npm registry, so it needs published Mayura packages; it does not include the chat UI.

## Know the limits

- **Chat runs are held in server memory.** A finished chat stays readable for five minutes (sooner released under load
  once the browser has read the reply); a server restart forgets chats in flight. Capacity counts concurrent chats
  (`src/server.ts`), and a busy server answers HTTP 429. Customer data is not affected: memory, returns and
  follow-ups are durable in the database.
- **Replies arrive whole.** What streams is the run's activity (tools starting and finishing); the reply text appears
  when the run completes. The Mayura run protocol has no token streaming.
- **PII redaction is heuristic.** Card numbers (Luhn-checked), emails and 10 to 15 digit phone numbers are recognized;
  unusual formats slip through and long digit strings can be flagged. Anything the redaction would still change in a
  tool result or reply is withheld (the run ends `blocked`), which is safe but blunt.
- **The offline model is keyword rules.** It shows the tool-call protocol; it does not understand language.
- **The returns desk is simulated.** "Already open" is remembered per process; a real desk must be idempotent itself.
- **Operators act as the service.** Every operator token authenticates as the service scope; for per-person
  attribution put your identity provider in front of the API. Operators cannot read customer chats.
- A failed write tool (a return or a note) ends the chat run as `outcome_unknown`: Mayura does not guess whether a
  write happened. The customer is asked to check before retrying; both writes are idempotent.
