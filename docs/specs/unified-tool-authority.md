# Unified tool authority

Status: V01 conformance contract.

Every supported invocation path ultimately submits a genuine `@mayura/tools` definition to the ordinary Mayura broker. A wrapper may narrow inherited authority, but it cannot add a missing grant, create an independent budget, bypass schemas or guards, or dispatch before admission.

The rule covers direct invocation, batches, delegated agents, workflow-as-tool composition, required hook actions, MCP client tools and Code Mode nested calls. These paths may add stricter preflight checks or orchestration constraints. Their shared policy decision for a tool is still based on the exact `tool:<id>`, declared capabilities and `effect:<category>` grants captured by the broker.

`@mayura/adapter-mcp` is the MCP client boundary. The application selects and authenticates the MCP client, then declares the remote operation's effects, capabilities and maximum cost. The adapter exposes only bounded structured results and never converts server text, discovery metadata or credentials into authority. A missing Mayura grant prevents the transport call entirely.

The deterministic V01 matrix removes the same `effect:read` grant from all seven paths. Every path reports `PERMISSION_DENIED`, the local executor is never called, and the MCP transport is never called. Code Mode's test adapter observes the broker outcome through its mediated nested bridge. This proves equivalence for the finite policy scenario; it does not claim that all wrapper-specific lifecycle behavior is identical.
