# Operator console

The agent server can serve an operator console from its own origin. The console is built with React and shadcn/ui components.

```ts
const server = await listenAgentServer({ inspector: true, agents, authenticate, workflowIndex, workflowViews, /* ...transports */ });
// open `${server.origin}/inspector` and paste an access token
```

Try it with the demo. It runs a real SQLite lifecycle fleet with fleet control and a reviewed v1 → v2 migration, and prints the URL and a one-time loopback token:

```sh
node examples/inspector.mjs
```

## What it does

Everything goes through the ordinary authenticated API, so the console can see and do only what the token's capabilities allow. An action whose transport the server does not configure fails with `404` and changes nothing. The Migrations view says so explicitly.

| View | Reads | Actions | Capabilities |
|---|---|---|---|
| Overview | Health, agents, tools | — | `operations:read`, `runs:read` |
| Workflows | Run index (active, or finished and unresolved runs), step graph and pending approvals with the exact tool call | Pause, resume, cancel, approve | `workflows:read`, `workflows:control` |
| Human requests | Waiting requests | Respond with JSON | `humans:read`, `humans:respond` |
| Fleet control | Hold state | Hold, release, pause and resume sweeps | `workflows:read`, `workflows:fleet` |
| Migrations | Migrations offered per run, dry-run plans | Apply a reviewed migration to a paused run | `workflows:read`, `workflows:migrate` |
| Agent runs | Run snapshot and the live event stream | Cancel | `runs:read`, `runs:cancel` |

Every command asks for confirmation in a dialog. It is sent with the run's current revision and a fresh command id, so a stale page gets `409` instead of acting on changed state. Migrations show the full plan: what happens to each step and why anything is blocked. See [Migrating in-flight workflow runs](workflow-migrations.md).

## Safety

- The console is off by default. It is served only when `inspector: true`, and only at `/inspector`, `/inspector/app.js` and `/inspector/app.css`, for `GET` without a query string. With the console on, the server accepts its own origin as a browser origin, so the console can send commands. Other origins still need `allowedOrigins`.
- The static assets contain no data. The page asks for a token and keeps it in page memory only (never in storage, cookies or the URL). It has a "Forget token" button.
- React renders every value as text. The bundle uses no `innerHTML`, `eval` or browser storage. A test checks this.
- The CSP is `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`.
  - The style nonce is fresh on every page response. It admits only the one `<style>` element dialogs inject for scroll locking.
  - Scripts are same-origin files only.
  - Responses are `no-store` with `X-Frame-Options: DENY`.
- In production, serve the console behind the same TLS origin as the API. Give operators tokens scoped to the capabilities they need. Give `workflows:migrate` to few operators.

## Developing the console

The source is `packages/inspector-ui` (internal, never published). `node scripts/inspector-bundle.mjs` builds it and embeds the assets in `packages/server/src/inspector-bundle.ts`, so the server package needs no filesystem access or build tools at runtime.

`pnpm console:check` (in CI) fails when the console sources, or the client they bundle, changed without the embedded bundle being rebuilt. `node scripts/inspector-bundle.mjs --verify` also rebuilds and compares the bundle byte for byte on the current platform.
