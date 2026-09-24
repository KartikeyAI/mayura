# Use the React bindings

Install the browser client, React adapter and the React version selected by your application:

```sh
pnpm add @mayura/client @mayura/client-react react
```

Create one headless store outside render, or memoize it by run identity. Start network work only from application-controlled handlers or effects, and dispose the store when its owning scope ends.

```tsx
import { useEffect, useMemo } from 'react';
import { createClient } from '@mayura/client';
import { createHeadlessRunStore } from '@mayura/client/headless';
import { useMayuraRun, useMayuraRunActions, useMayuraRunActivity } from '@mayura/client-react';

export function RunStatus({ runId, token }: { runId: string; token: () => Promise<string> }) {
  const store = useMemo(() => {
    const client = createClient({ baseUrl: 'https://agents.example.com', token });
    return createHeadlessRunStore({ run: client.run(runId) });
  }, [runId, token]);
  const state = useMayuraRun(store);
  const actions = useMayuraRunActions(store);
  const activity = useMayuraRunActivity(state);

  useEffect(() => () => store.dispose(), [store]);
  return <button type="button" onClick={() => void actions.refresh()}>{state.connection}: {activity.items.length}</button>;
}
```

Choose observation, retry, polling and cancellation policy in the application. `dispose()` aborts local reads and removes subscribers; it never cancels the remote run. Render human-request prompts as text and submit responses through the authenticated client using the request digest.
