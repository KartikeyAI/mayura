# Mayura — Technical Proposal

Date: 2026-09-20  
Status: Technical baseline accepted for local development; experimental implementation in progress.  
Governing requirements: [Mayura development plan, version 1.3](create-mayura-agentic-framework-plan.md).  
Independence: Mayura has its own repository, packages, tests and releases. Arth is a later consumer.

## 1. Recommendation

Build Mayura as a modular TypeScript SDK backed by our own durable graph runtime, with an optional server and isolated execution workers. Use transactional SQL for execution state, explicit durable steps for workflows, and a single broker for tool/model execution, permissions, approvals and budgets.

Mayura is an open-source framework for developers building their own agents. Its public authoring experience is the product: a small install, predictable APIs, useful types/errors, and a gradual path from an embedded agent to durable enterprise operation. Internal architectural rigor must not become mandatory setup complexity for every consumer.

The first engineering deliverable should prove a complete execution path: a typed workflow runs two branches, pauses for human approval, survives a forced restart, completes one authorized effect, and exposes its events and result. Build this against both storage adapters before expanding orchestration features. This is an internal foundation milestone; the complete product scope remains the development plan.

Next actionable step: continue the authorized implementation in `mayura/`, using its ADRs/specifications before each slice and its [evidence ledger](development-status.md) to track remaining release gates.

## 2. Proposed stack

| Layer | Recommended choice | Reason / constraint |
| --- | --- | --- |
| Language/runtime | Strict TypeScript, ESM, Node.js 24 LTS | One reference runtime for the server, CLI and workers; browser clients have separate exports. |
| Workspace/build | pnpm workspaces; TypeScript project references and `tsc --build` | Small dependency surface; emitted JS and declarations preserve package boundaries. |
| Schemas | Standard Schema authoring contract, Zod 4 reference integration, JSON Schema 2020-12 wire profile, Ajv 2020 validator | Typed authoring plus validation of stored/remote schemas; explicit conversion limits. |
| SQL access | Kysely with reviewed dialect-specific SQL and migrations | Typed queries while keeping transaction/locking behavior explicit. |
| Local durable storage, opt-in | SQLite through `better-sqlite3`, owned by a dedicated storage process | Serialized writes away from request handling; never a base-SDK install dependency. |
| Server storage | PostgreSQL through `pg` | Concurrent workers, row-level locking and durable shared state. |
| HTTP/events | Hono with its Node adapter; HTTP commands and SSE observation | Thin typed transport around the runtime, with authenticated reconnectable streams. |
| Client/UI | Browser-safe TypeScript client; optional React bindings; Vite for inspector/examples | Framework-independent client with a convenient reference frontend. |
| Code Mode | QuickJS/WASM through `quickjs-emscripten`, inside an OS-isolated worker | Explicit host bindings, replaceable interpreter and external tool broker. |
| Native retrieval | SQLite FTS5 plus a qualified `sqlite-vec` adapter locally; PostgreSQL text search plus `pgvector` on servers | Local and server retrieval behind one contract; indexes remain rebuildable. |
| Observability | Pino structured logs, native run/event inspector, OpenTelemetry exporters | Local inspection works without a hosted dashboard. |
| Testing/releases | Vitest, fast-check, Playwright, Changesets | Runtime tests, invariant/property tests, browser E2E and versioned packages. |

These are recommendations, not installed dependencies. Pin exact compiler, package-manager, package and native-engine versions after compatibility/security qualification; commit the resulting lockfile. Do not use floating `latest` versions in builds or execution images.

### 2.1 What consumers must and must not adopt

pnpm, project references and strict compiler settings govern Mayura's repository, not applications using it. Consumers install published JavaScript/declarations into their own supported npm/pnpm/Yarn, TypeScript or JavaScript project. They do not need our monorepo layout, Vite, React, Hono, Kysely, Zod or a custom build transform. Framework-specific and validator integrations are explicit adapter choices; their implementation types must not leak into core APIs.

The basic tools/agent path must contain no native SQLite/vector module, sandbox, browser binary, HTTP server or unused provider SDK. Optional packages are installed deliberately, not pulled into the default dependency graph. Offer a small ergonomic entry point without making every user wire the internal module graph. Package names remain provisional until availability and ownership are resolved.

