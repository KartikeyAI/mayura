import { z } from 'mayura';

// The ticket tracker's own model. In a real deployment this lives in your tracker (Jira, Linear, Zendesk, GitHub
// Issues...) and Mayura reaches it only through that tracker's MCP server. The in-memory tracker below backs the
// local MCP server in `mcp-server.ts` so the starter runs offline.

export const ticketId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
export const label = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,31}$/u);
export const assignee = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u);

export interface Ticket {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly reporter: string;
  readonly labels: readonly string[];
  readonly comments: readonly { readonly id: string; readonly body: string }[];
  readonly assignee: string | null;
}

/** What the tracker's MCP tools do. Every operation names one existing ticket. */
export interface TicketTracker {
  get(ticketId: string): Promise<Ticket | undefined>;
  /** Adds labels (a set: adding one twice keeps one) and returns the ticket's labels afterwards. */
  addLabels(ticketId: string, labels: readonly string[]): Promise<readonly string[]>;
  /** Adds a comment and returns its id. */
  addComment(ticketId: string, body: string): Promise<string>;
  assign(ticketId: string, assignee: string): Promise<void>;
}

export class TicketNotFound extends Error { constructor() { super('Ticket not found.'); } }

/** An in-memory tracker with an operation log, so tests and the dev run can see exactly what the agent changed. */
export function memoryTracker(seed: readonly Pick<Ticket, 'id' | 'title' | 'body' | 'reporter'>[]) {
  const tickets = new Map<string, { id: string; title: string; body: string; reporter: string; labels: string[]; comments: { id: string; body: string }[]; assignee: string | null }>();
  for (const ticket of seed) tickets.set(ticket.id, { ...ticket, labels: [], comments: [], assignee: null });
  const operations: { readonly operation: 'label' | 'comment' | 'assign'; readonly ticketId: string }[] = [];
  const find = (id: string) => { const ticket = tickets.get(id); if (!ticket) throw new TicketNotFound(); return ticket; };
  const tracker: TicketTracker & { operations(): readonly { readonly operation: string; readonly ticketId: string }[] } = {
    get: async id => { const ticket = tickets.get(id); return ticket ? structuredClone(ticket) : undefined; },
    addLabels: async (id, labels) => {
      const ticket = find(id); operations.push({ operation: 'label', ticketId: id });
      for (const value of labels) if (!ticket.labels.includes(value)) ticket.labels.push(value);
      return [...ticket.labels];
    },
    addComment: async (id, body) => {
      const ticket = find(id); operations.push({ operation: 'comment', ticketId: id });
      const comment = { id: `${id}-c${ticket.comments.length + 1}`, body }; ticket.comments.push(comment); return comment.id;
    },
    assign: async (id, to) => { const ticket = find(id); operations.push({ operation: 'assign', ticketId: id }); ticket.assignee = to; },
    operations: () => [...operations],
  };
  return tracker;
}
