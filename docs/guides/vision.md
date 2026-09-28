---
title: "Vision: images and PDFs"
description: "Agents that see: send images and PDFs with an agent's input, return screenshots from tools, and keep media checked, limited and out of logs."
---

An agent can look at images and PDFs: a screenshot of an error, a photo of a receipt, a scanned contract. Media does
not travel inside your JSON input. It has its own channel next to the input, its own byte limits, and it is checked
before a run starts: its type is read from the file's own bytes, not only from its label.

```ts
import { readFile } from 'node:fs/promises';
import { createRuntime, defineAgent, media } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const agent = defineAgent({
  id: 'receipts', version: '1', instructions: 'Read the receipt and report its total.',
  model: openAIResponses({ apiKey, model: modelId, maxCostMicros: 20_000, pricing }),
  tools: [],
  input: z.object({ question: z.string() }),
  output: z.object({ total: z.string(), currency: z.string() }),
  media: { accept: ['image/png', 'image/jpeg', 'application/pdf'] },
});

const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: ['model:openai.responses'] }, limits: { maxCostMicros: 100_000 },
});
const photo = media(await readFile('receipt.jpg'), 'image/jpeg', { name: 'receipt.jpg' });
const outcome = await runtime.submit(agent, { input: { question: 'What is the total?' }, media: [photo] }).result();
```

## Media values

| Function | Creates |
|---|---|
| `media(bytes, mediaType, { name? })` | Media from bytes (`Uint8Array` or `ArrayBuffer`). The bytes are copied, and must really be `mediaType`: a PNG labelled `image/jpeg` is refused here. |
| `mediaUrl(url, mediaType, { name? })` | Media the model provider fetches itself from an `https://` URL. |
| `mediaFromBase64(text, mediaType, { name? })` | Media from base64 text, as it arrives in JSON. |
| `mediaFromArtifact(store, reference, scope)` | Media read from the [artifact store](artifacts.md), from `mayura/artifacts`. |

The supported types are `image/png`, `image/jpeg`, `image/webp`, `image/gif` and `application/pdf` (`MEDIA_TYPES`).
Other files, such as SVG or HTML, are never accepted.

## What an agent accepts

Nothing is accepted unless the agent declares it with `media`:

| Field | Meaning |
|---|---|
| `accept` | The media types allowed. Required. |
| `maxItems` | How many items one run may carry. Default 4, at most 32. |
| `maxBytes` | The largest single item, in bytes. Default 10 MB, at most 64 MiB. |
| `urls` | HTTPS URL prefixes that URL media must start with, each ending in `/`, such as `'https://cdn.example.com/uploads/'`. Without it, only bytes are accepted. |

The runtime limit `maxMediaBytes` (default 20 MiB) bounds all media in one run, with the input and from tools. It is
counted apart from the JSON limits (`maxInputBytes`, `maxContextBytes`), so an image does not crowd out the
conversation.

A refusal happens when you call `submit`, before the run exists, and says what to change: for example
`Agent receipts: media 1 is image/gif, which is not accepted (accepted: image/png, image/jpeg, application/pdf).`

URL media is fetched by the model provider, not by Mayura. List only prefixes you trust the provider to read, and
prefer bytes for anything private.

## Models that can see

A model adapter declares what it can see in `capabilities.media`. `defineAgent` refuses an agent whose model cannot
see a type the agent accepts or its tools return, naming the types, so the mistake shows before the first run.

| Adapter | Default | Change it with |
|---|---|---|
| `openAIResponses` | Every type, and URLs | `media: { types, urls }`, or `media: false` for a model that sees nothing |
| `anthropicMessages` | Every type, and URLs | `media: { types, urls }`, or `media: false` |
| `openAICompatibleChat` | Nothing | `media: { types: ['image/png', 'image/jpeg'], urls: true }` for a model that can see |

A router sees only what every one of its routes can see. Compatible providers receive images as `image_url` parts; a
PDF is sent as a `file` part only if you list `application/pdf`, only as bytes, and not every provider takes it.

## Tools that return images

A tool can return media for the model to look at, such as a screenshot. It declares what it may return with `media`,
and returns `withMedia(output, items)`:

```ts
import { defineTool, media, withMedia } from 'mayura';
import { z } from 'zod';

const screenshot = defineTool({
  id: 'browser.screenshot', version: '1', description: 'Take a screenshot of the current page.',
  input: z.object({}), output: z.object({ width: z.number(), height: z.number() }),
  effects: 'read', capabilities: ['browser'],
  media: { accept: ['image/png'], maxBytes: 5_000_000 },
  execute: async () => {
    const png = await takeScreenshot(); // your browser automation
    return withMedia({ width: 1280, height: 800 }, [media(png, 'image/png', { name: 'page.png' })]);
  },
});
```

The output is checked against the tool's output schema as usual; the media is checked against the tool's `media` and
the run's `maxMediaBytes`. A tool that returns media it did not declare fails with `INVALID_OUTPUT`. Anthropic models
see the images inside the tool result; OpenAI models see them in a message right after the tool results.

## Privacy

- Hooks never see media bytes. `beforeExecution` has `media`, a summary of each item (type, size, name), and
  `beforeModelCall` has `request.media`, the same summaries by message index. See [Lifecycle hooks](lifecycle-hooks.md).
- Events carry only counts: `run.started` and `tool.completed` have `media` when there was some.
- Guards check the JSON input and outputs only, so text guards such as `redactPII` never touch image data.
- Continuations never store media bytes: they point back to the run's own messages.

## Over HTTP

`POST /v1/runs` takes `media` next to `input`: base64 bytes, an allowed URL, or an artifact reference. The client
sends media with `submit`:

```ts
import { createClient } from 'mayura/client';

const client = createClient({ baseUrl: 'https://agents.example.com', token: async () => accessToken });
const file = await fetch('/receipt.jpg').then(response => response.arrayBuffer());
await client.submit('receipts', { question: 'What is the total?' }, {
  idempotencyKey: crypto.randomUUID(),
  media: [{ mediaType: 'image/jpeg', data: new Uint8Array(file), name: 'receipt.jpg' }],
});
```

The server checks the media against the agent before starting the run and answers `400 INVALID_MEDIA` with the exact
reason. See [Server and client](server-and-client.md) for the body limit and artifact references.

## In workflows

Workflow state holds JSON only. To give a workflow step's agent an image, keep a reference in the step's input and
read the media when the step runs, with `agentStep`'s `media` option:

```ts
import { defineAgent } from 'mayura';
import { mediaFromArtifact } from 'mayura/artifacts';
import { agentStep } from 'mayura/workflows/lifecycle';
import { z } from 'zod';

const receiptAgent = defineAgent({
  id: 'receipts', version: '1', instructions: 'Read the receipt and report its total.', model, tools: [],
  input: z.object({ receipt: z.record(z.string(), z.unknown()) }), // the stored artifact's reference
  output: z.object({ total: z.string() }),
  media: { accept: ['image/png', 'image/jpeg', 'application/pdf'] },
});

const readReceipt = agentStep(receiptAgent, {
  id: 'receipt.read', permissions: ['model:openai.responses'], limits: { maxCostMicros: 50_000 },
  media: async (input, context) => [await mediaFromArtifact(artifacts, input.receipt, context.scope)],
});
```

## Testing

`scriptedModel` can see every type, and a scripted step receives the request with its `media`. `testImage()` and
`testPdf()` from `mayura/testing` return small valid files. See [Testing](testing.md).
