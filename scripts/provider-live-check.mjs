// Live-account qualification for Mayura's model providers, run by the owner with their own credentials.
//   pnpm providers:live-check              live: paid requests to the providers selected by explicit environment variables
//   pnpm providers:live-check --dry-run    offline: the same checks against deterministic local fake transports
// Every check goes through the real runtime (defineAgent, createRuntime, createModelRouter). The harness never discovers
// credentials or reads files, and its report never contains a credential, a prompt or a provider error body.
// See CONTRIBUTING.md (Checking model providers against live accounts).
import { randomBytes, randomInt } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createModelRouter, createRuntime, defineAgent, defineTool, media, withMedia } from '@mayura/sdk';
import { anthropicMessages } from '@mayura/provider-anthropic';
import { openAICompatibleChat, openAIResponses } from '@mayura/provider-openai';
import { z } from 'zod';

export const CHECKS = Object.freeze(['structured', 'tools', 'streaming', 'router_failover', 'router_streaming', 'vision', 'vision_tools']);
/** Per-call bounds each check may be charged at worst: a tool round trip may take 3 calls, a router call reserves both routes. */
const WORST_CASE_BOUNDS = Object.freeze({ structured: 1, tools: 3, streaming: 1, router_failover: 2, router_streaming: 2, vision: 1, vision_tools: 3 });
/** Sent only as the router's first route, which must be refused by the provider. It is not a credential. */
const INVALID_KEY = 'mayura-live-check-deliberately-invalid-key';
const ROUTER_ID = 'live.router';

export class Refusal extends Error {
  constructor(problems, skipped = []) { super('The live check refused to run.'); this.problems = problems; this.skipped = skipped; }
}

/**
 * Read the configuration from explicitly named variables only. The opt-in for a provider is its model variable; once a
 * provider is opted in, its credential and prices are required. Nothing here enumerates the environment.
 */
