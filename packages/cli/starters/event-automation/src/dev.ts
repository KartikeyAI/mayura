import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { devSecrets, tokenDigest } from './auth.js';
import { loadConfig } from './config.js';
import { startServer } from './server.js';
import { openServices } from './services.js';
import { sendDelivery } from './signing.js';
import { startTrackerMcpServer } from './tracker/mcp-server.js';
import { sampleTickets, ticketCreatedEvent, type SampleName } from './tracker/samples.js';
import { memoryTracker } from './tracker/tickets.js';
import { createTicketWorker } from './worker.js';

// Local development in one process: the local tracker (an MCP server on an ephemeral port), the Mayura server, the
// webhook ingress and a worker, on SQLite, with an operator token and webhook secret kept in .data/dev-secrets.json across restarts.
// Production runs `npm run serve` and `npm run worker` as separate processes against your real tracker (see README).
const { operatorToken, webhookSecret, trackerToken } = await devSecrets(['operatorToken', 'webhookSecret', 'trackerToken']);
const tickets = memoryTracker(Object.values(sampleTickets));
const tracker = await startTrackerMcpServer({ tracker: tickets, port: 0, token: trackerToken });
const config = await loadConfig({ ...process.env, MAYURA_ENV: 'development', MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken),
  WEBHOOK_SECRET: webhookSecret, TRACKER_MCP_URL: tracker.url, TRACKER_MCP_TOKEN: trackerToken });
const services = await openServices(config);
const server = await startServer(config, services);
const { worker } = createTicketWorker(config, services); worker.start();

// `npm run send-sample` reads the URL and secret from here, so it needs no arguments. Development only.
const devFile = resolve('.data/dev-webhook.json');
await mkdir(dirname(devFile), { recursive: true });
await writeFile(devFile, `${JSON.stringify({ url: server.webhookUrl, secret: webhookSecret }, null, 2)}\n`, { mode: 0o600 });

// Demo data: three signed deliveries, as the tracker would send them. Fixed delivery ids mean a restart repeats the
// same deliveries, which the durable delivery record recognises: no second run starts.
const delivered: Record<string, unknown> = {};
for (const name of ['billing', 'docs', 'outage'] as const satisfies readonly SampleName[]) {
  const { status, body } = await sendDelivery(server.webhookUrl, webhookSecret, { deliveryId: `dev-${sampleTickets[name].id}`, event: ticketCreatedEvent(name) });
  delivered[name] = { ticket: sampleTickets[name].id, http: status, response: body };
}

console.log(JSON.stringify({
  console: `${server.origin}/inspector`,
  operatorToken,
  webhookUrl: server.webhookUrl,
  webhookSecret,
  trackerMcp: tracker.url,
  delivered,
  sendSample: 'npm run send-sample -- outage        (in another terminal; also: billing, docs, feature, --stale, --forged, --delivery <id>)',
  next: 'Open the console, paste the operator token, open Workflows. T-1001 (outage) waits for approval to assign it to on-call.',
}, null, 2));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) process.exit(1); stopping = true;
  await worker.drain({ timeoutMs: 10_000 }); await server.close(); await services.close(); await tracker.close();
};
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
