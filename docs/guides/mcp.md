---
title: "MCP tools"
description: "Wrap one operation of a Model Context Protocol server as a Mayura tool, with the effects, permissions and cost you declare."
---

The Model Context Protocol (MCP) is a standard way for servers to offer tools to AI applications. `mayura/adapter-mcp`
turns one tool of an MCP server into an ordinary Mayura tool, so an agent can call it under the same permission,
validation, guard, budget and timeout checks as your own tools.

Mayura does not connect to MCP servers itself, discover their tools or read their descriptions of what a tool does.
You connect with an MCP client of your choice, pick each remote tool you want, and declare what it is allowed to do.

```ts
import { createRuntime, defineAgent } from 'mayura';
import { defineMcpTool } from 'mayura/adapter-mcp';
import { z } from 'zod';

const IssueInput = z.object({ title: z.string().max(200), body: z.string().max(10_000) });
const IssueOutput = z.object({ number: z.number().int(), url: z.string() });

const createIssue = defineMcpTool({
  id: 'tracker.create_issue',
  version: '1',
  description: 'Create an issue in the team tracker.',
  remoteName: 'create_issue',  // the tool's name on the MCP server
  input: IssueInput,
  output: IssueOutput,
  inputJsonSchema: jsonSchema(IssueInput),
  effects: 'write',
  capabilities: ['tracker:write'],
  timeoutMs: 15_000,
  client: {
    // `mcp` is a connected client from an MCP SDK, for example the official TypeScript SDK's Client.
    callTool: ({ name, arguments: args, signal }) => mcp.callTool({ name, arguments: args }, undefined, { signal }),
  },
});

const agent = defineAgent({
  id: 'triage', version: '1', instructions: 'File an issue for each bug report.',
  model, tools: [createIssue], input, output,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:tracker.create_issue', 'tracker:write', 'effect:write'] },
  limits: { maxCostMicros: 100_000 },
});
```

`jsonSchema` is the Zod-to-JSON-Schema helper from [Model providers](model-providers.md).

## What you declare

`defineMcpTool` takes the same options as `defineTool`, minus `execute`, plus `remoteName` and `client`:

| Option | Meaning |
|---|---|
| `id`, `version`, `description` | The Mayura tool. The model reads `description`, so write your own; the server's is not used. |
| `remoteName` | The tool's name on the MCP server (letters, digits and `._/-`, up to 128 characters). |
| `input`, `output` | Validators for the arguments and the result. The input must be a JSON object. |
| `inputJsonSchema` | The input's JSON Schema, which model providers need for every tool. |
| `effects` | `none`, `read`, `write` or `host`: what calling this tool can change. |
| `capabilities` | Extra permission strings the runtime must grant, such as `tracker:write`. |
| `client` | An object with a `callTool(request)` method (below). |
| `timeoutMs`, `costMicros` | Deadline (default 30,000) and the most one call may cost (default 0). |

Nothing is taken from the server: not the effects, not the cost, not the schema. Declare them from what you know the
remote tool does. To call a tool, the runtime must grant `tool:<id>`, every capability, and `effect:<effects>` unless
the effects are `none`. See [Permissions](../concepts/permissions.md).

## The client

`client` is any object with a `callTool` method. Mayura calls it with a frozen request:

```ts
import type { McpClient } from 'mayura/adapter-mcp';

const client: McpClient = {
  async callTool({ name, arguments: args, signal }) {
    // Send an MCP tools/call request for `name` with `args`, and stop when `signal` aborts.
    return await mcp.callTool({ name, arguments: args }, undefined, { signal });
  },
};
```

Connecting, authenticating and closing the MCP session are up to you and your MCP client. Mayura only calls
`callTool`, and only after the runtime's checks allowed the call and the input passed its validator.

## What the server must return

`callTool` must resolve to the MCP tool result: an object with `structuredContent`, and optionally `content`,
`isError` and `_meta`. Mayura validates `structuredContent` with your `output` schema and hands that to the agent.

The call fails when:

- the result has no `structuredContent` (text-only results are not parsed into data); MCP tools that declare an
  output schema return structured content;
- `isError` is `true`;
- the result has any other top-level key, or is larger than 1 MiB;
- `callTool` throws, or the timeout passes.

Error details from the server or the transport never reach the model, events or outcomes. `_meta` is accepted and
dropped.

## When a call fails

For a tool with effects other than `none`, a failure after the request was sent means Mayura cannot know whether the
server acted. The run ends `outcome_unknown`, and you should check the remote system before retrying. This includes a
result with `isError: true`, because the server may have done part of the work. For a tool with effects `none`, the run
ends `failed`. See [Outcomes](../concepts/outcomes.md).

## Good to know

- Wrap only the remote tools the agent needs, one `defineMcpTool` each. There is no way to expose a whole server at
  once.
- An MCP server is someone else's code. Its results pass your `output` schema and the agent's output guards before the
  model sees them; add [guardrails](guardrails.md) if a server may return text you would not show a model.
- Server-side tool lists and descriptions can change. Because you declare each tool, a change on the server does not
  change what your agent is allowed to do.

## Related

- [Tools](../concepts/tools.md)
- [Permissions](../concepts/permissions.md)
- [Outcomes](../concepts/outcomes.md)
- [Guardrails](guardrails.md)
- [Model providers](model-providers.md)
