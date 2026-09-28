# mayura/adapter-code-quickjs

The QuickJS sandbox for `mayura/code-mode`, qualified `production`. Each execution runs in a new Node.js child process under the Node.js permission model (read-only access to the QuickJS packages; no file writes, processes, worker threads, native addons or code generation from strings) with an empty environment, and in a fresh QuickJS WebAssembly interpreter. The program sees standard JavaScript and `tools.call` only.

Limits are hard: `cpuMillis` counts interpreter time and is enforced by an uncatchable interrupt, `memoryBytes` by the WebAssembly memory maximum, recursion by a fixed stack, and results and tool calls by size and count before they leave the interpreter. `createQuickJsProtocolAdapter` runs the same worker inside an outer sandbox you launch; it defaults to the `test` qualification.

Install the optional peers `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`. See the [Code Mode guide](../../docs/guides/code-mode.md) and the [sandbox guarantees](../../docs/project/security.md#code-mode-sandboxing).
