# Pause and resume a durable workflow

Bind the pause command to the same format-specific runtime or coordinator that owns the run. Pause has its own least-authority adapter; a server without `workflowPauses` answers `404` for the route even when continuation is configured.

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowPauses: {
    pause: command => workflowCommands.pause(command),
  },
  workflowResumes: {
    resume: command => workflowCommands.resume(command),
  },
});
```

`workflowCommands.pause` must atomically journal `commandId` with the verified scope, action and request digest, check the expected revision, then call the owning runtime's `pause(runId)`: the conservative format-2 runtime, `createWorkflowGraphRuntime` (format 3), `createWorkflowTreeRuntime` (format 4, tree-wide) or the format-5 lifecycle runtime or fleet. Map a runtime `CONFLICT` to `{ status: 'conflict' }`: the run is terminal, the revision is stale, or an effect is claimed or in flight and must settle or be recovered first. Pause never interrupts a dispatched effect and never cancels the run.

Lift a pause through the existing continuation command. When the run is paused, `workflowCommands.resume` calls the runtime's `resume(runId)` before normal continuation. Resume restores `waiting` when an approval, human request, timer, signal or child is still unresolved; it never satisfies that gate.

Browser clients and the caller-owned command controller issue one explicit request each:

```ts
const paused = await client.pauseWorkflow(runId, view.revision, { commandId, signal });
await controls.pause({ commandId, signal }); // only from a running or waiting view
await controls.resume({ commandId, signal }); // from a paused view
```

The Node CLI uses the same boundary:

```text
mayura workflow-pause --url https://agent.example --id <run-id> --revision 7 --command-id <stable-id> --token-stdin
mayura workflow-resume --url https://agent.example --id <run-id> --revision 8 --command-id <stable-id> --token-stdin
```

After conflict, fetch the latest view and reconsider. After an ambiguous failure, reconcile with the same command ID. Never create a new command ID merely to retry a pause.
