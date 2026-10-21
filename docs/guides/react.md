---
title: "React and UI bindings"
description: "Show live agent runs, workflow progress and human response forms in React, or in any UI framework through headless stores."
---

When a web app calls agents through the [Mayura server](server-and-client.md), it needs to show what is happening:
the run's status, which tools are running, text as it streams, and forms for people to answer questions a workflow
asks. Mayura splits this into two layers:

- Headless stores in `mayura/client` subpaths. They hold state and send requests, with no UI code:
  `mayura/client/headless` (run state), `mayura/client/forms` (human response forms) and `mayura/client/workflows`
  (workflow graphs and commands). Any framework can use them through `subscribe` and `getSnapshot`.
- React bindings: hooks in `mayura/client-react` and unstyled components in `mayura/client-react/components`.

React 18.3 or 19 is an optional peer dependency. Install it yourself:

```bash
npm install mayura react react-dom
```

Nothing here starts a request on its own. Mounting a component or calling a hook never fetches, streams, retries or
cancels. Your event handlers call the store's methods when you decide to.

## A live run in React

This submits a question, follows the run's events until it completes, and shows tool activity, streamed text and the
final reply.

```tsx
import { useEffect, useState } from 'react';
import { createClient } from 'mayura/client';
import { createHeadlessRunStore, type HeadlessRunStore } from 'mayura/client/headless';
import { useMayuraRun, useMayuraRunActivity } from 'mayura/client-react';
import { z } from 'mayura';

const Reply = z.object({ reply: z.string() });
const client = createClient({ baseUrl: `${window.location.origin}/`, token: () => sessionToken() });

function RunView({ store }: { readonly store: HeadlessRunStore }) {
  const state = useMayuraRun(store);
  const activity = useMayuraRunActivity(state);
  return (
    <section>
      <p>{state.connection === 'reconnecting' ? 'Reconnecting…' : state.snapshot?.status ?? state.connection}</p>
      <ul>
        {activity.items.filter(item => item.kind === 'tool').map(item => <li key={item.id}>{item.label}: {item.status}</li>)}
      </ul>
      {state.streamedOutput && <p>{state.streamedOutput.text}</p>}
    </section>
  );
}

export function Ask() {
  const [store, setStore] = useState<HeadlessRunStore | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => () => store?.dispose(), [store]);

  async function ask(message: string): Promise<void> {
    const run = await client.submit('support.assistant', { message }, { idempotencyKey: crypto.randomUUID() });
    const next = createHeadlessRunStore({ run });
    setStore(next);
    setReply(null);
    // Follows the run to its end, reconnecting by itself if the stream drops; throws on real failures.
    await next.observe();
    const outcome = await run.result(Reply);
    setReply(outcome?.status === 'succeeded' ? outcome.output.reply : 'Something went wrong.');
  }

  return (
    <div>
      <button onClick={() => void ask('Where is my order?').catch(() => setReply('Something went wrong.'))}>Ask</button>
      {store && <RunView store={store} />}
      {reply && <p>{reply}</p>}
    </div>
  );
}
```

The chat UI in the support-agent starter (see [mayura init](../cli/init.md)) is a complete version of this, with
sign-in and styling.

## The headless run store

`createHeadlessRunStore({ run })` wraps one `RemoteRun` from the client. You own it: create it once per run and call
`dispose()` when the view goes away. Disposing stops observation; it does not cancel the run.

| Method | What it does |
| --- | --- |
| `refresh()` | Reads the run's current snapshot once. |
| `observe()` | Follows the run's events until `run.completed`, then reads the snapshot. The client reconnects dropped streams from the last sequence (see [Streaming run events](server-and-client.md#streaming-run-events)). One at a time. |
| `cancel()` | Asks the server to cancel the run. Never retried. |
| `subscribe(listener)`, `getSnapshot()` | The external-store contract React and other frameworks use. |
| `dispose()` | Stops everything the store started and removes listeners. |

The state from `getSnapshot()` is immutable and changes identity on every update:

