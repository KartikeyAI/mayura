# Ephemeral workflow composition

Status: implemented experimental profile, 2026-09-20, with 51 public-path regression cases and an isolated packed-consumer fixture. This is an explicit process-local profile, not a wrapper around the durable workflow driver or the standalone leased scheduler.

## Decision

A finite, approval-free workflow can be compiled to an ordinary agent definition whose planner is deterministic, local framework code. It reads only the run's admitted input and tool-result messages, selects dependency-ready tool nodes, evaluates joins, and returns the declared result binding. It performs no inference, network request, generated-code execution, or ambient lookup. Mayura's existing runtime remains the sole authority for execution, guards, accounting, cancellation, descendant limits, and effect evidence.

Expose `workflowAsAgent(definition, { profile: 'ephemeral', plannerId?, guards? })` and `workflowAsTool(definition, { profile: 'ephemeral', id, description, permissions, limits?, plannerId?, inputJsonSchema?, guards? })` from `@mayura/workflows/ephemeral`. Both require an authentic `defineWorkflow` definition. The default planner identity is `mayura.workflow`; the caller must explicitly grant `model:mayura.workflow` (or the configured identity). This deterministic planner uses the existing model-adapter protocol and consumes a zero-cost model-call/step allowance per scheduling wave, including finalization. This overhead is visible and bounded, not hidden or advertised as a billable model call.

The tool form uses `agentAsTool` without creating another runtime or budget. It therefore requires the ordinary wrapper tool grant and `agent:delegate`, intersects explicit child grants with parent authority, shares ancestor cost/call/concurrency ceilings, and joins the child before success. The agent form can also be submitted directly to an ephemeral runtime. Neither form imports caller credentials, conversation history, memory, or provider continuation.

## Deliberate boundaries

- Definitions containing any approval-required tool node are rejected at composition time. No approval flag is ignored or treated as permission. Use the existing durable workflow driver for approval/wait/restart requirements; durable composition needs the separate atomic shared-ledger design.
- One tool identity may occur at multiple nodes only when it is the same immutable definition object. Different definitions sharing an ID are rejected, rather than silently choosing an implementation or version.
- The compiler returns a fresh immutable definition, with no mutable per-run state. Concurrent runs reconstruct their own completed-node projection from their own admitted messages. Node IDs are call IDs within that child run. Joins are local projections, not effects or separately charged tool calls.
- Each scheduling wave contains all ready tool nodes in definition order. Their execution order/concurrency is controlled by the owning runtime; the initial runtime executes each wave's tools sequentially. Do not claim parallel workflow execution from this compiler.
- All nodes are required. A failed, blocked, cancelled, or uncertain tool prevents a subsequent wave or successful final result through the owning runtime. Earlier effect receipts remain available through runtime inspection/composed outcomes.
- Original workflow input and final output schema transforms happen once at their respective run boundaries. Tool schemas are still checked by the ordinary broker, including its pure preflight; joins and bindings consume only released results.
- The finite graph remains capped at 128 nodes. A chain can need 129 planner calls; defaults do not automatically increase caller limits. The planner independently caps transcript/response JSON at 8 MiB, 300,000 nodes and 257 messages; individual bindings retain the existing 1 MiB JSON boundary. Context/message/output bounds, deadlines and ancestor limits may stop a valid but too-large graph. There is no unbounded replay loop or silent retry.

This is partial F08/V05/V18 evidence, not durable child orchestration, restartable joins, workflow-as-durable-node support, or closure of any full enterprise release gate. It leaves format-2 workflow records and scheduler ownership unchanged.

## Required verification

Public runtime execution of chains, fan-in joins, literal/input/step bindings and repeated tools; identical concurrent submissions without state leakage; transformed input/output parity; missing grants and narrowing; approval/forged/ambiguous definitions rejected before effects; one-slot nested progress and bounded recursion; shared cost/call caps; failure, blocked output and unknown/late receipt truthfulness; cancellation/deadline propagation; malformed direct planner transcripts fail safely; packed public-subpath types and a credential-free example.