export function readConfig(env) {
  const problems = []; const secrets = []; const warnings = [];
  const text = name => { const value = env[name]; return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; };
  const amount = (name, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const raw = text(name);
    if (raw === undefined) { if (fallback === undefined) problems.push(`${name} is required.`); return fallback; }
    const value = /^\d{1,16}$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) { problems.push(`${name} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}.`); return undefined; }
    return value;
  };
  const secret = name => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') { problems.push(`${name} is required for the selected provider.`); return undefined; }
    secrets.push(value); return value;
  };
  const optionalSecret = name => { const value = env[name]; if (typeof value !== 'string' || value.trim() === '') return undefined; secrets.push(value); return value; };
  const pricing = prefix => ({ inputMicrosPerMillionTokens: amount(`${prefix}_INPUT_MICROS_PER_MILLION_TOKENS`),
    outputMicrosPerMillionTokens: amount(`${prefix}_OUTPUT_MICROS_PER_MILLION_TOKENS`) });

  const maxCallCostMicros = amount('MAYURA_LIVE_MAX_CALL_COST_MICROS');
  const maxTotalCostMicros = amount('MAYURA_LIVE_MAX_TOTAL_COST_MICROS');
  const timeoutMs = amount('MAYURA_LIVE_TIMEOUT_MS', 60_000, 600_000);
  const maxOutputTokens = amount('MAYURA_LIVE_MAX_OUTPUT_TOKENS', 1_024, 65_536);
  let checks = [...CHECKS];
  const selectedChecks = text('MAYURA_LIVE_CHECKS');
  if (selectedChecks !== undefined) {
    checks = [...new Set(selectedChecks.split(',').map(item => item.trim()).filter(Boolean))];
    if (checks.length === 0 || checks.some(check => !CHECKS.includes(check))) problems.push(`MAYURA_LIVE_CHECKS must list some of: ${CHECKS.join(', ')}.`);
  }

  const providers = []; const skipped = [];
  const openaiModel = text('MAYURA_LIVE_OPENAI_MODEL');
  if (openaiModel) providers.push({ provider: 'openai', kind: 'openai', adapterId: 'openai.responses', model: openaiModel,
    apiKey: secret('OPENAI_API_KEY'), pricing: pricing('MAYURA_LIVE_OPENAI') });
  else skipped.push({ provider: 'openai', reason: 'MAYURA_LIVE_OPENAI_MODEL is not set.' });
  const anthropicModel = text('MAYURA_LIVE_ANTHROPIC_MODEL');
  if (anthropicModel) providers.push({ provider: 'anthropic', kind: 'anthropic', adapterId: 'anthropic.messages', model: anthropicModel,
    apiKey: secret('ANTHROPIC_API_KEY'), pricing: pricing('MAYURA_LIVE_ANTHROPIC') });
  else skipped.push({ provider: 'anthropic', reason: 'MAYURA_LIVE_ANTHROPIC_MODEL is not set.' });
  const compatible = text('MAYURA_LIVE_COMPATIBLE');
  if (compatible) {
    const seen = new Set();
    for (const id of compatible.split(',').map(item => item.trim()).filter(Boolean)) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id) || seen.has(id)) { problems.push('MAYURA_LIVE_COMPATIBLE must list distinct lower-case provider ids (a-z, 0-9, -).'); continue; }
      seen.add(id);
      const prefix = `MAYURA_LIVE_COMPATIBLE_${id.toUpperCase().replaceAll('-', '_')}`;
      const endpoint = text(`${prefix}_URL`); const model = text(`${prefix}_MODEL`); const auth = text(`${prefix}_AUTH`) ?? 'bearer';
      if (!endpoint) problems.push(`${prefix}_URL is required for the selected provider.`);
      if (!model) problems.push(`${prefix}_MODEL is required for the selected provider.`);
      if (auth !== 'bearer' && auth !== 'api-key') problems.push(`${prefix}_AUTH must be bearer or api-key.`);
      // A gateway (Cloudflare AI Gateway) takes its own token; with keys stored in the gateway, no provider key is sent.
      const gatewayToken = optionalSecret(`${prefix}_GATEWAY_TOKEN`);
      const output = text(`${prefix}_OUTPUT`) ?? 'json_schema';
      if (output !== 'json_schema' && output !== 'json_object') problems.push(`${prefix}_OUTPUT must be json_schema or json_object.`);
      const strict = text(`${prefix}_STRICT_TOOLS`) ?? 'false';
      if (strict !== 'true' && strict !== 'false') problems.push(`${prefix}_STRICT_TOOLS must be true or false.`);
      // The images a compatible model can see; without it the vision checks are skipped for this provider.
      const mediaTypes = text(`${prefix}_MEDIA`)?.split(',').map(item => item.trim()).filter(Boolean);
      if (mediaTypes && mediaTypes.some(type => !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'].includes(type))) {
        problems.push(`${prefix}_MEDIA must list media types such as image/png,image/jpeg.`);
      }
      const tokenLimitField = text(`${prefix}_TOKEN_LIMIT_FIELD`) ?? 'max_tokens';
      if (tokenLimitField !== 'max_tokens' && tokenLimitField !== 'max_completion_tokens') problems.push(`${prefix}_TOKEN_LIMIT_FIELD must be max_tokens or max_completion_tokens.`);
      let body;
      const rawBody = text(`${prefix}_BODY`);
      if (rawBody !== undefined) {
        try { body = JSON.parse(rawBody); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
        catch { problems.push(`${prefix}_BODY must be a JSON object of extra request fields, such as {"thinking":{"type":"disabled"}}.`); body = undefined; }
      }
      providers.push({ provider: `compatible:${id}`, kind: 'compatible', id, adapterId: `openai-compatible.${id}`, endpoint, auth, model,
        apiKey: gatewayToken ? optionalSecret(`${prefix}_KEY`) : secret(`${prefix}_KEY`), gatewayToken, output, strictTools: strict === 'true', tokenLimitField, ...(mediaTypes ? { mediaTypes } : {}),
        ...(body ? { body } : {}), pricing: pricing(prefix), variablePrefix: prefix });
    }
  } else skipped.push({ provider: 'compatible', reason: 'MAYURA_LIVE_COMPATIBLE is not set.' });
  if (providers.length === 0) problems.push('No provider is selected: set MAYURA_LIVE_OPENAI_MODEL, MAYURA_LIVE_ANTHROPIC_MODEL or MAYURA_LIVE_COMPATIBLE.');
  if (problems.length > 0) throw new Refusal(problems, skipped);

  const config = { providers, skipped, checks, maxCallCostMicros, maxTotalCostMicros, timeoutMs, maxOutputTokens, secrets };
  // Constructing an adapter sends nothing; it validates the endpoint, credential shape and prices before any spend.
  for (const provider of providers) {
    try { adapterFor(config, provider, { outputJsonSchema: STRUCTURED.jsonSchema }); }
    catch (error) { problems.push(`${provider.variablePrefix ?? provider.provider} configuration was refused by the adapter: ${safeError(error).message}`); }
    const outputBound = Math.ceil(maxOutputTokens * provider.pricing.outputMicrosPerMillionTokens / 1_000_000);
    if (outputBound > maxCallCostMicros) warnings.push(`${provider.provider}: MAYURA_LIVE_MAX_OUTPUT_TOKENS at its output price may cost ${outputBound} micros, above the per-call bound; a long answer would exceed the bound and fail.`);
  }
  const plannedWorstCaseMicros = providers.length * checks.reduce((sum, check) => sum + WORST_CASE_BOUNDS[check], 0) * maxCallCostMicros;
  if (plannedWorstCaseMicros > maxTotalCostMicros) {
    problems.push(`MAYURA_LIVE_MAX_TOTAL_COST_MICROS (${maxTotalCostMicros}) is below the planned worst case of ${plannedWorstCaseMicros} micros; raise it, lower MAYURA_LIVE_MAX_CALL_COST_MICROS or narrow MAYURA_LIVE_CHECKS.`);
  }
  if (problems.length > 0) throw new Refusal(problems, skipped);
  return Object.freeze({ ...config, warnings, plannedWorstCaseMicros });
}

/** The adapter for one provider. `invalid` replaces its credential (the gateway token, when it has one) with a wrong one. */
function adapterFor(config, provider, { outputJsonSchema, invalid = false, transport }) {
  const common = { model: provider.model, outputJsonSchema, maxCostMicros: config.maxCallCostMicros, pricing: provider.pricing,
    timeoutMs: config.timeoutMs, ...(transport ? { fetch: transport } : {}) };
  const apiKey = invalid && !provider.gatewayToken ? INVALID_KEY : provider.apiKey;
  if (provider.kind === 'openai') return openAIResponses({ apiKey, ...common });
  if (provider.kind === 'anthropic') return anthropicMessages({ apiKey, ...common });
  return openAICompatibleChat({ endpoint: provider.endpoint, remote: { id: provider.id, auth: provider.auth }, ...(apiKey ? { apiKey } : {}), ...common,
    ...(provider.gatewayToken ? { headers: { 'cf-aig-authorization': `Bearer ${invalid ? INVALID_KEY : provider.gatewayToken}` } } : {}),
    output: provider.output, strictTools: provider.strictTools, tokenLimitField: provider.tokenLimitField,
    ...(provider.mediaTypes ? { media: { types: provider.mediaTypes, urls: false } } : {}), ...(provider.body ? { body: provider.body } : {}) });
}

