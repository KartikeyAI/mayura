# Read a durable workflow in a browser

Provide a server-side adapter that authorizes and assembles one content-free view from an authoritative definition/snapshot pair:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowViews: {
    async inspect({ scope, agentIds, runId, signal }) {
      return workflowViews.inspectAuthorized({ scope, agentIds, runId, signal });
    },
  },
});
```

Grant `workflows:read` only to identities allowed to inspect that project. In the browser:

```ts
import { createWorkflowGraphProjection } from '@mayura/client/workflows';

const view = await client.workflow(runId, { signal });
const graph = createWorkflowGraphProjection(view);
```

Treat `NOT_FOUND` uniformly for absent or unauthorized records inside your adapter. Refresh explicitly according to application policy; the client does not poll or retry. Do not use `ready` presentation metadata as permission to execute a step.