Before accepting a dependency, review maintainership/security, license compatibility, transitive weight, supported platforms, install/type-check/cold-start cost and replacement feasibility. The SQLite and sandbox recommendations remain conditional on their separately tested installation profiles; they cannot dictate the prerequisites for basic agent development.

Node's current release table lists 24 as LTS and 26 as Current, which is why 24 is the proposed initial production baseline. [Node release schedule](https://nodejs.org/en/about/previous-releases)

The selected tools document the relevant primitives: [pnpm workspaces](https://pnpm.io/workspaces), [Kysely](https://kysely.dev/docs/getting-started), [Hono on Node](https://hono.dev/docs/getting-started/nodejs), [Hono SSE](https://hono.dev/docs/helpers/streaming), [Changesets](https://github.com/changesets/changesets). Choosing them over alternatives is an architectural recommendation, not a benchmark claim.

## 3. Package and ownership boundaries

Start with a small set of real packages and maintain the larger plan's logical boundaries as modules. Split packages when independent consumption or dependency weight justifies it.

| Initial package | Owns | Must not depend on |
| --- | --- | --- |
| `@mayura/core` | IDs, messages, schemas, result/error types, execution context and adapter contracts | Database drivers, web frameworks, provider SDKs or UI libraries. |
| `@mayura/tools` | Tool definitions, registry, validation, invocation and batch contracts | A mandatory agent loop, server, model or memory service. |
| `@mayura/runtime` | Durable scheduler, policy/budget broker, approvals, waits, events and resource claims | A specific database, model provider, memory vendor or consumer application. |
| Storage adapters | SQLite/PostgreSQL implementations and migrations | Agent prompts or application business logic. |
| `@mayura/testing` | Deterministic clocks, model/tool fakes, storage conformance and crash fixtures | Live cloud credentials for the default test suite. |

Add workflow and agent authoring, processors/guardrails, memory/context, Code Mode, server/client, observability and optional UI entry points as their vertical slices mature. Dependency injection occurs through explicit constructors/factories; avoid a mutable global runtime or service registry.

Use strict compiler settings including unchecked-index and exact-optional-property checks. Publish explicit package exports and declarations. Browser consumers must be tested against packed packages to catch accidental imports of Node modules, credentials or native binaries. A future Arth installation consumes public packages like any other application.

### 3.1 Progressive execution profiles

| Profile | Consumer setup | Guarantee boundary |
| --- | --- | --- |
| Bounded in-process agent/tools | Base SDK plus the selected model adapter; no service or native build | Explicitly non-durable, process-local state/audit; same validation, authority and bounded execution gates. |
| Durable embedded | Add the selected local storage adapter and managed workers | Recorded effects, restart recovery and durable waits/approvals. |
| Self-hosted server | Add server, authentication, PostgreSQL and worker deployment | Multi-client operation, scoped access and shared durable scheduling. |
| Optional capabilities | Add memory, Code Mode, UI or provider integrations as needed | Each advertises its own prerequisites, support matrix and conformance evidence. |

Keep agent/tool definitions and result contracts consistent across profiles. Explicit durable boundaries and infrastructure configuration add guarantees; they do not require rewriting business handlers. Never silently fall back to process-local state after a storage failure. Reject durable waits, restart-safe approvals and policy-mandated persistent audit/reconciliation in the non-durable profile before effects. In-process state loss can leave external outcomes unknown; documentation must say so. The SQL recovery protocol below applies to durable execution.

## 4. Durable runtime and persistence

### 4.1 Execution model

Use a typed graph builder that produces versioned serializable workflow IR. Nodes reference registered executable handlers and typed data mappings. Initial node kinds cover activities/tools, model calls, child runs, branches, bounded maps/loops, joins, waits, approvals and Code Mode phases.

An agent is a resumable loop over these same primitives. Tools, agents-as-tools and workflows-as-tools all use the same invocation identity and admission path. We do not promise persistence of arbitrary JavaScript call stacks, closures or pending promises.

Store transactional current-state tables plus append-only events. Full event sourcing is unnecessary for the initial design: recovery uses authoritative rows and recorded results, while the event log supplies inspection, causality and delivery. Inspecting/replaying history executes no effects.

### 4.2 Concrete data groups

| Tables / records | Role |
| --- | --- |
| `definitions`, `runs`, `steps`, `attempts` | Pinned executable/schema versions, graph state, parentage, deadlines and optimistic versions. |
| `effect_intents`, `effect_receipts` | Stable logical call IDs, attempt IDs, argument hashes, provider operation IDs and known/unknown outcomes. |
| `jobs`, `events`, `outbox` | Due work, per-run event sequence and durable delivery. |
| `waits`, `signals`, `approvals` | Durable suspension, correlation, event watermarks and human decisions. |
| `budget_accounts`, `reservations`, `usage_entries` | Shared accounting, concurrent admission and immutable settlements. |
| `artifacts`, `content_versions`, `verdicts` | Scoped evidence, integrity hashes and checks bound to exact content/policy versions. |
| Memory/source/index records | Added with the native memory/context slice; separate from execution authority. |

Scope every record by its verified ownership boundary. Large content lives in an artifact adapter, initially local content-addressed files; store references and hashes in SQL. Artifact writes are not atomic with database commits, so stage, verify, and reconcile missing/orphaned objects explicitly.

### 4.3 Storage profiles

For SQLite, use one storage-owning process with WAL, `synchronous=FULL`, bounded IPC requests and short transactions. Execution workers do not independently compete as uncontrolled writers. SQLite's single-writer and same-host WAL model make this a local profile, not a shared network-filesystem deployment. Verify the actual bundled SQLite engine and relevant fixes, not only the npm driver's version. [SQLite WAL documentation](https://sqlite.org/wal.html), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

For PostgreSQL, use pooled connections, short transactions, conditional version updates and leased jobs. Claim available jobs with `FOR UPDATE SKIP LOCKED`; lock budget/resource rows in a consistent order. This is a queue-consumer mechanism, not a substitute for business-level consistency. Both adapters must pass the same behavior suite. [PostgreSQL SELECT/locking documentation](https://www.postgresql.org/docs/current/sql-select.html)

Use a database-backed outbox initially. Optional external queue adapters may wake workers later, but database state remains authoritative. A queue message is a hint to claim eligible work, not proof that a job is still authorized.

### 4.4 Effect protocol

1. Process and validate final inputs; evaluate guards and scoped policy.
2. If approval is needed, persist the exact request and suspend without holding a transaction or worker.
3. On continuation, revalidate the approval digest, current policy, target and cancellation state.
4. In one short transaction, reserve budget, record intent, append the state event and enqueue dispatch.
5. Claim the job with a lease/fencing generation and recheck admission at the execution broker.
6. Execute outside the database transaction.
7. Persist the effect receipt and usage; then separately validate/redact the returned payload.
8. Advance dependencies and publish permitted events through the outbox.

Keep execution success separate from disclosure success. A write may complete even if its returned content is blocked. Lost connections and unknown receipts require reconciliation before retry; they are not automatic failures eligible for replay.

Fencing rejects new stale dispatches and prevents obsolete workers from advancing current state. It cannot retract an already transmitted remote request. Preserve late completion evidence against its original attempt without allowing it to overwrite the current run. Provider idempotency or reconciliation is required for safe repeatable effects; universal exactly-once execution is not claimed.

## 5. Tool and workflow APIs

Freeze the following conceptual public surface before implementation:

| Operation | Contract |
| --- | --- |
| `defineTool` | Versioned identity, input/output schema, handler, effects, capabilities, resources, timeout and retry/reconciliation behavior. |
| `defineWorkflow` | Versioned graph, registered steps, typed references, limits and completion schema. |
| `defineAgent` | Instructions, model adapter, tools, context/memory policy, processors, guardrails and stop conditions. |
| `submit` | Always returns a scoped typed run handle. |
| `result` / `observe` | Validated completion envelope / permitted events, without changing shape based on execution speed. |
| `waitFor`, `waitForAll`, `waitForAny` | Durable wait semantics, deadlines, terminal outcomes and explicit cancellation behavior. |
| `asTool` | Agent/workflow adapter preserving child identity, permissions, budgets, failures and cancellation. |
| `approve`, `provideInput`, `cancel` | Authenticated durable control bound to the current candidate/version. |

Use Standard Schema-compatible validators for authoring. Require portable JSON Schema for exported tool and API contracts. Zod's input/output conversions and unrepresentable constructs need explicit handling; transformations belong in named processors rather than being silently erased from a wire contract. Ajv's 2020 validator handles the selected JSON Schema dialect. [Zod conversion](https://zod.dev/json-schema), [Ajv dialect support](https://ajv.js.org/json-schema.html)

Validate an entire multi-tool dependency graph before dispatch, then authorize and meter each call. Serialize conflicting resources. Return success, denial, waiting, skipped, cancelled and unknown outcomes per call. `fail-fast` stops new work; it does not undo completed effects.

Implement a Mayura-owned model-adapter contract with streaming events, tool-call correlation, structured-output capabilities, cancellation, usage and error mapping. Proposed reference integrations are OpenAI, Anthropic and a compatible local endpoint, isolated in optional adapters using supported provider transports. Concrete models and prices are deployment configuration, not hard-coded defaults. Provider fallback cannot cross a data boundary without authorization.

## 6. WorkStream and human intervention

Persist control events independently of display/token deltas. Maintain monotonic sequence numbers per run and causal references across child runs. Register a wait plus its watermark transactionally, then evaluate existing matching events to prevent lost wakeups.

Resolve event/deadline/cancellation races through one durable resolution record. `waitForAll` returns all terminal outcomes; `waitForAny` persists the winner and removes losing subscriptions. Cancelling a subscription does not cancel the target run unless explicitly requested. Waiting releases worker capacity and model context.

Approvals contain the authenticated human, tool/version, processed arguments and target hashes, code/artifact digests, environment, policy epoch, expiry and permitted repetitions. Changes invalidate the approval. A child agent or callback cannot resolve a human approval as if it were a person.

HTTP clients submit commands and consume authenticated SSE with cursor-based reconnect. An expired cursor returns a snapshot/gap response. Disconnect does not implicitly cancel durable work. Client state is a projection of server truth, not an authorization source.

## 7. Processors, guardrails, streaming and budgets

Processors produce versioned content; guards evaluate that content; hooks participate at declared lifecycle stages. Bind verdicts to content and policy hashes. A hook that changes arguments must run before final authorization. Trusted in-process extensions are trusted code; untrusted extensions need isolated workers.

Use a staged pipeline: local normalization/privacy checks → admitted auxiliary language/detection calls → required input-guard barrier → authorized context assembly → primary model → separately gated tool calls → output processors and checks → public release. Auxiliary calls use a bounded non-recursive admission profile so a moderation model does not recursively invoke itself.

Built-in controls cover all G01–G11 requirements: normalization, injection defenses, separate language detection/translation, stream batching, prompt scrubbing, cost limits, PII, input/output moderation, callbacks, blocked handling and parallel guards. Native deterministic recognizers handle explicit patterns and protected spans; model-backed detectors use replaceable local/hosted adapters. Select detection models through a language/false-positive evaluation, not a blanket claim that regex or a classifier prevents every leak.

Default to buffered release for policies needing whole-output validation. Guarded batches are an explicit lower-latency option with narrower guarantees. Never release raw provider events or partial tool arguments to consumers. Final-output detection cannot retract text already sent.

Reserve budget atomically across root/children, primary and auxiliary model calls, tools, embeddings, retries and speculation. Include required output-check cost before generation begins. Use integer accounting units with a recorded currency/price version, bounded maximum-output assumptions and visible unknown usage. A timeout does not refund unconfirmed spending. Cancellation stops new dispatch and tracks in-flight outcomes.

## 8. Native memory and context

Mayura owns canonical memory records, provenance, permissions, temporal validity, corrections and tombstones. Provider writes are durable synchronization jobs; delayed provider results cannot resurrect deleted or superseded records. Runtime state and approvals remain outside semantic memory.

Recommend SQLite FTS5 with a version-pinned, explicitly loaded `sqlite-vec` adapter locally, and PostgreSQL text search plus `pgvector` for server deployments. Keep vector access behind a contract because native packaging, API stability and performance require qualification. Apply source authorization before candidate ranking and verify it again on retrieval. [sqlite-vec](https://github.com/asg017/sqlite-vec), [pgvector](https://github.com/pgvector/pgvector)

Embeddings are a separate model adapter: local execution is supported, hosted execution requires configured data permission. Without an embedding provider, text retrieval remains available and the semantic limitation is explicit. Do not label text-only fallback as full semantic recall.

Context assembly pins instructions, scope, pending approvals and unresolved work, then retrieves source-linked evidence within a token budget. Compaction produces a structured continuation record. Caches include scope, source generation, instruction/schema/policy versions and model configuration. Revocation, correction and deletion invalidate derived context.

Mem0, Supermemory and OpenViking remain optional adapters under the existing plan's edition, privacy and license checks. Native operation and qualification do not depend on them. Native canonical content is retained only according to policy; metadata-only configurations cannot promise full offline recall.

## 9. Code Mode and platform support

Recommend QuickJS/WASM as the first interpreter adapter. Compile/check TypeScript in a restricted compiler worker, target a tested JavaScript subset, and expose only typed JSON broker bindings. No package installation, unrestricted imports, raw provider clients, credentials, direct filesystem/network or process APIs inside generated programs. QuickJS provides explicit host bindings and interpreter limits; the outer sandbox and watchdog remain necessary. [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)

First qualify a Linux execution profile using gVisor/runsc, non-root execution, cgroup quotas, a read-only image, disposable scratch, no direct network, and a bounded broker channel. Runtime/host configuration is part of that qualification; the name of a sandbox alone is not a security guarantee. [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/)

Windows and macOS run the SDK/server/CLI natively and use a separately qualified Linux worker in a local VM for this hostile-code profile. A remote worker is an explicit deployment/data-location choice, never an automatic fallback. Native OS-specific sandbox adapters can follow their own qualification. The full release support matrix must identify the actual local configurations tested on each OS.

Keep `isolated-vm` as an optional future adapter rather than making it mandatory. Its documented maintenance mode and host-reference/process risks justify keeping the execution abstraction replaceable. [isolated-vm](https://github.com/laverdet/isolated-vm)

Durability uses bounded code phases with serializable checkpoints and a per-call effect journal. Suspend long human/event waits as runtime waits and release the interpreter. Do not rerun an interrupted program from the beginning if that could repeat a write. Every nested tool invocation rechecks authority, approval and budget. Generated host execution follows the secure default human-approval gate.

## 10. Server, developer experience and observability

Keep Hono as a transport adapter over runtime services. Routes cover registered definitions, runs, control operations, waits/signals, approvals, artifacts and scoped memory. Authentication supplies a verified principal; every object operation checks ownership. Local serving binds to loopback with authentication. Multi-user serving requires configured authentication, TLS termination and scope isolation.

Provide a browser-safe client before adding optional React hooks/components. Use a Vite-based local inspector/reference app for run graphs, tool activity, approvals, waits, usage and redacted evidence. It consumes the same public API as external applications. Native tokens, provider keys and raw private events stay server-side.

Pino supplies structured logging, with redaction before persistence/export. OpenTelemetry exporters map the stable Mayura event model to versioned telemetry conventions. Mandatory audit remains durable and unsampled; optional exporters cannot take down execution. [Pino](https://github.com/pinojs/pino), [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai)

Ship executable templates and helpers for configuration, abort propagation, retries, artifact handling, pagination, scoped credentials and test adapters. Each template runs in release CI. Optional browser, sandbox and vendor dependencies remain separate from the small tool package.

### 10.1 Developer experience and open-source distribution

The first public recipe should expose instructions, one model adapter and one schema-defined tool/handler with explicit effects. Show a credential-free deterministic fixture and a clearly labeled real-model variant. Advanced scheduler, lease, tenant and workflow-IR details remain behind public defaults until selected. No global CLI, mandatory generator, private imports or unsafe casts should be necessary for ordinary use.

Test fresh packed-package installation, type inference, JavaScript editor help, actionable errors, cancellation and an existing-app integration. Measure install weight, cold start, type-check cost and time to first successful agent. Set numerical budgets and first-time-user walkthrough criteria during specifications, then require evidence for release. Offer versioned documentation, tested recipes and migration guidance; do not advertise ease based only on an internal demo.

Open-source distribution uses Apache-2.0. Publish usable source/build instructions, contribution and RFC processes, maintainer ownership, security reporting, changelogs, stability tiers and a supported-version policy. No Mayura-hosted account, proprietary runtime or default phone-home is required. Local audit is distinct from explicitly configured external telemetry. Dependency licenses and optional service terms still need per-release review. [Open Source Definition](https://opensource.org/osd)

Stable public contracts include types, exports, event/error shapes and documented semantics. Qualify upgrades against packed consumer applications and persisted-run migrations. Controlled CI must verify package contents and produce provenance where supported; provenance is source/build traceability, not proof of harmless code. [Semantic Versioning](https://semver.org/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)

## 11. First implementation milestone and expansion order

The first milestone is a restart-safe approved workflow, using deterministic fake model/tool adapters and a controlled test effect. This establishes the foundation without requiring real cloud accounts.

Acceptance:

1. Define/register a typed tool and a two-branch workflow through public APIs.
2. Validate input and reject an unauthorized action before dispatch.
3. Create an approval request and release all worker capacity while waiting.
4. Terminate/restart the runtime; recover the wait and resolve it as an authenticated test human.
5. Execute the effect with a shared budget and stable invocation identity.
6. Recover crashes before and after dispatch without blindly repeating unknown effects.
7. Preserve a successful effect receipt even when output validation rejects its payload.
8. Observe ordered events and a typed result; pass the same suite with SQLite and PostgreSQL.

In parallel, validate the base install and first-agent API contract with deterministic fixtures: no native dependencies or infrastructure prerequisites, no bypassed safety gates, clear non-durable semantics, and a documented move to the durable profile. These consumer tests start with the first packaged slice, not after the runtime is finished. Source-plan gates V19–V22 add adoption, compatibility and open-source release evidence.

Use Vitest for contracts/integration, fast-check for state transitions and races, and Playwright for later browser/approval journeys. Add packaged-consumer and cross-OS jobs before claiming distribution support. [Vitest](https://vitest.dev/guide/), [fast-check](https://github.com/dubzzz/fast-check), [Playwright](https://playwright.dev/docs/intro)

| Sequence | Deliverable | Existing plan mapping |
| --- | --- | --- |
| 1 | Contract ADRs, schemas, migrations/transaction specification, module boundaries and qualified dependency pins | M1 |
| 2 | Tools, policy/budgets, durable runtime, both stores, minimal wait/approval and recovery path | M2 + first M3 slice |
| 3 | Full workflow/WorkStream operations, agents, child composition and tool batches | Remaining M3–M4 |
| 4 | Complete processors/guardrails, structured output and protected streaming | M5; minimum hard gates already present in sequence 2 |
| 5 | Native memory/context, provider synchronization and semantic retrieval | M6 |
| 6 | Qualified Code Mode and standalone consumer conformance | M7 |
| 7 | Server/client/UI packaging, native inspector, integrations and templates | M8; minimal API exercised earlier |
| 8 | Security, compatibility, performance and release qualification | M9 |

Performance targets remain hypotheses until measured on declared workloads. Report scheduling/wakeup latency, suspended-wait resource use, cancellation, recovery, guardrail overhead, retrieval quality and cost per accepted task. No timeline estimate is implied without staffing and scope allocation.

## 12. Decisions and next step

This proposal makes concrete recommendations for the runtime, storage, tool contracts, server, UI, testing, memory and sandbox approach. It is aligned with source-of-truth version 1.2, including consumer-first open-source requirements. Accepting a technology recommendation should produce an ADR before implementation relies on it.

Owner decisions still needed before the relevant external action: standalone repository location/name, package namespace and exact open-source license. Open-source distribution itself is no longer an open decision. Those choices do not prevent preparing the core specifications. Exact dependency patch versions and detector/embedding models are selected through compatibility/security/evaluation checks; they are not silently selected by a future installer.

Immediate next deliverables: first-agent and existing-app API recipes with install/DX budgets; execution/result and schema contracts; storage transactions and effect-recovery protocol; workflow IR and WorkStream semantics; processor/guardrail ordering; broker/approval/budget contract; and the first-milestone test specification. These should be short, reviewable engineering documents linked to F/G/V requirement IDs.

Development starts with the standalone workspace and the first milestone after the user moves from proposal review to implementation. No source scaffold, dependencies, database, service, repository or deployment was created while preparing this proposal.
