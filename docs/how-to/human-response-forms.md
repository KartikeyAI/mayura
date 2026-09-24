# Build a typed human response form

Define forms in trusted application code and bind them to the same registered schema identity returned by the server:

```tsx
import { defineHumanResponseForm } from '@mayura/client/forms';
import { MayuraHumanResponseForm } from '@mayura/client-react/components';

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

export function Review({ client, request, nowMs }: Props) {
  return <MayuraHumanResponseForm
    key={request.digest}
    request={request}
    definition={reviewForm}
    nowMs={nowMs}
    onSubmit={({ id, digest, value }) => {
      void client.respondHumanRequest(id, digest, value, { commandId: crypto.randomUUID() });
    }}
  />;
}
```

Track pending, success and conflict state in the application. Re-fetch after a digest conflict instead of replaying automatically. Never derive trusted definitions from unvalidated remote JavaScript objects, and do not put secrets in labels, prompts or client-side validation errors.

