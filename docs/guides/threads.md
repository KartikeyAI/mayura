---
title: "Threads"
description: "Keep a user's conversations with an agent in your store, run each new message as a turn with the conversation so far, and delete them for good."
---

A thread is one conversation between a user and an agent: every message, tool call, result, approval and answer,
in order. `mayura/threads` keeps threads in your store, scoped to who they belong to, and runs each new message as a
turn that sees the conversation so far.

## A conversation in three calls

```ts
import { createRuntime } from 'mayura';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createThreads, runInThread } from 'mayura/threads';

const store = createSqliteStore({ filename: 'app.sqlite' });
await store.initialize();
await store.threads.initialize(); // once: creates the thread tables

const scope = { principalId: 'user-42', projectId: 'shop' }; // from your verified identity
const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:openai.responses', 'tool:orders.lookup', 'effect:read'] } });
const threads = createThreads({ store, scope, permissions: { allow: ['thread:read', 'thread:write', 'thread:delete'] } });

const thread = await threads.create({ title: 'Order help', agentId: 'support' });

const turn = await runInThread({ threads, runtime, agent: supportAgent, threadId: thread.id, input: { message: 'Where is order A-1001?' } });
const { outcome } = await turn.done;

// The next message sees the first turn: its question, the lookup and the answer.
const next = await runInThread({ threads, runtime, agent: supportAgent, threadId: thread.id, input: { message: 'When will it arrive?' } });
console.log((await next.done).outcome);
```

## What a turn does

`runInThread` runs one message as a turn:

1. **Holds the thread** for this turn. One turn runs at a time; a second gets `CONFLICT` until the first is done. The
   hold is renewed while the run lasts, including while it waits for an approval, and lapses if the process dies.
2. **Gives the run its history:** the thread's newest whole turns that fit the history policy, oldest first. The run
   sends them before its input on every model call. See [A conversation history](../concepts/runtime.md#a-conversation-history).
3. **Records the turn** when the run ends: its input as the model saw it, each batch of tool calls with its approvals
   and released results, the final output, and the outcome. A result a guard withheld is never stored.
4. **Lets go** of the thread, so the next turn can start.

It returns `{ turnId, run, history, done }` at once: observe, approve or cancel `run` as any run, and await `done` for
the outcome and the recorded entries.

- **Failed turns** are recorded (the input and the outcome, with its error code) but left out of later history.
- **The thread's agent:** a thread created with `agentId` refuses another agent with `CONFLICT`. An archived thread
  refuses new turns until `restore`.
- **Too large to store:** an entry holds at most 256 KiB. A larger input, result or output is recorded as
  `{ ..., omitted: 'too_large' }`, and later history shows the model that it was left out.
- **Media** is not stored in threads; an entry says how many items were left out (`mediaOmitted`).
- **Approvals:** a turn whose run waits for approval keeps the thread held while it waits; the approval is recorded
  with who answered. A run that another runtime continues after a restart is not recorded in the thread yet.

## History

`threads.history(id, { maxEntries, maxBytes })` returns the messages a run would get, and `runInThread` takes the same
`history` option:

- the newest whole turns that fit: a tool call is never split from its result, and a turn is never cut;
- at most `maxEntries` messages (default 200) and `maxBytes` of JSON (default 512 KiB); history also counts toward
  the run's `limits.maxContextBytes`;
- `turns` and `omittedTurns` say what was included and what did not fit;
- if the newest turn alone does not fit, `LIMIT_EXCEEDED`: nothing is silently truncated.

## Managing threads

| Method | Grant | What it does |
| --- | --- | --- |
| `create({ id?, agentId?, title?, metadata? })` | `thread:write` | A new thread. With your own `id`, calling it again returns the same thread. |
| `get(id)` | `thread:read` | The thread, or `undefined`. |
| `list({ status?, cursor?, limit? })` | `thread:read` | This scope's threads, most recently updated first, 20 a page by default. |
| `update(id, { title?, metadata?, expectedVersion? })` | `thread:write` | Rename it or change its metadata (at most 2 KiB); with `expectedVersion`, only if unchanged since. |
| `archive(id)`, `restore(id)` | `thread:write` | Hide it from the default list, or bring it back. |
| `entries(id, { after?, before?, limit? })` | `thread:read` | Its entries in order; with `before`, the newest page below a sequence. |
| `history(id, policy?)` | `thread:read` | See above. |
| `delete(id)` | `thread:delete` | Delete it and all its entries for good. |

- **Scope:** every method works only on the threads of `scope`. Another user's thread is not found.
- **Deleting** makes the content unreadable at once, removes every entry, and keeps a tombstone (`status: 'deleted'`)
  so the id is never reused.
- **Retention:** `purgeIdleThreads({ store, idleBefore, limit? })` deletes threads idle since before a time, in every
  scope. It is an administrative job for your scheduler, not scoped.

## Good to know

- Threads work on every Mayura store: SQLite, PostgreSQL, libSQL, MySQL, MongoDB, D1 and DynamoDB.
- The server and client do not expose threads yet.

## Related

- [Runtime](../concepts/runtime.md)
- [Storage](storage.md)
- [Memory and context](memory-and-context.md)
