# Performance report

Reproduce with `pnpm build && pnpm perf`; each run writes a JSON report to `.artifacts/`. The suite measures framework compute only. Models and tools are zero-latency local fixtures, human waiting is replaced by an injected clock, and provider/network time is excluded ([plan §21.3](create-mayura-agentic-framework-plan.md)).

**Declared hardware (2026-09-27 run).**

- Machine: Windows 11 Pro 10.0.22631 x64, 12th Gen Intel Core i7-12700 (20 logical cores), 31.7 GB RAM.
- Runtime: Node.js 24.14.1.
- Storage: SQLite (WAL, `synchronous=FULL`) on local SSD.
- Load: one process, sequential operations, no concurrent load.

## Reference targets

| Target (plan §21.3) | Result | Met |
|---|---|---|
| 10,000 suspended waits without a thread, process or model context per wait | 10,000 durable timer waits held in storage; 1 active handle; RSS 71 → 275 MB | yes |
| Synthetic local dispatch/wakeup p95 ≤ 100 ms | due-wait wakeup to completion: p50 4.8 ms, **p95 6.6 ms** (1,000 wakeups) | yes |
| Local cancellation stops owned work within 5 s | cancel to terminal outcome: p95 0.33 ms, **max 0.52 ms** (100 runs) | yes |
| Native semantic index recall | IVF recall@10 against exact search: **1.00** over 50,000 records (219 lists, `nprobe` 8) | yes |

## Measurements

| Measure | Result |
|---|---|
| Durable wait creation (submit and suspend) | 13.7 ms per wait |
| Ephemeral run with one tool call | p50 0.15 ms, p95 0.26 ms |
| Native memory load, 50,000 records | 3.8 ms per record (each add is one durable transaction) |
| Lexical BM25, typical terms, 50,000 records | p50 65 ms, p95 76 ms |
| Lexical BM25, most common terms (in about half of all records) | p50 102 ms, p95 176 ms |
| Semantic IVF search, 50,000 records | p50 47 ms, p95 79 ms |
| Embedding and index build, 50,000 records (local hashing embedder) | 176 s, with periodic retraining |

## Notes and limits

- Authorization filters run inside every ranking query, so search cost grows with the postings or vectors a query touches, not only with the result size. The common-term row is a deliberate worst case.
- An optimization pass informed by this suite fixed three problems:
  - SQLite no longer chooses a record-driven join plan;
  - the IVF branch read now stays on its list index;
  - BM25 ranking now runs in the database.

  Together these took IVF search p50 from 204 ms to 47 ms and common-term BM25 p50 from 259 ms to 102 ms.
- The RSS growth during the wait test is the process working set after creating 10,000 runs through one SQLite worker. It is not per-wait execution context: no timers, threads or model contexts are held per wait.
- These are single-machine figures. PostgreSQL (`pnpm perf -- --postgres`), concurrent load, macOS and Arm qualification belong to hosted CI and the owner-held items (F7, F10).
