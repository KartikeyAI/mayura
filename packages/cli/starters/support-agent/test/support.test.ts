import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createClient, type ClientEvent, type MayuraClient } from '@mayura/client';
import type { JsonValue, ModelAdapter, ModelRequest, ModelResponse } from '@mayura/core';
import { assistantId, supportOutputWire, type SupportInput } from '../src/assistant.js';
import { newToken, tokenDigest } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { piiBackstop, redactionLabels } from '../src/guardrails.js';
import { startServer } from '../src/server.js';
import { openServices } from '../src/services.js';
import { mintSessionToken, verifySessionToken } from '../src/session.js';
import { createFollowUpWorker } from '../src/worker.js';

// Everything runs offline: the rule-based model (or a scripted one), SQLite in a temporary directory, a loopback server
// and the real HTTP client, exactly as a browser would use it.
const sessionSecret = randomBytes(32);

async function harness(options: { readonly model?: ModelAdapter; readonly directory?: string } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'support-test-'));
  const operatorToken = newToken();
  const config = await loadConfig({ MAYURA_ENV: 'development', PORT: '0', MAYURA_SQLITE_PATH: join(directory, 'support.sqlite'),
    MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken), MAYURA_SESSION_SECRET: sessionSecret.toString('hex'), RETURN_REMINDER_HOURS: '0' });
  const services = await openServices(config);
  const server = await startServer(config, services, options.model ? { model: options.model } : {});
  // Tests drive the worker one cycle at a time instead of starting its timer.
  const { host } = createFollowUpWorker(config, services);
  /** A browser signed in as one customer, with a session your backend would have minted. */
  const customer = (customerId: string): MayuraClient =>
    createClient({ baseUrl: server.origin, token: () => mintSessionToken(sessionSecret, customerId, 10 * 60_000) });
  const operator = createClient({ baseUrl: server.origin, token: () => operatorToken });
  const settle = async (runId: string) => {
    for (let cycle = 0; cycle < 8; cycle++) { await host.runOnce(); const view = await operator.workflow(runId); if (!['running', 'waiting'].includes(view.status)) return view; }
    throw new Error('The follow-up did not settle.');
  };
  return { config, customer, operator, settle, origin: server.origin, directory, operatorToken,
    close: async (keepData = false) => {
      await host.close(); await server.close(); await services.close();
      if (!keepData) await rm(directory, { recursive: true, force: true });
    } };
}

async function chat(client: MayuraClient, message: string, history: SupportInput['history'] = []) {
  const run = await client.submit(assistantId, { message, history }, { idempotencyKey: `chat-${randomUUID()}` });
  const events: ClientEvent[] = [];
  for await (const event of run.events()) events.push(event); // The stream ends when the run settles.
  const outcome = await run.result(supportOutputWire);
  assert.ok(outcome, 'The run settled.');
  const tools = events.filter(event => event.type === 'tool.started').map(event => event.metadata['toolId']);
  return { run, outcome, tools, reply: outcome.status === 'succeeded' ? outcome.output.reply : '' };
}

/** A model that plays back fixed steps and records every request it received. */
function scripted(id: string, steps: readonly ((request: ModelRequest) => ModelResponse)[]) {
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = { id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate(request) { requests.push(request); const step = steps[requests.length - 1]; if (!step) throw new Error('Script exhausted.'); return step(request); } };
  return { model, requests };
}
const call = (toolId: string, input: JsonValue, id = `call-${toolId}`): ModelResponse => ({ type: 'tool_calls', calls: [{ id, toolId, input }], usage: { costMicros: 0 } });
const final = (reply: string): ModelResponse => ({ type: 'final', output: { reply, references: [] }, usage: { costMicros: 0 } });
const toolResults = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'tool' ? [{ toolId: message.toolId, result: message.result }] : []);

