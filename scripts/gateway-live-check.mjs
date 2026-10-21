// Explicit owner-run qualification. Never imported by unit tests or run during deferred validation.
// node scripts/gateway-live-check.mjs <gateway> --allow-paid
import { randomBytes } from 'node:crypto';
import { createModels, createRuntime, defineAgent, defineTool, z } from 'mayura';

const factories = { vercel: 'vercelGateway', cloudflare: 'cloudflareGateway', openrouter: 'openrouter', portkey: 'portkey', helicone: 'helicone', litellm: 'litellm' };
const id = process.argv[2];
try {
  if (!Object.hasOwn(factories, id ?? '') || process.argv.length !== 4 || process.argv[3] !== '--allow-paid') throw new Error();
  const prefix = `MAYURA_LIVE_GATEWAY_${id.toUpperCase()}_`;
  const text = name => { const value = process.env[`${prefix}${name}`]; if (typeof value !== 'string' || !value.trim()) throw new Error(); return value; };
  const positive = name => { const raw = text(name); if (!/^[1-9][0-9]{0,14}$/u.test(raw)) throw new Error(); return Number(raw); };
  const maxCall = positive('MAX_CALL_COST_MICROS'); const maxTotal = positive('MAX_TOTAL_COST_MICROS');
  // Five admitted calls across structured (1), tools (3), and streaming (1); unresolved calls retain their full bound.
  if (!Number.isSafeInteger(maxCall * 5) || maxTotal < maxCall * 5) throw new Error();
  const modelName = text('MODEL');
  const options = { apiKey: text('API_KEY'), timeoutMs: 60_000 };
  if (process.env[`${prefix}BASE_URL`]) options.baseURL = text('BASE_URL');
  if (id === 'cloudflare') { options.accountId = text('ACCOUNT_ID'); options.gatewayId = text('GATEWAY_ID'); }
  if (id === 'portkey') options.provider = text('PROVIDER');
  if (id === 'litellm') options.baseURL = text('BASE_URL');
  const module = await import(new URL(`../extensions/gateway-${id}/dist/index.js`, import.meta.url));
  const provider = module[factories[id]](options);
  const models = createModels({ providers: [provider], maxCallCostMicros: maxCall });
  const model = models.model(`${id}/${modelName}`, { pricing: { inputMicrosPerMillionTokens: positive('INPUT_MICROS_PER_MILLION_TOKENS'), outputMicrosPerMillionTokens: positive('OUTPUT_MICROS_PER_MILLION_TOKENS') } });
  const nonce = randomBytes(12).toString('hex'); let toolCalls = 0;
  const tool = defineTool({ id: 'gateway.lookup', version: '1', description: 'Read the current verification code.', input: z.object({}).strict(), output: z.object({ code: z.string() }).strict(), effects: 'none', capabilities: [], costMicros: 0, execute: () => { toolCalls++; return { code: nonce }; } });
  let admitted = 0; const checks = [];
  for (const check of ['structured', 'tools', 'streaming']) {
    const calls = check === 'tools' ? 3 : 1; const bound = maxCall * calls;
    if (admitted + bound > maxTotal) throw new Error(); admitted += bound;
    const agent = defineAgent({ id: `gateway-${check}`, version: '1', input: z.object({}), output: z.object({ answer: z.string() }).strict(), model,
      instructions: check === 'tools' ? 'Call gateway.lookup exactly once. Return its code as answer in JSON.' : 'Return JSON with answer equal to hello.', tools: check === 'tools' ? [tool] : [],
      ...(check === 'streaming' ? { stream: { field: ['answer'], guards: [{ id: 'qualification.allow', check: () => ({ decision: 'allow' }) }], batch: { minChars: 1, maxChars: 16 } } } : {}) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: [`model:${model.id}`, ...(check === 'tools' ? ['tool:gateway.lookup'] : [])] }, limits: { maxCostMicros: bound, maxModelCalls: calls, maxToolCalls: check === 'tools' ? 1 : 0, maxOutputTokens: 256, maxSteps: 4, maxDurationMs: 195_000 } });
    try {
      const handle = runtime.submit(agent, { input: {} });
      const result = await handle.result(); let deltas = 0;
      for await (const event of handle.observe()) if (event.type === 'output.delta') deltas++;
      const passed = result.status === 'succeeded' && result.output.answer === (check === 'tools' ? nonce : 'hello') && (check !== 'tools' || toolCalls === 1) && (check !== 'streaming' || deltas > 0);
      checks.push({ check, passed, status: result.status });
      if (!passed) break; // No retry or paid recovery after any failed qualification.
    } finally { await runtime.close(); }
  }
  console.log(JSON.stringify({ gateway: id, checks, admittedCostMicros: admitted }));
  if (checks.length !== 3 || checks.some(check => !check.passed)) process.exitCode = 1;
} catch {
  // Errors and config may hold credentials. Emit only a fixed message.
  console.error('Gateway qualification refused or failed. Supply one gateway, --allow-paid, explicit credentials, model, prices and call/total bounds.');
  process.exitCode = 1;
}
