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

Packages were installed with lifecycle scripts disabled. Base core/tools/runtime/testing code has no external runtime dependency. Native tooling/storage are separate from that installation path. TypeScript's current native compiler is invoked explicitly in maintainer scripts; this avoids an observed local shell resolving an older globally installed compiler.

PostgreSQL integration used the existing local `postgres:17-alpine` image with digest `sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`, in a disposable localhost-only container. This records a tested image, not qualification of all PostgreSQL versions or a claim that the image has been security-audited.

CI configuration pins verified upstream action commit IDs and adds Linux/macOS/Windows jobs. Those remote jobs have not run in this local checkout; configuration is not cross-platform evidence. Public release still requires a complete declared runtime/OS/architecture/package-manager matrix, license review and vulnerability evaluation.

## Advisory check

On 2026-09-20, `pnpm audit --prod --json` checked 27 dependency entries and reported zero known advisories at every severity. This is time-bounded registry evidence, not a source audit, container scan, transitive license review, or proof of absence of vulnerabilities. Repeat it after dependency changes and before release.

The final full-toolchain `pnpm audit --json` checked 120 dependency entries and likewise reported zero known advisories. The documented Compose fixture was started from the pinned local image and used for a complete 470-test run on this machine. Remote CI and other host operating systems remain unqualified.
