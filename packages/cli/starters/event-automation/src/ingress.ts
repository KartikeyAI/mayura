import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MayuraError } from '@mayura/core';
import { StorageError } from '@mayura/storage-contracts';
import { createWebhookRuntime, defineWebhookTrigger } from '@mayura/workstream/webhooks';
import type { Config } from './config.js';
import { jsonSchema } from './model.js';
import type { Services } from './services.js';
import { webhookHeaders } from './signing.js';
import { ticketCreated } from './triage.js';

export const WEBHOOK_PATH = '/webhooks/tickets';
const maxBodyBytes = 65_536;
const maxInFlight = 32;
/** Deliveries signed more than five minutes before or after our clock are refused, so a captured request goes stale. */
const replayWindowMs = 300_000;
// Pins the payload schema into every stored delivery: a schema change is a new trigger version, never a silent reinterpretation.
const schemaDigest = createHash('sha256').update(JSON.stringify(jsonSchema(ticketCreated))).digest('hex');

export interface WebhookIngress { readonly url: string; isAccepting(): boolean; close(): Promise<void> }

/**
 * The webhook listener: its own small HTTP server, because the Mayura agent server serves only its own API.
 * One route, `POST /webhooks/tickets`. Each request is bounded (size, time, concurrency) and handed, as raw bytes, to
 * the Mayura webhook runtime, which verifies the HMAC signature and the replay window, validates the payload, and
 * records the delivery durably before dispatching it exactly once. A repeated delivery id finds that record instead
 * of starting anything. Responses carry a status and a fixed error word, never details.
 */
export async function startWebhookIngress(config: Config, services: Services): Promise<WebhookIngress> {
  const secret = Buffer.from(config.webhook.secret, 'utf8');
  const webhooks = createWebhookRuntime({
    store: services.store, scope: config.scope, maxBodyBytes, maxClockSkewMs: replayWindowMs,
    // Replace with a read from your secret manager to rotate without a restart.
    resolveSecret: async () => new Uint8Array(secret),
  });
  const trigger = defineWebhookTrigger({
    id: 'tickets.created', version: '1', secretId: 'tracker-webhook', schemaId: 'tickets.created.v1', schemaDigest, input: ticketCreated,
    // Runs once per new delivery, after verification. `commandId` is stable for the delivery, so the intake run is
    // idempotent on it too: even a dispatch retried after a crash finds the run it already started.
    dispatch: async (event, { deliveryId, commandId }) => {
      const run = await services.submissions.submit(services.workflows.intake, { idempotencyKey: `delivery:${commandId}`, input: { deliveryId, ticket: event.ticket } });
      return { runId: run.id };
    },
  });

  let accepting = true; let inFlight = 0;
  const reply = (response: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    response.end(JSON.stringify(body));
  };
  const log = (event: Record<string, unknown>): void => { process.stderr.write(`${JSON.stringify(event)}\n`); };
  const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name]; return typeof value === 'string' ? value : undefined;
  };

  async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > maxBodyBytes) return undefined;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length; if (size > maxBodyBytes) return undefined;
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((request.url ?? '').split('?')[0] !== WEBHOOK_PATH) return reply(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') return reply(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    if (!accepting || inFlight >= maxInFlight) return reply(response, 503, { error: 'unavailable' }, { 'retry-after': '5' });
    if (!/^application\/json\s*(;|$)/iu.test(header(request, 'content-type') ?? '')) return reply(response, 415, { error: 'unsupported_media_type' });
    const deliveryId = header(request, webhookHeaders.delivery); const timestamp = header(request, webhookHeaders.timestamp);
    const signature = header(request, webhookHeaders.signature);
    if (!signature) return reply(response, 401, { error: 'unauthorized' });
    if (!deliveryId || !timestamp || !/^\d{1,16}$/u.test(timestamp)) return reply(response, 400, { error: 'bad_request' });
    inFlight++;
    try {
      const body = await readBody(request);
      if (!body) return reply(response, 413, { error: 'too_large' }, { connection: 'close' });
      const delivery = await webhooks.receive(trigger, { deliveryId, timestampMs: Number(timestamp), signature, body });
      if (delivery.status === 'succeeded') {
        const { runId } = delivery.output as { readonly runId: string };
        // The same answer for a new delivery and for a repeat of one already handled: the tracker can stop retrying.
        return reply(response, 202, { status: 'accepted', runId });
      }
      if (delivery.status === 'outcome_unknown') {
        // Dispatch failed part-way. It is never retried automatically; an operator reconciles it (see README).
        log({ event: 'webhook-unconfirmed', deliveryId });
        return reply(response, 500, { error: 'unconfirmed' });
      }
      // Another process is dispatching this delivery right now (or crashed doing so): ask the tracker to retry later.
      return reply(response, 503, { error: 'in_progress' }, { 'retry-after': '5' });
    } catch (error) {
      const code = error instanceof MayuraError || error instanceof StorageError ? error.code : 'UNEXPECTED';
      if (code === 'PERMISSION_DENIED') return reply(response, 401, { error: 'unauthorized' });
      if (code === 'INVALID_INPUT') return reply(response, 400, { error: 'bad_request' });
      // A delivery id reused with a different body (the store refuses it), or a concurrent copy of this delivery that
      // another process is already handling. Either way this request must not start anything.
      if (code === 'CONFLICT') return reply(response, 409, { error: 'conflict' });
      if (code === 'LIMIT_EXCEEDED') return reply(response, 503, { error: 'unavailable' }, { 'retry-after': '5' });
      log({ event: 'webhook-error', code });
      return reply(response, code === 'STORAGE_UNAVAILABLE' ? 503 : 500, { error: 'internal' });
    } finally { inFlight--; }
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
    handle(request, response).catch(() => { if (!response.headersSent) reply(response, 500, { error: 'internal' }); else response.destroy(); });
  });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.webhook.port, config.webhook.bind, () => { server.off('error', reject); resolve(); });
  });
  if (config.webhook.secretGenerated) {
    log({ event: 'webhook-secret-generated', note: 'WEBHOOK_SECRET is not set, so a random development secret is in use and no tracker can sign deliveries. Set WEBHOOK_SECRET, or use `npm run dev`.' });
  }
  const { port } = server.address() as AddressInfo;
  const host = config.webhook.bind === '0.0.0.0' ? '127.0.0.1' : config.webhook.bind;
  return {
    url: `http://${host}:${port}${WEBHOOK_PATH}`,
    isAccepting: () => accepting,
    close: async () => {
      accepting = false;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
      webhooks.close();
    },
  };
}