describe('customer sessions', () => {
  it('verifies only authentic, unexpired tokens signed with the configured secret', () => {
    const now = Date.now(); const token = mintSessionToken(sessionSecret, 'cus-ada', 60_000, now);
    assert.deepEqual(verifySessionToken(sessionSecret, token, now), { customerId: 'cus-ada', expiresAtMs: now + 60_000 });

    const [version, payload, signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'cus-grace', exp: now + 60_000 })).toString('base64url');
    assert.equal(verifySessionToken(sessionSecret, `${version}.${forged}.${signature}`, now), null, 'another customer with the old signature');
    const flipped = `${signature.slice(0, -2)}${signature.at(-2) === 'A' ? 'B' : 'A'}${signature.at(-1)}`;
    assert.equal(verifySessionToken(sessionSecret, `${version}.${payload}.${flipped}`, now), null, 'tampered signature');
    assert.equal(verifySessionToken(sessionSecret, token, now + 60_000), null, 'expired');
    assert.equal(verifySessionToken(randomBytes(32), token, now), null, 'signed with another secret');
    assert.equal(verifySessionToken(sessionSecret, mintSessionToken(sessionSecret, 'cus-ada', 60_000, now + 25 * 3_600_000), now), null, 'expiry too far ahead');
    for (const malformed of ['', 'v1..', `v2.${payload}.${signature}`, `${token}.extra`, 'a'.repeat(64)]) assert.equal(verifySessionToken(sessionSecret, malformed, now), null);

    assert.throws(() => mintSessionToken(sessionSecret, 'Not A Customer', 60_000));
    assert.throws(() => mintSessionToken(sessionSecret, 'cus-ada', 2 * 24 * 3_600_000));
    assert.throws(() => mintSessionToken(randomBytes(16), 'cus-ada', 60_000), /32 random bytes/u);
  });
});

