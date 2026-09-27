# mayura/server-node

Optional loopback-only Hono/Node host adapter for authenticated ephemeral agents and application-provided human/workflow transports. Uses the same server protocol and browser client; does not expose an unauthenticated local API or bind a public interface. Local HTTP is limited to literal loopback. Production TLS/reverse-proxy/durable-worker serving requires a separate qualified deployment profile.
