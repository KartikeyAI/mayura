# Deliver a durable workflow signal

Implement the signal callback over the same authoritative store as the workflow revision and command journal:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowSignals: {
    deliver: command => workflowCommands.deliverSignal(command),
  },
});
```

Grant `workflows:control` separately from read access. Preserve one command ID for one logical attempt:

```ts
const next = await client.signalWorkflow(runId, {
  revision: view.revision,
  signalId: 'deployment-ready/42',
  signalName: 'deployment.ready',
  value: { region: 'ap-south-1' },
}, { commandId, signal });
```

The Node CLI reads the value from a regular, non-linked UTF-8 JSON file and never prints it:

```text
mayura workflow-signal --url https://agent.example --id <run-id> --revision 7 --command-id <stable-id> --signal-id deployment-ready/42 --signal-name deployment.ready --value-file ./signal.json --token-stdin
```

Refresh from the returned view before issuing another revision-dependent command. On conflict, fetch the current view and reconsider. After timeout or connection loss, reconcile using the same command ID because the signal may already be durable.
