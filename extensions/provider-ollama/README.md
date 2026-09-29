# @mayurajs/provider-ollama

Ollama models for [Mayura](https://mayurajs.com), on your own machine or in Ollama's cloud, through the official `ollama` SDK.

```bash
npm install mayura @mayurajs/provider-ollama
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { ollama } from '@mayurajs/provider-ollama';

const models = createModels({
  providers: [ollama()], // http://127.0.0.1:11434
  prices: { 'ollama/gpt-oss:20b': { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
  maxCallCostMicros: 1,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('ollama/gpt-oss:20b'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:ollama/gpt-oss:20b.
```

- Local models cost nothing, so there is no catalog: give each model's price, zero or your own.
- `host` is http only on a loopback address, https anywhere else. For Ollama's cloud, use `ollama({ host: 'https://ollama.com', apiKey })`.
- Nothing is read from the environment (not `OLLAMA_HOST` or `OLLAMA_API_KEY`) or the file system.
- Structured output and tool inputs use JSON Schema. With tools, the answer comes from one more call, in the format, once the model calls no more tools (a format leaves no way to call a tool); streaming reports output text as it arrives; set `think` for a thinking model, whose thinking is kept for the next call and never released.
- Models see no media unless you say so: pass `media: { types: ['image/png', 'image/jpeg'], urls: false }` for a vision model.
- The default time limit is 120 seconds, since a local model may need loading first.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
