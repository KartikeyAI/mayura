# Scheduled workflow conformance

Status: local conformance verified on 2026-09-20. The shared suite passed **44 cases on SQLite and 44 on real PostgreSQL**, 88 total, in one paired run. Strict test typechecking passed. The existing conservative workflow, review-regression and process-recovery suites also passed 68 cases across four files. These are bounded local results, not a complete enterprise release or independent security audit.

The [scheduled workflow contract](specs/scheduled-workflows.md) is exercised through `createScheduledWorkflowRuntime` using actual SQLite and PostgreSQL adapters. One shared suite lives in `packages/workflows/test/scheduled-conformance.ts`; the two backend entry points run the same assertions.

## Running the suite

Build the workspace first. The SQLite tests create a private temporary database; they do not use an application database.

```sh
pnpm build
node node_modules/vitest/vitest.mjs run packages/workflows/test/scheduled.sqlite.test.ts --project unit
```

For PostgreSQL, start the repository's disposable test fixture and set `MAYURA_TEST_POSTGRES_URL` to that fixture's connection string. Then run:

```sh
node node_modules/vitest/vitest.mjs run packages/workflows/test/scheduled.postgres.integration.test.ts --project integration
```

Without that environment variable the PostgreSQL entry point is skipped, not passed. Each test uses a unique schema with a validated test-only prefix. Cleanup drops only that schema. Never point these fault-injection tests at a production database.

## Assertions

- Parallel branches, deterministic joins, local execution limits and completion after unrelated aggregate version changes.
- Scoped idempotent submission, immutable snapshots and one aggregate event sequence.
- Pristine format-2 attachment retaining the original state and submission identity; rejection of existing approvals, completed runs and incompatible one-MiB policies.
- Ordinary legacy-write rejection, standalone scheduler claim/cancel/reservation bypass closure and immutable resource enrollment.
- Approval without held jobs/resources/budget, verified identity, restart continuity, storage-clock decisions despite caller-clock skew, and actual database-lock waits that outlast approval expiry.
- Atomic budget admission, duplicate worker contention and exactly one reservation for a reclaimed never-started job.
- Pre-dispatch guard refusal, successful effects followed by schema/guard/size refusal, and final-schema failure without erasing step evidence.
- Sticky cancellation, independently retained late successful receipts, cost settlement without output resurrection, resource quarantine and unrelated-resource progress.
- Lost prepare/start/complete acknowledgements, lease renewal, pre-start lease expiry and approval expiry after immutable preparation.
- Real owned-process termination after persistent start, successful receipt and successful completion; reopening the runtime never replays the logical invocation.
- Sidecar version/unknown-field corruption, missing job links, fabricated within-budget spending and phantom dispatch receipts are rejected before further dispatch or disclosure.

The transport-failure wrappers call the real storage command and then deliberately lose its response. They do not replace transaction semantics with an in-memory mock. Controlled deferred handlers represent cooperative and late-returning application code; no real infrastructure changes, provider requests or credentials are involved.

Raw SQL is used only inside disposable fixtures to simulate persisted corruption. Passing these cases is not cryptographic protection against a privileged actor consistently rewriting every stored copy.

Additional suites cover bounded worker shutdown/custom-adapter response checks, retained pending-handler/adapter capacity, 128-node graphs, repeated unchanged drains without history growth, join/aggregate/final output overflow, and receipt-preserving fallback. The storage review fixture uses real SQLite transactions with only the internal storage-time query controlled: rejected expiry, backwards time, fresh review replacement, late contradictory evidence, quarantine and stale command deduplication are exercised without changing the machine/database server clock.

## Evidence still required

The integrated suite and conservative format-2 checks above are now local evidence toward the scheduled-workflow gate; keep the full release qualification open. The owned-process checkpoints do not exhaust every instruction/transaction interruption, hardware power-loss scenario or ambiguous provider response. Old adapter binary deployment, provider-side fencing and a production worker fleet also need separate operational qualification. Started effects are never automatically replayed; resource quarantine has no automatic clearance in this profile.