| Field | Meaning |
| --- | --- |
| `connection` | `idle`, `loading`, `observing`, `reconnecting` (the stream dropped and is being reopened; `errorCode` says why), `stopped`, `error` or `disposed`. |
| `snapshot` | The last run snapshot (`status`, `budget`, tool receipts), or `null`. |
| `events`, `lastSequence` | The latest events (up to `maxEvents`, default 256) and the last sequence seen. |
| `hasGap` | Some events were missed; treat the timeline as incomplete and trust `snapshot`. |
| `activity` | How many model, tool and hook calls are in progress (`null` after a gap). |
| `streamedOutput` | For agents that stream an output field: the text so far for the latest model call, plus `withheld` (a stream guard stopped it) and `complete`. The final output from `run.result()` is what counts. |
| `errorCode` | The last error code, safe to show or log: the server's own code (for example `RUN_NOT_FOUND` or `AUTH_EXPIRED`) when it sent one. |

`createRunActivityProjection(state)` (or the `useMayuraRunActivity` hook) turns the events into a timeline of run,
step, model, tool, hook and delegate items, each `active`, `waiting`, `completed`, `failed`, `blocked`, `cancelled`,
`outcome_unknown` or `unknown`. `unknown` means the events cannot tell; do not guess.

## Hooks

| Hook | Returns |
| --- | --- |
| `useMayuraRun(store)` | The store's current state. |
| `useMayuraRunActions(store)` | Stable `refresh`, `observe` and `cancel` functions for event handlers. |
| `useMayuraRunActivity(state)` | The activity timeline for a state. |
| `useMayuraHumanRequest(request, nowMs)` | Display fields for a human request: `statusText`, `actionText`, `urgency`, `canRespond`. |
| `useMayuraHumanResponseCommand(controller)` | The state of a human response submission. |
| `useMayuraWorkflowGraph(view)` | A workflow run as a graph with progress counts. |
| `useMayuraWorkflowCommand(controller)` | The state of a workflow command. |

A hook given something that is not a Mayura store or controller throws `MayuraReactError`.

## Components

`mayura/client-react/components` has accessible, unstyled components. They render plain semantic HTML (sections,
lists, forms, `role="status"` live regions) with `data-mayura-component` and `data-status` attributes to style from,
and render every value as text.

| Component | Shows |
| --- | --- |
| `MayuraThreadHistory` | One thread history page, from a caller-owned thread store; optional explicit paging callbacks. |
| `MayuraRunApprovalControl` | Exact pending tool input, expiry, optional reason and approve/reject actions, from a caller-owned approval controller. |
| `MayuraRunSummary` | A run's status and activity timeline, from a `store`. |
| `MayuraWorkflowGraph` | A workflow run's steps, their status and dependencies, from a run view. |
| `MayuraHumanRequestCard` | A human request's prompt and status, with a respond button that calls `onRespond`. |
| `MayuraHumanResponseForm` | A typed form for answering a human request (below). |
| `MayuraWorkflowPauseControl` | A pause or resume button for one workflow run. |
| `MayuraFleetHoldControl` | Hold and release for the whole fleet, with a confirmation step before holding. |

Components never send anything themselves. Buttons and forms call your callbacks, and you send the command.

## Human response forms

A durable workflow can stop and wait for a person to answer a typed question (see
[Approvals and human input](approvals-and-human-input.md)). Each request names a `schemaId` and `schemaDigest`. In
the browser you define a matching form, and the form validates the answer before anything is sent:

```tsx
import { useEffect, useState } from 'react';
import type { MayuraClient, RemoteHumanRequest } from 'mayura/client';
import { createHumanResponseController, defineHumanResponseForm, type HumanResponseController } from 'mayura/client/forms';
import { useMayuraHumanResponseCommand } from 'mayura/client-react';
import { MayuraHumanResponseForm } from 'mayura/client-react/components';

const reviewForm = defineHumanResponseForm({
  schemaId: 'refund-review',
  schemaDigest: REFUND_REVIEW_DIGEST, // the same digest as the workflow's human step
  fields: [
    { kind: 'select', name: 'decision', label: 'Decision', required: true, options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ] },
    { kind: 'textarea', name: 'note', label: 'Note for the customer', maxLength: 2_000 },
  ],
});

function ReviewForm({ controller, request }: { readonly controller: HumanResponseController; readonly request: RemoteHumanRequest }) {
  const command = useMayuraHumanResponseCommand(controller);
  const [commandId] = useState(() => crypto.randomUUID()); // reuse it only to retry this same answer
  return (
    <MayuraHumanResponseForm
      request={request}
      definition={reviewForm}
      nowMs={Date.now()}
      commandState={command}
      onSubmit={submission => { void controller.submit(submission, { commandId }).catch(() => undefined); }}
    />
  );
}

export function Review({ client, request }: { readonly client: MayuraClient; readonly request: RemoteHumanRequest }) {
  const [controller, setController] = useState<HumanResponseController | null>(null);
  useEffect(() => {
    const next = createHumanResponseController({ client, request });
    setController(next);
    return () => next.dispose();
  }, [client, request]);
  return controller && <ReviewForm key={request.digest} controller={controller} request={request} />;
}
```

