# Build a typed human response form

Define forms in trusted application code and bind them to the same registered schema identity returned by the server:

```tsx
import { createHumanResponseController, defineHumanResponseForm } from 'mayura/client/forms';
import { MayuraHumanResponseForm } from 'mayura/client-react/components';
import { useMayuraHumanResponseCommand } from 'mayura/client-react';

const reviewForm = defineHumanResponseForm({
  schemaId: 'deployment-review-v1',
  schemaDigest: registeredSchemaDigest,
  fields: [
    { kind: 'textarea', name: 'summary', label: 'Review summary', required: true, maxLength: 2_000 },
    { kind: 'integer', name: 'risk', label: 'Risk score', required: true, minimum: 1, maximum: 5 },
    { kind: 'select', name: 'decision', label: 'Decision', required: true, options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ] },
  ],
});

export function Review({ controller, request, nowMs }: Props) {
  const command = useMayuraHumanResponseCommand(controller);
  return <MayuraHumanResponseForm
    key={request.digest}
    request={request}
    definition={reviewForm}
    nowMs={nowMs}
    commandState={command}
    onSubmit={submission => {
      void controller.submit(submission, { commandId: currentCommandId }).catch(() => {});
    }}
  />;
}
```

Create the controller when the authenticated request changes and dispose it on unmount:

```ts
const controller = createHumanResponseController({ client, request });
```

The controller accepts the genuine submission returned by the form validator; do not reconstruct it as a plain object. Keep a stable command ID for one logical attempt. Re-fetch after a digest conflict instead of replaying automatically. Never derive trusted definitions from unvalidated remote JavaScript objects, and do not put secrets in labels, prompts or client-side validation errors.
