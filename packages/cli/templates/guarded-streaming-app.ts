import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@mayura/client';
import { defineAgent, type Guard } from '@mayura/sdk';
import { listenAgentServer } from '@mayura/server-node';
import { scriptedModel } from '@mayura/testing';

const message = { '~standard': { version: 1 as const, vendor: 'starter', validate: (value: unknown) => typeof value === 'string'
  ? { value } : { issues: [{ message: 'Expected text.' }] } } };
const guard: Guard = { id: 'block-secret-marker', check: value => ({ decision: typeof value === 'string' && value.includes('SECRET') ? 'block' : 'allow' }) };
const agent = defineAgent({ id: 'starter.guarded-streaming-app', version: '1.0.0', instructions: 'Return safe structured text.', input: message, output: message,
  tools: [], guards: { input: [guard], output: [guard] }, model: scriptedModel([{ type: 'final', output: 'Safe streamed response.', usage: { costMicros: 0 } }]) });
const secret = randomBytes(32); const token = secret.toString('hex');
const server = await listenAgentServer({ agents: [{ agent, permissions: { allow: ['model:scripted'] } }], authenticate: async request =>
  /^[a-f0-9]{64}$/.test(request.token) && timingSafeEqual(Buffer.from(request.token, 'hex'), secret)
    ? { scope: { principalId: 'local', projectId: 'starter' }, agentIds: [agent.id], capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 30_000 } : null,
  limits: { maxRuns: 1, maxRuntimes: 1, maxRequests: 8, maxStreams: 2, maxBodyBytes: 4_096, maxResponseBytes: 65_536,
    requestTimeoutMs: 2_000, streamDurationMs: 2_000 }, shutdownGraceMs: 100 });
try {
  const client = createClient({ baseUrl: server.origin, token: () => token });
  const run = await client.submit(agent.id, 'Hello', { idempotencyKey: 'starter-request' }); let events = 0;
  for await (const _event of run.events()) events++;
  console.log(JSON.stringify({ result: await run.result(message), events, frontend: 'Use @mayura/client from any browser application; never expose the server token.' }));
} finally { await server.close(); }
