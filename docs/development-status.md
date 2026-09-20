# Development status

Updated: 2026-09-20. Release status: **experimental development preview / not enterprise-qualified**.

The owner authorized independent development in `mayura/`. Its local repository has no remote; nothing has been published or deployed. Packages remain private pending the owner's license and registry namespace decisions. F01–F29, G01–G11 and V01–V22 remain the product contract, not a checklist completed by this foundation.

## Implemented slices and integration status

| Slice | Current behavior and evidence |
| --- | --- |
| Public SDK | One-import `@mayura/sdk` facade and direct package imports, Standard Schema inference, runtime validation, credential-free example. Packed offline npm installation, strict/negative consumer type tests and source navigation pass on Windows x64 / Node 24.14.1. |
| Core | Bounded plain JSON, immutable snapshots, explicit grants, safe typed errors and genuine hierarchical integer-cost accounts. Tests cover accessor/mutation rejection, ancestor ceilings, concurrent admission, exact overruns and retained unknown reservations. |
| Tools/batches | Shared broker, input/output guards, separate execution/disclosure receipts, bounded DAG scheduling, shared budgets, dependency skips, fail-fast and per-batch resource exclusion/quarantine. |
| Ephemeral agents and composition | Bounded model/tool loop plus direct required children and agents as tools through one private admission path. Inherited scope, narrowed grants, ancestor cost/call/operation ceilings, cycle/depth/run bounds, capacity-safe joins, transform parity and private transcripts. Packed SDK composition and the credential-free child example are exercised. |
| Ephemeral workflow composition | Explicit approval-free finite graphs compile to a stateless, zero-inference local planner through the existing runtime. Input/output transform parity, exact dependency/result binding, required child composition, budgets, cancellation and receipts are covered by 51 tests. Approval-required definitions fail at composition time. No durable composition or new ledger is implied. |
| Optional model provider | OpenAI Responses adapter with fixed destination, strict schemas, aliases, bounded bodies and explicit known-failure accounting. Mocked HTTP only; no live/paid calls or model-quality qualification. |
| Storage | Driver-free aggregate/scheduler interfaces and one shared error identity, plus separately selected worker-owned SQLite and pooled PostgreSQL adapters. Scoped idempotency, aggregate CAS, atomic state/events and shared conformance tests. Not itself authentication or a workflow engine. |
| Standalone leased scheduler | Optional capability on both SQL adapters: fixed reservation identity/due time, expiring claims, sticky revocation, monotonic fences, start permits, independent receipts/completion, resource quarantine and conservative recovery. Real-database tests cover races, process termination, corruption, late evidence and bounded large result pages. This does not fence existing workflow writes. |
| Durable workflow foundation | Finite tools/joins, exact human approval, restart and conservative no-replay recovery. Both databases pass race/conformance tests; three real process-kill scenarios pass. Format 2 rejects inconsistent/old state instead of guessing migration. |
| WorkStream foundation | Scoped durable broadcast signals, all/any waits, idempotent registration, cursors and cancellation without retaining worker compute. Same 26 conformance cases pass on both SQL adapters. |
| Guardrail foundation | Ordered processors, versioned immutable candidates, required parallel barriers, normalization, heuristic PII, literal protection, safe callbacks and guarded text batches. No general prompt-injection prevention or complete PII detection claim. |
| Auxiliary guardrails | Explicit schema-validated model checks, moderation guards, and separately metered detection/translation of application-classified prose. Genuine caller-supplied shared accounts, local egress barriers, original/protected-span preservation, exact segment mapping and late-usage accounting are exercised with fake adapters; runtime provisioning and semantic-quality qualification remain. |
| Native memory | Scoped provenance-backed records, CAS correction, permanent content-scrubbing tombstones, sensitivity grants, bounded lexical search and export. Deletion/stale-update tests on both databases. |
| Native context | Scoped current-source selection, required continuity, sensitivity/validity checks, exact bytes, explicit token estimates, upstream provenance and exclusion evidence. Includes repeated assembly and property tests. |
| HTTP transport and client | Authenticated ephemeral Fetch API with exact body shape, scoped run access, finite idempotency/run/request/stream registries, guarded final results and bounded metadata SSE. Browser-safe client uses explicit tokens, no cookies/redirect following or automatic command retries, validated output, and explicit cursor reconnect. Request-facade and client tests are exercised; no browser UI or durable serving claim. |
| Local Node host | Optional Hono/Node adapter binds only literal loopback addresses, derives origin from the socket, limits HTTP resources and drains all connections within a grace period. Twenty real socket tests include hostile headers and half-open rejected upgrades. The credential-free HTTP example passes; production TLS/proxy/multi-host qualification remains. |
| Native observability | Optional metadata-only observer with bounded subscriptions/history/sinks, explicit gaps, exact counters, reported cost snapshots and no automatic tree cost summing. Sixty-four tests include hostile events, slow sinks and read/cleanup quarantine that blocks reconnect until actual callbacks settle. It never cancels the observed execution and is not mandatory durable audit or an OpenTelemetry exporter. |
| Maintainer operations | Exact pins/lockfile, Markdown specs/ADRs, contribution/security guidance, packed-consumer checks and pinned CI definitions. Local strict types, full tests, examples and offline consumer profiles pass. Production and complete dependency audits report zero known advisories; remote CI has not run. |

