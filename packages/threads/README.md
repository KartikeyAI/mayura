# mayura/threads

A scope's conversation threads over `store.threads`, and `runInThread`, which runs an agent in a thread: it holds
the thread for one turn, gives the run the thread's newest whole turns as history, and records the turn.

```ts
import { createThreads, runInThread } from 'mayura/threads';

const threads = createThreads({ store, scope, permissions: { allow: ['thread:read', 'thread:write'] } });
const thread = await threads.create({ title: 'Order help' });
const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Hi' } });
console.log((await turn.done).outcome);
```

See the [threads guide](../../docs/guides/threads.md).
