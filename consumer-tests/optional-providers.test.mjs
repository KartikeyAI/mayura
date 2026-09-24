import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicMessages } from '@mayura/provider-anthropic';
import { openAICompatibleChat } from '@mayura/provider-openai';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/provider-anthropic', '@mayura/provider-openai']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
let hostedUrl; let hostedHeaders;
const hosted = anthropicMessages({ apiKey: 'explicit', model: 'claude-fixture', outputJsonSchema: schema, maxCostMicros: 10,
  pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 }, fetch: async (url, init) => {
    hostedUrl = String(url); hostedHeaders = init.headers;
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"answer":1}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  } });
let localUrl; let localHeaders;
const local = openAICompatibleChat({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local', outputJsonSchema: schema,
  maxCostMicros: 0, pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, fetch: async (url, init) => {
    localUrl = String(url); localHeaders = init.headers;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":1}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  } });
const request = { instructions: 'Return JSON.', messages: [{ role: 'user', content: { question: 1 } }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 32 };
const [hostedResult, localResult] = await Promise.all([hosted.generate(request), local.generate(request)]);
assert.equal(hostedResult.type, 'final'); assert.equal(localResult.type, 'final');
assert.equal(hostedUrl, 'https://api.anthropic.com/v1/messages');
assert.equal(localUrl, 'http://127.0.0.1:11434/v1/chat/completions');
assert.equal(hostedHeaders['x-api-key'], 'explicit'); assert(!('Authorization' in localHeaders));
console.log(JSON.stringify({ status: 'passed', fixedHostedDestination: true, loopbackLocalDestination: true,
  explicitCredentials: true, structuredOutput: hostedResult.output.answer === 1 && localResult.output.answer === 1 }));
