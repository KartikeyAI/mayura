# Stream an agent's answer

By default Mayura **buffers** output: nothing reaches the caller until the complete output has passed validation and
every output guard. An agent can opt into streaming one text field of its output, released in **guarded batches**.

```ts
import { defineAgent } from 'mayura';

const assistant = defineAgent({
  id: 'support', version: '1', instructions, input, output, tools, model,
  stream: {
    field: ['reply'],                 // the string field of the output to stream
    guards: [noCardNumbers],          // local checks run on every batch before it is released
    batch: { minChars: 24, maxChars: 512 },
  },
});
```

The model adapter must support `stream()`: `openAIResponses`, `anthropicMessages` and `createModelRouter` do. On an
adapter without it, the agent answers buffered.

## What is guaranteed

- **Only the chosen field streams.** The runtime follows the model's streamed JSON and releases only the decoded text
  of `field`. Tool-call arguments, reasoning, other fields and provider events are never published.
- **Every batch is checked before release.** Each batch goes through `stream.guards` together with up to 512
  characters of text already released, so a pattern split across batches can still be seen. A block, or a guard that
  throws, stops further release for that model call (`output.withheld`); the answer is still delivered whole if the
  final checks pass. A guard may instead **rewrite** the batch (return `{ decision: 'rewrite', value }` with the same
  released context followed by the new batch text), for example to redact an email address and keep streaming.
  `guards: []` streams without batch checks and must be chosen explicitly.
- **The final output stays authoritative.** The complete response is validated against the output schema and passes
  the agent's output guards exactly as a buffered answer does. Streamed text is provisional: if the final checks
  block, the run fails even though some text was shown. **Released text cannot be retracted**, so put checks that
  must see every character before release in `stream.guards`, and keep strict whole-answer policies buffered.
- **Accounting is unchanged.** Cost comes from the complete response; a stream that breaks keeps the call's full
  reservation unless the provider confirmed its cost.

## Receive it

Streamed text arrives as `output.delta` run events (`step`, `modelCall`, `index`, `text`) on the normal event
stream. The headless store assembles them:

```ts
const store = createHeadlessRunStore({ run });
store.subscribe(() => render(store.getSnapshot().streamedOutput?.text ?? ''));
await store.observe();
```

`streamedOutput` covers the latest model call; `withheld` is true when a batch guard stopped the stream, and
`complete` is false if an event gap or the size bound dropped text. Show the run's final output once it completes.
Render streamed text with `textContent`, never as HTML.

Observers and the OTLP exporter record only the position and length of each delta, never its text.

## Providers and the router

- **OpenAI Responses** streams output-text deltas; the final `response.completed` event carries the same response a
  buffered call returns, which is parsed and accounted by the same code.
- **Anthropic Messages** streams text deltas; the adapter rebuilds the complete message from the event stream and
  parses it with the buffered code.
- **The router** fails over only until the first delta has been released. After that, a failure ends the call rather
  than splicing a second provider's answer onto the first.