/** Only a Mayura public error's code and message are reported; anything else is reduced to a fixed code. */
function safeError(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' && /^[A-Z_]{1,40}$/u.test(error.code) ? error.code : undefined;
  return code ? { code, message: String(error.message).slice(0, 300) } : { code: 'HARNESS_ERROR', message: 'The check raised an unexpected error.' };
}

// ---- The agents. Provider JSON Schemas stay minimal (types, required, no extra properties); the zod schemas that the
// runtime validates are stricter.
const strictObject = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const STRUCTURED = Object.freeze({
  instructions: 'You are a precise assistant. Answer with the requested fields only.',
  question: 'What is the capital city of France? Give the city name and the ISO 3166-1 alpha-2 code of its country.',
  jsonSchema: strictObject({ city: { type: 'string' }, countryCode: { type: 'string' } }),
  output: z.object({ city: z.string().min(1).max(100), countryCode: z.string().regex(/^[A-Z]{2}$/u) }).strict(),
  expected: output => output.countryCode === 'FR' && /paris/iu.test(output.city),
});
const TOOLS = Object.freeze({
  instructions: 'Use the tool to look up the verification code registered under the name "alpha". Then answer with that code, copied exactly as the tool returned it.',
  question: 'What is the verification code registered under "alpha"?',
  jsonSchema: strictObject({ code: { type: 'string' } }),
  output: z.object({ code: z.string().min(1).max(64) }).strict(),
});
const STREAMING = Object.freeze({
  instructions: 'Answer in the reply field with three short plain-text sentences.',
  question: 'Why do rivers matter to cities?',
  jsonSchema: strictObject({ reply: { type: 'string' } }),
  output: z.object({ reply: z.string().min(40).max(2_000) }).strict(),
});
const questionInput = z.object({ question: z.string().min(1).max(500) }).strict();
const VISION = Object.freeze({
  instructions: 'Read the six-digit number written in the image. Answer with the digits only, in the seen field.',
  toolInstructions: 'Call the screenshot tool, then read the six-digit number written in the screenshot it returns. Answer with the digits only, in the seen field.',
  question: 'What is the number in the image?',
  jsonSchema: strictObject({ seen: { type: 'string' } }),
  output: z.object({ seen: z.string().min(1).max(64) }).strict(),
});

// ---- A PNG with a number drawn in it: large black seven-segment digits on white, as on a calculator, so no two digits
// look alike. Only a model that reads the pixels can answer. The number is also stored in a tEXt chunk, which only the
// dry run's fake provider reads.
const SEGMENTS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function pngChunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
export function numberImage(code) {
  const digitWidth = 60; const digitHeight = 110; const stroke = 12; const gap = 28; const margin = 40;
  const width = margin * 2 + code.length * (digitWidth + gap) - gap; const height = margin * 2 + digitHeight;
  const rows = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0; // filter byte: none
  const box = (left, top, boxWidth, boxHeight) => { for (let y = top; y < top + boxHeight; y++) rows.fill(0, y * (width + 1) + 1 + left, y * (width + 1) + 1 + left + boxWidth); };
  [...code].forEach((digit, position) => {
    const x = margin + position * (digitWidth + gap); const y = margin; const middle = y + (digitHeight - stroke) / 2;
    const half = (digitHeight - stroke) / 2 + stroke;
    const draw = { a: () => box(x, y, digitWidth, stroke), d: () => box(x, y + digitHeight - stroke, digitWidth, stroke), g: () => box(x, middle, digitWidth, stroke),
      f: () => box(x, y, stroke, half), b: () => box(x + digitWidth - stroke, y, stroke, half),
      e: () => box(x, middle, stroke, digitHeight - (middle - y)), c: () => box(x + digitWidth - stroke, middle, stroke, digitHeight - (middle - y)) };
    for (const segment of SEGMENTS[digit]) draw[segment]();
  });
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from(`mayura-code\0${code}`, 'latin1')), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]));
}
/**
 * Whether a model read the drawn number: at least five of its six digits, in place. The checks qualify that the image
 * reaches the model, not how well the model reads; a model that could not see would match by chance about once in
 * 20,000 tries.
 */
function readNumber(answer, code) {
  const digits = String(answer).replace(/\D/gu, '');
  return digits.length === code.length && [...code].filter((digit, index) => digits[index] === digit).length >= code.length - 1;
}
/** The number stored in a PNG's tEXt chunk (dry run only). */
function numberInImage(bytes) {
  const buffer = Buffer.from(bytes); let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset); const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'tEXt') { const [key, value] = buffer.toString('latin1', offset + 8, offset + 8 + length).split('\0'); if (key === 'mayura-code') return value; }
    offset += 12 + length;
  }
  return undefined;
}

/** A transparent pass-through that records each call's reported cost and how many deltas the provider streamed. */
function metered(adapter) {
  const calls = [];
  const start = mode => { const call = { mode, outcome: 'failed', costMicros: null, providerDeltas: 0 }; calls.push(call); return call; };
  const settle = (call, response) => {
    const cost = response?.usage?.costMicros;
    call.outcome = 'succeeded'; call.costMicros = Number.isSafeInteger(cost) ? cost : null; call.response = response?.type;
  };
  const wrapped = {
    id: adapter.id, capabilities: adapter.capabilities, maxCostMicros: adapter.maxCostMicros,
    async generate(request) {
      const call = start('generate');
      try { const response = await adapter.generate(request); settle(call, response); return response; }
      catch (error) { call.errorCode = safeError(error).code; throw error; }
    },
    ...(typeof adapter.stream === 'function' ? {
      async *stream(request) {
        const call = start('stream');
        try {
          for await (const event of adapter.stream(request)) {
            if (event?.type === 'output.delta') call.providerDeltas += 1;
            else if (event?.type === 'response') settle(call, event.response);
            yield event;
          }
        } catch (error) { call.errorCode = safeError(error).code; throw error; }
      },
    } : {}),
  };
  return { adapter: wrapped, calls };
}

