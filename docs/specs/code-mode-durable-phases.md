# Durable Code Mode phases

Status: experimental bridge to the existing scheduled-workflow profile.

`@mayura/code-mode-workflows` defines finite workflows from genuine Code Program and Code Mode handles. It adds no database driver. Run the returned definition with `createScheduledWorkflowRuntime` and an explicitly selected durable storage adapter.

```ts
const workflow = defineDurableCodeWorkflow({
  id: 'review-and-apply',
  version: '1',
  input,
  output,
  codeMode,
  phases: [
    { id: 'review', program: reviewProgram, input: { kind: 'input', path: [] } },
    { id: 'apply', program: applyProgram, input: { kind: 'step', stepId: 'review', path: [] }, dependsOn: ['review'] },
  ],
  result: { kind: 'step', stepId: 'apply', path: [] },
});
```

Every phase is approval-required; there is no option to disable this secure default. Runtime permissions must include the generated phase tool ID, `code:execute`, `code:program:<program digest>`, and the phase effect grant when the strongest nested effect is not `none`. Approval uses the ordinary workflow API and the exact digest exposed on the waiting phase snapshot. Changing source, manifest limits, schemas, imports or the nested tool catalog changes the program digest and therefore the workflow/candidate identity.

Phases are not resumable JavaScript. Each one starts in a fresh selected sandbox, returns validated JSON, and finishes before dependent phases run. Long waits and approvals happen between phases while no isolate is retained. Workflow restart requires the same genuine definitions to be registered in the new process.

The workflow ledger charges a conservative upper bound for each phase. Nested calls still pass Code Mode's ordinary broker; the application must configure that broker with the intended live policy and accounting. If a write/host phase fails after dispatch, scheduled recovery withholds output, records an unknown outcome and never replays it automatically. Operators must reconcile unknown external state rather than approving or resubmitting the same phase blindly.

Current limitations are exact-usage reconciliation, a first-class nested-receipt audit view, the complete cross-adapter phase/receipt/completion process-kill matrix, durable child/wait return values, migration policy and production sandbox qualification. These keep V15 open.
