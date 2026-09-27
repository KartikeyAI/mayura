import { z } from 'zod';
import { startTrackerMcpServer } from './mcp-server.js';
import { sampleTickets } from './samples.js';
import { memoryTracker } from './tickets.js';

// `npm run tracker`: the local stand-in tracker on its own, for running `npm run serve` and `npm run worker` as
// separate processes on your machine. State is in memory and starts with the sample tickets. Not for production.
const settings = z.object({
  port: z.coerce.number().int().min(0).max(65_535).default(8090),
  token: z.string().min(1).max(4_096).optional(),
}).parse({ port: process.env['TRACKER_PORT'], token: process.env['TRACKER_MCP_TOKEN'] });

const tracker = memoryTracker(Object.values(sampleTickets));
const server = await startTrackerMcpServer({ tracker, port: settings.port, ...(settings.token ? { token: settings.token } : {}) });
console.log(JSON.stringify({ event: 'tracker-listening', mcp: server.url, tickets: Object.values(sampleTickets).map(ticket => ticket.id) }));

const stop = (): void => { void server.close().then(() => process.exit(0)); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
