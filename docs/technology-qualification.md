# Technology qualification record

Checked 2026-09-20 against local executables and registry metadata. Exact resolved dependencies and integrity hashes are in `pnpm-lock.yaml`. Registry metadata is not itself a vulnerability audit.

| Component | Pinned version | Role |
| --- | --- | --- |
| Node.js | 24.14.1 | Current local qualification runtime |
| pnpm | 10.17.1 | Maintainer workspace tool, not a consumer requirement |
| TypeScript | 7.0.2 | Native maintainer compiler; no consumer dependency |
| Vitest / Vite | 5.0.1 / 8.3.0 | Maintainer test execution |
| fast-check | 4.10.1 | Property testing; newest release excluded by minimum age policy |
| Zod | 4.6.5 | Test/reference schema adapter, not a core runtime dependency |
| better-sqlite3 | 13.0.3 | Optional worker-owned SQLite adapter |
| pg | 8.23.0 | Optional PostgreSQL adapter |
| Hono | 4.13.8 | Optional `@mayura/server-node` router; excluded from the base SDK/client |
| @hono/node-server | 2.1.1 | Optional Node Fetch/HTTP bridge for the loopback host |

Packages were installed with lifecycle scripts disabled. Base core/tools/runtime/testing code has no external runtime dependency. Native tooling/storage are separate from that installation path. TypeScript's current native compiler is invoked explicitly in maintainer scripts; this avoids an observed local shell resolving an older globally installed compiler.

`@mayura/server` remains a listener-free Fetch facade over the runtime; `@mayura/client` has no runtime dependencies or Node imports. Only `@mayura/server-node` adds Hono and its Node adapter, and only when explicitly selected. Auxiliary guardrails use existing core model/budget contracts and add no provider or native dependency. The metadata observer depends only on core. Workflows, WorkStream and memory use driver-free `@mayura/storage-contracts`. Select `@mayura/storage-sqlite` or `@mayura/storage-postgres` to install only the chosen SQL driver; the `@mayura/storage` compatibility facade deliberately installs both. The single shared `@mayura/storage-sql/host` engine adds no driver dependency itself.

The Hono pins are recorded in the optional host manifest and lockfile. The implementation uses the adapter without replacing global Web API objects and exposes a loopback-only host, not arbitrary router/proxy facilities. See the [local host contract](specs/node-local-host.md), official [Hono Node guide](https://hono.dev/docs/getting-started/nodejs) and [Node adapter source](https://github.com/honojs/node-server). These upstream references are integration documentation, not security or production-deployment certification.

PostgreSQL integration used the existing local `postgres:17-alpine` image with digest `sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`, in a disposable localhost-only container. This records a tested image, not qualification of all PostgreSQL versions or a claim that the image has been security-audited.

CI configuration pins verified upstream action commit IDs and adds Linux/macOS/Windows jobs. Those remote jobs have not run in this local checkout; configuration is not cross-platform evidence. Public release still requires a complete declared runtime/OS/architecture/package-manager matrix, license review and vulnerability evaluation.

## Advisory check

Fresh checks on 2026-09-20 after the optional host and driver-free contract additions reported zero known advisories: `pnpm audit --prod --json` reported 37 dependencies and `pnpm audit --json` reported 127. These are the tool's complete graph counts, not a count of external packages in the base SDK.

Registry advisory results are time-bounded evidence, not a source audit, container scan, transitive license review or proof of absence of vulnerabilities. The completion-wait, selected-storage, graph-wait, discovery and coordinator slices change no external dependency pins; the earlier graph counts above are not a fresh audit of the reorganized workspace.

The integrated local suite passed 2,190 tests in 86 files on 2026-09-21 with both SQL adapters enabled and two test processes; eleven credential-free examples pass. The two-process bound is now the default after documented timing-sensitive failures under four concurrent suites; production limits and in-test concurrent-worker assertions are unchanged. Offline optional installation checks cover the client (one package), host/observer fixture (11 packages), workflows (five packages; no SQL driver), managed moderation/hooks/observer (six packages; no provider, server, testing or validator dependency), completion-wait custom-adapter facade (three packages; no SQL driver) and versioned graph/discovery/coordinator facade (five packages; no SQL driver). The base SDK's six-package closure and archive budget remain unchanged. The client was browser-target bundled and exercised without Node globals; no live-browser UI claim follows.

Selected-storage archive checks passed SQLite-only (six packages), PostgreSQL-only (18), compatibility (22) and workflow-tree-plus-SQLite (nine) installations, including real SQL transactions, bidirectional reopen, format-3 wait/resume, finite discovery, packed required-child execution, profile isolation, identical error identity and actual SQLite worker native-load evidence with lifecycle scripts disabled. Third-party manifests, notices and shipped binaries were preserved; only the current host's loaded binary was exercised. All four profiles reject ancestor workspace declarations and runtime-module fallback. See the [storage qualification record](specs/storage-package-qualification.md) and [development ledger](development-status.md) for retained reports, timing-test observations and limitations. Remote CI and other host operating systems remain unqualified.
