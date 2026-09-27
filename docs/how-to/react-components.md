# Render Mayura's React reference components

Install the optional React adapter and your application's React runtime/types:

```sh
pnpm add mayura react
pnpm add -D @types/react
```

```tsx
import { MayuraHumanRequestCard, MayuraHumanResponseForm, MayuraRunSummary, MayuraWorkflowGraph } from 'mayura/client-react/components';

export function OperationsView({ store, workflow, request, nowMs }: Props) {
  return <>
    <MayuraRunSummary store={store} />
    <MayuraWorkflowGraph input={workflow} />
    <MayuraHumanRequestCard
      request={request}
      nowMs={nowMs}
      onRespond={({ id, digest }) => openValidatedResponseForm(id, digest)}
    />
    <MayuraHumanResponseForm
      key={request.digest}
      request={request}
      definition={responseForm}
      nowMs={nowMs}
      commandState={responseCommand}
      onSubmit={submission => { void responseController.submit(submission, { commandId: currentCommandId }).catch(() => {}); }}
    />
  </>;
}
```

Own and dispose the run store outside these components. The reference form validates and binds a typed value but does not send it; submit through the authenticated client with a stable command ID and application-owned pending/conflict feedback. Treat workflow readiness and progress as presentation facts only. See the [response-form guide](human-response-forms.md).
