import { defineMcpTool, type McpClient } from 'mayura/adapter-mcp';
import { z } from 'mayura';
import { jsonSchema } from './model.js';
import { assignee, label, ticketId } from './tracker/tickets.js';

/**
 * The tracker's MCP operations as Mayura tools. Each one names the remote MCP tool it calls, validates its input and
 * output with a schema, and declares the capability a caller must be granted to use it:
 *
 *   tickets.label    -> label_ticket       tickets:write
 *   tickets.comment  -> comment_on_ticket  tickets:write
 *   tickets.assign   -> assign_ticket      tickets:assign
 *
 * The broker checks the grant before the MCP request is sent, so a tool without its grant never reaches the tracker.
 * Only operations wrapped here are reachable; anything else the MCP server offers stays out of reach.
 */
export function trackerTools(client: McpClient) {
  const labelInput = z.strictObject({ ticketId, labels: z.array(label).min(1).max(8) });
  const commentInput = z.strictObject({ ticketId, body: z.string().min(1).max(2_000) });
  const assignInput = z.strictObject({ ticketId, assignee });
  const label_ = defineMcpTool({
    id: 'tickets.label', version: '1', remoteName: 'label_ticket', client, effects: 'write', capabilities: ['tickets:write'],
    description: 'Add labels to a ticket. Existing labels are kept.',
    input: labelInput, inputJsonSchema: jsonSchema(labelInput), output: z.strictObject({ ticketId, labels: z.array(label).max(64) }), timeoutMs: 10_000,
  });
  const comment = defineMcpTool({
    id: 'tickets.comment', version: '1', remoteName: 'comment_on_ticket', client, effects: 'write', capabilities: ['tickets:write'],
    description: 'Post a comment on a ticket. The reporter can see it.',
    input: commentInput, inputJsonSchema: jsonSchema(commentInput), output: z.strictObject({ ticketId, commentId: z.string().max(128) }), timeoutMs: 10_000,
  });
  const assign = defineMcpTool({
    id: 'tickets.assign', version: '1', remoteName: 'assign_ticket', client, effects: 'write', capabilities: ['tickets:assign'],
    description: 'Assign a ticket to a person or rotation.',
    input: assignInput, inputJsonSchema: jsonSchema(assignInput), output: z.strictObject({ ticketId, assignee }), timeoutMs: 10_000,
  });
  return { label: label_, comment, assign } as const;
}
export type TrackerTools = ReturnType<typeof trackerTools>;
