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

`threads.compact(id, { commandId, through, agent, maxCostMicros })` adds a budgeted summary without deleting
conversation entries. It requires `thread:compact` and an explicit model grant; identical retries reuse staged
results. `history()` includes generated summaries as untrusted context, and `cancelCompaction` fences unfinished work.

See the [threads guide](../../docs/guides/threads.md).

### Core authorization

`createThreads({ ..., authorization, signal? })` adds core policy checks to static grants. Supply the same host-owned
authorizer to the agent runtime for bound run and approval enforcement. Thread resources use exact IDs and verified
scope ownership; lists use `collection`/`list`, filter denied rows and seal scanned continuations. Thread turns need
`append`, approvals need `approve`, and explicit terminal outbox recovery needs `recover`. Reads are checked before
disclosure. An admitted turn's recorder can settle after revocation using its existing durable association.

Compaction inherits the service authorizer and rechecks `compact`/`read` before paid admission and publication. A
paid ready summary and known cost survive denied publication; a retry of that command never regenerates it. Core
audit events contain resource metadata only. Services never close the shared authorizer. See the public authorization
guide for action names and cursor/settlement boundaries. Local offline validation passed; see [release validation status](../../docs/guides/release-readiness.md) for remaining qualifications.
