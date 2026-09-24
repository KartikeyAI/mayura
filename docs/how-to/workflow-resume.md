# Request durable workflow continuation

Bind continuation to the format-specific durable coordinator that owns the run:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowResumes: {
    resume: command => workflowCommands.resume(command),
  },
});
```

The application callback must verify the expected revision, pinned definition and current authorization, then run normal continuation. It must return conflict rather than bypass an unresolved approval, human request, timer, signal wait, uncertain effect or incompatible definition.

Browser clients and the caller-owned command controller issue one explicit request:

```ts
const next = await client.resumeWorkflow(runId, view.revision, { commandId, signal });
await controls.resume({ commandId, signal });
```

The Node CLI uses the same boundary:

```text
mayura workflow-resume --url https://agent.example --id <run-id> --revision 7 --command-id <stable-id> --token-stdin
```

After conflict, fetch the latest view and reconsider. After ambiguous failure, reconcile with the same command ID. Never create a new command ID merely to retry continuation.
