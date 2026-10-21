# @mayurajs/authz-cedar

Local native Cedar authorization through Mayura's core policy, enforcement and audit contract. The host supplies
an initialized evaluator; this extension has no SDK/WASM loader, environment credentials or infrastructure dependency.

See [the integration guide](../../docs/integrations/authz-cedar.md) for setup, scoped identity mapping, policy/schema
configuration, trusted attributes, bounds, server wiring and lifecycle ownership.

## Native engine bridge

Install and pin `@cedar-policy/cedar-wasm` in the host application and use its runtime-appropriate entry point.
For example, after initializing that module, wrap its exported `isAuthorized` function:

```ts
import type { CedarAuthorizationEvaluator } from '@mayurajs/authz-cedar';
// isAuthorized is the initialized native cedar-wasm export owned by the host.
const evaluate: CedarAuthorizationEvaluator = (call, { signal }) => {
  if (signal.aborted) throw new Error('Cancelled');
  // JSON conversion supplies native mutable FFI values from the adapter's bounded readonly API.
  return isAuthorized(JSON.parse(JSON.stringify(call)));
};
```

Preserve the complete native result. Do not replace diagnostics with a boolean or omit errors accompanying an allow.
The adapter supports the stateless native FFI, named static policies, Cedar schema source and literal attributes;
entity hierarchies, extension values, template links and Amazon Verified Permissions are not included in this slice.
Use a host worker when hard CPU/memory termination is needed; synchronous WASM cannot be preempted by JS timers.

## Primary references

Reviewed 2026-10-20; no real engine invocation or validation has been performed in this development slice.

- [Official Cedar stateless authorization FFI](https://github.com/cedar-policy/cedar/blob/main/cedar-policy/src/ffi/is_authorized.rs)
- [Official policy set, schema and entity FFI representations](https://github.com/cedar-policy/cedar/blob/main/cedar-policy/src/ffi/utils.rs)
- [Official Cedar WASM export](https://github.com/cedar-policy/cedar/blob/main/cedar-wasm/src/lib.rs)
- [Cedar authorization semantics and error handling](https://docs.cedarpolicy.com/auth/authorization.html)

Offline regression tests are authored. Tests and all validation remain deferred.
