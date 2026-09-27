# Bind Mayura to a UI framework

```ts
import { createHeadlessRunStore, createRunActivityProjection } from 'mayura/client/headless';

const store = createHeadlessRunStore({ run: client.run(runId), maxEvents: 256 });
const unsubscribe = store.subscribe(() => render(store.getSnapshot()));

await store.refresh();       // one authenticated snapshot read
const activity = createRunActivityProjection(store.getSnapshot());
void store.observe();        // one explicit SSE observation, no reconnect loop

// A cancellation is an explicit command and is never retried automatically.
await store.cancel();

unsubscribe();
store.dispose();             // stops observation; does not cancel the run
```

For React, use the optional `mayura/client-react` hooks. Keep the store outside render execution and dispose it when its run view is permanently removed. Vue and Svelte adapters can subscribe through the same two methods.

When `activity.complete` is false or `hasGap` is true, present the timeline as incomplete and refresh the authoritative run snapshot. An item with `unknown` status has no safe terminal inference. Display `errorCode`, not caught transport messages. Call `observe()` again only after an explicit application/user reconnect decision.

Create human-request presentation metadata with `createHumanRequestView(request, trustedNowMs)`. Render its `prompt`, IDs and status labels as text. Submit responses through `client.respondHumanRequest()` using the exact selected request digest and a stable command ID; never treat the view model as approval authority.
