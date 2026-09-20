# Real process-termination recovery tests

Status: experimental durable-engine verification, not a universal exactly-once guarantee.

The process-recovery suite starts separate Node.js children using the built public workflow, tool, and SQLite packages. Each child uses the same file-backed database after restart. The suite waits for an explicit IPC crash marker, terminates only its own spawned child, waits for that process to exit, and starts a fresh child. It does not substitute closing and reopening a connection for a process crash.

| Crash boundary | Required recovery result |
| --- | --- |
| Approval request durably stored, handler not dispatched | The exact review digest survives. A verified human approves it after restart, and one controlled write succeeds. |
| Handler has appended and flushed the test artifact, but has not returned | Operator-established abandonment produces an unknown outcome. The reservation remains and the effect is never automatically replayed. |
| Successful execution receipt persisted, output guard still pending | Known success and spending survive. Missing admitted output blocks the step; the handler is not repeated to recreate output. |

Every recovery calls the driver twice and verifies that the test artifact contains exactly one effect record. The record includes the stable run/call identity. Tests also verify durable event evidence and receipt/disclosure state.

Run after building the packages:

```sh
pnpm build
node node_modules/vitest/vitest.mjs run packages/workflows/test/process-recovery.test.ts --project unit
```

The suite requires a supported Node.js runtime, a working optional SQLite adapter, and permission to spawn/terminate its own child processes. It does not require Docker, PostgreSQL, provider credentials, or network access. Its SQLite database and controlled artifact live in a uniquely created operating-system temporary directory. Cleanup resolves and verifies that exact directory before recursive removal and terminates all owned children first.

These tests establish real process-crash behavior at three controlled boundaries on the tested host. They do not establish power-loss durability, disk-corruption recovery, distributed worker leases, provider-side idempotency, or equivalent process-kill evidence for PostgreSQL. `recoverAbandoned` remains an explicit trusted operator action after abandonment has been established; no automatic lease-reclaim guarantee is implied.

## Scheduled completion facts and waits

The separate `packages/storage/test/execution-waits-conformance.ts` suite adds four process-kill boundaries **on each real SQL adapter**:

| Boundary | Recovery requirement |
| --- | --- |
| Terminal aggregate/owner changes and completion-fact insert, before transaction commit | All source changes and the fact roll back together; the wait remains pending. |
| Terminal source transaction committed | The terminal source and its single immutable completion fact survive process loss. |
| Resolved wait and journal insert, before transaction commit | The original waiting snapshot and journal survive; a later finite drain resolves it once. |
| Resolution transaction committed | The version-2 resolved snapshot and exactly one resolution event survive; subsequent drains are empty. |

Precommit checkpoints use actual reducer code and actual SQLite/PostgreSQL connections with a test-owned backend that pauses after the relevant SQL insert. There is no production failpoint. After-commit checkpoints use the public adapter. Parents kill only their own children, await exit, and inspect/continue through public storage. This is transaction/process-loss evidence, not power-loss or full distributed operation qualification. See [completion-wait semantics](specs/execution-completion-waits.md) and [Docker testing](testing-docker.md) for PostgreSQL setup.
