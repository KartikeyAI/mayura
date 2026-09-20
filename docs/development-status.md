# Development status

Updated: 2026-09-20. Release status: **experimental development preview / not enterprise-qualified**.

The owner authorized independent development in `mayura/`. Its local repository has no remote; nothing has been published or deployed. Packages remain private pending the owner's license and registry namespace decisions. F01–F29, G01–G11 and V01–V22 remain the product contract, not a checklist completed by this foundation.

## Implemented and exercised

| Slice | Current behavior and evidence |
| --- | --- |
| Public SDK | One-import `@mayura/sdk` facade and direct package imports, Standard Schema inference, runtime validation, credential-free example. Packed offline npm installation, strict/negative consumer type tests and source navigation pass on Windows x64 / Node 24.14.1. |
| Core | Bounded plain JSON, immutable snapshots, explicit grants, safe typed errors and shared integer-cost reservations. Tests cover accessors, cycles, limits, concurrent admission, overruns and unknown reservations. |
| Tools/batches | Shared broker, input/output guards, separate execution/disclosure receipts, bounded DAG scheduling, shared budgets, dependency skips, fail-fast and per-batch resource exclusion/quarantine. |
| Ephemeral agents | Bounded model/tool loop, cooperative cancellation, metadata events, structured final output and private per-run provider continuation. No child-agent orchestration yet. |
| Optional model provider | OpenAI Responses adapter with fixed destination, strict schemas, aliases, bounded bodies and explicit known-failure accounting. Mocked HTTP only; no live/paid calls or model-quality qualification. |
| Storage | Worker-owned SQLite and pooled PostgreSQL aggregate CAS, scoped idempotency, atomic state/events and shared conformance tests. Not itself authentication or a workflow engine. |
| Durable workflow foundation | Finite tools/joins, exact human approval, restart and conservative no-replay recovery. Both databases pass race/conformance tests; three real process-kill scenarios pass. Format 2 rejects inconsistent/old state instead of guessing migration. |
| WorkStream foundation | Scoped durable broadcast signals, all/any waits, idempotent registration, cursors and cancellation without retaining worker compute. Same 26 conformance cases pass on both SQL adapters. |
| Guardrail foundation | Ordered processors, versioned immutable candidates, required parallel barriers, normalization, heuristic PII, literal protection, safe callbacks and guarded text batches. Not comprehensive injection prevention or moderation. |
| Native memory | Scoped provenance-backed records, CAS correction, permanent content-scrubbing tombstones, sensitivity grants, bounded lexical search and export. Deletion/stale-update tests on both databases. |
| Native context | Scoped current-source selection, required continuity, sensitivity/validity checks, exact bytes, explicit token estimates, upstream provenance and exclusion evidence. Includes repeated assembly and property tests. |
| Maintainer operations | Exact pins/lockfile, Markdown specs/ADRs, contribution/security guidance, packed-consumer checks and pinned CI definitions. Remote CI has not run. Production registry audit reported zero known advisories; not a security certification. |

## Important boundaries

- No leased workers, automatic fencing/reconciliation, transactional outbox, timers, general workflow loops, compensation or safe definition/data migration yet. Unknown external effects are never silently replayed.
- Late handler completion may persist receipts after cancellation/close while the separately owned store remains open. It cannot rewrite the original result or release late output. Store/process loss can still leave unknown evidence.
- WorkStream caps each stream at 256 signals, 128 waits and 1 MiB. Native memory caps each scope at 128 lifetime IDs (including tombstones) and 768 KiB. These are experimental correctness-first limits, not production-scale indexed storage.
- Memory deletion removes canonical content/provenance and current retrieval results. WAL, database pages, backups, previous exports/disclosures require separate erasure/retention controls.
- Context needs a trusted current-source manifest and faithful validity/provenance mapping. Stale caller evidence is not magically refreshed. Token estimates are not exact provider tokenization. There is no context cache or model compaction yet.
- PII recognizers are heuristic. Literal checks are not semantic injection defenses. Batch-local checking cannot catch every protected span split across batches; whole-response safety requires whole-response buffering.
- Optional storage consumers currently install both SQL drivers through `@mayura/storage`. The base SDK installs neither. Splitting backend installation profiles remains a DX gate.
- Self-hosted HTTP, browser clients/UI, MCP, sub-agent/workflow-as-tool composition, hosted memory/context integrations, qualified Code Mode, OTel exporters and production starter deployments are not represented as implemented.

