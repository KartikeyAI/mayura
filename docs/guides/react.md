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
step, model, tool, hook and delegate items, each `active`, `completed`, `failed`, `blocked`, `cancelled`,
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
