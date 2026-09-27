import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineAgent } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { listenAgentServer } from 'mayura/server-node';
import { createClient } from 'mayura/client';

const input = { '~standard': { version: 1, vendor: 'example', validate(value) {
  return value !== null && typeof value === 'object' && typeof value.message === 'string'
    ? { value: { message: value.message } } : { issues: [{ message: 'Expected a message.' }] };
} } };
const output = { '~standard': { version: 1, vendor: 'example', validate(value) {
  return value !== null && typeof value === 'object' && typeof value.answer === 'number' && Number.isFinite(value.answer)
    ? { value: { answer: value.answer } } : { issues: [{ message: 'Expected a finite answer.' }] };
} } };
const agent = defineAgent({
  id: 'local.demo', version: '1', instructions: 'Demonstrate the authenticated local transport.',
  input, output, tools: [],
  // Deterministic transport fixture: this is not a language model or reasoning demonstration.
  model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]),
});

// Demo only: a fresh in-process credential, never printed, with fixed scope and short expiry.
// Production authentication must verify your identity provider's tokens and authorization policy.
const secret = randomBytes(32);
const token = secret.toString('hex');
const expiresAtMs = Date.now() + 30_000;
const server = await listenAgentServer({
  agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
  authenticate: async ({ token: supplied, signal }) => {
    if (signal.aborted || expiresAtMs <= Date.now() || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied, 'hex'), secret)) return null;
    return {
      scope: { principalId: 'demo-user', projectId: 'local-demo' },
      agentIds: ['local.demo'], capabilities: ['runs:read', 'runs:submit'], expiresAtMs,
    };
  },
  limits: { maxRuns: 1, maxRuntimes: 1, maxRequests: 8, maxStreams: 2, maxBodyBytes: 4_096,
    maxResponseBytes: 65_536, requestTimeoutMs: 2_000, streamDurationMs: 2_000 },
  shutdownGraceMs: 100,
});
try {
  const client = createClient({ baseUrl: server.origin, token: () => token, requestTimeoutMs: 2_000 });
  const run = await client.submit('local.demo', { message: 'Verify the local transport.' }, { idempotencyKey: 'demo-request' });
  let observedEvents = 0;
  for await (const _event of run.events()) observedEvents++;
  const result = await run.result(output);
  if (result?.status !== 'succeeded') throw new Error('Local transport example did not succeed.');
  console.log(JSON.stringify({ output: result.output, observedEvents }));
} finally {
  await server.close();
}
