---
title: "Streaming"
description: "Stream one text field of an agent's answer as the model writes it, with guards on every batch and the final output still checked."
---

By default Mayura buffers an agent's output: nothing reaches the caller until the whole answer has passed the output
schema and every output guard. For a chat, that means the person waits for the full reply. Streaming lets an agent
release one text field of its answer, such as `reply`, while the model is still writing it.

Streamed text is released in batches, and each batch passes your streaming guards before anyone sees it. The final
output is still validated and guarded as a whole, and it stays the authoritative result of the run.

```ts
import { createRuntime, defineAgent, type Guard } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const noCardNumbers: Guard = {
  id: 'no-card-numbers',
  check: value => (/\d{4}[ -]?\d{4}[ -]?\d{4}/u.test(String(value)) ? { decision: 'block' } : { decision: 'allow' }),
};

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer briefly.',
  model: openAIResponses({ apiKey, model: modelId, outputJsonSchema, maxCostMicros: 20_000, pricing }),
  tools: [],
  input: z.object({ message: z.string() }),
  output: z.object({ reply: z.string() }),
  stream: {
    field: ['reply'],        // the string field to stream
    guards: [noCardNumbers], // checked on every batch before it is released
  },
});

const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: ['model:openai.responses'] }, limits: { maxCostMicros: 100_000 },
});
const run = runtime.submit(agent, { input: { message: 'Where is my parcel?' } });
for await (const event of run.observe()) {
  if (event.type === 'output.delta') process.stdout.write(String(event.metadata['text']));
}
const outcome = await run.result(); // the validated, guarded answer
```

## The stream policy

| Field | Meaning |
|---|---|
| `field` | Path to a string field of the output, 1 to 8 parts: `['reply']`, or `['answer', 'text']` for a nested field. |
| `guards` | Guards run on every batch. Required: pass `[]` to stream without batch checks, as a deliberate choice. |
| `batch.minChars` | A batch is released once it has at least this many characters and ends at a space or line break. Default 24. |
| `batch.maxChars` | A batch never exceeds this many characters. Default 512, at most 4,096. |

Smaller batches show text sooner and run the guards more often; larger batches mean fewer checks and more delay. At the
end of the answer, whatever is left is released as a last batch.

Batch guards must be ordinary local guards (an object with `id` and `check`). Model-backed managed guards are refused
here, because they would run on every batch; keep them in the agent's `guards.output`. See [Guardrails](guardrails.md).

## Guards on batches

Each batch guard receives a string: up to 512 characters of text already released, followed by the new batch. The
context lets a guard see a pattern split across two batches, such as a card number cut in half.

- **Allow**: the batch is released.
- **Block**, or a guard that throws: the batch is withheld, an `output.withheld` event is emitted, and nothing more is
  released for that model call. The run goes on: the full answer is still delivered at the end if the final checks
  pass.
- **Rewrite**: return `{ decision: 'rewrite', value }` where `value` is the same released context followed by the new
  batch text, for example with an email address masked. The rewritten text is released and the next guard sees it.

## The final output stays authoritative

When the model finishes, its complete answer is validated against the agent's `output` schema and passes the agent's
output guards exactly as a buffered answer does. The run's outcome carries that validated output.

Streamed text is provisional, and it is the model's raw text for that field: it has not been through your output
schema's transforms. Two consequences:

- **Released text cannot be taken back.** If the final checks block the answer, the run fails even though some text was
  already shown. Put every check that must see each character before anyone does into `stream.guards`, and keep
  answers that need a whole-answer decision buffered (no `stream`).
- **Show the final output when the run completes**, and replace the streamed text with it. This matters most when a
  batch was withheld, or when your output schema rewrites the answer (for example to redact it).

Accounting does not change: the call's cost comes from the complete response. A stream that breaks keeps the call's
full reservation unless the provider confirmed its cost.

## Consuming the stream

Streamed text arrives as run events of type `output.delta`, with this metadata:

| Key | Meaning |
|---|---|
| `step` | The agent step. |
| `modelCall` | The model call within the run. A new call starts a new answer. |
| `index` | The batch's position in that call, from 0. |
| `text` | The batch text. |

`output.withheld` (with `step` and `modelCall`) says a batch guard stopped the stream for that call.

In the same process, read them from `run.observe()`, as in the example above. The runtime keeps the last 256 events of
a run by default (`limits.maxEventRetention`); an observer that falls further behind receives an `events.gap` event
instead of the missing ones, so observe while the run is in progress.

Over HTTP, the client's headless run store assembles the deltas for you. `streamedOutput` holds the text of the latest
model call, `withheld`, and `complete` (false when an event gap dropped text):

```ts
import { createHeadlessRunStore } from 'mayura/client/headless';

const store = createHeadlessRunStore({ run: remoteRun });
store.subscribe(() => {
  const state = store.getSnapshot();
  preview.textContent = state.streamedOutput?.text ?? '';
});
await store.observe();
```

Render streamed text as text (`textContent`), never as HTML. See [Server and client](server-and-client.md) and
[React](react.md). The terminal front ends in `mayura/terminal` print streamed text as it arrives; see
[Terminal](terminal.md).

## Which models stream

The runtime streams only when the agent has a `stream` policy **and** its model adapter has a `stream` method.
`openAIResponses`, `anthropicMessages`, `openAICompatibleChat` and `createModelRouter` all do. With an adapter that
does not, such as `scriptedModel` from `mayura/testing`, the agent answers buffered. An agent without a `stream`
policy never streams, whatever its adapter supports.

Only the chosen field is released. Other fields, tool-call arguments, reasoning and raw provider events never are.
A model call that ends in tool calls releases no remaining text.

## Good to know

- Mayura's observability records the position and length of each delta, not its text. See
  [Observability](observability.md).
- A stream that produces more characters than `limits.maxOutputBytes` fails the call.
- With a [model router](model-routing.md), failover is possible only until the first batch is released.

## Related

- [Guardrails](guardrails.md)
- [Model providers](model-providers.md)
- [Server and client](server-and-client.md)
- [React](react.md)
- [Terminal](terminal.md)
