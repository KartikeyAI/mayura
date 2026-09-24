# Durable agent phase

Status: experimental progressive-adoption profile.

`agentAsDurableWorkflow(agent, options)` reuses the exact genuine agent definition and compiles it into one scheduled workflow phase. The caller explicitly selects the durable store/runtime, outer workflow authority, inner agent authority, limits and approval policy. Approval defaults on.

The scheduled boundary persists intent, dispatch and receipt evidence. The agent's in-phase model loop remains process-local. A crash after model or tool dispatch therefore leaves the outer host-effect phase unknown and the scheduler does not replay it automatically. This profile provides conservative restart behavior and same-definition adoption; it does not claim instruction-level checkpointing or automatic external-effect reconciliation.

The compiler delays agent input-schema validation until the phase executes so transforming Standard Schema definitions are not applied twice. Scheduled storage still enforces bounded JSON. Invalid input fails before model or tool dispatch. Successful agent output has already crossed the original output schema and is persisted through an identity boundary without a second transformation.
