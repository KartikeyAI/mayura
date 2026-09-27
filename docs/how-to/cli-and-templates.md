# Initialize a Mayura project

`mayura/cli` is an optional Node-only package. It inspects a non-executable `mayura.project.json` catalog and never imports application code merely to list definitions or tools.

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

For a starter, the wizard also asks which model provider to use: Offline (no key; rule-based stand-in models),
OpenAI, Anthropic, an OpenAI-compatible provider with a known endpoint (Groq, Google Gemini, Mistral, DeepSeek, xAI,
OpenRouter, Together, Fireworks), Azure OpenAI (it asks for the resource, deployment and API version) or any other
HTTPS chat-completions endpoint. The compatible endpoints follow [Model providers](model-providers.md); Mayura has not
qualified them against live accounts, so check yours with `pnpm providers:live-check`. For a real provider it asks for
the model, the API key (typed masked), your prices per million
tokens and two spending caps (per model call and per agent run, with defaults), and writes them to the new project's
`.env`. That file is owner-only and ignored by git; the key is never printed or put in the plan. An existing `.env`
is left untouched.

## Develop

`mayura dev`, run in a project (the starters' `npm run dev`), runs the project's `build` script, then starts
`dist/src/dev.js` if the project has one, or else `migrate` once and then `serve` and `worker` for `dist/src/app.js`
(`--app` and `--entry` choose other files). It loads `.env` for the project (real environment variables win, and no
value is printed), watches the project, and on each saved change rebuilds and restarts. A failed build prints its
errors and keeps the last good version running. `--no-watch` builds and runs once. Ctrl+C stops the project
gracefully; press it again to force.

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
