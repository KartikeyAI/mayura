// Local inspector demo: serves the read-only inspector on loopback next to one agent, submits a run and keeps
// serving until Ctrl+C. Open the printed URL and paste the printed one-time token.
//   node examples/inspector.mjs [--port 4318] [--seconds 600]
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineAgent } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { listenAgentServer } from '@mayura/server-node';
import { createClient } from '@mayura/client';

const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : Number(process.argv[index + 1]); };
const any = { '~standard': { version: 1, vendor: 'example', validate: value => ({ value }) } };
const agent = defineAgent({ id: 'inspector.demo', version: '1', instructions: 'Demonstrate the inspector.', input: any, output: any, tools: [],
  model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]) });

// Demo only: a fresh loopback credential printed once for the operator. Production must verify real identities.
const secret = randomBytes(32); const token = secret.toString('hex'); const expiresAtMs = Date.now() + option('--seconds', 600) * 1_000;
const server = await listenAgentServer({
  inspector: true, port: option('--port', 0),
  agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
  authenticate: async ({ token: supplied }) => expiresAtMs > Date.now() && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied, 'hex'), secret)
    ? { scope: { principalId: 'demo-user', projectId: 'inspector-demo' }, agentIds: ['inspector.demo'], capabilities: ['runs:read', 'runs:submit', 'operations:read'], expiresAtMs }
    : null,
});
const client = createClient({ baseUrl: server.origin, token: () => token });
const run = await client.submit('inspector.demo', { question: 'demo' }, { idempotencyKey: `demo-${Date.now()}` });
console.log(JSON.stringify({ inspector: `${server.origin}/inspector`, token, runId: run.id, expiresAt: new Date(expiresAtMs).toISOString() }));
const stop = async () => { await server.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
setTimeout(stop, Math.max(0, expiresAtMs - Date.now())).unref?.();
await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAtMs - Date.now())));