async function execute({ agent, input, grants, limits, media: attached }) {
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: grants }, limits });
  try {
    const handle = runtime.submit(agent, { input, ...(attached ? { media: attached } : {}) });
    const outcome = await handle.result(); const events = [];
    for await (const event of handle.observe()) events.push(event);
    const budget = runtime.inspect(handle).budget;
    return { outcome, events, spentMicros: Number(budget.spentMicros), reservedMicros: budget.reservedMicros };
  } finally { await runtime.close(); }
}

/** The streamed-output evidence shared by the direct and the router streaming checks. */
function streamEvidence(run, meter, guardChecks) {
  const failures = []; const deltas = run.events.filter(event => event.type === 'output.delta');
  const reply = run.outcome.status === 'succeeded' ? run.outcome.output.reply : undefined;
  const streamed = meter.calls.filter(call => call.mode === 'stream');
  if (streamed.length !== 1 || meter.calls.length !== 1) failures.push('The agent did not make exactly one streamed model call.');
  const providerDeltas = streamed.reduce((sum, call) => sum + call.providerDeltas, 0);
  if (providerDeltas < 2) failures.push('The provider did not stream its answer incrementally (fewer than 2 deltas).');
  if (deltas.length < 1) failures.push('No output.delta event was released.');
  if (deltas.some((event, index) => event.metadata['index'] !== index)) failures.push('output.delta indexes are not in order.');
  if (deltas.some((event, index) => index > 0 && event.sequence <= deltas[index - 1].sequence)) failures.push('output.delta events are out of sequence.');
  if (new Set(deltas.map(event => event.metadata['modelCall'])).size > 1) failures.push('output.delta events span several model calls.');
  if (reply !== undefined && deltas.map(event => event.metadata['text']).join('') !== reply) failures.push('The streamed text does not concatenate to the final field.');
  if (guardChecks.count !== deltas.length) failures.push('Not every released batch passed the batch guard.');
  if (run.events.some(event => event.type === 'output.withheld' || event.type === 'events.gap')) failures.push('The stream was withheld or has an event gap.');
  if (!(streamed[0]?.costMicros > 0)) failures.push('The streamed response did not report usage.');
  return { failures, deltas: deltas.length, providerDeltas };
}

/**
 * Run every selected check for every selected provider. `transport(provider)` supplies a fake fetch for the dry run;
 * in a live run it is absent and the adapters use their fixed provider destinations.
 */
