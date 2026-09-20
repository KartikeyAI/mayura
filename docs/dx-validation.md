# Developer-experience validation

Mayura's base installation is validated as a separate developer application, not only through imports inside its workspace. This is an experimental distribution gate; it does not qualify the entire framework as enterprise-ready.

## Run the check

After installing the workspace's pinned development dependencies and building it:

```sh
node node_modules/typescript/bin/tsc --build
node scripts/consumer-check.mjs
```

The consumer test also runs from `packages/consumer-tests/test/consumer.test.ts` through the unit test suite. The check does not publish packages, contact a model, start a server, require Docker, or install native modules. Local npm and pnpm must already be available. It disables Corepack network acquisition and npm registry access, audit, funding requests, and installation scripts.

CLI discovery checks local JavaScript entry points alongside the running Node installation, package-manager-provided entry paths, and Node-shebang symlinks on `PATH` (including common Unix/Homebrew layouts). Windows command shims are not passed to Node or interpreted through a shell. If a nonstandard installation layout is used, set `MAYURA_NPM_CLI` and `MAYURA_PNPM_CLI` to the respective absolute CLI JavaScript paths. An invalid explicit path fails rather than silently selecting another installation. This never downloads a missing package manager. Use the Node version in the workspace's declared support range.

The workspace and installed-package checks use canonical filesystem paths, including when the checkout is reached through a symlink/junction. The caller can run the script from an unrelated working directory. Generated artifacts must resolve inside the canonical workspace; a redirected artifact directory is rejected.

## Evidence produced

Each run creates a uniquely named directory under `.artifacts/consumer-*`. It contains the exact local package archives, the generated independent application, its lockfile, an isolated npm cache, and `report.json`. Generated files remain available for inspection; the script performs no recursive cleanup or changes to application source. These generated artifacts are ignored by Git.

The check:

1. Packs the actual compiled `@mayura/core`, `@mayura/tools`, `@mayura/runtime`, `@mayura/testing`, and `@mayura/sdk` packages using pnpm, exercising workspace dependency rewriting.
2. Inspects real archive members. Only compiled JavaScript, declarations/maps, map-referenced TypeScript under `src`, package metadata, README, and license files are permitted. Unreferenced source, test/spec files, native files, lifecycle scripts, executable entries, unreviewed dependencies, and private-key markers fail the check.
3. Packs Zod from the existing local development installation. Zod is a chosen application validator, not a dependency of Mayura's base runtime.
4. Installs all six local archives into a clean application with npm's offline mode, installation scripts disabled, and an isolated cache. No workspace links or registry resolution satisfy these imports.
5. Verifies the complete dependency tree contains only those six packages. Browser automation, database drivers, sandbox binaries, provider SDKs, and telemetry exporters are absent.
6. Runs a strict TypeScript consumer compile against the installed declarations, including `exactOptionalPropertyTypes`, unchecked-index checking, and positive/negative type fixtures. This catches errors that ordinary Vitest transpilation does not type-check.
7. Exercises Zod inference, input/output transformations, submit input checking, success-result narrowing, hidden tool executors, and rejected invalid type assignments through public exports. Shared budget bundles are tested through the installed SDK: readonly types, ancestor holds, single-use genuine receivers, cleanup and unchanged usage snapshots.
8. Executes an independent ESM first-agent/required-child fixture, verifies the actual tool result reaches the next scripted-model call, observes completion, and tests default-deny behavior. A Node module-resolution preloader bounds both the execution and debugger fixtures to their installed application, resolving real paths and rejecting ancestor workspace/source fallback. Explicit forbidden ancestor-package/source imports prove those paths cannot rescue an incomplete archive. Private package subpath imports must fail. This test boundary permits Node builtins and is not an untrusted-code sandbox.
9. Verifies every shipped JavaScript/declaration source map resolves to an actual packaged TypeScript source, with no external/build-machine path dependency. JavaScript maps' embedded source content must exactly match that source. A separate Node process with source maps enabled must produce a real framework error stack pointing to its installed TypeScript file.
10. Records local installation, type-check, fresh-process import, and execution duration together with Node/OS/architecture and archive size. These measurements are evidence from one environment, not cross-platform performance claims.

The fixture model is deterministic and credential-free. It does not perform inference or prove model quality. Live-provider qualification is a separate opt-in gate; no fake successful fallback is used here.

## Source and debugger navigation

The five base package manifests include vetted `src/**/*.ts` files alongside `dist`. Public package exports are unchanged: including open-source implementation for debugging does not add an importable private API. TypeScript declaration maps now have on-disk targets inside the installed package, and JavaScript maps carry inline source content for debugger display.

The archive check rejects missing or mismatched targets, stale embedded source, unexpected source roots, extra source files not used by the compiled maps, and test/spec content. This is tested against actual tarballs and an independent npm installation, rather than relying on source files that happen to exist in the development checkout.

The first passing navigation run on 2026-09-20 used Windows x64 and Node 24.14.1. It verified 26 maps across 13 source files, including an actual source-mapped Node stack. The four framework archives totaled 53,979 compressed bytes and 234,706 unpacked bytes; no size budget was increased. The retained report is `.artifacts/consumer-8ZzcFJ/report.json`. These are a dated measurement, not a permanent size or cross-platform guarantee. Specific editor UI integration remains part of the later supported-tooling matrix.

## Initial regression budgets

These budgets apply to the five base framework packages together, excluding the application's chosen validator and the build/test toolchain. ADR 0003 adds a thin SDK facade without increasing any size budget or adding an external dependency:

| Measurement | Initial gate |
| --- | --- |
| Each compressed package | At most 150 KiB |
| Combined compressed archives | At most 512 KiB |
| Combined unpacked archive members | At most 2 MiB |
| Mandatory runtime dependency surface | Only the five Mayura packages; no external/native/provider package |
| Fixture installation | Exactly five Mayura packages plus the chosen Zod validator |
| Scripts, registry, telemetry, or paid models required | None |

Individual subprocesses have a 30-second timeout, and the test suite bounds the complete consumer check. Timings are measured but not yet used as fine-grained performance regression thresholds: stable baseline cohorts and CI hardware must be established first. Changing a size/dependency gate requires a documented DX tradeoff, not silently widening the gate after a failure.

## Remaining release qualifications

- Repeat clean installation and examples across the supported Windows, Linux, and macOS matrix and chosen package-manager versions.
- Execute a real-provider tutorial with explicit credentials, permissions, and spending limits.
- Validate editor UI navigation across the supported tooling matrix, API reference links, package provenance, licensing, and published-package upgrade/migration fixtures.
- Conduct first-time-developer walkthroughs and measure time to first successful agent and error recovery.
- Expand [optional-package qualification](specs/optional-package-qualification.md), which already covers client bundling and host/observer/driver-free workflow installations, to live browsers and the remaining OS/package-manager matrix. The base runtime is not advertised as a browser sandbox.
- Repeat the gate for concrete storage, memory, and Code Mode installation profiles without adding them to the basic dependency graph.

Passing this narrow gate demonstrates the recorded packed-consumer behavior. It does not imply that planned durable workflows, enterprise deployment, security reviews, or all other release requirements are complete.