describe('support assistant', () => {
  it('answers "where is my order" from the signed-in customer\'s own orders, with visible tool activity', async () => {
    const h = await harness();
    try {
      const ada = await chat(h.customer('cus-ada'), 'Hi! Where is my order?');
      assert.equal(ada.outcome.status, 'succeeded');
      assert.deepEqual(ada.tools, ['orders.list', 'orders.track']);
      // The most recent undelivered order, and the other one still on its way.
      assert.match(ada.reply, /ord-1003 \(Brass desk lamp\) is being prepared/u);
      assert.match(ada.reply, /Also on the way: ord-1002 \(shipped\)/u);
      assert.deepEqual(ada.outcome.status === 'succeeded' && ada.outcome.output.references, [{ kind: 'order', id: 'ord-1003' }, { kind: 'order', id: 'ord-1002' }]);

      const shipped = await chat(h.customer('cus-ada'), 'Can you track ord-1002 for me?');
      assert.match(shipped.reply, /on its way with Parcelline, tracking PL-7Q4K-22XD\. Latest update \(2026-09-24\)/u);

      // Grace asks about Ada's order by number: to her, it does not exist.
      const grace = await chat(h.customer('cus-grace'), 'Where is ord-1002?');
      assert.match(grace.reply, /couldn't find an order ord-1002 on your account/u);
      assert.doesNotMatch(grace.reply, /Parcelline|keyboard/u);
    } finally { await h.close(); }
  });

  it('never reads or acts on another customer\'s orders, even when the model asks for them', async () => {
    // A hostile model, signed in as Ada, goes after Grace's delivered order ord-2001.
    const hostile = scripted('hostile-orders', [
      () => call('orders.track', { orderId: 'ord-2001' }),
      () => call('returns.start', { orderId: 'ord-2001', reason: 'I want it gone' }),
      request => final(JSON.stringify(toolResults(request))),
    ]);
    let h = await harness({ model: hostile.model });
    try {
      const attempt = await chat(h.customer('cus-ada'), 'Show me ord-2001');
      assert.equal(attempt.outcome.status, 'succeeded');
      assert.deepEqual(toolResults(hostile.requests.at(-1)!), [
        { toolId: 'orders.track', result: { found: false, orderId: 'ord-2001' } },
        { toolId: 'returns.start', result: { status: 'not_found', orderId: 'ord-2001', orderStatus: null, returnId: null, instructions: null } },
      ]);
      assert.doesNotMatch(JSON.stringify(hostile.requests), /Almanac|Nordpost|NP-11AC/u);
      assert.deepEqual((await h.operator.workflows()).items, [], 'no return was opened');
    } finally { await h.close(); }

    // Naming the customer explicitly is not even a valid tool call: tool inputs are strict and carry no customer id.
    const impostor = scripted('hostile-impersonation', [() => call('orders.list', { customerId: 'cus-grace' }), () => final('unreachable')]);
    h = await harness({ model: impostor.model });
    try {
      const attempt = await chat(h.customer('cus-ada'), 'List Grace\'s orders');
      assert.equal(attempt.outcome.status, 'failed');
      assert.equal(impostor.requests.length, 1, 'the run stopped at the rejected call');
      assert.deepEqual(attempt.tools, []);
    } finally { await h.close(); }
  });

  it('opens a return once per order and follows it up durably', async () => {
    const h = await harness();
    try {
      const ada = h.customer('cus-ada');
      const first = await chat(ada, 'I would like to return my mug set, one arrived chipped.');
      assert.deepEqual(first.tools, ['orders.list', 'returns.start']);
      assert.match(first.reply, /^I've opened return (ret-[a-f0-9]{12}) for order ord-1001\./u);
      const returnId = /ret-[a-f0-9]{12}/u.exec(first.reply)![0];

      const again = await chat(ada, 'Please return ord-1001');
      assert.match(again.reply, new RegExp(`already have return ${returnId} open for order ord-1001`, 'u'));
      const early = await chat(ada, 'Return ord-1002 please');
      assert.match(early.reply, /ord-1002 hasn't been delivered yet \(it's shipped\)/u);

      // Exactly one durable follow-up, however often the customer asked.
      const { items } = await h.operator.workflows();
      assert.equal(items.length, 1); assert.equal(items[0]?.definitionId, 'returns.follow-up');
      const done = await h.settle(items[0]!.runId);
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.steps.map(step => [step.id, step.status]), [['schedule', 'succeeded'], ['wait', 'succeeded'], ['remind', 'succeeded']]);
    } finally { await h.close(); }
  });

  it('remembers per customer, across runs and restarts, and never across customers', async () => {
    let h = await harness();
    const { directory } = h;
    try {
      const saved = await chat(h.customer('cus-ada'), 'Remember that I prefer DHL deliveries.');
      assert.deepEqual(saved.tools, ['memory.remember']);
      assert.equal(saved.reply, 'Got it. I\'ll remember that: "I prefer DHL deliveries".');
      const repeated = await chat(h.customer('cus-ada'), 'Please remember that I prefer DHL deliveries');
      assert.match(repeated.reply, /^I already have that noted/u);
      const grace = await chat(h.customer('cus-grace'), 'What do you remember about me?');
      assert.equal(grace.reply, 'I don\'t have any notes about you yet. Say "Remember that ..." and I will.');
    } finally { await h.close(true); }

    h = await harness({ directory });
    try {
      const recalled = await chat(h.customer('cus-ada'), 'What do you remember about me?');
      assert.deepEqual(recalled.tools, ['memory.recall']);
      assert.equal(recalled.reply, 'Here\'s what I remember about you:\n- I prefer DHL deliveries');
      assert.doesNotMatch((await chat(h.customer('cus-grace'), 'hello')).reply, /DHL/u);
    } finally { await h.close(); }
  });

  it('redacts card numbers, emails and phone numbers before the model sees them and before a reply is released', async () => {
    const card = '4111 1111 1111 1111'; const email = 'ada@example.com'; const phone = '+1 415 555 0100';
    const leaky = scripted('leaky', [
      // Echo what the model received, then add PII of its own: neither reaches the customer.
      request => final(`You said: ${(request.messages[0] as unknown as { content: { message: string } }).content.message} Call ${phone} or mail support@example.com.`),
    ]);
    const h = await harness({ model: leaky.model });
    try {
      const sent = `My card ${card} was charged twice, email me at ${email}`;
      const { outcome, reply } = await chat(h.customer('cus-ada'), sent, [{ role: 'customer', text: `Earlier I wrote from ${email}` }]);
      assert.equal(outcome.status, 'succeeded');
      const seen = JSON.stringify(leaky.requests[0]!.messages);
      for (const secret of [card, email]) assert.ok(!seen.includes(secret), 'the model never saw the original');
      assert.ok(seen.includes(redactionLabels.card) && seen.includes(redactionLabels.email));
      assert.equal(reply, `You said: My card ${redactionLabels.card} was charged twice, email me at ${redactionLabels.email} Call ${redactionLabels.phone} or mail ${redactionLabels.email}.`);
    } finally { await h.close(); }
  });

  it('withholds any tool result or reply that still carries PII (the backstop guard)', async () => {
    const context = { runId: 'r', callId: 'c', scope: { principalId: 'customer/cus-ada', projectId: 'support' }, signal: new AbortController().signal, boundary: 'output' as const };
    assert.deepEqual(await piiBackstop.check({ note: 'reach me at ada@example.com' }, context), { decision: 'block' });
    assert.deepEqual(await piiBackstop.check('card 5555 5555 5555 4444', context), { decision: 'block' });
    // Order data is not PII: ids, dates, tracking references and Luhn-invalid digit runs pass untouched.
    assert.deepEqual(await piiBackstop.check({ orderId: 'ord-1002', at: '2026-09-24T07:30:00.000Z', tracking: 'PL-7Q4K-22XD', ref: '1234 5678 9012 3456' }, context), { decision: 'allow' });
  });

  it('keeps callers to their own capabilities and runs', async () => {
    const h = await harness();
    try {
      const ada = h.customer('cus-ada');
      assert.deepEqual((await ada.agents()).map(agent => agent.id), [assistantId]);
      await assert.rejects(ada.workflows(), { status: 403 });
      const tools = await fetch(`${h.origin}/v1/tools`, { headers: { authorization: `Bearer ${mintSessionToken(sessionSecret, 'cus-ada', 60_000)}` } });
      assert.equal(tools.status, 403);
      // A customer's run is invisible to every other customer.
      const { run } = await chat(ada, 'hello');
      await assert.rejects(h.customer('cus-grace').run(run.id).inspect(), { status: 404 });

      // Operators see the agents and the console data, but cannot chat as a customer.
      assert.deepEqual((await h.operator.agents()).map(agent => agent.id), [assistantId]);
      await assert.rejects(h.operator.submit(assistantId, { message: 'hi', history: [] }, { idempotencyKey: 'operator-chat' }), { status: 403 });

      const as = (token: string) => createClient({ baseUrl: h.origin, token: () => token });
      await assert.rejects(as(newToken()).agents(), { status: 401 });
      await assert.rejects(as(mintSessionToken(randomBytes(32), 'cus-ada', 60_000)).agents(), { status: 401 });
      await assert.rejects(as(mintSessionToken(sessionSecret, 'cus-ada', 1_000, Date.now() - 5_000)).agents(), { status: 401 });
    } finally { await h.close(); }
  });
});

