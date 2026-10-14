# Firewall for Agents · Mayura

`@mayurajs/firewall` connects Mayura agent lifecycle hooks and output guards to Dvar's deterministic agent-action policy engine.

- Mayura continues to enforce tool permissions, budgets, schemas and outcomes.
- Dvar evaluates the proposed tool action, applies configured approval/runtime controls, and emits its audit events.
- Tool outputs can be redacted or blocked using the Dvar output guard.

Install `mayura` and `@mayurajs/firewall`. The firewall package installs `@rokadhq/dvar` automatically and re-exports `createDvar` and `createOutputGuard` for consumers. Dvar is supplied explicitly—there is no hidden cloud service or second policy engine.

See `docs/integrations/firewall.md` for a complete example.

**Limits:** `beforeToolCall` receives the raw model proposal, not schema-transformed input. Only agents with these hooks are protected, not separate direct `invokeTool` or workflow calls. A `require_approval` decision blocks the current run unless an existing grant is supplied via `approvalGrant`. Process-local correlation is not durable; use Dvar's shared state for distributed quota and replay semantics. Dvar's Node-specific package means this integration targets Mayura's supported Node.js runtimes; it is not an Edge adapter.
