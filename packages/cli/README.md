# @mayura/cli

Node-only Mayura project initialization and inspection CLI. Initialization is plan-first: it prints every create/replace operation and a content-bound confirmation digest before it can write. Existing files are never replaced from a stale or unconfirmed plan.

Initial commands:

```text
mayura templates
mayura init --template basic-agent --directory ./my-agent
mayura init --template basic-agent --directory ./my-agent --apply
mayura validate --file ./my-agent/mayura.project.json
mayura inspect --file ./my-agent/mayura.project.json
printf '%s\n' "$MAYURA_TOKEN" | mayura server-health --url https://agent.example.com --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura server-tools --url https://agent.example.com --token-stdin --limit 50
printf '%s\n' "$MAYURA_TOKEN" | mayura human-list --url https://agent.example.com --token-stdin --limit 50
printf '%s\n' "$MAYURA_TOKEN" | mayura human-get --url https://agent.example.com --id review --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura human-respond --url https://agent.example.com --id review --digest REQUEST_SHA256 --command-id response-1 --response-file ./response.json --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura run-get --url https://agent.example.com --id RUN_UUID --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura run-wait --url https://agent.example.com --id RUN_UUID --poll-ms 1000 --wait-ms 60000 --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura run-cancel --url https://agent.example.com --id RUN_UUID --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura workflow-get --url https://agent.example.com --id WORKFLOW_SHA256 --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura workflow-list --url https://agent.example.com --limit 20 --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura workflow-cancel --url https://agent.example.com --id WORKFLOW_SHA256 --revision 7 --command-id cancel-1 --token-stdin
printf '%s\n' "$MAYURA_TOKEN" | mayura workflow-approve --url https://agent.example.com --id WORKFLOW_SHA256 --revision 7 --command-id approve-1 --node review --digest APPROVAL_SHA256 --token-stdin
```

Operational commands accept credentials only from piped stdin, never a command-line argument, URL, project file or saved CLI configuration. They support access-controlled readiness, metadata-only tool catalogs, typed human request list/inspect/respond, ephemeral-run inspect/wait/cancel and content-free durable workflow list/inspect/cancel/exact approval/bounded signal/continuation/quiescent pause, plus fleet hold/release and bounded multi-page fleet sweeps (`workflows:fleet`). Human values come from an explicit bounded regular JSON file; run output/error payloads and submitted values are never echoed. The transport uses HTTPS or loopback HTTP, rejects redirects, bounds responses and never retries commands. Run wait performs bounded read-only polling; every workflow command is sent exactly once. Run submission, fleet administration, cache/evidence administration and migrations remain intentionally unavailable; the CLI never imports and executes an application module merely to inspect it.

## Running an application

`mayura serve --app ./app.mjs` and `mayura worker --app ./app.mjs [--probe-port 9090] [--probe-host 0.0.0.0] [--drain-timeout-ms 30000]` import exactly the named regular `.js`/`.mjs` module. Its default export (see `defineMayuraApplication`) provides `server()` returning a running host such as `listenProductionServer(...)`, `worker()` returning a worker such as `createWorkflowWorker(...)`, and an optional `shutdown()` that closes storage. The application wires everything with its own installed Mayura packages; the CLI adds no dependency and owns only the process lifecycle: structured JSON status lines, worker `/livez` and `/readyz` probes (served by the application's own installed `@mayura/server-node`, so the CLI itself opens no listener), and graceful shutdown on `SIGINT`/`SIGTERM` (server close, or worker drain then lease release, followed by `shutdown()`). A second signal forces exit.

