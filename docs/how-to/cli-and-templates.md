# Initialize a Mayura project

`@mayura/cli` is an optional Node-only package. It inspects a non-executable `mayura.project.json` catalog and never imports application code merely to list definitions or tools.

```text
mayura templates
mayura init --template basic-agent --directory ./my-agent
mayura init --template basic-agent --directory ./my-agent --apply
mayura validate --file ./my-agent/mayura.project.json
mayura inspect --file ./my-agent/mayura.project.json
```

Run `mayura init` with no options in a terminal to choose interactively: starter or template, which one, and where.
The wizard shows the plan (and lists any file it would replace, defaulting to not replacing), writes the files after
you confirm, and prints the next steps. It needs a terminal on both input and output; scripts use the flags.

## Output

In a terminal, commands print readable output: coloured statuses, wrapped descriptions, and next steps or the flag
to add. Piped or redirected output, or any command with `--json`, prints the same JSON documents as before, so
scripts and CI are unaffected. Errors follow the same rule on stderr. Colour honours `NO_COLOR`, `FORCE_COLOR` and
`TERM=dumb`. `mayura --help` lists the commands. The CLI never prompts for a token: authenticated commands read it
from stdin (`--token-stdin`) only.

`init` is plan-first. Without `--apply` it performs no writes and prints every path, operation, before/after digest and a bounded text diff for conflicts. A replacement requires a new invocation with `--apply --confirm <displayed-plan-digest>`. Application files changed after planning cause the whole preflight to fail before the first write. The library API additionally requires a genuine process-local plan handle so copied JSON cannot become write authority.

For a complete, multi-file project with a server, a worker, tests and deployment files, use a starter instead: `mayura starters` and `mayura init --starter <name>`. See [Starters](starters.md).

The eight templates cover a typed tool runner, basic agent, durable approval, parallel child agents, native memory, guarded authenticated streaming, approval-required Code Mode and capability denial. They use credential-free deterministic fixtures. SQLite templates use an in-memory local database; Code Mode uses the local QuickJS adapter. Replace fixtures, scope and review credentials deliberately before deployment.

Release qualification generates every template into a fresh directory, installs only its exact packed dependency closure with networking and lifecycle scripts disabled, type-checks with the installed compiler, and executes the built project. This current-host check prevents examples from passing only because the Mayura workspace is nearby.

The executable supplies initialization, validation, safe static inspection, authenticated health/tool/human operations, ephemeral `run-get`/`run-wait`/`run-cancel`, durable `workflow-list`/`workflow-get`/`workflow-cancel`/`workflow-approve`/`workflow-signal`/`workflow-resume`/`workflow-pause`, fleet `fleet-get`/`fleet-hold`/`fleet-release`/`fleet-sweep`, and the application lifecycle `serve`/`worker`/`migrate --app`. All authenticated commands require `--token-stdin`; pagination is explicit, mutations are revision-bound and sent once without retry, while run output/error, approval data and signal values are never printed. Resume cannot force a waiting gate. Cache/evidence administration and in-flight workflow migrations are not CLI commands; migrate runs from the operator console or API.
