# @mayura/workflows

Experimental finite, schema-driven workflows for Mayura. Define versioned tools/joins once, then explicitly select conservative durable execution, opt-in leased scheduled execution, or approval-free ephemeral agent composition.

```ts
import {
  defineWorkflow,
  createWorkflowRuntime,
  createScheduledWorkflowRuntime,
} from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
```

Both durable runtimes require an application-owned storage adapter. The scheduled runtime requires atomic `ScheduledWorkflowStore` support and does not silently upgrade conservative runs. SQLite and PostgreSQL implementations are selected separately through `@mayura/storage`; this package does not install their drivers.

Scheduled execution admits at most 64 KiB per input/output, uses storage-clock leases and exact approvals, and retains late effect evidence without releasing late output. Unknown started effects are never automatically replayed. Worker shutdown is cooperative, not hard isolation or provider-side cancellation.

See the workspace Markdown documentation for complete scheduled/conservative contracts, adoption examples, failure tests and current limitations. This private development build is not an enterprise-qualified release. License and registry namespace remain owner decisions; nothing has been published.
