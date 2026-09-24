# Initialize a Mayura project

`@mayura/cli` is an optional Node-only package. It inspects a non-executable `mayura.project.json` catalog and never imports application code merely to list definitions or tools.

```text
mayura templates
mayura init --template basic-agent --directory ./my-agent
mayura init --template basic-agent --directory ./my-agent --apply
mayura validate --file ./my-agent/mayura.project.json
mayura inspect --file ./my-agent/mayura.project.json
```

`init` is plan-first. Without `--apply` it performs no writes and prints every path, operation, before/after digest and a bounded text diff for conflicts. A replacement requires a new invocation with `--apply --confirm <displayed-plan-digest>`. Application files changed after planning cause the whole preflight to fail before the first write. The library API additionally requires a genuine process-local plan handle so copied JSON cannot become write authority.

The eight starters cover a typed tool runner, basic agent, durable approval, parallel child agents, native memory, guarded authenticated streaming, approval-required Code Mode and capability denial. They use credential-free deterministic fixtures. SQLite templates use an in-memory local database; Code Mode uses the local QuickJS adapter. Replace fixtures, scope and review credentials deliberately before deployment.

The executable supplies initialization, validation, safe static inspection, authenticated health/tool/human operations, ephemeral `run-get`/`run-wait`/`run-cancel`, and durable `workflow-list`/`workflow-get`/`workflow-cancel`/`workflow-approve`/`workflow-signal`/`workflow-resume`. All authenticated commands require `--token-stdin`; pagination is explicit, mutations are revision-bound and sent once without retry, while run output/error, approval data and signal values are never printed. Resume cannot force a waiting gate. Operator pause, fleet control, cache/evidence administration and migrations remain withheld; the CLI does not simulate them by loading arbitrary application modules.
