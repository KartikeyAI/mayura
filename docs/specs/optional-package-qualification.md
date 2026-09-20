# Optional package consumer qualification

Status: implemented and exercised local distribution gate. It complements, and does not replace, the base SDK consumer gate or the enterprise release criteria.

## Profiles

The gate packs current built packages and installs their actual archives into fresh consumers using an empty npm cache, offline mode and disabled lifecycle scripts. Child commands receive a small environment allowlist, not application credentials or Node injection flags. No registry download, publication or production service is involved.

1. **Browser client:** only `@mayura/client` is installed. Its runtime, optional and peer dependency sets must remain empty. Strict public TypeScript declarations are checked without Node ambient types. The existing workspace Vite tool builds an IIFE browser bundle from the installed export; every included module must belong to the isolated application. No Node builtin, external module, privileged Mayura package or Node global shim is admitted. A no-Node-globals VM smoke check exercises the bundled client against a controlled Fetch implementation. This is browser-target bundling evidence, not a live browser UI qualification.
2. **Local host and observation:** installed `@mayura/server-node`, `@mayura/client`, `@mayura/observability`, SDK and deterministic testing fixture packages perform a real authenticated HTTP/SSE/result roundtrip on an ephemeral loopback port. Required Mayura packages plus the exact installed Hono/Node-adapter versions are supplied as local archives; local dependency overrides make resolution fully offline. Strict public types include negative fixtures. An explicitly attached observer also follows a local runtime handle, inspects its terminal counters and closes without cancelling its source.
3. **Driver-free workflow composition:** installed `@mayura/workflows` and its contracts/core/tools/runtime closure execute the public `@mayura/workflows/ephemeral` adapter. A finite fork/join graph verifies transformed inputs and output, while a composed workflow runs as a required child tool. No storage driver, PostgreSQL client, Hono package, SQL database, native build script or inference provider is installed or used. This proves ephemeral composition only, not durable execution or restart recovery.

4. **Runtime-managed moderation and hooks:** installed SDK, guardrails and observability resolve to exactly six Mayura packages, with no testing, validator, server, provider or database package. Genuine definitions cross the packed core/host and tools/host entries. Input moderation, an entry-hook assertion with output moderation, primary-request hook/generation and final moderation/release hook share one execution slot, one reasoning step and one actual account. The observer accepts 18 safe events: four model calls, one tool and three required hooks, plus the run boundary. Strict negative types, run-qualified action evidence and forged-handle rejection preserve the definition-only authoring boundary. The hook catalog is absent from primary model tools and history.

## Assertions

Package runtime imports resolve under the isolated application's real `node_modules`, not workspace symlinks or source paths. Consumer fixtures import public package exports only. Private source/deep exports stay inaccessible. Packed manifests contain no workspace protocol, Mayura installation lifecycle scripts or undeclared profile dependencies. Framework archives contain only reviewed manifests, readmes, licenses, compiled declarations/JavaScript, maps and their mapped TypeScript sources; map targets must remain inside the archive.

The base SDK/core/tools/runtime dependency closure must not acquire client, server, host, observability, guardrails, Hono or native database/provider dependencies. Host-related dependencies remain an explicit optional install choice. Third-party archive packing is limited to already-installed exact dependencies; lifecycle scripts stay disabled during both packing and installation. Their existing license/manifests are preserved, not rewritten.

The roundtrip creates a random, short-lived, in-process demo credential that is never printed. No external model call occurs. Streams are metadata-only; output is admitted through the supplied wire validator. All listeners, observations and runtimes are closed in `finally`. Errors must not include the generated token or private fixture prompt.

## Artifacts and limits

Run `node scripts/optional-consumer-check.mjs` after the workspace build. The gate retains archives, isolated installed applications, lockfiles, browser output and a machine-readable report beneath a fresh `.artifacts/optional-consumer-*` directory. It performs no recursive deletion and never replaces an existing consumer directory. Set `MAYURA_NPM_CLI` or `MAYURA_PNPM_CLI` only when an installed CLI's absolute JavaScript entry point cannot be discovered locally.

A passed report proves the current archives work in the measured local environment. It does not publish packages, qualify every OS/browser, establish production authentication/TLS, supply durable serving, or turn optional metadata observation into mandatory audit or OpenTelemetry. Existing source, unit, socket and durable-store gates remain independently required.
