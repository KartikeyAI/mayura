# List authorized durable workflows

Provide a bounded application index separately from full view inspection:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowIndex: {
    list: query => workflowRepository.listAuthorized(query),
  },
});
```

Read one page explicitly:

```ts
const page = await client.workflows({ limit: 20 });
const nextPage = page.next === null
  ? null
  : await client.workflows({ after: page.next, limit: 20 });
```

## Finished runs and runs that need reconciling

The index lists active runs (running, waiting or paused) by default. Ask for the settled view to see runs that
finished, and runs whose outcome is unknown, for example after a crash during an external effect:

```ts
const settled = await client.workflows({ view: 'settled', limit: 20 });
for (const run of settled.items) console.log(run.runId, run.status, new Date(run.settledAtMs!));
```

From the command line: `mayura workflow-list --url <server> --token-stdin --settled`. The console's Workflows
view has an Active / Finished toggle.

With `createWorkflowOperatorTransports`, lifecycle runs appear in the settled view automatically: the lifecycle fleet
runtime records each run as it settles (`runtime.settled()`), keeping at most 64 per shard (16,384 per scope). When
a shard is full the oldest finished run is dropped first; a run whose outcome is unknown is dropped only when a shard
holds nothing else, so these stay listed until you reconcile them. Graph and tree runs are not in the settled view
yet; open them by id. A custom `workflowIndex.list` receives `view: 'settled'` for this request and must return
records with `settledAtMs` and a final status, or the server refuses the page.

Treat the cursor as opaque and short-lived. Do not infer visibility or existence from omission, and do not automatically exhaust pages in a UI or background effect.
