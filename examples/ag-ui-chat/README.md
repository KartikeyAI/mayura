# AG-UI notebook

Offline deterministic model, SQLite thread history, exact approval of an idempotent note write, shared state,
guarded text and a permissioned browser tool. Native checkpoints and a shared durable frontend journal are enabled.
No inference service, paid model call or provider credential is used. Bind only to loopback.

From the repository root, after the deferred build/dependency work:

```sh
node examples/ag-ui-chat/server.mjs
```

Open the displayed address, enter a note, review/approve its exact tool request, then click **Deliver saved browser
result**. This second button submits the retained result; it never invokes the browser handler again. The native
budget and thread association continue through both interruptions. SQLite and the interrupt key are retained under
`.data/ag-ui-chat`; credentials for the local browser expire after one hour and never appear in the URL or console.
For process-loss recovery, select the same fixed loopback port with MAYURA_AG_UI_PORT and keep the data directory,
interrupt key and page open. The local credential is domain-separated from the persisted key and survives restart;
run/claim expiries still apply. Abrupt owner loss can retain parked native checkpoints and durable outboxes; orderly
shutdown can cancel an active wait. Deliver the retained browser result to exercise native-owner recovery. Lost browser state after a claimed effect remains reconciliation-only; no handler or
uncertain paid work is replayed. This example does not claim general recovery of in-flight operations.

The model has explicit zero-cost limits and a read-only browser theme selection. Notes use an effect-local idempotency
key; approval ownership alone cannot make arbitrary external writes exactly once. Shared state is a static fixture.
The host serves only same-origin/local assets and credential configuration; it is not a production login system.

`sdk-conformance.mjs` is an opt-in reference `HttpAgent` harness requiring installed `@ag-ui/client`/`@ag-ui/core`
versions compatible with the documented AG-UI 1.0 profile. Supply the demo endpoint/key through explicit environment
variables, never real credentials. Tests, builds, SDK conformance and all validation remain deferred: neither this
example nor the harness has been run in this development slice.
