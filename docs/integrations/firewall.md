---
title: "Firewall for Agents (Dvar)"
description: "Deterministic Dvar policy for Mayura agent tool calls, with outcome accounting and optional output redaction."
package: "@mayurajs/firewall"
vendor: "Rokad"
website: "https://github.com/rokadhq/dvar"
area: "security"
---

**Firewall for Agents** is a Mayura extension powered by [Dvar](https://github.com/rokadhq/dvar).
Mayura retains its own verified scopes, permissions, budgets, schemas and outcome semantics.
Dvar provides an additional deterministic policy decision, bounded approvals and runtime limits.

## Install

```bash
npm install mayura @mayurajs/firewall @rokadhq/dvar@alpha
```

## Protect an agent

```js
import { defineAgent, defineTool, z } from 'mayura';
import { createAgentFirewall } from '@mayurajs/firewall';
import { createDvar } from '@rokadhq/dvar';
import { createOutputGuard } from '@rokadhq/dvar/output-guard';

const dvar = await createDvar({ policyPath: 'dvar.yaml' });
const order = defineTool({
  id: 'orders.read', version: '1', description: 'Read an order.',
  input: z.object({ id: z.string() }), output: z.object({ id: z.string() }),
  effects: 'read', capabilities: ['orders:read'],
  execute: async ({ id }) => ({ id })
});
const firewall = createAgentFirewall({
  dvar, environment: 'production', tools: [order],
  outputFilter: createOutputGuard({ policy: { maxBytes: 64000, redactBuiltInSecrets: true } })
});
const agent = defineAgent({
  id: 'orders-agent', version: '1', instructions: 'Read orders.',
  model, tools: [order], input: z.string(), output: z.string(),
  hooks: firewall.hooks,
  guards: { output: firewall.outputGuard ? [firewall.outputGuard] : [] }
});
```

Dvar authorization runs before each model-proposed tool execution. The mandatory post-tool observer
reports real outcomes to Dvar's circuit-breaker bookkeeping. An optional output guard delegates
redaction/blocking to Dvar, then Mayura revalidates rewritten output.

## Security boundaries

- A Dvar `require_approval` blocks the run unless a previously issued signed grant is supplied via
  `approvalGrant`. The extension never auto-approves.
- The `beforeToolCall` hook receives the **raw model proposal**, before Mayura's schema transformations.
  Use Mayura's tool input guards if a rule must inspect validated executor input.
- The hooks protect only agents that attach them; they do not intercept standalone `invokeTool()`
  or workflow steps. Disconnected/unwrapped execution paths bypass the firewall.
- Mayura's existing permission and budget enforcement remains mandatory.
- Dvar may reserve quota for a proposal that Mayura subsequently rejects before dispatch.
- Dvar's current Node-specific runtime makes this a Node.js integration, not an Edge adapter.