## Important boundaries

- The leased scheduler is a standalone job ledger, not an integrated workflow worker. Ordinary aggregate/workflow writes are not made fenced merely by obtaining a scheduler claim. Opt-in ownership sidecars, finite atomic workflow/budget/approval commands, reconciliation, transactional outbox, timers, general workflow loops, compensation and safe migration remain unimplemented. Unknown effects are never silently replayed.
- Child orchestration and workflow-as-tool composition are process-local. No durable child links, restartable joins, durable workflow composition or distributed capacity is claimed. Waiting inside an ordinary model/tool callback is not a supported nested-execution mechanism; use `agentAsTool` or explicit ephemeral `workflowAsTool`. Parent budgets already include descendants and must not be summed with child snapshots. The finite workflow planner consumes visible zero-cost model-call/step allowances, and approval-required graphs are rejected.
- Late handler completion may persist receipts after cancellation/close while the separately owned store remains open. It cannot rewrite the original result or release late output. Store/process loss can still leave unknown evidence.
- WorkStream caps each stream at 256 signals, 128 waits and 1 MiB. Native memory caps each scope at 128 lifetime IDs (including tombstones) and 768 KiB. These are experimental correctness-first limits, not production-scale indexed storage.
- The scheduler bounds each job's retained attempts/evidence/commands and each query/batch, but has no global history-retention policy. Its resource identities are explicit, not inferred path aliases. Unresolved started work quarantines its resource holds until a future qualified reconciliation mechanism; fences are not provider-side exactly-once guarantees. Redundant-state checks detect covered corruption, not a privileged database writer consistently rewriting every copy.
- Memory deletion removes canonical content/provenance and current retrieval results. WAL, database pages, backups, previous exports/disclosures require separate erasure/retention controls.
- Context needs a trusted current-source manifest and faithful validity/provenance mapping. Stale caller evidence is not magically refreshed. Token estimates are not exact provider tokenization. There is no context cache or model compaction yet.
- PII recognizers are heuristic. Literal checks are not semantic injection defenses. Batch-local checking cannot catch every protected span split across batches; whole-response safety requires whole-response buffering.
- Auxiliary models require application-owned destination screening, genuine shared accounting and exact grants. The package does not automatically obtain the runtime's account or operation permits. Model verdicts and translations may be wrong; low-confidence preservation is not permission to bypass mandatory downstream checks. Protected segments stay local only when the application classifies them correctly.
- HTTP history and idempotency are in memory, finite and never silently evicted. Replacement loses that history; no restart-safe command deduplication is claimed. Stream expiry requires reauthentication, but revocation is not continuously checked midstream. The Node host is loopback-only; TLS, reverse proxies, distributed quotas, durable worker serving and UI rendering remain separate work.
- Workflows, WorkStream and memory depend on driver-free storage contracts, so custom adapter or ephemeral workflow consumers install neither SQL driver. Selecting the reference `@mayura/storage` adapters still installs both drivers. Separate SQLite-only/PostgreSQL-only installation profiles remain a DX gate.
- MCP, durable workflow composition, hosted memory/context integrations, qualified Code Mode, OTel exporters, browser UI bindings and production starter deployments are not represented as implemented. The native observer is optional process-local telemetry, not required durable audit. Application-provided source/sink callbacks are trusted JavaScript, not hard-isolated code.

## Release-gate ledger

All V01–V22 release gates remain open. “Partial” means narrower evidence exists, not enterprise qualification. The checkpoint below verifies these local slices, not every condition in a gate.

