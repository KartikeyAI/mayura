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
```

Operational inspection accepts credentials only from piped stdin, never a command-line argument, URL, project file or saved CLI configuration. It supports the access-controlled readiness and metadata-only tool-catalog routes, uses HTTPS or loopback HTTP, rejects redirects, bounds responses and does not retry or follow pagination automatically. Run submission, approval and migration commands remain intentionally unavailable until their durable authenticated admin contracts are implemented; the CLI never imports and executes an application module merely to inspect it.
