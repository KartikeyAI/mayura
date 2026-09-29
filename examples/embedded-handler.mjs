// Mount Mayura's HTTP API inside an application you already run. Any framework that hands you a web `Request` works
// the same way (a Next.js route handler, Hono, Fastify with a fetch adapter): send every `/v1/*` request to
// `api.fetch` and serve your own routes as usual. Here a tiny router plays the framework, the client talks to it in
// memory, and the framework sees an internal URL (as it would behind a proxy), which is what `mounted: true` is for.
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineAgent, z } from 'mayura';
import { createClient } from 'mayura/client';
import { createAgentServer } from 'mayura/server';
import { scriptedModel } from 'mayura/testing';

const Answer = z.object({ answer: z.number() });
const agent = defineAgent({
  id: 'demo.answer', version: '1', instructions: 'Answer the question with a number.',
  input: z.object({ question: z.string() }), output: Answer, tools: [],
  // A scripted stand-in, so the example runs offline.
  model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]),
});

// Demo credential only. Verify your identity provider's tokens here instead.
const secret = randomBytes(32);
const token = secret.toString('hex');

const api = createAgentServer({
  publicOrigin: 'https://agents.example.com',
  mounted: true, // the framework routes requests here, so trust only the path and query, never the Host header
  agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
  authenticate: async ({ token: supplied }) => {
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), secret)) return null;
    return { scope: { principalId: 'user-1', projectId: 'demo' }, agentIds: ['demo.answer'],
      capabilities: ['runs:submit', 'runs:read'], expiresAtMs: Date.now() + 60_000 };
  },
});

// The application's own router: Mayura's API under /v1, everything else is yours.
async function app(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/v1/')) return api.fetch(request);
  if (pathname === '/') return new Response('Your app', { headers: { 'content-type': 'text/plain' } });
  return new Response('Not found', { status: 404 });
}

// Behind a proxy the framework sees http://app.internal:3000/... rather than the public origin.
const viaProxy = (input, init) => app(new Request(String(input).replace('https://agents.example.com', 'http://app.internal:3000'), init));
const client = createClient({ baseUrl: 'https://agents.example.com', token: () => token, fetch: viaProxy });

try {
  assert.equal(await (await app(new Request('http://app.internal:3000/'))).text(), 'Your app');
  const run = await client.submit('demo.answer', { question: 'What is six times seven?' }, { idempotencyKey: 'question-1' });
  const events = [];
  for await (const event of run.events()) events.push(event.type);
  const result = await run.result(Answer);
  assert.equal(result?.status, 'succeeded');
  assert.equal(result.output.answer, 42);
  assert.ok(events.length > 0, 'events streamed through the mounted handler');
  const denied = await app(new Request('http://app.internal:3000/v1/agents', { headers: { authorization: 'Bearer wrong' } }));
  assert.equal(denied.status, 401);
  console.log(JSON.stringify({ status: 'passed', answer: result.output.answer, events: events.length, unauthenticated: denied.status }));
} finally {
  await api.close();
}
