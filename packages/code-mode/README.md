# mayura/code-mode

Provider-neutral Code Mode: define a content-addressed program, run it in a sandbox adapter, and broker every nested tool call through your own tool broker. The package never evaluates program source in the host process and has no fallback when a sandbox is unavailable.

Every execution returns host-derived nested-tool usage: admitted call count, known cost, unresolved cost and the program maximum. A missing or unknown broker receipt forces `outcome_unknown`; the program cannot conceal it by returning an apparently successful result. Failures carry precise codes (`LIMIT_EXCEEDED` for `cpuMillis` or `memoryBytes`, `INVALID_OUTPUT`, `TIMEOUT` and so on) with messages written by Mayura; what the program threw is returned separately as a bounded `programError`.

Adapters declare a qualification. The built-in QuickJS and Docker adapters are `production`. Your own adapters may declare `test`; `createCodeMode` then requires `allowTestAdapter: true`. See the [Code Mode guide](../../docs/guides/code-mode.md) and the [sandbox guarantees](../../docs/project/security.md#code-mode-sandboxing).
