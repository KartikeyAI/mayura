# mayura/adapter-code-quickjs

Experimental QuickJS/WASM inner-interpreter adapter for `mayura/code-mode`. Each execution uses a disposable child process, a fresh QuickJS runtime, explicit memory/stack/CPU limits and a bounded JSON tool bridge.

This adapter is deliberately marked `test`: a child process and WebAssembly interpreter are defense-in-depth, not Mayura's required OS-enforced hostile-code boundary. Use requires `allowTestAdapter: true`. It has no imports, filesystem, network, environment, process or module API inside the QuickJS context, but V15 remains open until an outer sandbox profile and crash/replay path are qualified.
