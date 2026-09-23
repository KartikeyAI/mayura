# @mayura/code-mode

Experimental provider-neutral Code Mode contracts and a bounded nested-tool bridge. The package never evaluates generated source in the host process and provides no fallback when a sandbox is unavailable.

Every execution returns host-derived nested-tool usage: admitted call count, known cost, unresolved cost and the program maximum. A missing or unknown broker receipt forces `outcome_unknown`; generated code cannot conceal it by returning an apparently successful result.

Optional QuickJS and Docker adapters are test-qualified only. See [the containment contract](../../docs/specs/code-mode.md) for the current boundary and remaining V15 work.
