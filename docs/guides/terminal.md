---
title: "Terminal"
description: "Chat with an agent in the terminal, or turn it into a one-shot command, with a person confirming actions and answering questions."
---

`mayura/terminal` puts an agent in front of a person at a terminal. Use `runTerminalChat` for an interactive chat
while you develop or for internal tools, and `runAgentCommand` to ship an agent as a command-line program whose flags
come from its input schema. A person at the terminal can confirm tool calls before they run and answer the agent's
questions.

```ts
import { createRuntime, defineAgent } from 'mayura';
import { askPersonTool, confirmBeforeRunning, runTerminalChat } from 'mayura/terminal';

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'You help customers with their orders.',
  model, input, output,
  tools: [lookupOrder, confirmBeforeRunning(refundOrder), askPersonTool],
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: [
    'model:openai.responses', 'tool:orders.lookup', 'tool:orders.refund', 'effect:write',
    'tool:person.ask', 'person:ask',
  ] },
  limits: { maxCostMicros: 100_000 },
});

try {
  await runTerminalChat({ agent, runtime, toInput: (message, history) => ({ message, history }) });
} finally {
  await runtime.close();
}
```

## Chat

Each message runs the agent once. While it works, the chat shows which tool it is using. If the agent streams (see
[Streaming](streaming.md)), the reply appears as it is written; otherwise it is shown when the run completes. Each turn
shows what it cost when the cost is above zero.

At the prompt, `/help` lists commands, `/clear` forgets the conversation, `/cost` shows the spend so far, and `/exit`
(or `/quit`, or Ctrl+C) leaves. `runTerminalChat` resolves to `{ turns, spentMicros }`.

| Option | Meaning |
|---|---|
| `agent`, `runtime` | Required. The runtime's permissions and limits apply to every turn. |
| `toInput(message, history)` | Builds the agent's input. The default passes the message text alone. |
| `toText(output)` | Turns the agent's output into what the person reads. The default is `outputText`. |
| `title` | Shown at the top. The default is the agent id. |
| `io` | `{ input, output }` streams to use instead of the process's terminal. |

**The agent has no memory of earlier turns unless you pass it.** `history` holds the earlier turns of this chat as
`{ role: 'person' | 'agent', text }`; use `toInput` to put them into the input, and give the agent an input schema that
accepts them. `/clear` empties it.

`outputText(output)` returns the output if it is a string, otherwise its first string field among `reply`, `message`,
`text`, `answer`, `content` and `response`, otherwise the output as indented JSON.

## A person in the loop

`confirmBeforeRunning(tool, options?)` returns the same tool, except that before it runs, the person sees its input
and is asked "Allow it?". The default answer is no.

```ts
import { confirmBeforeRunning } from 'mayura/terminal';

const refund = confirmBeforeRunning(refundOrder, {
  describe: input => `Refund order ${input.orderId} for ${input.amountCents / 100} EUR`,
  waitMs: 120_000, // how long to wait for an answer; default 10 minutes
});
```

`describe` turns the validated input into what the person reads (the default is the input as JSON). The confirmation
runs after the input passed the tool's schema and the runtime's permission checks, and before the tool's own code.

**Declining ends the turn.** The tool call is refused before any effect, and Mayura ends a run whose tool call fails,
so the turn ends with "The person declined orders.refund." (for a tool with id `orders.refund`). The chat goes on, and
the person can ask again.

`askPersonTool` is a tool (id `person.ask`) the agent calls to ask the person a question and continue with the answer.
Grant `tool:person.ask` and `person:ask`. If the person cancels the question, the call is refused and the turn ends.

Both need someone at a terminal. The same agent running anywhere else, such as a server, a scheduled job or a piped
command, refuses them, so a confirmed tool can never run unconfirmed there. The confirmation is built on
`withPreflight` from `mayura`, which runs any check you like on a tool's validated input before it executes.

## One-shot commands

`runAgentCommand` runs an agent once from the command line and resolves to an exit code: 0 when the run succeeded,
1 otherwise.

```ts
import { runAgentCommand } from 'mayura/terminal';

process.exitCode = await runAgentCommand({
  agent, runtime, name: 'plan-trip',
  inputJsonSchema: {
    type: 'object',
    required: ['city'],
    properties: {
      city: { type: 'string', description: 'Where to go.' },
      days: { type: 'integer' },
      budget: { type: 'boolean' },
    },
  },
});
await runtime.close();
```

```text
plan-trip --city Paris --days 3
plan-trip --city Rome --no-budget
plan-trip --help
plan-trip --input '{"city":"Paris"}' --json
echo "a weekend in Lisbon" | plan-trip
```

The input comes from exactly one of these:

1. **`--input <json>`** or **`--input-file <path>`**: the whole input as JSON. It cannot be combined with flags or
   words.
2. **Flags**, from the top-level `string`, `number`, `integer` and `boolean` properties of `inputJsonSchema`, collected
   into an object. Booleans take no value and also accept `--no-<name>`. Numbers are checked.
3. **Words** on the command line, joined with spaces into one string (only without flags).
4. **Standard input**, when nothing else is given and it is piped (up to 1 MiB of text).

The agent's `input` schema still validates whatever arrives; the JSON Schema only drives the flags and `--help`.

| Option | Meaning |
|---|---|
| `agent`, `runtime` | Required. |
| `name` | The command name in `--help`. The default is the agent id. |
| `argv` | The arguments. The default is `process.argv.slice(2)`. |
| `inputJsonSchema` | The input's JSON Schema, for flags and `--help`. |
| `toText(output)` | What to print for a successful output. The default is `outputText`. |
| `io` | `{ stdin, stdout, stderr }` streams to use instead of the process's. |

`--json` prints `{ status, output, spentMicros }` (or `{ status, error, spentMicros }`) instead of text. When standard
output is a terminal and `--json` is not set, streamed text is printed as it arrives and each tool the agent uses is
listed on standard error. Confirmations and questions are asked only when standard input is a terminal; in a pipe or
a scheduled job they are refused.

`parseAgentCommand(argv, schema?, stdin?)` and `agentCommandHelp(name, schema?)` are the parser and help text on
their own, for building a different front end.

## Good to know

- When a reply was streamed, the chat and commands show the streamed text and do not print the final output again.
  Streamed text is the model's raw field: if a batch guard stopped the stream partway, or your output schema rewrites
  the answer (for example to redact it), what the person saw differs from the run's output. For such agents, leave
  out `stream` when you use these front ends.
- Costs shown are from the runtime's budget for each run; see [Costs and budgets](../concepts/costs-and-budgets.md).
- These helpers are for a person at a terminal. For approvals in a web app or a long-running workflow, see
  [Approvals and human input](approvals-and-human-input.md).

## Related

- [Streaming](streaming.md)
- [Tools](../concepts/tools.md)
- [Approvals and human input](approvals-and-human-input.md)
- [CLI overview](../cli/overview.md)
