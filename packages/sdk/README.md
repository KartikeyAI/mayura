# mayura

Experimental Mayura authoring facade: `defineTool`, `defineAgent`, `defineHook`, `createRuntime`, `invokeTool`, `invokeBatch` and their core contracts. Required control hooks use the same run-owned grants and budgets for permitted tool actions; they are not arbitrary middleware or a sandbox. No external runtime dependency or configuration side effect. Provider adapters, native storage, guardrails and other infrastructure are separate explicit imports.

The package is private and unpublished. See the repository's `docs/quickstart.md` and `docs/development-status.md` for the executed example and current limitations.
