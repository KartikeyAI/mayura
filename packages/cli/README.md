# @mayura/cli

Node-only Mayura project initialization and inspection CLI. Initialization is plan-first: it prints every create/replace operation and a content-bound confirmation digest before it can write. Existing files are never replaced from a stale or unconfirmed plan.

Initial commands:

```text
mayura templates
mayura init --template basic-agent --directory ./my-agent
mayura init --template basic-agent --directory ./my-agent --apply
mayura validate --file ./my-agent/mayura.project.json
mayura inspect --file ./my-agent/mayura.project.json
```

Operational run/approval/migration commands are intentionally unavailable until their authenticated admin transport contract is implemented; the CLI never imports and executes an application module merely to inspect it.
