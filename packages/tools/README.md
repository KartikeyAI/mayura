# `@mayura/tools`

Typed tools, admission, execution receipts and bounded process-local batch orchestration for Mayura.

## Batch output references

`batchOutput(callId, path?)` connects one admitted tool output to another call's input without application-side scheduling. The handle adds its dependency edge automatically; paths use exact own object properties and array indices.

```ts
import { Budget, batchOutput, invokeBatch } from '@mayura/tools';

const outcomes = await invokeBatch([
  { id: 'summarize', tool: summarize, input: { text: batchOutput<string>('load', ['body']) } },
  { id: 'load', tool: loadDocument, input: { id: 'document-1' } },
], {
  runId: 'request-1',
  scope: { principalId: 'user-1', projectId: 'project-1' },
  permissions: { allow: ['tool:load-document', 'tool:summarize'] },
  budget: new Budget(10_000, 2),
  signal: new AbortController().signal,
});
```

Every resolved input crosses the ordinary tool broker, including schema validation, guards, admission and accounting. Missing paths and invalid resolved schemas do not dispatch the dependent. Successful predecessor effects remain successful; batches do not imply rollback.

Handles are immutable process-local authoring values, not serializable durable references. Use workflows for persistence, restart, human approval or cross-process coordination. Batch resource keys coordinate only calls in the same invocation.
