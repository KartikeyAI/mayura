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