- Field kinds are `text`, `textarea`, `number`, `integer`, `boolean` and `select`, up to 32 fields.
- `validateHumanResponse(request, definition, draft)` is the same validation without React. The form calls it on
  submit and passes a checked submission, bound to the request's id and digest, to `onSubmit`.
- A controller sends one answer at a time and never retries. Its state is `idle`, `submitting`, `succeeded`,
  `conflict` (the request changed or was already answered: fetch it again) or `failed`.
- Create the controller only for a request whose `status` is `waiting`. List waiting requests with
  `client.humanRequests()`; the caller needs `humans:read` and `humans:respond`.

## Workflow progress and controls

`client.workflow(runId)` returns a run view. Show it with `MayuraWorkflowGraph`, and steer it through a command
controller, which runs one command at a time against that exact revision:

```tsx
import { useEffect, useState } from 'react';
import type { MayuraClient } from 'mayura/client';
import { createWorkflowCommandController, type WorkflowCommandController, type WorkflowViewInput } from 'mayura/client/workflows';
import { useMayuraWorkflowCommand } from 'mayura/client-react';
import { MayuraWorkflowGraph, MayuraWorkflowPauseControl } from 'mayura/client-react/components';

function Controls({ controller, view, onChange }: {
  readonly controller: WorkflowCommandController; readonly view: WorkflowViewInput; readonly onChange: (view: WorkflowViewInput) => void;
}) {
  const command = useMayuraWorkflowCommand(controller);
  const send = (action: 'pause' | 'resume') => {
    void controller[action]({ commandId: crypto.randomUUID() }).then(onChange, () => undefined);
  };
  return (
    <>
      <MayuraWorkflowGraph input={view} />
      <MayuraWorkflowPauseControl workflow={view} commandState={command} onPause={() => send('pause')} onResume={() => send('resume')} />
    </>
  );
}

export function WorkflowRun({ client, initial }: { readonly client: MayuraClient; readonly initial: WorkflowViewInput }) {
  const [view, setView] = useState(initial);
  const [controller, setController] = useState<WorkflowCommandController | null>(null);
  useEffect(() => {
    // One controller per revision: after a command applies, the new view gets a fresh controller.
    const next = createWorkflowCommandController({ client, workflow: view });
    setController(next);
    return () => next.dispose();
  }, [client, view]);
  return controller && <Controls key={view.revision} controller={controller} view={view} onChange={setView} />;
}
```

A command that finds the run changed (another operator, a fleet sweep) ends in `conflict`: read the run again and
decide. The thrown `ClientError` has the server's code (`WORKFLOW_CONFLICT`) and, when the token may read the run,
`details.currentRevision`. The caller needs `workflows:read` and `workflows:control`; see [Workflow operations](workflow-operations.md).

## Other frameworks

The stores follow the common external-store shape, so Vue, Svelte, Solid or plain DOM code can use them directly:

```ts
import { createHeadlessRunStore } from 'mayura/client/headless';

const store = createHeadlessRunStore({ run: client.run(runId) });
const unsubscribe = store.subscribe(() => render(store.getSnapshot()));
await store.refresh();
void store.observe();
// When the view goes away:
unsubscribe();
store.dispose();
```

`createHumanRequestView(request, nowMs)` in `mayura/client/headless` gives the same display fields as
`useMayuraHumanRequest`. Render prompts and ids with `textContent`, never as HTML.

## Good to know

- Everything the browser sees is metadata or validated output: event streams carry no prompts, tool inputs or tool
  outputs, and the store rejects anything outside the expected shapes.
- Keep secrets out of the bundle. The browser holds a short-lived token that your backend issues; the server decides
  what that token may do.
- `streamedOutput` is provisional. A guard can withhold the rest of the stream, and the validated result can differ.

## Related

- [Server and client](server-and-client.md)
- [Streaming](streaming.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Workflow operations](workflow-operations.md)


## Threads and run approvals

