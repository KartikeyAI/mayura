# Mayura tanstack-start notebook

A deterministic chat fixture with persistent scoped threads, exact in-run note approvals and a separate durable
indexing workflow. No provider credential, model billing or external write is involved. Automated qualification covers the local framework build, scoped approval flow, background worker and isolated
packed server contracts. Deployment qualification remains the host's responsibility.

## Run locally

Use Node 24.14.1 or later in the 24.x line. From the generated project:

```sh
npm install
npm run setup
npm run dev
```

Open http://localhost:3000. Open the ignored `.data/login-token` file locally and paste its value into the password
field. Setup creates an eight-hour single-user session and refuses to replace existing `.env` or credential files.
It never prints the token. The browser keeps the credential in memory only; re-enter it after reload.
Do not commit `.env`, `.data`, tokens or database connection strings.

In another terminal run `npm run worker`. Send a note, inspect its exact proposed input, then approve or reject it.
Saved note content lives in the database; the worker indexes approved notes in a separate scoped aggregate and
performs bounded conversation recovery. The worker has its own tool permissions and shared-store leadership.

## Architecture and authorization

The framework routes `/api/mayura/*` to `server/application.mjs`, preserving Request/Response bodies and streams.
`src/connect.js` uses the root-only Mayura client with an origin-pinned transport that adds this mount prefix.
No credential is placed in an URL, page prop, public config or browser build. No run or approval command is retried
by mounting, subscribing or reconnecting. A lost submission keeps its exact message/key in this tab's session storage;
retry is an explicit action. Selection keys are partitioned by a credential digest. Session storage holds message
content while a send is unresolved; disconnect does not cancel a remote run. Treat a lost tab's unresolved write as
an inspection/reconciliation task, never a new automatic send.

`server/auth.mjs` verifies 64-character private session tokens against a bounded host-owned SHA-256 directory.
Each directory entry fixes the principal, project, expiry, agent list and route capabilities. Browser claims cannot
choose scope. This starter's local setup is a single-user demonstration, not an identity provider: replace the
`authenticate` callback with your verified application identity before exposing it to customers. Never issue a
shared owner token to multiple tenants. Restart processes after rotating the configured identity directory.

The runtime permits only `notes.save`, `notes:write` and its write effect; the tool requires exact approval and has
an effect-local `(runId, callId)` idempotency key. The workflow worker separately permits only `notes.index` and
`notes:index`. Shared history comes from scoped threads. Tools, thread scopes, record leases and approval claims
retain Mayura's normal enforcement. Paid providers require deliberate host prices, grants and nonzero bounded
budgets; `modelOverride` exists for offline tests and does not lift the zero-cost production fixture budget.

A note write and its workflow submission are two durable operations. If scheduling fails after a saved note, inspect
the run and reconcile the missing job using its note id; do not replay the browser write. Abrupt owners retain an
unknown outcome when recovery cannot prove execution. Recovery drains recording/checkpoint work; it does not redo
claimed tool writes, model calls or paid work.

## Storage and deployment

Node uses `.data/notebook.sqlite` by default. Set `DATABASE_URL` to use shared PostgreSQL for replicas or serverless
functions; SQLite needs a persistent single-host volume shared with the worker. The server runs each invocation
inside the request and persists its run record before responding. Give the platform at least 30 seconds for the
configured run/request limits and use a trusted worker or Cron for bounded recovery. Do not put a public HTTP route
in front of `application.runOnce()`.

`Dockerfile` and `compose.yaml` run the web app and worker separately with the same persistent volume. Set the
exact externally visible `MAYURA_PUBLIC_ORIGIN`, terminate TLS at your trusted proxy, and supply session hashes and
credentials at runtime. The image build excludes `.env` and `.data`; use your secret manager in production.
Mayura remains an external server dependency so its SQLite worker files retain their paths. Deploy the generated
project with its installed production dependencies.
`npm run build` creates framework output; `npm start` serves it. The background worker is `npm run worker`.

`npm test` contains only fake/scripted model and in-memory SQLite cases, including denied scope, invalid approval,
cancellation, failed/unregistered tool requests, same-key submission reuse and exactly-once resumed history.
Run `npm run typecheck` and `npm run build` locally. In the Mayura workspace, `pnpm test:starters` also checks
the compiled HTTP routes and approval flow, then installs and exercises the generated server offline.

## React source ownership

`src/components/mayura` contains copied registry source for thread history, approval controls and the thread list.
Edit it directly; hooks and command controllers remain public Mayura APIs. Render/subscribe is inert. The application
owns explicit connect/send/inspect actions and observer teardown. To refresh the list after creating a new thread,
use Refresh conversations. The thread history has explicit earlier/later pagination.

The TanStack Node build uses the Nitro Vite adapter and its `.output/server/index.mjs` entry. The adapter is pinned to the upstream example's beta version; host deployment qualification remains explicit.
