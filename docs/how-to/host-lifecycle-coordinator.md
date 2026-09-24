# Host lifecycle continuation

Create one host for an exact scope and definition catalog, then explicitly start it:

```ts
const host = createWorkflowLifecycleHost({
  store, scope, permissions, policyVersion: '2026-09', maxCostMicros: 50_000,
  definitions: [reviewWorkflow, scheduledPublish],
  intervalMs: 1_000, maxBackoffMs: 30_000,
});

host.start();
// During graceful shutdown:
await host.close();
```

Use `host.runtime` for submissions and authenticated human/approval operations so the fleet index stays synchronized. Deploy only one active host for a scope unless the platform supplies leader election. Read `host.status()` for sanitized health and call `runOnce()` in tests or externally scheduled environments.
