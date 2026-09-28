import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createClient } from 'mayura/client';
import { newToken, tokenDigest } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { mcpHttpClient } from '../src/mcp.js';
import { startServer } from '../src/server.js';
import { openServices } from '../src/services.js';
import { sendDelivery, signDelivery, webhookHeaders } from '../src/signing.js';
import { startTrackerMcpServer } from '../src/tracker/mcp-server.js';
import { sampleTickets, ticketCreatedEvent, type SampleName } from '../src/tracker/samples.js';
import { memoryTracker } from '../src/tracker/tickets.js';
import type { TriageOutput } from '../src/triage.js';
import { createTicketWorker } from '../src/worker.js';

// Everything runs offline over real HTTP: the local tracker's MCP server, the Mayura server, the webhook ingress, the
// rule-based triage model and SQLite in a temporary directory.
async function harness(options: { readonly revoke?: readonly string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tickets-test-'));
  const operatorToken = newToken(); const secret = newToken(); const trackerToken = newToken();
  const tickets = memoryTracker(Object.values(sampleTickets));
  const tracker = await startTrackerMcpServer({ tracker: tickets, port: 0, token: trackerToken });
  const config = await loadConfig({ MAYURA_ENV: 'development', PORT: '0', WEBHOOK_PORT: '0', MAYURA_SQLITE_PATH: join(directory, 'tickets.sqlite'),
    MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken), WEBHOOK_SECRET: secret, TRACKER_MCP_URL: tracker.url, TRACKER_MCP_TOKEN: trackerToken });
  const services = await openServices(config, options.revoke ? { revoke: options.revoke } : {});
  const server = await startServer(config, services);
  // Tests drive the worker one cycle at a time instead of starting its timer.
  const { host } = createTicketWorker(config, services);
  const operator = createClient({ baseUrl: server.origin, token: () => operatorToken });
  const deliver = (name: SampleName, overrides: { readonly deliveryId?: string; readonly timestampMs?: number; readonly secret?: string; readonly event?: unknown } = {}) =>
    sendDelivery(server.webhookUrl, overrides.secret ?? secret, { deliveryId: overrides.deliveryId ?? `delivery-${name}`,
      event: overrides.event ?? ticketCreatedEvent(name), ...(overrides.timestampMs === undefined ? {} : { timestampMs: overrides.timestampMs }) });
  /** Run worker cycles until the run leaves `running`. */
  const settle = async (runId: string) => {
    for (let cycle = 0; cycle < 8; cycle++) { await host.runOnce(); const view = await operator.workflow(runId); if (view.status !== 'running') return view; }
    throw new Error('The run did not settle.');
  };
  return { config, services, host, operator, tickets, tracker, trackerToken, deliver, settle, server,
    close: async () => { await host.close(); await server.close(); await services.close(); await tracker.close(); await rm(directory, { recursive: true, force: true }); } };
}
const runIdOf = (reply: { readonly body: unknown }): string => (reply.body as { readonly runId: string }).runId;