export async function runHarness({ env, transport, mode = 'live' }) {
  const config = readConfig(env);
  if (mode === 'dry-run' && typeof transport !== 'function') throw new Error('A dry run requires fake transports.');
  const ledger = { chargedMicros: 0 };
  const report = { harness: 'mayura.provider-live-check', version: 1, mode, status: 'passed',
    caps: { maxCallCostMicros: config.maxCallCostMicros, maxTotalCostMicros: config.maxTotalCostMicros, plannedWorstCaseMicros: config.plannedWorstCaseMicros },
    settings: { timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, checks: config.checks },
    warnings: config.warnings, providers: [], totals: { chargedMicros: 0 }, summary: {} };

  for (const provider of config.providers) {
    const fetch = transport?.(provider);
    const make = (outputJsonSchema, invalid = false) => adapterFor(config, provider, { outputJsonSchema, invalid, transport: fetch });
    const bound = config.maxCallCostMicros;
    const costRecords = [];
    /** Run one agent under a run budget of `bounds` per-call bounds, charging the harness ledger conservatively. */
    const run = async (check, bounds, options) => {
      const maxCostMicros = bounds * bound;
      if (ledger.chargedMicros + maxCostMicros > config.maxTotalCostMicros) throw Object.assign(new Error(), { capReached: true });
      const limits = { maxModelCalls: options.modelCalls ?? 1, maxToolCalls: options.toolCalls ?? 0, maxSteps: options.modelCalls ?? 1,
        maxOutputTokens: config.maxOutputTokens, maxCostMicros, maxDurationMs: bounds * config.timeoutMs + 15_000 };
      const result = await execute({ ...options, limits });
      const chargedMicros = result.spentMicros + result.reservedMicros; ledger.chargedMicros += chargedMicros;
      costRecords.push({ check, chargedMicros, maxCostMicros, reservedMicros: result.reservedMicros, spentMicros: result.spentMicros, calls: options.meter.calls, attempts: options.attempts });
      return { ...result, chargedMicros };
    };
    const outcomeFailure = result => result.outcome.status === 'succeeded' ? [] : [`The run ended ${result.outcome.status}.`];
    // The vision checks need a model that can see PNG images.
    const seesImages = make(VISION.jsonSchema).capabilities.media?.types.includes('image/png') === true;
    const noVision = provider.kind === 'compatible' ? `The adapter declares no image input; set ${provider.variablePrefix}_MEDIA=image/png,image/jpeg for a model that can see.`
      : 'The adapter declares no image input.';

    const implementations = {
      async structured() {
        const meter = metered(make(STRUCTURED.jsonSchema));
        const agent = defineAgent({ id: 'live.structured', version: '1', instructions: STRUCTURED.instructions, input: questionInput, output: STRUCTURED.output, tools: [], model: meter.adapter });
        const result = await run('structured', WORST_CASE_BOUNDS.structured, { agent, meter, input: { question: STRUCTURED.question }, grants: [`model:${provider.adapterId}`] });
        const failures = outcomeFailure(result);
        if (result.outcome.status === 'succeeded' && !STRUCTURED.expected(result.outcome.output)) failures.push('The schema-valid answer did not match the expected facts.');
        return { failures, result, modelCalls: meter.calls.length };
      },
      async tools() {
        const nonce = `LC-${randomBytes(4).toString('hex').toUpperCase()}`; const executions = [];
        const lookup = defineTool({ id: 'live.lookup_code', version: '1', description: 'Returns the verification code registered under a name.',
          input: z.object({ name: z.string().min(1).max(32) }).strict(), output: z.object({ code: z.string() }).strict(),
          inputJsonSchema: strictObject({ name: { type: 'string' } }), effects: 'none', capabilities: [], costMicros: 0,
          execute: ({ name }) => { executions.push(name); return { code: nonce }; } });
        const meter = metered(make(TOOLS.jsonSchema));
        const agent = defineAgent({ id: 'live.tools', version: '1', instructions: TOOLS.instructions, input: questionInput, output: TOOLS.output, tools: [lookup], model: meter.adapter });
        const result = await run('tools', WORST_CASE_BOUNDS.tools, { agent, meter, input: { question: TOOLS.question }, modelCalls: 3, toolCalls: 2,
          grants: [`model:${provider.adapterId}`, 'tool:live.lookup_code'] });
        const failures = outcomeFailure(result);
        const completed = result.events.filter(event => event.type === 'tool.completed' && event.metadata['toolId'] === 'live.lookup_code' && event.metadata['status'] === 'succeeded');
        if (executions.length < 1 || completed.length < 1) failures.push('The model did not call the local tool.');
        if (!meter.calls.some(call => call.response === 'tool_calls')) failures.push('No model response proposed a tool call.');
        if (result.outcome.status === 'succeeded' && result.outcome.output.code !== nonce) failures.push('The final answer did not use the tool result.');
        return { failures, result, modelCalls: meter.calls.length, details: { toolExecutions: executions.length } };
      },
      async streaming() {
        const guardChecks = { count: 0 };
        const meter = metered(make(STREAMING.jsonSchema));
        const agent = defineAgent({ id: 'live.streaming', version: '1', instructions: STREAMING.instructions, input: questionInput, output: STREAMING.output, tools: [], model: meter.adapter,
          stream: { field: ['reply'], guards: [{ id: 'live.batch-allow', check: () => { guardChecks.count += 1; return { decision: 'allow' }; } }], batch: { minChars: 8, maxChars: 64 } } });
        const result = await run('streaming', WORST_CASE_BOUNDS.streaming, { agent, meter, input: { question: STREAMING.question }, grants: [`model:${provider.adapterId}`] });
        const evidence = streamEvidence(result, meter, guardChecks);
        return { failures: [...outcomeFailure(result), ...evidence.failures], result, modelCalls: meter.calls.length, details: { deltas: evidence.deltas, providerDeltas: evidence.providerDeltas } };
      },
      async router_failover() { return routed(false); },
      async router_streaming() { return routed(true); },
      // (e) The model reads an image sent with the input, and (f) one returned by a tool (such as a screenshot).
      async vision() {
        if (!seesImages) return { skip: noVision };
        const code = String(randomInt(100_000, 1_000_000));
        const meter = metered(make(VISION.jsonSchema));
        const agent = defineAgent({ id: 'live.vision', version: '1', instructions: VISION.instructions, input: questionInput, output: VISION.output, tools: [], model: meter.adapter,
          media: { accept: ['image/png'] } });
        const result = await run('vision', WORST_CASE_BOUNDS.vision, { agent, meter, input: { question: VISION.question }, grants: [`model:${provider.adapterId}`],
          media: [media(numberImage(code), 'image/png', { name: 'number.png' })] });
        const failures = outcomeFailure(result);
        if (result.outcome.status === 'succeeded' && !readNumber(result.outcome.output.seen, code)) failures.push('The model did not read the number in the image.');
        return { failures, result, modelCalls: meter.calls.length };
      },
      async vision_tools() {
        if (!seesImages) return { skip: noVision };
        const code = String(randomInt(100_000, 1_000_000)); let taken = 0;
        const screenshot = defineTool({ id: 'live.screenshot', version: '1', description: 'Takes a screenshot of the screen.',
          input: z.object({}).strict(), output: z.object({ taken: z.boolean() }).strict(), inputJsonSchema: strictObject({}),
          effects: 'none', capabilities: [], costMicros: 0, media: { accept: ['image/png'] },
          execute: () => { taken += 1; return withMedia({ taken: true }, [media(numberImage(code), 'image/png', { name: 'screen.png' })]); } });
        const meter = metered(make(VISION.jsonSchema));
        const agent = defineAgent({ id: 'live.vision-tools', version: '1', instructions: VISION.toolInstructions, input: questionInput, output: VISION.output, tools: [screenshot], model: meter.adapter });
        const result = await run('vision_tools', WORST_CASE_BOUNDS.vision_tools, { agent, meter, input: { question: VISION.question }, modelCalls: 3, toolCalls: 2,
          grants: [`model:${provider.adapterId}`, 'tool:live.screenshot'] });
        const failures = outcomeFailure(result);
        if (taken < 1) failures.push('The model did not call the screenshot tool.');
        if (result.outcome.status === 'succeeded' && !readNumber(result.outcome.output.seen, code)) failures.push('The model did not read the number in the tool\'s screenshot.');
        return { failures, result, modelCalls: meter.calls.length };
      },
    };
    /** Route 0 is this provider with a deliberately invalid key; route 1 is the valid one. */
    const routed = async streamed => {
      const check = streamed ? 'router_streaming' : 'router_failover'; const spec = streamed ? STREAMING : STRUCTURED;
      const attempts = []; const guardChecks = { count: 0 };
      const router = createModelRouter({ id: ROUTER_ID, routes: [make(spec.jsonSchema, true), make(spec.jsonSchema)], onAttempt: attempt => attempts.push(attempt) });
      const meter = metered(router);
      const agent = defineAgent({ id: `live.${check.replace('_', '-')}`, version: '1', instructions: spec.instructions, input: questionInput, output: spec.output, tools: [], model: meter.adapter,
        ...(streamed ? { stream: { field: ['reply'], guards: [{ id: 'live.batch-allow', check: () => { guardChecks.count += 1; return { decision: 'allow' }; } }], batch: { minChars: 8, maxChars: 64 } } } : {}) });
      const result = await run(check, WORST_CASE_BOUNDS[check], { agent, meter, attempts, input: { question: spec.question }, grants: [`model:${ROUTER_ID}`] });
      const failures = outcomeFailure(result);
      const [first, second] = attempts;
      if (attempts.length !== 2 || first.route !== 0 || first.outcome !== 'failed' || second.route !== 1 || second.outcome !== 'succeeded') {
        failures.push('The router did not fail over from the invalid-key route to the valid route.');
      } else {
        if (first.costMicros !== null) failures.push('The refused route reported a confirmed cost.');
        // Documented rule: a failed attempt with unknown cost is charged its full bound; the call reports the sum.
        const expected = bound + second.costMicros;
        if (result.spentMicros !== expected || result.reservedMicros !== 0) failures.push('The router charge does not follow the documented rule (full bound of the refused route plus the confirmed cost).');
      }
      if (streamed) failures.push(...streamEvidence(result, meter, guardChecks).failures);
      else if (result.outcome.status === 'succeeded' && !STRUCTURED.expected(result.outcome.output)) failures.push('The schema-valid answer did not match the expected facts.');
      return { failures, result, modelCalls: meter.calls.length, details: { attempts: attempts.map(({ route, outcome, reason, costMicros }) => ({ route, outcome, ...(reason ? { reason } : {}), costMicros })),
        confirmedMicros: attempts.reduce((sum, attempt) => sum + (attempt.costMicros ?? 0), 0) } };
    };

    const checks = [];
    for (const check of CHECKS) {
      if (!config.checks.includes(check)) { checks.push({ check, status: 'skipped', reason: 'Not selected by MAYURA_LIVE_CHECKS.' }); continue; }
      const started = performance.now(); let entry;
      try {
        const done = await implementations[check]();
        if (done.skip) { checks.push({ check, status: 'skipped', reason: done.skip }); continue; }
        const { failures, result, modelCalls, details } = done;
        entry = { check, status: failures.length === 0 ? 'passed' : 'failed', ...(failures.length ? { reasons: failures } : {}),
          ...(result.outcome.status === 'succeeded' ? {} : { error: safeError(result.outcome.error) }), chargedMicros: result.chargedMicros, modelCalls, ...(details ? { details } : {}) };
      } catch (error) {
        entry = error?.capReached ? { check, status: 'failed', reasons: ['Not run: the total cost cap would be exceeded.'] }
          : { check, status: 'failed', reasons: ['The check could not run.'], error: safeError(error) };
      }
      checks.push({ ...entry, durationMs: Math.round(performance.now() - started) });
    }
    checks.push(costCheck(costRecords, bound, ledger, config));
    report.providers.push({ provider: provider.provider, adapterId: provider.adapterId, model: provider.model,
      status: checks.some(check => check.status === 'failed') ? 'failed' : 'passed', checks });
  }
  for (const { provider, reason } of config.skipped) report.providers.push({ provider, status: 'skipped', reason, checks: [] });

  const all = report.providers.flatMap(provider => provider.checks);
  report.totals.chargedMicros = ledger.chargedMicros;
  report.summary = { selectedProviders: config.providers.length, skippedProviders: config.skipped.length,
    passed: all.filter(check => check.status === 'passed').length, failed: all.filter(check => check.status === 'failed').length, skipped: all.filter(check => check.status === 'skipped').length };
  if (report.summary.failed > 0 || ledger.chargedMicros > config.maxTotalCostMicros) report.status = 'failed';
  return redact(report, config.secrets);
}

