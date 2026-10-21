# mayura/provider-anthropic

Explicit Anthropic Messages adapter for Mayura. It uses the fixed Anthropic API destination, never discovers ambient credentials, streams final answers for agents with a stream policy, exposes only caller-declared client tools (under their own ids, made safe for the API), requires strict portable JSON Schemas (generated from the agent's validators unless you give one), and accounts for ordinary plus cache creation/read input tokens before accepting model output.

It takes a conversation history (`capabilities.history`) and sends it before the run's own messages on every call: earlier tool calls and results as `tool_use` and `tool_result` blocks (as JSON text when the run offers no tools, since Anthropic refuses tool blocks then), and an earlier final answer as assistant text holding its JSON. A history call id with characters Anthropic refuses gets a safe stand-in.

The adapter intentionally does not enable provider-hosted tools, prompt caching, extended thinking, containers, remote MCP servers, retries, or redirects. Applications must select those capabilities through separate reviewed policies and adapters.

The wire contract follows Anthropic's official [Messages API](https://platform.claude.com/docs/en/api/messages/create), [HTTP API](https://platform.claude.com/docs/en/api/http/messages), and [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) documentation.
