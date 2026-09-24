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

Treat the cursor as opaque and short-lived. Do not infer visibility or existence from omission, and do not automatically exhaust pages in a UI or background effect.