/** (d) Every confirmed call cost is positive and within its bound, runs settle within their budgets, the total within the cap. */
function costCheck(records, bound, ledger, config) {
  if (records.length === 0) return { check: 'cost', status: 'skipped', reason: 'No check ran a model call.' };
  const failures = []; let confirmedCalls = 0;
  for (const record of records) {
    const costs = record.attempts ? record.attempts.filter(attempt => attempt.outcome === 'succeeded').map(attempt => attempt.costMicros)
      : record.calls.filter(call => call.outcome === 'succeeded').map(call => call.costMicros);
    for (const cost of costs) {
      confirmedCalls += 1;
      if (!Number.isSafeInteger(cost) || cost <= 0) failures.push(`${record.check}: a call reported no positive cost.`);
      else if (cost > bound) failures.push(`${record.check}: a call cost more than the per-call bound.`);
    }
    if (record.chargedMicros > record.maxCostMicros) failures.push(`${record.check}: the run was charged more than its budget.`);
    if (!record.attempts && record.calls.every(call => call.outcome === 'succeeded') && record.spentMicros !== costs.reduce((sum, cost) => sum + cost, 0)) {
      failures.push(`${record.check}: the run budget does not equal the sum of the reported call costs.`);
    }
  }
  if (confirmedCalls === 0) failures.push('No call confirmed its cost.');
  if (ledger.chargedMicros > config.maxTotalCostMicros) failures.push('The harness total exceeded MAYURA_LIVE_MAX_TOTAL_COST_MICROS.');
  return { check: 'cost', status: failures.length === 0 ? 'passed' : 'failed', ...(failures.length ? { reasons: failures } : {}),
    details: { confirmedCalls, runChargedMicros: records.reduce((sum, record) => sum + record.chargedMicros, 0), harnessChargedMicros: ledger.chargedMicros } };
}

