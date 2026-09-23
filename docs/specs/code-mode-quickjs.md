# QuickJS Code Mode adapter boundary

Status: experimental inner interpreter; not a hostile-code sandbox.

`@mayura/adapter-code-quickjs` implements the `@mayura/code-mode` sandbox-adapter protocol for JavaScript expression programs. Every run owns a new child process, WebAssembly module, QuickJS runtime and context. It exposes one JSON-only tool-call function; the parent independently resolves the pinned genuine tool and applies all Code Mode and ordinary broker limits.

The adapter supports:

- JavaScript whose source evaluates to `(input, tools) => output`, including async functions;
- empty import catalogs only;
- JSON input, tool arguments/outcomes and final output;
- parallel guest promises within the manifest's host-enforced call/concurrency bounds;
- QuickJS heap, stack and CPU interrupt limits; and
- parent cancellation and exact child termination.

The context intentionally has no `process`, `require`, `fetch`, `console`, module loader, credential, filesystem or network binding. The child receives an empty environment. Protocol records and stderr are bounded; malformed, duplicate or oversized records fail closed without reflecting worker errors.

The package does not compile TypeScript, resolve imports, provide timers, persist phases or execute host code. It is registered with qualification `test`; using it requires the explicit `allowTestAdapter` switch. QuickJS/WASM bugs, Node child-process compromise and host-kernel access remain outside the proven boundary. The optional [Docker outer adapter](code-mode-docker.md) adds local OS controls but is also test-qualified and does not authorize hostile production code.

The packed-consumer gate includes exact third-party archives and dependency overrides, installation with lifecycle scripts disabled, strict public types and actual child execution. Unit fixtures additionally cover heap/CPU exhaustion, cancellation, Node-global absence and sequential/parallel tool calls. V15 remains open pending production outer-containment qualification, authoritative external reconciliation and supported-host coverage.
