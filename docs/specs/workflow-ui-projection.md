# Durable workflow UI projection

Status: implemented experimental browser projection for durable workflow formats 2, 3, 4 and 5. It is a content-free view contract, not a workflow transport or execution authority.

`@mayura/client/workflows` accepts one deeply immutable `WorkflowViewInput` produced by a trusted application adapter from a matched, already validated durable manifest and snapshot. The input contains only definition/run identity, revision, run status, node kinds/dependencies, step statuses and optional required-child run identities. It contains no input, output, prompt, approval value, receipt, credential, policy or tool argument.

`createWorkflowGraphProjection()` rejects unknown/extra fields, mutable structures, invalid format/node combinations, duplicate or missing nodes, manifest/snapshot kind disagreement, dangling/duplicate/self edges, cycles, invalid child links, oversized graphs and incompatible human/timer statuses. Limits are 128 nodes, 127 dependencies per node and 512 total edges.

The result preserves manifest order and returns immutable nodes, stable topological depths, explicit edges, ready-state facts and aggregate progress. `ready` means only that a pending node's projected dependencies succeeded; it is not a scheduler readiness promise, permission, approval or command capability. Unknown and blocked states remain distinct.

The client does not accept raw storage records or infer topology from an event tail. The application adapter must authenticate and authorize the request, match the pinned manifest to the durable snapshot, convert exact current state into this content-free contract and freeze it before projection. This slice does not add HTTP routes, polling, mutation commands, nested child expansion, layout coordinates, rendered components or accessibility qualification.