/** Defence in depth: no configured credential can appear in anything printed, whatever produced it. */
function redact(value, secrets) {
  let text = JSON.stringify(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  }
  return JSON.parse(text);
}

// ---- Dry run: deterministic fake transports that speak each provider's wire protocol, offline.

const DRY_RUN_PRICES = { INPUT_MICROS_PER_MILLION_TOKENS: '2000000', OUTPUT_MICROS_PER_MILLION_TOKENS: '8000000' };
const prices = prefix => Object.fromEntries(Object.entries(DRY_RUN_PRICES).map(([key, value]) => [`${prefix}_${key}`, value]));
/** Fixture configuration for the dry run. The credentials are fixed placeholders, and hosts under .invalid cannot resolve. */
export const DRY_RUN_ENV = Object.freeze({
  MAYURA_LIVE_MAX_CALL_COST_MICROS: '5000', MAYURA_LIVE_MAX_TOTAL_COST_MICROS: '400000', MAYURA_LIVE_MAX_OUTPUT_TOKENS: '256', MAYURA_LIVE_TIMEOUT_MS: '10000',
  OPENAI_API_KEY: 'dry-run-openai-credential', MAYURA_LIVE_OPENAI_MODEL: 'dry-run-openai-model', ...prices('MAYURA_LIVE_OPENAI'),
  ANTHROPIC_API_KEY: 'dry-run-anthropic-credential', MAYURA_LIVE_ANTHROPIC_MODEL: 'dry-run-anthropic-model', ...prices('MAYURA_LIVE_ANTHROPIC'),
  MAYURA_LIVE_COMPATIBLE: 'groq,azure,cloudflare',
  MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_URL: 'https://gateway.dry-run.invalid/v1/account/gateway/compat/chat/completions',
  MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_GATEWAY_TOKEN: 'dry-run-gateway-credential', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_MODEL: 'deepseek/dry-run-model',
  MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_OUTPUT: 'json_object', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_STRICT_TOOLS: 'true',
  MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_BODY: '{"thinking":{"type":"enabled"}}', ...prices('MAYURA_LIVE_COMPATIBLE_CLOUDFLARE'),
  MAYURA_LIVE_COMPATIBLE_GROQ_URL: 'https://groq.dry-run.invalid/openai/v1/chat/completions', MAYURA_LIVE_COMPATIBLE_GROQ_KEY: 'dry-run-groq-credential',
  MAYURA_LIVE_COMPATIBLE_GROQ_MODEL: 'dry-run-compatible-model', MAYURA_LIVE_COMPATIBLE_GROQ_MEDIA: 'image/png,image/jpeg', ...prices('MAYURA_LIVE_COMPATIBLE_GROQ'),
  MAYURA_LIVE_COMPATIBLE_AZURE_URL: 'https://azure.dry-run.invalid/openai/deployments/fixture/chat/completions?api-version=2024-10-21',
  MAYURA_LIVE_COMPATIBLE_AZURE_AUTH: 'api-key', MAYURA_LIVE_COMPATIBLE_AZURE_KEY: 'dry-run-azure-credential',
  MAYURA_LIVE_COMPATIBLE_AZURE_MODEL: 'dry-run-compatible-model', ...prices('MAYURA_LIVE_COMPATIBLE_AZURE'),
});
/** Faults a dry run can inject to prove the checks fail when the behaviour they qualify is missing. */
export const DRY_RUN_FAULTS = Object.freeze(['ignore-tool-result', 'single-chunk-stream', 'overcharge', 'accept-invalid-key', 'blind']);

const REPLY = 'Rivers carried trade into early cities. They still supply water and cool dense streets. Healthy banks also soften floods.';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const chunks = (text, single) => single ? [text] : text.match(/[\s\S]{1,12}/gu);

