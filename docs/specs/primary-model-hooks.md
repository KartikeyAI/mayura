# Primary-model admission hook

Status: implemented experimental ephemeral subset, verified by 15 focused execution tests plus factory/client/observer and packed-consumer cases in the 1,581-test integrated checkpoint. Extends [required control hooks](lifecycle-hooks.md), not the full F09/F21 lifecycle or enterprise qualification. No new dependency, storage format, public execution gateway or provider change.

## Purpose and exact authoring surface

`beforeExecution` runs once; every later primary request contains newly assembled history. Add `beforeModelCall` as a fourth **required control** stage using the existing opaque `defineHook`, private action catalogs, limits and runtime evaluator. Optional terminal observation already exists; durable `onFinally` recovery requires a different delivery contract and remains deferred.

The new inferred event is:

```ts
{
  stage: 'beforeModelCall',
  purpose: 'primary',
  modelId: string,
  request: Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>>,
}
```

The request projection is deeply immutable and matches those fields on the prospective adapter request. It includes admitted history and model-visible tool metadata, not instructions, private continuation, credentials, model executors, signal, account or grants. It is a content projection, **not a guarantee of inspecting every provider-bound byte**. Do not expose the mutable original transcript or insert action results. Consumers wanting to inspect private instructions must supply their own trusted policy configuration instead of gaining it from this callback.

`context.step` is the actual zero-based primary reasoning step. Stage/purpose identify this as a primary request. Runtime-generated hook invocation identity remains separate from actual model-call counters, which include auxiliary calls. No new model-call ID claim is introduced.

## Admission and accounting

1. Complete agent input admission and before-execution hooks as before.
2. On each primary iteration, verify model grant, assemble/bound/freeze the full existing model request and atomically reserve the primary plus required output-check bundle.
3. Run matching before-model hooks in registration order, **before acquiring the primary executor permit**. Retain its financial/model holds while hook actions compete for remaining shared capacity.
4. If the hook continues, recheck cancellation and use the same reserved primary ticket at the original model admission point. No callback changes primary arguments, adapter, max tokens, authority or original holds.
5. If any hook fails, cancel only never-dispatched primary/check holds. Preserve completed action charges, started unknown reservations, truthful receipts and actual callback permits.

Hook actions retain existing read/pure-only, non-composed, required-success semantics and agent output checks. Their results are not fed into the primary request or callback. Auxiliary moderation never invokes before-model hooks, including checks triggered by a hook action; this deliberate non-recursive profile prevents policy recursion and preserves one-slot progress. It does not mean auxiliary checks are exempt from grants, budgets or local egress screening.

Reuse actual-lifetime callback admission, bounded whole-hook deadlines, ancestor `maxHookCalls`, model/tool counters, immutable result admission and sanitized errors. Local before-model callbacks do not consume primary steps, model calls or inferred cost; requested actions/checks do. Shared hook definitions obtain the actual root/child authority on every invocation. No retries or durable delivery are added.

## Compatibility and qualification

Expand factory and type unions, client/observer exact stage allowlists and packed positive/negative inference fixtures together. `hook.started/completed` metadata remains unchanged apart from accepting the new stage. Requests/candidates remain excluded from events and observation. Other control-stage behavior and existing no-hook agents must remain compatible.

Fail-first evidence must cover every primary iteration (including newly admitted tool history), prior input denial, deeply immutable exact projections, excluded instructions/continuation, block/malformed/unavailable/timeout with zero primary dispatch, protected primary/output-check money and model slots, child ceilings, non-recursive auxiliary checks, one-permit progress, callback lifetime after timeout, no late actions, and unknown action receipts/late cost without downgrading outcomes. Full regression, source/strict packed types, installed observer interoperability and credential-free examples remain required before this slice is called verified.