`mayura/client/headless` also exports `createHeadlessThreadsStore({ client })` for one index page and
`createHeadlessThreadStore({ client, threadId, maxEntries? })` for one conversation page. Both start idle.
Call the index store's `refresh({ status, cursor, limit })` explicitly to load a page. The conversation store's
`refresh({ after, before, limit })` replaces its history page, bounded by `maxEntries` (default 100, at most 500).
Both stores allow one operation at a time; overlapping work fails with `VIEW_BUSY`.

The conversation store exposes `update`, `archive`, `restore`, `delete` and `submit`. `submit(agentId, input,
{ idempotencyKey })` fixes the binding to its thread and returns a `RemoteRun`; create a run store separately to
observe it. Mutations never retry or refresh implicitly. Refresh the history after a run ends to load its recorded
turn. Deletion clears the visible thread and entries. Calling `dispose()` aborts owned operations and stops updates.

```tsx
import type { HeadlessThreadStore, HeadlessThreadsStore } from 'mayura/client/headless';
import { useMayuraThread, useMayuraThreadActions, useMayuraThreads } from 'mayura/client-react';

export function Conversation({ store }: { readonly store: HeadlessThreadStore }) {
  const state = useMayuraThread(store);
  const actions = useMayuraThreadActions(store);
  return <section>
    <button onClick={() => { void actions.refresh().catch(() => {}); }}>Refresh conversation</button>
    <p>{state.thread?.title ?? 'Conversation'}: {state.status}</p>
    {state.errorCode && <p role="alert">{state.errorCode}</p>}
    <ol>{state.entries.map(entry => <li key={entry.sequence}>{entry.kind}</li>)}</ol>
  </section>;
}

export function Conversations({ store }: { readonly store: HeadlessThreadsStore }) {
  const state = useMayuraThreads(store);
  return <ul>{state.page?.threads.map(thread => <li key={thread.id}>{thread.title ?? thread.id}</li>)}</ul>;
}
```

Run stores accept `waiting` and refresh their snapshot at pause, resume and event gaps, so the UI can render the
exact `state.snapshot.approval`. Observation remains open across a pause; it does not make approval decisions.
`useMayuraRunActivity` shows a paused run as `waiting`, without treating it as completed.

After inspection, create `createRunApprovalController({ run, approval: snapshot.approval })` outside render.
It captures an immutable copy of that call and digest. Present its tool, input and expiry for review before
calling `submit('approved' | 'rejected', { reason?, signal? })`. Decisions are explicit and never retried.
Feedback is `idle`, `submitting`, `succeeded`, `conflict`, `failed` or `disposed`; an expired request becomes a
conflict without sending. Success or conflict closes that controller to further decisions. Inspect again and create
a new controller for a different pending request. A failed transport may have accepted the decision; inspect before
an explicit retry. The server supplies the actor identity and checks capabilities and the current checkpoint.

```tsx
import type { RunApprovalController } from 'mayura/client/headless';
import { useMayuraRunApprovalCommand } from 'mayura/client-react';

export function Approval({ controller }: { readonly controller: RunApprovalController }) {
  const state = useMayuraRunApprovalCommand(controller);
  const disabled = !['idle', 'failed'].includes(state.status);
  return <section>
    <p>Review {state.approval.toolId}</p>
    <pre>{JSON.stringify(state.approval.input, null, 2)}</pre>
    <button disabled={disabled} onClick={() => { void controller.submit('approved').catch(() => {}); }}>Approve</button>
    <button disabled={disabled} onClick={() => { void controller.submit('rejected').catch(() => {}); }}>Reject</button>
    {state.errorCode && <p role="alert">{state.errorCode}</p>}
  </section>;
}
```

These hooks use the caller's stable snapshots, including during server rendering and React StrictMode.
Mounting and unmounting start no requests, submit no decisions and do not dispose shared stores. The application
owns explicit actions and disposal. `useMayuraThreadActions` returns stable actions without adding a subscription.


## Conversation components

`MayuraThreadHistory` subscribes to a `HeadlessThreadStore` and renders its current page as an ordered list, with
sequence numbers, timestamps, user input, assistant output, tool calls/results, approvals, summaries and terminal
run outcomes. Internal recording markers are hidden. HTML, Markdown and URLs remain plain text. Omitted content
and media are marked explicitly. `maxContentChars` bounds displayed characters per entry (default 8,192, at most
65,536); truncation is marked without changing the saved content. Loading, empty, deleted, disposed and failed
states have accessible feedback. A failed refresh retains the last loaded page.

