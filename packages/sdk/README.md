# mayura

Experimental Mayura authoring facade: `defineTool`, `defineAgent`, `defineHook`, `createRuntime`, `invokeTool`, `invokeBatch` and their core contracts. Required control hooks use the same run-owned grants and budgets for permitted tool actions; they are not arbitrary middleware or a sandbox. It also exports `z` (Zod 4) for schemas, its one external dependency, with no configuration side effect. Provider adapters, native storage, guardrails and other infrastructure are separate explicit imports.

It is published as the root of the `mayura` package (`import { defineAgent, z } from 'mayura'`). See the [quickstart](../../docs/quickstart.md).
