---
title: "CLI overview"
description: "Install and run the mayura command: its commands, readable and JSON output, help, version, exit codes and errors."
---

The `mayura` command ships inside the `mayura` npm package. You use it to create projects from starters and
templates, to run your application during development and in production, and to operate a running Mayura server
from a terminal or a script.

```bash
npx mayura init
```

In a terminal, `mayura init` with no options opens a short wizard. Everything else is driven by flags, so the same
commands work in scripts and CI.

## Installing and running

You do not need to install anything globally. There are two common ways to run the CLI:

- **Before you have a project**, run it with `npx`, which fetches the `mayura` package on demand:

  ```bash
  npx mayura starters
  ```

- **Inside a project**, add `mayura` as a dependency. Every project created by `mayura init` already has it, pinned
  to the exact version of the CLI that created it. Run the command through `npx` or from your `package.json` scripts:

  ```bash
  npm install mayura
  npx mayura --version
  ```

  The starters' scripts call it this way, for example `"dev": "mayura dev"` and
  `"serve": "mayura serve --app dist/src/app.js"`.

The CLI needs Node.js 22 (22.12 or later) or 24 (24.14.1 or later). See [Support](../project/support.md).

## Commands

`mayura --help` groups the commands like this:

| Group | Commands | Page |
|---|---|---|
| Create | `init`, `starters`, `templates`, `validate`, `inspect` | [Create a project](init.md) |
| Run an application | `dev` | [Develop with mayura dev](dev.md) |
| Run an application | `serve`, `worker`, `migrate` | [Serve, worker and migrate](run.md) |
| Operate a server | `server-health`, `server-tools`, `run-get`, `run-wait`, `run-cancel`, `human-list`, `human-get`, `human-respond`, `workflow-list`, `workflow-get`, `workflow-approve`, `workflow-cancel`, `workflow-pause`, `workflow-resume`, `workflow-signal`, `fleet-get`, `fleet-hold`, `fleet-release`, `fleet-sweep` | [Operate a server](operations.md) |

Options take the form `--name value`, or just `--name` for switches such as `--apply`. An unknown option, or the
same option given twice, is an error.

## Help and version

```bash
mayura --help
mayura init --help
mayura --version
```

`--help` (or `-h`) shows the command list and wins anywhere on the line, so `mayura init --help` prints help instead
of an argument error. `mayura help` does the same. Running `mayura` with no command in a terminal also prints help.

`--version` (or `-v`, or `mayura version`) prints the version as plain text, so scripts can read it. Add `--json` to
get it as a JSON document instead.

## Readable and JSON output

The CLI picks its output format from where the output goes:

- **In a terminal**, results are readable: coloured statuses (`✔ succeeded`, `● waiting`, `✖ failed`), wrapped
  descriptions, and the next command or flag to use.
- **When output is piped or redirected**, every command prints one JSON document instead. Scripts and CI can parse it
  directly.
- **With `--json`**, the CLI always prints JSON, even in a terminal.

```bash
mayura templates --json
mayura starters | jq -r '.starters[].name'
```

Every JSON document has a `status` field. Most commands report `succeeded`; `init` without `--apply` reports
`planned`, `migrate` reports `migrated`, `serve`, `worker` and `dev` report `stopped` when they exit, and a
`fleet-sweep` that did not finish reports `incomplete`.

Colour follows the usual conventions: it is off when `NO_COLOR` is set to any non-empty value or `TERM=dumb`, and on
when `FORCE_COLOR` is set to anything other than `0`. Colour is never written into JSON output.

## Exit codes and errors

| Exit code | Meaning |
|---|---|
| `0` | The command succeeded. This includes `init` printing a plan, and `fleet-sweep` stopping with `incomplete`. |
| `1` | The command failed, or you cancelled the `init` wizard. |

Errors go to stderr. In a terminal they read like this:

```text
✖ Unknown template; run mayura templates. (INVALID_INPUT)
```

When stderr is not a terminal, or with `--json`, the error is a JSON document:

```text
{"status":"failed","error":{"code":"INVALID_INPUT","message":"Unknown command. Run mayura --help to see the commands."}}
```

The `code` is one of Mayura's error codes (see [Outcomes](../concepts/outcomes.md)): `INVALID_INPUT` for a usage
problem the CLI found, `INVALID_CONFIG` for a bad file or setting, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`,
`TIMEOUT` and so on for server commands. Messages are fixed, safe text. The CLI never echoes an unknown command or
argument back, because it might be a credential pasted in the wrong place.

## Good to know

- The CLI never prompts for a server token. Authenticated commands read it only from stdin (`--token-stdin`); see
  [Operate a server](operations.md).
- `serve`, `worker` and `migrate` import only the one module you name with `--app`. Listing and inspecting a project
  never runs your code.
- Everything the commands do is also available as functions from `mayura/cli`, for example `planProject`,
  `inspectWorkflows` and `defineMayuraApplication`. See [Entry points](../reference/entry-points.md).

## Related

- [Create a project](init.md)
- [Develop with mayura dev](dev.md)
- [Serve, worker and migrate](run.md)
- [Operate a server](operations.md)
- [Quickstart](../quickstart.md)
