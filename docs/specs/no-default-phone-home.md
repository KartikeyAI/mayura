# No-default-phone-home boundary

Status: local import/source qualification; not a complete supply-chain or deployment audit.

Mayura's default and local-only packages must not open network connections, call global transports, or discover ambient credentials merely because they are installed or imported. Provider, client, server and selected remote-storage packages are explicit opt-ins and are outside this local-only set; their network behavior remains governed by their own configuration contracts.

The executable check imports sixteen compiled local-only package entry points after replacing common Fetch, WebSocket, HTTP(S), TCP/TLS, datagram and DNS entry points with recording denials, then observes a bounded quiet period. A companion source check rejects imports of those network modules, direct global Fetch/WebSocket/EventSource calls, and ambient environment lookups whose key name indicates a token, key, secret, password or credential. The package list includes the base SDK closure, workflows, WorkStream, storage contracts, memory/context, guardrails, observability and both Code Mode adapters.

This is defense in depth, not proof against intentionally obfuscated trusted code, native dependency behavior after explicit construction, application callbacks, delayed work beyond the observation interval or operating-system compromise. Packed offline-install checks separately prove that package installation scripts and registry access are disabled in the consumer fixtures. Explicitly configured providers/exporters/tools may use the network only within their documented authority.
