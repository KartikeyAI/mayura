---
title: "Operate a server"
description: "Inspect and control a running Mayura server from the CLI: health, tools, runs, human requests, workflows and the fleet."
---

The operational commands talk to a running Mayura server over its authenticated HTTP API. Use them to check health,
follow and cancel runs, answer human requests, approve, pause, resume, signal or cancel durable workflows, and hold
the whole workflow fleet during an incident. They are the command-line counterpart of the
[operator console](../guides/operator-console.md), and they work well in scripts because they print JSON when piped.

```bash
printf '%s' "$OPERATOR_TOKEN" | mayura server-health --url https://agents.example.com --token-stdin
```

## The token and the URL

Every operational command needs two options:

- `--url <origin>`: the server's origin, such as `https://agents.example.com`. It must be HTTPS. Plain HTTP is
  allowed only for `localhost`, `127.0.0.1` and `[::1]`. Give the origin only: no path, query or credentials.
- `--token-stdin`: read the bearer token from standard input.

The token is accepted **only** through a pipe. There is no token option, no environment variable and no prompt, so
the token never appears in your shell history, the process list or logs. If stdin is a terminal the command refuses to
run. A trailing newline is removed; the token must be printable ASCII without spaces, at most 8192 characters.

Pipe it from wherever you keep it, for example a secret manager:

```bash
my-secret-tool read mayura/operator-token | mayura workflow-list --url https://agents.example.com --token-stdin
```

The server decides what the token may do. Your application's `authenticate` callback turns it into an identity with a
set of capabilities, and each command needs one:

| Commands | Capability |
|---|---|
| `server-health`, `server-tools` | `operations:read` |
| `run-get`, `run-wait` | `runs:read` |
| `run-cancel` | `runs:cancel` |
| `human-list`, `human-get` | `humans:read` |
| `human-respond` | `humans:respond` |
| `workflow-list`, `workflow-get`, `fleet-get` | `workflows:read` |
| `workflow-approve`, `workflow-cancel`, `workflow-pause`, `workflow-resume`, `workflow-signal` | `workflows:control` |
| `fleet-hold`, `fleet-release`, `fleet-sweep` | `workflows:fleet` |

See [Server and client](../guides/server-and-client.md) for setting up authentication.

## How requests behave

- Each command sends its request **once**. Nothing is retried automatically, and redirects are refused.
- A request times out after 10 seconds.
- Responses are checked strictly. Output never includes a run's output or error payload, approval data or a signal
  value.