/** A scripted provider for one configured provider: it checks destination and credential, then answers by protocol. */
export function dryRunTransport(provider, fault) {
  if (fault !== undefined && !DRY_RUN_FAULTS.includes(fault)) throw new Error('Unknown dry-run fault.');
  const destination = provider.kind === 'openai' ? 'https://api.openai.com/v1/responses' : provider.kind === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : new URL(provider.endpoint).href;
  const usage = { input: 120, output: fault === 'overcharge' ? 10_000_000 : 30 };
  return async (url, init) => {
    const headers = init?.headers ?? {};
    const presented = provider.kind === 'anthropic' ? headers['x-api-key'] : provider.gatewayToken ? headers['cf-aig-authorization']?.replace(/^Bearer /u, '')
      : provider.kind === 'compatible' && provider.auth === 'api-key' ? headers['api-key'] : headers['Authorization']?.replace(/^Bearer /u, '');
    const expected = provider.gatewayToken ?? provider.apiKey;
    if (String(url) !== destination || init?.method !== 'POST') return new Response('{"error":"not found"}', { status: 404 });
    if (presented !== expected && !(fault === 'accept-invalid-key' && presented === INVALID_KEY)) return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
    const body = JSON.parse(init.body);
    // Like DeepSeek with thinking on: a request with tools must carry back the reasoning of every earlier assistant turn.
    if (provider.body?.thinking?.type === 'enabled' && body.messages?.some(message => message.role === 'assistant' && typeof message.reasoning_content !== 'string')) {
      return new Response('{"error":{"message":"reasoning_content must be passed back"}}', { status: 400 });
    }
    if (provider.output === 'json_object' && (body.response_format?.type !== 'json_object' || (body.tools ?? []).some(tool => tool.function.strict !== true))) {
      return new Response('{"error":{"message":"unsupported response_format or non-strict tool"}}', { status: 400 });
    }
    const view = provider.kind === 'openai' ? { schema: body.text.format.schema, tool: body.tools[0]?.name, result: body.input.find(item => item.type === 'function_call_output')?.output }
      : provider.kind === 'anthropic' ? { schema: body.output_config.format.schema, tool: body.tools?.[0]?.name, result: body.messages.flatMap(message => message.content).find(block => block.type === 'tool_result')?.content }
        : { schema: body.response_format.type === 'json_object' ? JSON.parse(body.messages[0].content.split('JSON Schema:\n').at(-1)) : body.response_format.json_schema.schema,
          tool: body.tools?.[0]?.function.name, result: body.messages.find(message => message.role === 'tool')?.content };
    const properties = view.schema.properties;
    const needsTool = ('code' in properties || 'seen' in properties) && view.tool !== undefined && view.result === undefined;
    // The fake "sees" the last image in the request, in each provider's own format, by its tEXt chunk.
    const images = JSON.stringify(body).match(/(?:data:image\/png;base64,|"media_type":"image\/png","data":")([A-Za-z0-9+/=]+)/gu) ?? [];
    const lastImage = images.at(-1)?.replace(/^.*(?:base64,|"data":")/u, '');
    const seen = fault === 'blind' || !lastImage ? 'none' : numberInImage(Buffer.from(lastImage, 'base64')) ?? 'none';
    const answer = 'code' in properties ? { code: fault === 'ignore-tool-result' ? 'LC-00000000' : JSON.parse(view.result ?? '{}').code ?? 'missing' }
      : 'seen' in properties ? { seen } : 'reply' in properties ? { reply: REPLY } : { city: 'Paris', countryCode: 'FR' };
    const text = JSON.stringify(answer); const pieces = chunks(text, fault === 'single-chunk-stream');
    const toolArguments = 'seen' in properties ? {} : { name: 'alpha' };
    if (body.stream && needsTool) return new Response('{"error":"unsupported"}', { status: 500 });
    if (provider.kind === 'openai') {
      const output = needsTool ? [{ type: 'function_call', id: 'fc_dry', call_id: 'call_dry_1', name: view.tool, arguments: JSON.stringify(toolArguments), status: 'completed' }]
        : [{ type: 'message', id: 'msg_dry', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
      const response = { id: 'resp_dry', status: 'completed', output, usage: { input_tokens: usage.input, output_tokens: usage.output } };
      return body.stream ? sse([...pieces.map(delta => ({ type: 'response.output_text.delta', delta })), { type: 'response.completed', response }]) : json(response);
    }
    if (provider.kind === 'anthropic') {
      if (body.stream) {
        return sse([{ type: 'message_start', message: { id: 'msg_dry', type: 'message', role: 'assistant', content: [], usage: { input_tokens: usage.input, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, ...pieces.map(piece => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })),
          { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } }, { type: 'message_stop' }]);
      }
      return json({ id: 'msg_dry', type: 'message', role: 'assistant', stop_reason: needsTool ? 'tool_use' : 'end_turn', usage: { input_tokens: usage.input, output_tokens: usage.output },
        content: needsTool ? [{ type: 'tool_use', id: 'toolu_dry_1', name: view.tool, input: toolArguments }] : [{ type: 'text', text }] });
    }
    const tokens = { prompt_tokens: usage.input, completion_tokens: usage.output };
    if (body.stream) {
      return sse([...pieces.map((content, index) => ({ choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }] })),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: tokens }, '[DONE]']);
    }
    return json({ choices: [{ index: 0, finish_reason: needsTool ? 'tool_calls' : 'stop', message: needsTool
      ? { role: 'assistant', content: null, reasoning_content: 'The code comes from the tool.', tool_calls: [{ id: 'call_dry_1', type: 'function', function: { name: view.tool, arguments: JSON.stringify(toolArguments) } }] }
      : { role: 'assistant', content: text } }], usage: tokens });
  };
}

// ---- Command line.

const USAGE = 'Usage: node scripts/provider-live-check.mjs [--dry-run [--dry-run-fault=<fault>]]\nSee CONTRIBUTING.md for the environment variables.';
async function main(argv) {
  const dryRun = argv.includes('--dry-run'); const faultArgument = argv.find(argument => argument.startsWith('--dry-run-fault='));
  const fault = faultArgument?.slice('--dry-run-fault='.length);
  if (argv.includes('--help')) { console.log(USAGE); return 0; }
  if (argv.some(argument => argument !== '--dry-run' && argument !== faultArgument) || (fault !== undefined && (!dryRun || !DRY_RUN_FAULTS.includes(fault)))) {
    console.error(USAGE); return 2;
  }
  try {
    // A dry run never looks at the process environment, so it cannot pick up or send a real credential.
    const report = dryRun ? await runHarness({ env: DRY_RUN_ENV, mode: 'dry-run', transport: provider => dryRunTransport(provider, fault) })
      : await runHarness({ env: process.env, mode: 'live' });
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(JSON.stringify({ harness: 'mayura.provider-live-check', status: 'refused', problems: error.problems,
      skipped: error.skipped.map(({ provider, reason }) => ({ provider, status: 'skipped', reason })) }, null, 2));
    return 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
const self = import.meta.url;
if (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error(JSON.stringify({ harness: 'mayura.provider-live-check', status: 'failed', error: 'The harness failed unexpectedly.' }));
    process.exitCode = 1;
  });
}
