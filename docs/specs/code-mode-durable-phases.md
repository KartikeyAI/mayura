# Durable Code Mode phases

Status: experimental bridge to the existing scheduled-workflow profile.

`@mayura/code-mode-workflows` defines finite workflows from genuine Code Program, Code Mode and durable audit handles. It adds no database driver. Run the returned definition with `createScheduledWorkflowRuntime` and an explicitly selected durable storage adapter.

```ts
const workflow = defineDurableCodeWorkflow({
  id: 'review-and-apply',
  version: '1',
  input,
  output,
  codeMode,
  audit: createDurableCodeAudit({ store, scope }),
  phases: [
    { id: 'review', program: reviewProgram, input: { kind: 'input', path: [] } },
    { id: 'apply', program: applyProgram, input: { kind: 'step', stepId: 'review', path: [] }, dependsOn: ['review'] },
  ],
  result: { kind: 'step', stepId: 'apply', path: [] },
});
```

Every phase is approval-required; there is no option to disable this secure default. Runtime permissions must include the generated phase tool ID, `code:execute`, `code:audit:v1`, the generated `code:audit-scope:<scope digest>`, `code:program:<program digest>`, and the phase effect grant when the strongest nested effect is not `none`. The executor independently recomputes the live scope digest before entering Code Mode. Approval uses the ordinary workflow API and the exact digest exposed on the waiting phase snapshot. Changing source, manifest limits, schemas, imports, audit scope or the nested tool catalog changes the workflow/candidate identity.

Phases are not resumable JavaScript. Each one starts in a fresh selected sandbox, returns validated JSON, and finishes before dependent phases run. Long waits and approvals happen between phases while no isolate is retained. Workflow restart requires the same genuine definitions to be registered in the new process.

The workflow ledger charges a conservative upper bound for each phase. Nested calls still pass Code Mode's ordinary broker; the application must configure that broker with the intended live policy and accounting. Before the outer phase settles, the required audit stores one immutable aggregate keyed by scope, run and phase. It contains the exact program digest, deterministic execution ID, sanitized phase outcome and at most 64 exact nested receipts. `audit.inspect(runId, phaseId)` validates identity, shape, call sequence and bounds on every read. If a write/host phase fails after dispatch, scheduled recovery withholds output, records an unknown outcome and never replays it automatically. Operators must reconcile unknown external state rather than approving or resubmitting the same phase blindly.

Real-process fixtures terminate SQLite and PostgreSQL workers after the nested effect, after the outer receipt commit and after step completion. Unknown boundaries never replay; committed completion is finalized from stored output. The audit and workflow receipt are intentionally separate commits, so an absent audit after interruption is unknown evidence rather than a negative assertion. Current limitations are exact-usage reconciliation, authoritative external-effect reconciliation, durable child/wait return values, migration policy and production sandbox qualification. These keep V15 open.
