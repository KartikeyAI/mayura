# @mayura/code-mode-workflows

Experimental bridge from bounded Code Mode programs to Mayura's durable scheduled-workflow engine. Each phase is an ordinary brokered tool with a stable program-digest version and mandatory exact human approval. The workflow engine persists only JSON phase input/output and execution evidence; JavaScript heaps, closures and pending promises are never serialized.

Every phase reserves a conservative maximum nested-tool cost and inherits the strongest declared nested-tool effect. If a write/host phase is interrupted after dispatch, ordinary scheduled-workflow recovery preserves `outcome_unknown` and does not replay it automatically.

This package supplies definitions, not storage. Use a selected durable workflow store and `createScheduledWorkflowRuntime` from `@mayura/workflows`. The current bridge remains experimental: nested receipts are summarized by the phase result rather than exposed as a separate durable audit stream, and Code Mode sandbox qualification remains independent.

