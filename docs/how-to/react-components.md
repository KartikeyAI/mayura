# Render Mayura's React reference components

Install the optional React adapter and your application's React runtime/types:

```sh
pnpm add @mayura/client @mayura/client-react react
pnpm add -D @types/react
```

```tsx
import { MayuraHumanRequestCard, MayuraRunSummary, MayuraWorkflowGraph } from '@mayura/client-react/components';

export function OperationsView({ store, workflow, request, nowMs }: Props) {
  return <>
    <MayuraRunSummary store={store} />
    <MayuraWorkflowGraph input={workflow} />
    <MayuraHumanRequestCard
      request={request}
      nowMs={nowMs}
      onRespond={({ id, digest }) => openValidatedResponseForm(id, digest)}
    />
  </>;
}
```

Own and dispose the run store outside these components. Build response values in an application form, validate them against the registered request schema, and submit through the authenticated client with a stable command ID. Treat workflow readiness and progress as presentation facts only.
