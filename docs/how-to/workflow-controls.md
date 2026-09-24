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

On HTTP 409, refresh explicitly and ask the user to reconsider the new state. After an ambiguous transport failure, reconcile using the same command ID before deciding whether another logical command is appropriate. Never generate a new ID and automatically repeat a mutation.