Optional `onLoadEarlier({ before })` and `onLoadLater({ after })` callbacks add explicit paging buttons when the
loaded sequence bounds indicate more entries. The bounds include hidden recording markers. Route those callbacks
to `store.refresh`; the component never loads pages on mount or scroll. Buttons stop emitting while the store is
busy or closed. The thread count is a snapshot; refresh it to discover later entries from a newly completed run.

`MayuraRunApprovalControl` subscribes to a `RunApprovalController`. It shows the exact tool, version, call, input
and expiry with an optional reason field limited to 1,000 characters. Only explicit approve/reject button events
call `controller.submit`. Concurrent, expired, succeeded, conflicted and disposed decisions are locked. A failed
command also locks the controls because its outcome may be unknown: inspect the run and create a new controller
before another decision. Buttons retain keyboard focus and expose `aria-disabled` while locked; handlers enforce
the lock even when click events arrive before React repaints.

Pass an explicit `nowMs` and update it through your application's clock policy. The component creates no timer;
the controller and server still enforce expiry at submission. `maxInputChars` defaults to 8,192 (at most 65,536).
If the input is truncated, approval is disabled and rejection remains available; use a custom review surface to
review larger input before approving. A different call/digest clears the reason draft. `subject` distinguishes
button labels when several pending approvals are shown together.

```tsx
import type { HeadlessThreadStore, RunApprovalController } from 'mayura/client/headless';
import { MayuraThreadHistory, MayuraRunApprovalControl } from 'mayura/client-react/components';

export function ConversationPanel({ store, controller, nowMs }: {
  readonly store: HeadlessThreadStore;
  readonly controller: RunApprovalController;
  readonly nowMs: number;
}) {
  return <div>
    <button onClick={() => { void store.refresh().catch(() => {}); }}>Refresh history</button>
    <MayuraThreadHistory store={store}
      onLoadEarlier={page => { void store.refresh(page).catch(() => {}); }}
      onLoadLater={page => { void store.refresh(page).catch(() => {}); }} />
    <MayuraRunApprovalControl controller={controller} nowMs={nowMs} subject="current conversation" />
  </div>;
}
```

These components import from `mayura/client-react/components`. They are unstyled and use semantic HTML,
`data-mayura-component` selectors, live status regions and associated input labels. Server rendering, React
StrictMode and unmounting perform no requests, decisions or disposal. Applications own the shared stores,
controllers, refresh policy and eventual cleanup.


## Run the complete chat example

In a repository checkout, the thread chat example connects these components to a real SQLite-backed local server.
It needs no provider key: a deterministic adapter proposes saving each message as a local note.

```sh
pnpm build
node examples/thread-chat/server.mjs
```

Open the printed URL. Send a message, review the pending tool input, then approve, reject or cancel the turn.
The completed turn appears in history and the composer becomes available for the next message. Reload during a
wait to recover the same run and approval. A lost send response can be retried explicitly using its original
idempotency key; decisions never retry automatically. The example separates agent/server setup (`agent.mjs`,
`server.mjs`), app-owned session wiring (`session.js`) and React composition (`app.js`).

The hosts bind only loopback addresses and use a fixed-scope local demo token. Browser storage contains the
current thread/run and in-flight message/retry key, never the token. Temporary SQLite data lasts for the process;
set `MAYURA_CHAT_PORT` and `MAYURA_CHAT_DATABASE` for a stable origin and database across restarts. The application's
clock updates approval expiry; the reusable components still start no requests or timers on mount.

`node examples/thread-chat/check.mjs` builds the browser app and runs the same session through approval, rejection,
cancellation and reload recovery using in-process Fetch, without network calls or credentials. This runs in CI.

## Headless thread compaction

