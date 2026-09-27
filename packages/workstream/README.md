# mayura/workstream

Optional finite, durable coordination primitives for Mayura applications. Development preview; not enterprise-qualified or published.

The root export provides scoped signal-based WorkStreams. The separate `mayura/workstream/executions` export provides metadata-only `all` joins over already-submitted scheduled workflow references:

```ts
import { createExecutionWorkStream } from 'mayura/workstream/executions';

const target = await worker.reference(run.id);
const stream = createExecutionWorkStream({
  store, scope, policyHash: target.policyHash, streamId: 'release-joins',
});
await stream.initialize();
await stream.register({ id: 'release', targets: [target] });
await stream.drainReady({ limit: 16 });
const result = await stream.inspect('release');
await stream.close();
```

`mayura/workstream/humans` adds finite durable typed information, correction and plan-selection requests. It persists exact digest-bound request metadata, authorizes an authenticated actor through an application callback, validates the response with Standard Schema and resolves one deterministic response signal across retries/restarts. Corrections bind a subject digest and never rewrite or authorize the reviewed action.

`mayura/workstream/timers` adds finite durable absolute-time records. Applications run explicit bounded sweeps; one compare-and-set transition settles firing versus cancellation, and no live timeout or worker is retained between calls. A fired timer is readiness evidence only, never execution authority.

`mayura/workstream/webhooks` adds HMAC-SHA256 authenticated JSON ingress with an explicit replay window, Standard Schema validation, durable delivery deduplication and conservative `outcome_unknown` recovery. Trigger definitions bind explicit schema identity. Retries may use a fresh timestamp/signature, but changing the raw body under the same trigger/delivery identity is a conflict. It is a transport-neutral primitive: HTTPS routing, authorization, provider-specific signature formats, secret rotation and recovery scanning remain application responsibilities.

The application supplies initialized storage, verified scope and a pinned policy. References are data, not authorization capabilities. Closing a facade does not close application-owned storage or cancel persisted work. Applications explicitly invoke finite drains; no worker slot, polling loop or per-wait promise survives a command.

A resolved join means every target is terminal, not necessarily successful. Inspect each observation's `outcome`; `outcome_unknown` stays unknown. Results contain no workflow output, input, receipts or errors. Read authorized source evidence separately. These exports do not add workflow graph suspension, durable child orchestration, background timers or notifications.

The package depends only on core and driver-free storage contracts. Select `mayura/storage-sqlite` or `mayura/storage-postgres` for one reference driver. The compatibility `mayura/storage` package intentionally installs both; a custom adapter does not require either driver. The complete checkout includes Markdown guides, shared real-database conformance tests and a credential-free close/reopen example.
