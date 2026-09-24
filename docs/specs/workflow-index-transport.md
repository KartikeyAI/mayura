# Authenticated durable workflow index

Status: implemented experimental content-free listing transport. Fetch facade, browser client, Node loopback host, CLI and isolated archive checks pass. The application adapter remains responsible for authoritative indexing, ordering, retention and authorization.

`GET /v1/workflow-runs?after=<opaque>&limit=<1..100>` requires a verified identity with `workflows:read`. The separate `workflowIndex.list` callback receives only verified scope, authorized agent IDs, one opaque cursor, the bounded requested limit and request cancellation. Credentials and raw HTTP objects never cross the adapter boundary.

Each exact summary contains only workflow format, definition identity/version, 64-hex run identity, positive revision and run status. Inputs, outputs, prompts, approvals, receipts, costs, credentials, tool arguments and private errors are outside the schema. The server rejects unknown fields, duplicate run identities, oversized pages, invalid or repeated cursors and hostile callback output before release.

Listing shares the workflow operation pool with inspection and mutation. A non-cooperative callback retains its slot until settlement; cancellation, callback exceptions and capability changes fail closed with sanitized errors. The browser and CLI read exactly one page and never follow a cursor automatically.

The cursor is adapter-owned and opaque. This contract does not claim a stable snapshot, total count, cross-page deduplication, global ordering, change stream, retention service, fleet health or that an absent/omitted run does not exist. Applications must filter every page by current scope and agent authority.
