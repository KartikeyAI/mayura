# `@mayura/adapter-mcp`

Wraps an application-selected MCP `tools/call` transport as a genuine Mayura tool. The adapter never discovers servers, credentials, effects, capabilities, or costs. Applications declare those values and own transport authentication and lifecycle.

The ordinary Mayura broker remains the sole authority: permission, schema, guard, budget, timeout and receipt checks happen before and around the MCP call. A response must be bounded JSON with a non-error `structuredContent` field; text content is not parsed into authority-bearing data. Transport errors and remote error bodies are sanitized by the broker.

This package is a client adapter seam, not an MCP session implementation. Use a maintained MCP client to implement `McpClient`, and pass its bounded `callTool` method explicitly.