## Release-gate ledger

All complete gates remain open. “Partial” means narrower evidence exists, not enterprise qualification.

| Gate | Evidence / remaining scope |
| --- | --- |
| V01 authority | Partial direct/batched/agent/workflow broker equivalence; delegation, hooks, MCP and Code Mode remain. |
| V02 effects | Partial CAS and real process kills; complete fault/reconciliation matrix remains. |
| V03 fencing | Open: renewable leases, stale-worker fences and cross-run resource ownership. |
| V04 waits | Partial signal/register/cancel/restart races; timers, execution waits, notifications and cursor-gap recovery remain. |
| V05 orchestration | Open: descendants, shared budgets, cycle/depth limits and capacity-safe joins. |
| V06 batches | Partial literal-input DAGs and truthful receipts; output references and durable waits remain. |
| V07 humans | Partial exact restartable approvals; full input/override lifecycle and distributed expiry remain. |
| V08 processors/hooks | Partial candidate/guard/callback integrity; full lifecycle and mediated hook calls remain. |
| V09 guardrails | Partial deterministic barriers; metered auxiliary checks, moderation and injection controls remain. |
| V10 disclosure | Partial raw-output withholding and bounded batches; cross-batch secrets, citations, artifacts and frontend streams remain. |
| V11 language | Open: separate metered detection/translation and original-evidence preservation. |
| V12 budgets | Partial shared reservations, known malformed-response costs and late receipts; durable descendant/auxiliary accounts and reconciliation remain. |
| V13 memory | Partial native scope/correction/tombstones; indexed scale, providers, derivatives and import/migration remain. |
| V14 context | Partial pinned continuity and repeated assembly; semantic compaction/resume, caching and speculation remain. |
| V15 Code Mode | Open: containment, mediated nested tools, host approvals and crash/replay suite. |
| V16 server/client | Open: authenticated APIs, safe browser clients, reconnect and UI interaction. |
| V17 operations | Partial storage/safe-error tests; backup/restore, disk-full, migrations, artifacts, drain and exporters remain. |
| V18 independence | Partial public consumer/workflow fixtures without Arth; full policy/host-code/orchestration fixture remains. |
| V19 installation | Partial packed offline base SDK; complete OS/package-manager/optional-profile matrix remains. |
| V20 progressive DX | Partial executed fixture and facade; live-provider tutorial, novice walkthrough and durable/server adoption remain. |
| V21 compatibility | Partial exports/declarations/source maps; upgrade policy and migration fixtures remain. |
| V22 release trust | Partial build/contribution/security/pins; owner-approved license/scope, notices/provenance, evaluation and governance remain. |

## Verification

Latest local checkpoint: strict build and test type checking passed; **470 tests in 22 files passed**, with PostgreSQL enabled against the documented fresh Compose fixture. The packed-consumer gate ran as part of that suite, and the credential-free example separately returned answer 5. This is evidence for the slices above, not closure of the open release gates.

Run `pnpm typecheck`, `pnpm test`, `pnpm test:consumer` and `pnpm example`. PostgreSQL suites need `MAYURA_TEST_POSTGRES_URL` for a disposable database; without it they are skipped, not qualified. Tests clean only their own schemas/files. See [Docker testing](testing-docker.md).

Next implementation milestone: bounded child orchestration and workflow composition over shared authority/budgets, then leased scheduling and full WorkStream integration. Specifications and failure tests precede each implementation. A general enterprise release requires closing all applicable gates.