| Gate | Evidence / remaining scope |
| --- | --- |
| V01 authority | Partial direct/batched/agent/workflow broker equivalence and direct/tool child delegation; general hooks, MCP and Code Mode remain. |
| V02 effects | Partial CAS and real process kills; complete fault/reconciliation matrix remains. |
| V03 fencing | Partial standalone renewable claims, storage-clock expiry, stale fences and resource quarantine; integrated workflow writes/admission and complete fault qualification remain. |
| V04 waits | Partial durable signal/register/cancel/restart races and process-local required-child joins; durable execution waits, timers, notifications and full recovery remain. |
| V05 orchestration | Partial ephemeral descendants and workflow tools, genuine shared accounts/counters, cycle/depth bounds and capacity-safe joins; durable children/composition and distributed capacity remain. |
| V06 batches | Partial literal-input DAGs and truthful receipts; output references and durable waits remain. |
| V07 humans | Partial exact restartable approvals; full input/override lifecycle and distributed expiry remain. |
| V08 processors/hooks | Partial candidate/guard/callback integrity; full lifecycle and mediated hook calls remain. |
| V09 guardrails | Partial deterministic barriers, metered auxiliary evaluation and explicit model moderation; automatic runtime wiring, injection defenses and quality/adversarial qualification remain. |
| V10 disclosure | Partial raw-output withholding, bounded batches and authenticated metadata streams; cross-batch secrets, citations, artifacts and UI disclosure remain. |
| V11 language | Partial separately metered detection/translation, protected spans, original evidence and exact mappings; semantic/language coverage and mandatory downstream-policy qualification remain. |
| V12 budgets | Partial shared ancestor accounts, caller-wired auxiliary checks, known malformed-response costs and late settlement; automatic auxiliary ownership, durable descendant accounts and reconciliation remain. |
| V13 memory | Partial native scope/correction/tombstones; indexed scale, providers, derivatives and import/migration remain. |
| V14 context | Partial pinned continuity and repeated assembly; semantic compaction/resume, caching and speculation remain. |
| V15 Code Mode | Open: containment, mediated nested tools, host approvals and crash/replay suite. |
| V16 server/client | Partial scoped Fetch API, validated browser-safe HTTP/SSE client, explicit reconnect and loopback host; durable serving, browser UI, production TLS/proxy and multi-host qualification remain. |
| V17 operations | Partial storage corruption/recovery, local socket drain and bounded native metadata observation. Backup/restore, disk-full, migrations, artifacts, durable audit and exporters remain. |
| V18 independence | Partial public consumer/workflow/child-agent fixtures and local HTTP example without Arth; full policy/host-code/artifact conformance remains. |
| V19 installation | Partial isolated packed offline base SDK, browser client, local host/observer and driver-free workflows; complete OS/package-manager/SQL-profile matrix remains. |
| V20 progressive DX | Partial first-agent, transformed child, workflow-composition and local-server examples; live-provider tutorial, novice walkthrough and qualified durable/server adoption remain. |
| V21 compatibility | Partial exports/declarations/source maps; upgrade policy and migration fixtures remain. |
| V22 release trust | Partial build/contribution/security/pins; owner-approved license/scope, notices/provenance, evaluation and governance remain. |

## Verification

The integrated Windows x64 / Node 24.14.1 checkpoint passes strict build/test type checking and **932 tests in 36 files**, with PostgreSQL enabled against the documented disposable Compose fixture. This includes both SQL adapters, real process-termination cases, actual loopback HTTP sockets and the packed base SDK gate. All four credential-free examples also pass. Test workers are bounded to four; the 256-public-transition WorkStream durability fixture has a 30-second correctness-test deadline to accommodate disk contention, not to claim throughput qualification.

The separate isolated offline optional-package gate passes three profiles: browser client (one installed package), local host/observer fixture (11), and workflows (five; no SQL driver). Checks cover public/negative types, packed source maps, module isolation from ancestor workspace packages, browser-target bundling without Node globals, authenticated HTTP/SSE and transformed workflow/required-child execution. This is not a live-browser UI or cross-platform qualification. Retained machine-readable local report: `.artifacts/optional-consumer-Od1cS3/report.json` (ignored, not a published artifact).

Fresh registry audits reported zero known advisories for 37 production-graph dependencies and 127 complete-graph dependencies. They are time-bounded registry results, not a security certification, source/container scan or license audit. No paid model call, publication, remote commit or deployment occurred.

Run `pnpm typecheck`, `pnpm test`, `pnpm test:consumer`, `pnpm test:consumer:optional` and `pnpm example`. After building, `node examples/agent-orchestration.mjs`, `node examples/workflow-composition.mjs` and `node examples/local-server.mjs` exercise optional progressive-adoption paths. PostgreSQL suites need `MAYURA_TEST_POSTGRES_URL` for a disposable database; without it they are skipped, not qualified. Tests clean only their own schemas/files. See [Docker testing](testing-docker.md).

Next milestone: specify and implement the opt-in atomic scheduler/workflow ownership boundary, then durable composition and full WorkStream integration. Mediated lifecycle hooks/auxiliary calls, qualified Code Mode, provider integrations and production operations remain major workstreams. Specifications and failure tests precede each implementation; a general enterprise release requires closing all applicable gates.
