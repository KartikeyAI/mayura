# Provider-neutral credential store

Status: implemented provider contract and use-scoped broker. Concrete cloud/KMS/Vault adapters remain application or optional-package work.

`@mayura/helpers` exports opaque `SecretReference` values, `defineCredentialProvider` and `createCredentialBroker`. A reference contains only provider, key and optional version identity. A provider resolver remains private to its package instance and receives only the selected key/version plus cancellation. Imports and construction perform no I/O and the broker never reads environment variables, files or platform credential stores.

## Use scope and lifecycle

Resolution occurs only inside `broker.use(reference, signal, callback)`. The provider transfers ownership of a bounded `Uint8Array`; the broker copies it, zeroes the provider buffer, passes the copy to the trusted callback and zeroes that copy when the callback actually settles. Version mismatch, expiry, malformed material and provider failure fail closed with safe errors. JavaScript cannot guarantee erasure of copies made by a provider, callback, engine or operating system, so zeroing is defense in depth rather than a hardware-backed destruction claim.

There is no cache, refresh loop, retry, persistence, serialization, logging, inspection value or ambient discovery. Inspection exposes only sorted provider IDs and capacity counters. Callers must not return, log or persist the credential buffer and must use provider SDKs/transports that do not reflect request headers in errors.

## Capacity and cancellation

Broker-wide concurrency and timeout limits are explicit. External cancellation or timeout withholds the callback result and aborts the derived signal. A non-cooperative resolver or consumer retains its capacity slot until it really settles; repeated timeouts cannot create unbounded hidden work. Provider resolution errors are sanitized as unavailability and consumer exceptions as execution failure.

Focused tests cover genuine registration, explicit reference routing, version/expiry integrity, safe failures, ownership transfer, post-settlement zeroing and retained admission after timeout. The isolated packed helper consumer proves the API installs with only `@mayura/core` and performs no network or storage access.