- A refused request reports a stable `code`, the HTTP `status` and the server's own `serverCode` with its message, for
  example:

  ```json
  { "status": "failed", "error": { "code": "PERMISSION_DENIED", "message": "The operational server refused the request (HTTP 403 CAPABILITY_REQUIRED): The access token lacks the capability this request needs (see capability).", "status": 403, "serverCode": "CAPABILITY_REQUIRED", "capability": "workflows:read" } }
  ```

  `serverCode` is one of the codes in [Server and client](../guides/server-and-client.md#errors), such as
  `RUN_NOT_FOUND`, `AUTH_EXPIRED`, `WORKFLOW_CONFLICT` (with `currentRevision` when the token may read the run) or
  `RUN_LIMIT` (with `retryAfterMs`). It is `null` when the answer did not come from Mayura, for example a proxy's error
  page. Only a well-formed code and a short printable message are shown; nothing else from the answer is printed.
- The stable `code` is `PERMISSION_DENIED` (401, 403, or a redirect), `NOT_FOUND` (404, 410), `CONFLICT` (409, 412),
  `OUTCOME_UNKNOWN` (`SUBMISSION_OUTCOME_UNKNOWN`), `LIMIT_EXCEEDED` (413, 429), `INVALID_INPUT` (400, 415), `TIMEOUT`
  (408, or no answer within 10 seconds), and `TOOL_FAILED` when the server could not be reached or failed otherwise.
  `INVALID_OUTPUT` means the server's reply was not what the CLI expected.

## Server health and tools

```bash
printf '%s' "$TOKEN" | mayura server-health --url https://agents.example.com --token-stdin
printf '%s' "$TOKEN" | mayura server-tools --url https://agents.example.com --token-stdin --limit 50
```

`server-health` reports `ready` or `degraded` and the status of each health check the server defines. A degraded
server is a normal result, not an error.

`server-tools` lists the tools of the agents your token can see: id, version, owning agent, effects, maximum cost
and timeout. It never shows descriptions, schemas or handlers.

## Runs

These commands control the server's ephemeral agent runs. Run ids are UUIDs.

```bash
printf '%s' "$TOKEN" | mayura run-get --url https://agents.example.com --token-stdin --id <run id>
printf '%s' "$TOKEN" | mayura run-wait --url https://agents.example.com --token-stdin --id <run id> --wait-ms 120000
printf '%s' "$TOKEN" | mayura run-cancel --url https://agents.example.com --token-stdin --id <run id>
```

`run-get` shows the run's status, its spend (`spentMicros`, `reservedMicros`) and number of model calls, and a
receipt for each tool call: whether it executed (`not_started`, `succeeded`, `failed` or `unknown`) and whether its
output was released.

`run-wait` polls until the run finishes. `--poll-ms` sets the interval (250 to 10000, default 1000) and `--wait-ms`
the total wait (up to 300000, default 60000). Any failed read ends the wait.

`run-cancel` asks the server to cancel the run. If the acknowledgement is lost, the command fails rather than
retrying; check with `run-get`.

## Human requests

When an agent asks a person for information, the server lists the request until someone answers.

```bash
printf '%s' "$TOKEN" | mayura human-list --url https://agents.example.com --token-stdin --limit 20
printf '%s' "$TOKEN" | mayura human-get --url https://agents.example.com --token-stdin --id <request id>
printf '%s' "$TOKEN" | mayura human-respond --url https://agents.example.com --token-stdin --id <request id> --digest <request digest> --command-id answer-1 --response-file answer.json
```

`human-get` prints the prompt, the request `digest` and its schema. `human-respond` sends the JSON in
`--response-file` (a regular file of at most 1 MiB) as the answer. The `--digest` binds your answer to exactly the
request you read, so a request that changed in the meantime is refused. `--command-id` is an id you choose for this
answer. The command prints the updated request, never your answer. See
[Approvals and human input](../guides/approvals-and-human-input.md).

## Workflows

Durable workflow runs are identified by a 64-character hex id.

```bash
printf '%s' "$TOKEN" | mayura workflow-list --url https://agents.example.com --token-stdin
printf '%s' "$TOKEN" | mayura workflow-list --url https://agents.example.com --token-stdin --settled
printf '%s' "$TOKEN" | mayura workflow-get --url https://agents.example.com --token-stdin --id <workflow run id>
```

`workflow-list` shows active runs (running, waiting or paused). With `--settled` it shows finished runs instead, with
the time each one settled. `workflow-get` shows one run: its definition and version, status, `revision` and the
status of every step.

### Revision-bound commands

Every command that changes a workflow run takes two extra options:

- `--revision <n>`: the run's revision from `workflow-get` or `workflow-list`. If the run has changed since you read
  it, the server refuses the command with `CONFLICT` (`serverCode` `WORKFLOW_CONFLICT`). Read the run again and decide
  again.
- `--command-id <id>`: an id you choose for this action, such as `pause-incident-42`. Servers built with Mayura's
  workflow operator transports record command ids, so sending the same command again with the same id does not
  apply it twice. Reuse the id when you retry after an unclear failure; use a new id for a new action.

```bash
printf '%s' "$TOKEN" | mayura workflow-pause --url https://agents.example.com --token-stdin --id <workflow run id> --revision 7 --command-id pause-1
printf '%s' "$TOKEN" | mayura workflow-resume --url https://agents.example.com --token-stdin --id <workflow run id> --revision 8 --command-id resume-1
printf '%s' "$TOKEN" | mayura workflow-cancel --url https://agents.example.com --token-stdin --id <workflow run id> --revision 8 --command-id cancel-1
```

- `workflow-pause` stops the run at the next safe point. It does not interrupt a tool call already in progress.
- `workflow-resume` continues a paused or stalled run from its stored state. It cannot skip a step that is waiting for
  approval, a signal, a person or a timer.
- `workflow-cancel` cancels the run.

### Approving a step

A tool step marked for approval waits until someone approves its exact call:

```bash
printf '%s' "$TOKEN" | mayura workflow-approve --url https://agents.example.com --token-stdin --id <workflow run id> --revision 3 --command-id approve-1 --node issue --digest <approval digest>
```

`--node` is the waiting step's id and `--digest` is its approval digest. For a step inside a child workflow, add
`--child-id <child run id>`. The CLI does not display approval digests: read the digest, and the exact tool call it
approves, in the operator console or with `client.workflow(id)` from `mayura/client`.

### Sending a signal

```bash
printf '%s' "$TOKEN" | mayura workflow-signal --url https://agents.example.com --token-stdin --id <workflow run id> --revision 4 --command-id signal-1 --signal-id payment-7 --signal-name payment.received --value-file signal.json
```

`--signal-name` is the name the workflow waits for, `--signal-id` a stable id for this signal, and `--value-file` a
JSON file of at most 4096 bytes. See [Durable workflows](../guides/durable-workflows.md).

## The workflow fleet

A fleet hold stops workers from starting new workflow work across your scope, for example during an incident or a
risky deploy. Holding and releasing are idempotent.

```bash
printf '%s' "$TOKEN" | mayura fleet-get --url https://agents.example.com --token-stdin
printf '%s' "$TOKEN" | mayura fleet-hold --url https://agents.example.com --token-stdin
printf '%s' "$TOKEN" | mayura fleet-release --url https://agents.example.com --token-stdin
```

`fleet-sweep` pauses (or later resumes) every run in the fleet, one page at a time:

```bash
printf '%s' "$TOKEN" | mayura fleet-sweep --url https://agents.example.com --token-stdin --phase pause --json > sweep.json
```

| Option | Meaning |
|---|---|
| `--phase pause` or `--phase resume` | What to do to each run. Required. |
| `--limit <n>` | Runs per page, 1 to 128. Default 32. |
| `--max-pages <n>` | Pages to process in this invocation, 1 to 256. Default 32. |
| `--cursor-file <file>` | Continue a previous sweep from its saved `nextCursor`. |

The result counts each run's outcome, such as `paused`, `already_paused`, `terminal`, `busy` or `failed`. If the
sweep reached `--max-pages` before finishing, its status is `incomplete` and the JSON includes `nextCursor`. Save that
object to a file and continue with `--cursor-file`. See [Workflow operations](../guides/workflow-operations.md).

## From TypeScript

Every operational command is also a function in `mayura/cli`, taking the same options and an explicit token callback:

```ts
import { inspectWorkflows, pauseWorkflow } from 'mayura/cli';

const server = { baseUrl: 'https://agents.example.com', token: () => getOperatorToken() };
const page = await inspectWorkflows(server, { limit: 20 });
for (const run of page.items) {
  if (run.status === 'running') {
    await pauseWorkflow(server, { id: run.runId, revision: run.revision, commandId: `pause-${run.runId}` });
  }
}
```

## Good to know

- Pagination is explicit. List commands return one page and a `next` value; pass it back with `--after` for the next
  page.
- The CLI cannot submit runs, change which scope or agents a token sees, or migrate in-flight workflows. Use the
  client or the operator console for those.

## Related

- [Operator console](../guides/operator-console.md)
- [Workflow operations](../guides/workflow-operations.md)
- [Server and client](../guides/server-and-client.md)
- [Approvals and human input](../guides/approvals-and-human-input.md)
- [CLI overview](overview.md)