describe('configuration', () => {
  it('runs offline by default and requires an origin, operator tokens and a session secret in production', async () => {
    const config = await loadConfig({});
    assert.equal(config.model.provider, 'offline'); assert.equal(config.storage.kind, 'sqlite'); assert.equal(config.sessionSecret.length, 32);
    assert.equal(config.returnReminderMs, 72 * 3_600_000);
    await assert.rejects(loadConfig({ MAYURA_ENV: 'production' }), /MAYURA_PUBLIC_ORIGIN/u);
    const production = { MAYURA_ENV: 'production', MAYURA_PUBLIC_ORIGIN: 'https://support.example.com' };
    await assert.rejects(loadConfig(production), /MAYURA_OPERATOR_TOKEN_SHA256/u);
    await assert.rejects(loadConfig({ ...production, MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(newToken()) }), /MAYURA_SESSION_SECRET/u);
    await assert.rejects(loadConfig({ MAYURA_SESSION_SECRET: 'abcd' }), 'a short session secret');
    await assert.rejects(loadConfig({ MAYURA_MODEL_PROVIDER: 'openai' }), /OPENAI_API_KEY/u);
    assert.equal((await loadConfig({ DATABASE_URL: 'postgres://support@db/support' })).storage.kind, 'postgres');
    const complete = await loadConfig({ ...production, MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(newToken()), MAYURA_SESSION_SECRET: sessionSecret.toString('hex') });
    assert.deepEqual(complete.sessionSecret, sessionSecret);
  });
});