describe('ticket automation', () => {
  it('turns one signed delivery into one durable run in which the agent labels and comments through MCP', async () => {
    const h = await harness();
    try {
      const accepted = await h.deliver('billing');
      assert.equal(accepted.status, 202);
      const runId = runIdOf(accepted);
      const done = await h.settle(runId);
      assert.equal(done.definitionId, 'tickets.intake'); assert.equal(done.status, 'succeeded');
      const output = (await h.services.submissions.inspect(runId)).output as TriageOutput;
      assert.deepEqual(output, { ticketId: 'T-1002', priority: 'high', labels: ['triaged', 'priority:high', 'billing'],
        summary: 'high priority (billing): Charged twice for one invoice', escalationRunId: null });
      // The tracker holds exactly what the agent did through the MCP tools, and nothing it was not allowed to do.
      const ticket = await h.tickets.get('T-1002');
      assert.deepEqual(ticket?.labels, ['triaged', 'priority:high', 'billing']);
      assert.equal(ticket?.comments.length, 1); assert.match(ticket?.comments[0]?.body ?? '', /^\[automated triage\]/u);
      assert.equal(ticket?.assignee, null);

      // The tracker retries the same delivery (fresh timestamp and signature, same id and body): same run, nothing new.
      const retried = await h.deliver('billing');
      assert.equal(retried.status, 202); assert.equal(runIdOf(retried), runId);
      await h.host.runOnce();
      assert.deepEqual(h.tickets.operations(), [{ operation: 'label', ticketId: 'T-1002' }, { operation: 'comment', ticketId: 'T-1002' }]);
      // The same delivery id with a different body is a conflict, not a new delivery.
      assert.deepEqual(await h.deliver('billing', { event: ticketCreatedEvent('docs') }), { status: 409, body: { error: 'conflict' } });
    } finally { await h.close(); }
  });

  it('refuses forged, stale, unsigned and malformed deliveries before anything starts', async () => {
    const h = await harness();
    try {
      const unauthorized = { status: 401, body: { error: 'unauthorized' } };
      assert.deepEqual(await h.deliver('outage', { secret: newToken() }), unauthorized);
      assert.deepEqual(await h.deliver('outage', { timestampMs: Date.now() - 10 * 60_000 }), unauthorized);
      assert.deepEqual(await h.deliver('outage', { timestampMs: Date.now() + 10 * 60_000 }), unauthorized);
      const body = JSON.stringify(ticketCreatedEvent('outage'));
      const post = (headers: Record<string, string>, payload: string = body, path = '/webhooks/tickets', method = 'POST') =>
        fetch(new URL(path, h.server.webhookUrl), { method, headers, ...(method === 'POST' ? { body: payload } : {}) });
      const timestampMs = Date.now(); const signed = (deliveryId: string, payload: string = body) => ({ 'content-type': 'application/json',
        [webhookHeaders.delivery]: deliveryId, [webhookHeaders.timestamp]: String(timestampMs), [webhookHeaders.signature]: signDelivery(h.config.webhook.secret, { deliveryId, timestampMs, body: payload }) });
      assert.equal((await post({ 'content-type': 'application/json', [webhookHeaders.delivery]: 'd-1', [webhookHeaders.timestamp]: String(timestampMs) })).status, 401);
      // A valid signature over a different body does not verify the body that was sent.
      assert.equal((await post(signed('d-2', body.replace('502', '503')))).status, 401);
      // Signed, but not a payload this trigger accepts.
      const wrongEvent = JSON.stringify({ event: 'ticket.deleted', ticket: sampleTickets.outage });
      assert.deepEqual([(await post(signed('d-3', wrongEvent), wrongEvent)).status], [400]);
      assert.equal((await post({ ...signed('d-4'), 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(signed('d-5', 'x'.repeat(70_000)), 'x'.repeat(70_000))).status, 413);
      assert.equal((await post(signed('d-6'), body, '/webhooks/other')).status, 404);
      assert.equal((await post({}, body, '/webhooks/tickets', 'GET')).status, 405);

      assert.deepEqual((await h.operator.workflows()).items, []);
      assert.deepEqual(h.tickets.operations(), []);
      // A refused forgery does not use up the delivery id: the genuine delivery with that id is still accepted.
      assert.deepEqual(await h.deliver('outage', { deliveryId: 'd-1', secret: newToken() }), unauthorized);
      assert.equal((await h.deliver('outage', { deliveryId: 'd-1' })).status, 202);
    } finally { await h.close(); }
  });

  it('assigns an urgent ticket to on-call only after an operator approves the exact MCP call', async () => {
    const h = await harness();
    try {
      const runId = runIdOf(await h.deliver('outage'));
      assert.equal((await h.settle(runId)).status, 'succeeded');
      const output = (await h.services.submissions.inspect(runId)).output as TriageOutput;
      assert.equal(output.priority, 'urgent'); assert.ok(output.escalationRunId);

      const waiting = await h.settle(output.escalationRunId);
      assert.equal(waiting.definitionId, 'tickets.escalation'); assert.equal(waiting.status, 'waiting');
      const assign = waiting.steps.find(step => step.id === 'assign');
      assert.equal(assign?.status, 'waiting');
      // The operator sees the exact tool call, with the assignee from configuration rather than from the model.
      assert.equal(assign?.approval?.subject?.toolId, 'tickets.assign');
      assert.deepEqual(assign?.approval?.subject?.input, { ticketId: 'T-1001', assignee: 'oncall' });
      await h.host.runOnce();
      assert.equal((await h.tickets.get('T-1001'))?.assignee, null);

      await h.operator.approveWorkflow(output.escalationRunId, { revision: waiting.revision, nodeId: 'assign', approvalDigest: assign!.approval!.digest },
        { commandId: 'approve-T-1001' });
      const done = await h.settle(output.escalationRunId);
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.steps.map(step => [step.id, step.status]), [['assign', 'succeeded'], ['announce', 'succeeded']]);
      const ticket = await h.tickets.get('T-1001');
      assert.equal(ticket?.assignee, 'oncall');
      assert.deepEqual(ticket?.labels, ['triaged', 'priority:urgent', 'bug']);
      assert.equal(ticket?.comments.length, 2);
    } finally { await h.close(); }
  });

  it('refuses a tool whose capability is not granted before it reaches the tracker', async () => {
    // Without `tickets:assign`, the escalation's assign step is blocked outright: no approval is requested, no call is made.
    const withoutAssign = await harness({ revoke: ['tickets:assign'] });
    try {
      const runId = runIdOf(await withoutAssign.deliver('outage'));
      await withoutAssign.settle(runId);
      const { escalationRunId } = (await withoutAssign.services.submissions.inspect(runId)).output as TriageOutput;
      const blocked = await withoutAssign.settle(escalationRunId!);
      assert.equal(blocked.status, 'blocked');
      assert.deepEqual(blocked.steps.map(step => [step.id, step.status]), [['assign', 'blocked'], ['announce', 'skipped']]);
      assert.equal(blocked.steps[0]?.approval, undefined);
      assert.deepEqual(withoutAssign.tickets.operations().filter(entry => entry.operation === 'assign'), []);
    } finally { await withoutAssign.close(); }

    // Without `tickets:write`, the agent's first label call is refused before any MCP request. The agent is blocked with
    // a known outcome, so the triage step fails cleanly: there is nothing to reconcile, and the tracker shows nothing.
    const withoutWrite = await harness({ revoke: ['tickets:write'] });
    try {
      const runId = runIdOf(await withoutWrite.deliver('billing'));
      const stopped = await withoutWrite.settle(runId);
      assert.equal(stopped.status, 'failed');
      assert.deepEqual(withoutWrite.tickets.operations(), []);
    } finally { await withoutWrite.close(); }
  });

  it('keeps callers to their own capabilities', async () => {
    const h = await harness();
    try {
      assert.deepEqual((await h.operator.agents()).map(agent => agent.id), ['tickets.triage']);
      // Runs start only from verified deliveries: not even an operator can start the agent over the API.
      await assert.rejects(h.operator.submit('tickets.triage', sampleTickets.billing, { idempotencyKey: 'direct-1' }), { status: 403 });
      const stranger = createClient({ baseUrl: h.server.origin, token: () => newToken() });
      await assert.rejects(stranger.agents(), { status: 401 });
      await assert.rejects(stranger.workflows(), { status: 401 });
      // The tracker's MCP endpoint wants its own token.
      assert.equal((await fetch(h.tracker.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      await assert.rejects(mcpHttpClient({ url: h.tracker.url, token: 'wrong' }).listTools());
      const client = mcpHttpClient({ url: h.tracker.url, token: h.trackerToken });
      assert.deepEqual((await client.listTools()).map(tool => tool.name), ['label_ticket', 'comment_on_ticket', 'assign_ticket']);
      await client.close();
    } finally { await h.close(); }
  });
});

describe('configuration', () => {
  it('runs offline by default and requires an origin, operator tokens, a webhook secret and a tracker in production', async () => {
    const config = await loadConfig({});
    assert.equal(config.model.provider, 'offline'); assert.equal(config.storage.kind, 'sqlite');
    // Development without WEBHOOK_SECRET gets a throwaway random secret, so unsigned setups refuse every delivery.
    assert.equal(config.webhook.secretGenerated, true); assert.match(config.webhook.secret, /^[a-f0-9]{64}$/u);
    assert.notEqual((await loadConfig({})).webhook.secret, config.webhook.secret);
    assert.equal(config.webhook.bind, '127.0.0.1');
    const production = { MAYURA_ENV: 'production', MAYURA_PUBLIC_ORIGIN: 'https://tickets.example.com', MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(newToken()),
      WEBHOOK_SECRET: newToken(), TRACKER_MCP_URL: 'https://tracker.example.com/mcp' };
    assert.equal((await loadConfig(production)).webhook.secretGenerated, false);
    await assert.rejects(loadConfig({ ...production, MAYURA_PUBLIC_ORIGIN: undefined }), /MAYURA_PUBLIC_ORIGIN/u);
    await assert.rejects(loadConfig({ ...production, MAYURA_OPERATOR_TOKEN_SHA256: undefined }), /MAYURA_OPERATOR_TOKEN_SHA256/u);
    await assert.rejects(loadConfig({ ...production, WEBHOOK_SECRET: undefined }), /WEBHOOK_SECRET/u);
    await assert.rejects(loadConfig({ ...production, TRACKER_MCP_URL: undefined }), /TRACKER_MCP_URL/u);
    // Values that fail the schema are refused without echoing them (the message does not name the variable either).
    await assert.rejects(loadConfig({ WEBHOOK_SECRET: 'too-short' }), { code: 'INVALID_INPUT' });
    await assert.rejects(loadConfig({ TRACKER_MCP_URL: 'ftp://tracker.example.com' }), { code: 'INVALID_INPUT' });
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'openai' }), /OPENAI_API_KEY/u);
    assert.equal((await loadConfig({ DATABASE_URL: 'postgres://tickets@db/tickets' })).storage.kind, 'postgres');
  });
});
