# @mayura/provider-anthropic

Explicit Anthropic Messages adapter for Mayura. It uses the fixed Anthropic API destination, never discovers ambient credentials, disables streaming, exposes only caller-declared client tools, requires strict portable JSON Schemas, and accounts for ordinary plus cache creation/read input tokens before accepting model output.

The adapter intentionally does not enable provider-hosted tools, prompt caching, extended thinking, containers, remote MCP servers, retries, or redirects. Applications must select those capabilities through separate reviewed policies and adapters.

The wire contract follows Anthropic's official [Messages API](https://platform.claude.com/docs/en/api/messages/create), [HTTP API](https://platform.claude.com/docs/en/api/http/messages), and [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) documentation.
