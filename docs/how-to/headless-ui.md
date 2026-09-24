# Bind Mayura to a UI framework

```ts
import { createHeadlessRunStore } from '@mayura/client/headless';

const store = createHeadlessRunStore({ run: client.run(runId), maxEvents: 256 });
const unsubscribe = store.subscribe(() => render(store.getSnapshot()));

await store.refresh();       // one authenticated snapshot read
void store.observe();        // one explicit SSE observation, no reconnect loop

// A cancellation is an explicit command and is never retried automatically.
await store.cancel();

unsubscribe();
store.dispose();             // stops observation; does not cancel the run
```

For React, pass `store.subscribe` and `store.getSnapshot` to `useSyncExternalStore`. Keep the store outside render execution and dispose it when its run view is permanently removed. Vue and Svelte adapters can subscribe through the same two methods.

When `hasGap` is true, render activity as incomplete and refresh the authoritative run snapshot. Do not infer missing tool/model transitions. Display `errorCode`, not caught transport messages. Call `observe()` again only after an explicit application/user reconnect decision.

Create human-request presentation metadata with `createHumanRequestView(request, trustedNowMs)`. Render its `prompt`, IDs and status labels as text. Submit responses through `client.respondHumanRequest()` using the exact selected request digest and a stable command ID; never treat the view model as approval authority.
