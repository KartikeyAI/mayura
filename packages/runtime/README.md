# mayura/runtime

Typed agent runs with explicit permissions, bounded budgets, guarded execution and durable approval checkpoints.

Optional `authorization: Authorizer` guards root/child admission, handoffs, model/managed-guard dispatch, approvals, streamed/final disclosure and shared tool invocation. The host owns policy/audit lifecycle; runtime close cancels its work but never closes the shared authorizer. Denied asynchronous admission yields a blocked handle outcome before paid work.


### History events and approval observation

`history` accepts message arrays or `RunHistory` fitting results (`messages`, `omittedTurns`, `scanTruncated?`). Fresh
runs emit `history.applied` counts after input admission, before reasoning. Resumption and handoffs reuse history
without another application event. Empty history is accepted without a model history capability.

`defineHook({ stage: 'onApprovalRequested', ... })` is a bounded metadata-only observer before approval publication.
Mandatory failures block before checkpoint/answer creation; optional failures remain visible. No actions or input
arguments are exposed. Saved-candidate continuation does not notify again. This is not a durable notification queue.

External tools registered through the trusted `mayura/tools/host` continuation port can park an idle root run before external publication. With checkpoints configured, the runtime saves admitted input, history, provider continuation, remaining batch, budget/counters and recording identity. `resumeTool(runId, { callId, digest })` requires `run/resume_tool` policy, checks the authoritative result port and consumes the exact checkpoint epoch before continuing. Completed work and input guards are not repeated. This is distinct from human approval and does not recover paid work already admitted after checkpoint consumption. See [AG-UI recovery](../../docs/guides/ag-ui.md#safe-native-owner-recovery).
