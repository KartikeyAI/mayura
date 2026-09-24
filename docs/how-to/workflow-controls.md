# Connect durable workflow controls

Implement both callbacks over an authoritative, transactionally idempotent application service:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowControls: {
    cancel: command => workflowCommands.cancel(command),
    approve: command => workflowCommands.approve(command),
  },
});
```

Grant `workflows:control` separately from `workflows:read`. In a browser event handler, preserve one command ID for one logical attempt:

```ts
await client.approveWorkflow(runId, {
  revision: view.revision,
  nodeId: 'review',
  approvalDigest,
  childRunId,
}, { commandId, signal });

await client.cancelWorkflow(runId, view.revision, { commandId, signal });
```

For UI feedback, bind a controller to the currently admitted view and invoke it only from an explicit event:

```ts
const controls = createWorkflowCommandController({ workflow: view, client });
await controls.approve({ nodeId, approvalDigest, childRunId }, { commandId, signal });
const state = controls.getSnapshot();
```

The same controller can submit one bounded signal when its client implements signal delivery:

```ts
await controls.signal({ signalId, signalName, value }, { commandId, signal });
await controls.resume({ commandId, signal });
```

Signal values are immutable command inputs and are never copied into command state.

Create a new controller after accepting the returned view. `reset()` only clears feedback; it does not refresh or advance the revision.

On HTTP 409, refresh explicitly and ask the user to reconsider the new state. After an ambiguous transport failure, reconcile using the same command ID before deciding whether another logical command is appropriate. Never generate a new ID and automatically repeat a mutation.

Durable external signals use the separate least-authority adapter and route described in [workflow signals](workflow-signals.md); they are not added to the cancellation/approval controller implicitly.
Continuation uses the separate [workflow resume](workflow-resume.md) adapter and cannot satisfy a waiting gate by itself.
