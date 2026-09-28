# Run an agent in the terminal

`mayura/terminal` puts an agent in front of a person at a terminal, as an interactive chat or as a one-shot command.

## Chat

```ts
import { createRuntime, defineAgent } from 'mayura';
import { askPersonTool, confirmBeforeRunning, runTerminalChat } from 'mayura/terminal';

const agent = defineAgent({ id: 'support', version: '1', instructions: 'You help customers.', model, input, output,
  tools: [lookupOrder, confirmBeforeRunning(refundOrder), askPersonTool] });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: [
  'model:openai.responses', 'tool:orders.lookup', 'tool:orders.refund', 'effect:write', 'tool:person.ask', 'person:ask'] } });

await runTerminalChat({ agent, runtime, toInput: (message, history) => ({ message, history }) });
```

Each message runs the agent once. Replies stream in as they are written when the agent streams (`defineAgent({ stream })`),
tool use shows while it runs, and each turn shows what it cost. `/help`, `/clear` (forget the conversation), `/cost` and
`/exit` work at the prompt.

`toInput(message, history)` builds the agent's input from the message and the earlier turns (the default passes the
message text), and `toText(output)` turns its output into what the person reads (the default uses a string output, or
its `reply`, `message`, `text`, `answer`, `content` or `response` field, or else JSON).

## A person in the loop

- `confirmBeforeRunning(tool, { describe })` returns the same tool, but the person sees its input and confirms first.
  The default answer is no. Declining refuses the call before any effect: Mayura fails the run closed on a refused
  tool, so the turn ends with "The person declined …" and the chat goes on.
- `askPersonTool` lets the agent ask the person a question and continue with the answer. Grant `tool:person.ask` and
  `person:ask`.

Both need someone at a terminal. The same agent running anywhere else (a server, a scheduled job, a piped command)
refuses them, so a confirmed tool can never run unconfirmed. The confirmation is built on `withPreflight` from
`mayura/tools`, which runs any check on a tool's validated input before its executor.

## One-shot commands

```ts
#!/usr/bin/env node
import { runAgentCommand } from 'mayura/terminal';

process.exitCode = await runAgentCommand({ agent, runtime, name: 'plan-trip', inputJsonSchema: {
  type: 'object', required: ['city'], properties: { city: { type: 'string', description: 'Where to go.' }, days: { type: 'integer' } } } });
```

```text
plan-trip --city Paris --days 3
plan-trip --help
plan-trip --input '{"city":"Paris"}' --json
echo "a weekend in Lisbon" | plan-trip
```

Flags come from the top-level string, number, integer and boolean properties of `inputJsonSchema` (booleans also take
`--no-<name>`), and `--help` lists them. Without flags, the words on the command line, `--input <json>`,
`--input-file <path>` or piped standard input become the input. `--json` prints `{ status, output, spentMicros }`; the
exit code is 0 when the agent succeeded and 1 otherwise. In a terminal, streamed text and tool use are shown as they
happen; confirmations and questions are asked only when standard input is a terminal.
