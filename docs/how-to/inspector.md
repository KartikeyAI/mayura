# Local inspector

The agent server can serve a small, read-only inspector UI from the same origin:

```ts
const server = await listenAgentServer({ inspector: true, agents, authenticate });
// open `${server.origin}/inspector` and paste an access token
```

Try it with the demo, which prints the URL and a one-time loopback token:

```sh
node examples/inspector.mjs
```

## What it shows

Everything the inspector shows comes through the ordinary authenticated read API, so it shows only what that token's capabilities allow.

| View | API | Capability |
|---|---|---|
| Overview | `GET /v1/operations/health`, `/v1/agents`, `/v1/tools` | `operations:read`, `runs:read` |
| Workflows | `GET /v1/workflow-runs`, `/v1/workflow-runs/:id` | `workflows:read` |
| Human requests | `GET /v1/human-requests` | `humans:read` |
| Fleet | `GET /v1/workflow-fleet` | `workflows:fleet` |
| Run | `GET /v1/runs/:id`, and the live `/v1/runs/:id/events` stream | `runs:read` |

It has no write actions. To pause, resume, cancel, approve or respond, use the CLI, the client or your own UI with the command APIs.

## Safety

- It is off by default. It is served only when `inspector: true`, and only at `/inspector`, `/inspector/app.js` and `/inspector/app.css`, for `GET` without a query string.
- The static assets contain no data. The page asks for a token, keeps it in page memory only (never in storage, cookies or the URL) and has a "Forget token" button.
- Every value is rendered as a text node. The script uses no `innerHTML`, `eval` or storage APIs.
- The CSP is `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, and responses are `no-store` and `X-Frame-Options: DENY`.
- In production, put it behind the same TLS origin as the API, and give operators tokens scoped to the read capabilities above.
