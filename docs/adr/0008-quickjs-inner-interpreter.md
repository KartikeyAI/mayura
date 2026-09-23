# ADR 0008: QuickJS/WASM as the first inner interpreter

Status: accepted for an unqualified experimental adapter.

## Context

The Code Mode broker contract needs an actual interpreter fixture without turning the interpreter into a security claim. Current `isolated-vm` guidance warns that leaked references can expose the host process and recommends a separate process for resilience; a critical guest-reachable escape affected releases through 7.0.0 in August 2026. Node's own security policy states that its permission model and V8 sandbox are not malicious-code security boundaries.

`quickjs-emscripten` 0.32.0 supplies explicit runtime memory, stack and interrupt limits and supports host promises without exposing Node globals. The core package and one release/synchronous WASM variant are MIT licensed, contain no installation lifecycle hook and add about 417 KB of packed archives plus their small FFI type package. They remain optional.

## Decision

Use exactly pinned `quickjs-emscripten-core` 0.32.0 and `@jitl/quickjs-wasmfile-release-sync` 0.32.0 in optional `@mayura/adapter-code-quickjs`. Each execution creates a fresh QuickJS runtime in a disposable Node child process. The only guest binding accepts JSON tool requests and returns JSON outcomes through the parent Code Mode bridge. The guest receives no Node process, module loader, filesystem, network, environment, console or raw host object.

The adapter enforces QuickJS heap, stack and interrupt deadlines, bounds its newline-delimited protocol, clears the child environment and force-terminates the exact adapter-owned process on completion or cancellation. JavaScript expression programs and empty import catalogs are the only supported profile. TypeScript compilation and imports remain unsupported.

The adapter is registered as `test` and requires `allowTestAdapter: true`. A child process plus a WASM interpreter is defense-in-depth, not the required outer OS sandbox. No production qualification follows from this decision.

## Evidence and consequences

Focused tests execute pure code, sequential and parallel brokered tools, deny Node globals, enforce CPU/heap limits, reject TypeScript/imports and terminate on cancellation. A fail-first allocation case exposed a surviving CPU-heavy child; exact force termination was added and the repeated focused and isolated packed-consumer runs leave no recent worker process.

The isolated offline consumer installs seven packages, executes the packed worker and proves broker mediation, missing Node globals and CPU interruption with lifecycle scripts disabled. The 2026-09-23 production-graph registry audit reports zero known advisories across 45 dependencies. These results do not test an interpreter escape or container/kernel escape.

[ADR 0009](0009-docker-outer-sandbox.md) adds the first experimental outer profile with these controls while retaining test-only qualification. See the [QuickJS adapter boundary](../specs/code-mode-quickjs.md), [QuickJS runtime limits](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md), [Node security policy](https://github.com/nodejs/node/blob/main/SECURITY.md), and the [isolated-vm advisory](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4).