`mayura/client/headless` provides a command-bound controller for any UI framework. The host must opt into
[scoped compaction routes](server-and-client.md#hosted-thread-compaction), and the token needs their explicit capabilities.

```ts
import { createClient } from 'mayura/client';
import { createThreadCompactionController } from 'mayura/client/headless';
const client = createClient({ baseUrl: 'https://agents.example.com', token: () => 'session-token', requestTimeoutMs: 75_000 });
const controller = createThreadCompactionController({ client, threadId: 'conversation-1',
  command: { commandId: 'summary-first-turn', through: 3 }, maxSubscribers: 64 });
const unsubscribe = controller.subscribe(() => console.log(controller.getSnapshot().status));
await controller.compact(); // Only the captured command; no automatic retries.
await controller.refresh(); // Durable status after an interrupted response; no model call.
await controller.cancel(); // May also run while compact() is pending.
unsubscribe();
controller.dispose();
```

Snapshots are immutable and expose status, command metadata, the committed result, cancellation feedback and a safe
error code. History refresh remains explicit. A successful cancellation prevents late submit feedback from replacing
its view state. `missing` does not fence a request that has not reserved yet; inspect and cancel again explicitly if
needed. The controller serializes submit/inspection, independently admits one cancellation, bounds listeners (64 by
default, at most 256), propagates caller abort signals, and stops publication on disposal. Local abort/disposal does not
send a durable cancellation command. Reuse the captured command after uncertainty; a new command ID admits new spending.

## React thread compaction

`useMayuraThreadCompactionCommand(controller)` subscribes to the caller-owned controller;
`useMayuraThreadCompactionActions(controller)` returns stable, explicit `compact`, `refresh` and `cancel` actions.
The snapshot includes the immutable `threadId` and captured `command`, so a view can review the exact prefix before
admitting model spending. Neither hook starts a request, creates a controller or owns its disposal.

`MayuraThreadCompactionControl` on `mayura/client-react/components` provides accessible, unstyled controls over that
same controller. Create the controller once in the application's conversation/session lifecycle, then pass it in:

```tsx
import type { ThreadCompactionController } from 'mayura/client/headless';
import { MayuraThreadCompactionControl } from 'mayura/client-react/components';

export function ConversationCompaction({ controller }: { controller: ThreadCompactionController }) {
  return <MayuraThreadCompactionControl controller={controller}
    subject="Current conversation" label="Summarize earlier turns" maxSummaryChars={8192} />;
}
```

The control shows the thread ID, command ID, inclusive prefix and optional prior summary sequence. **Start compaction**
is available only for an untouched controller. After an uncertain submit, it offers inspection and cancellation;
it never retries a paid call or invents another command ID. Inspection of a `ready` journal enables **Publish saved
summary**, which uses the captured command to publish staged output without another model call. Pending commands
can be inspected again or cancelled; failed and committed commands cannot start another paid call through this view.

Cancellation remains available while submission is pending. A `missing` reservation is presented as uncertain and
never unlocks a replacement call. A committed cancellation preserves the summary. Read-only inspection reports the
last observed durable status, admitted ceiling and recorded cost; unknown cost is shown explicitly. The control does
not invent a numeric budget before the host has admitted the command.

Saved summaries render only as text, with explicit truncation and surrogate-safe character boundaries. Refresh thread
history explicitly after publication or when inspection finds an already committed summary. The component never
interprets summary text as HTML/Markdown, refreshes history implicitly or renders staged output. Its `label`, `subject`
and `maxSummaryChars` props change presentation only. Character limits default to 8,192 and accept 1–65,536.

For a custom view, compose the same hooks:

```tsx
import type { ThreadCompactionController } from 'mayura/client/headless';
import { useMayuraThreadCompactionCommand, useMayuraThreadCompactionActions } from 'mayura/client-react';

export function CompactionStatus({ controller }: { controller: ThreadCompactionController }) {
  const state = useMayuraThreadCompactionCommand(controller);
  const actions = useMayuraThreadCompactionActions(controller);
  const busy = state.status === 'submitting' || state.status === 'loading' || state.cancelling;
  return <section aria-label="Compaction status">
    <p role="status">{state.commandId}: {state.compaction?.status ?? state.status}</p>
    <button type="button" disabled={busy || state.status === 'disposed'}
      onClick={() => { void actions.refresh().catch(() => {}); }}>Inspect command</button>
  </section>;
}
```

SSR, StrictMode, mounting, controller replacement and unmounting perform no remote work or disposal. Applications own
token/capability gating, controller lifetime, command selection and eventual cleanup. Reuse the same command ID when
inspecting uncertainty; choosing a fresh ID is a separate explicit spending decision. Components keep action buttons
focusable while busy and recheck the current controller snapshot on activation, preventing duplicate clicks before
React paints feedback. Style `data-mayura-component="thread-compaction-control"` and `[aria-disabled="true"]` as needed.


See [copy-in components](copy-in-ui.md) for source-owned chat, threads, approvals, status, tools, citations and media controls. Thread actions additionally expose explicit `append` for permissioned imports; refresh the selected history page after a confirmed import.
