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

Operational commands accept credentials only from piped stdin, never a command-line argument, URL, project file or saved CLI configuration. They support access-controlled readiness, metadata-only tool catalogs, typed human request list/inspect/respond, ephemeral-run inspect/wait/cancel and content-free durable workflow list/inspect/cancel/exact approval. Human values come from an explicit bounded regular JSON file; run output/error payloads and submitted values are never echoed. The transport uses HTTPS or loopback HTTP, rejects redirects, bounds responses and never retries commands. Run wait performs bounded read-only polling; every cancellation or approval is sent exactly once. Run submission, workflow signals/resume, fleet administration, cache/evidence administration and migrations remain intentionally unavailable; the CLI never imports and executes an application module merely to inspect it.
