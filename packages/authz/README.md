# mayura/authz

Built-in role-based access control over Mayura's infrastructure-free authorization contract.

`createRbacPolicy` compiles immutable versioned roles, inheritance, explicit allow/deny rules and exact principal/project
bindings. `createRbacAuthorizer` adds the core fail-closed boundary: explicit `authz:evaluate`, verified scope isolation,
request snapshots, cancellation, deadlines and bounded concurrent policy work. Deny overrides every allow. Unknown
memberships/actions/resources deny. Resource wildcard IDs remain scoped, and optional ownership conditions use trusted
stored metadata. No role is administrative by default, and model-supplied role claims are never accepted.

The host explicitly calls `authorize` or `require` before an operation, alongside existing capabilities and run grants.
The server can opt into HTTP enforcement with its `authorization` option and a compiled RBAC policy. The policy
package itself introduces no database, network, provider or UI dependency.
Use a new policy version/authorizer for updates, and close the old one. Decisions expose fixed reasons and rule/version
IDs for host-owned auditing without exposing provider diagnostics.

See [Fine-grained authorization](../../docs/guides/authorization.md) for the contract, limits, examples and integration.

Optional `audit` settings forward to the core authorizer, require `authz:audit`, and isolate bounded decision receipt
delivery from access decisions. Inspect `auditSnapshot()` and drain `flushAudit()` before closing. The application can
attach `createOpenTelemetryAuthorization(...).sink` from `mayura/exporter-otlp/opentelemetry` without adding telemetry
dependencies to RBAC or core.
