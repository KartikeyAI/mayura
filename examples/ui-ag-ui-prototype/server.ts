import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { defineAgent, z } from 'mayura';
import { createAgUiAdapter } from 'mayura/ag-ui';
import type { AgUiRunInput } from 'mayura/ag-ui';
import type { ModelAdapter, ModelRequest, ModelResponse } from 'mayura/core';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { defineTool } from 'mayura/tools';
import { replyArtifactFixtures } from './src/artifact-fixtures.js';
import { attachmentContextDivider } from '@mayurajs/ui';
import { createThreadHistory, historyPath } from './thread-history-server.js';

const agentId = 'rollout-assistant';
const scope = { principalId: 'prototype-user', projectId: 'prototype-workspace' };
const sources = [
  {
    id: '1',
    title: 'Release runbook',
    detail: 'Release readiness · page 2',
    excerpt: 'Name the deploy owner before launch. Require passing CI, a verified migration and a successful staging smoke test.',
  },
  {
    id: '2',
    title: 'v1.3 staging notes',
    detail: 'Canary rollout · page 1',
    excerpt: 'Route 5% of traffic to the candidate. Observe the error rate and p95 latency for 15 minutes before expanding.',
  },
  {
    id: '3',
    title: 'Rollback guide',
    detail: 'Rollback triggers · page 3',
    excerpt: 'Revert if the error rate exceeds 1% or p95 latency rises 20% above the baseline.',
  },
];
const checklist = [
  'Confirm the deploy owner, CI, migrations, and staging smoke tests. [1]',
  'Start with 5% of traffic. Watch errors and latency for 15 minutes. [2]',
  'Revert if the error rate exceeds 1% or p95 latency rises by 20%. [3]',
];
const draft = {
  title: 'Rollout checklist',
  destination: 'Release workspace',
  content: checklist.map((item, index) => (index + 1) + '. ' + item).join('\n'),
};
const checklistReply = 'I’d start with a small rollout and expand only after the canary is healthy.\n\n' + draft.content;
const releaseReply = 'The staging notes call for a 5% canary and a 15-minute observation window. [2] '
  + 'Before opening traffic, confirm the deploy owner and verify the readiness checks. [1] '
  + 'Keep the rollback thresholds at hand while you watch the candidate. [3]';
const savedReply = 'Saved Rollout checklist to the Release workspace.';
const declinedReply = 'The rollout checklist was not saved. Your workspace is unchanged.';
const dashboardReply = 'Here’s the rollout dashboard. Start with 5% of traffic, then expand once the canary is healthy. [2]\n\n'
  + replyArtifactFixtures.map(({ id }) => '[[artifact:' + id + ']]').join('\n');
const publicReplies = [checklistReply, releaseReply, savedReply, declinedReply, dashboardReply];

function fixtureReply(request: ModelRequest): ModelResponse {
  request.signal.throwIfAborted();
  const turn = request.messages.findLastIndex(message => message.role === 'user');
  const user = request.messages[turn];
  const result = request.messages.slice(turn + 1).find(message => message.role === 'tool');
  const prompt = user?.role === 'user' && typeof user.content === 'string' ? user.content.split(attachmentContextDivider, 1)[0] ?? '' : '';
  const usage = { costMicros: 0 };
  if (result) {
    const value = result.result;
    const saved = value && typeof value === 'object' && !Array.isArray(value) && 'saved' in value && value.saved === true;
    return { type: 'final', output: { reply: saved ? savedReply : declinedReply }, usage };
  }
  if (/\b(save|write|publish|create|add)\b/i.test(prompt)) {
    return { type: 'tool_calls', calls: [{ id: 'checklist', toolId: 'workspace.save-checklist', input: draft }], usage };
  }
  if (/\b(dashboard|chart|video|audio|walkthrough|links?)\b/i.test(prompt)) {
    return { type: 'final', output: { reply: dashboardReply }, usage };
  }
  const reply = /\brelease notes\b/i.test(prompt) ? releaseReply : checklistReply;
  return { type: 'final', output: { reply }, usage };
}

const model: ModelAdapter = {
  id: 'prototype-local',
  maxCostMicros: 0,
  capabilities: { tools: true, structuredOutput: true, history: true },
  generate: async request => fixtureReply(request),
  async *stream(request) {
    const response = fixtureReply(request);
    await delay(620, undefined, { signal: request.signal });
    if (response.type === 'final') {
      const text = JSON.stringify(response.output);
      for (let offset = 0; offset < text.length; offset += 38) {
        await delay(195, undefined, { signal: request.signal });
        yield { type: 'output.delta', text: text.slice(offset, offset + 38) };
      }
    }
    yield { type: 'response', response };
  },
};

const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

/** Loopback-only demo. SQLite exercises the native checkpoints and claim flow within one dev-server lifetime. */
export async function createPrototypeServer(origin: string) {
  const base = new URL(origin);
  if (base.origin !== origin || base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('The UI prototype only serves a loopback HTTP origin.');
  }
  const key = randomBytes(32);
  const token = randomBytes(32);
  const tokenMatches = (value: string) => /^[a-f0-9]{64}$/u.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), token);
  const store = createSqliteStore({ filename: ':memory:' });
  let server: ReturnType<typeof createAgentServer> | undefined;
  try {
    await store.initialize();
    await store.threads.initialize();
    const save = defineTool({
      id: 'workspace.save-checklist',
      version: '1',
      description: 'Save the reviewed rollout checklist to the local demo workspace.',
      input: z.object({ title: z.literal(draft.title), destination: z.literal(draft.destination), content: z.literal(draft.content) }),
      output: z.object({ saved: z.literal(true) }),
      effects: 'write',
      capabilities: [],
      approval: 'required',
      costMicros: 0,
      timeoutMs: 5000,
      async execute(input, context) {
        context.signal.throwIfAborted();
        const id = context.runId + ':' + context.callId;
        await store.create({
          scope: 'prototype-workspace:rollout-checklists',
          id,
          idempotencyKey: id,
          definitionHash: 'rollout-checklist-v1',
          state: input,
          events: [{ type: 'checklist.saved', data: {} }],
        });
        return { saved: true as const };
      },
    });
    const agent = defineAgent({
      id: agentId,
      version: '1',
      instructions: 'Answer from the local release fixtures. Request approval before saving a rollout checklist.',
      input: z.string().trim().min(1).max(2000),
      output: z.object({ reply: z.string().max(512) }),
      model,
      tools: [save],
      stream: {
        field: ['reply'],
        batch: { minChars: 16, maxChars: 80 },
        guards: [{
          id: 'public-fixture-text',
          check: (value) => typeof value === 'string' && publicReplies.some(reply => reply.startsWith(value))
            ? { decision: 'allow' } : { decision: 'block' },
        }],
      },
    });
    const native = createAgentServer({
      publicOrigin: origin,
      threads: { store },
      runRecords: createAggregateRunRecords(store),
      agents: [{
        agent,
        limits: { maxCostMicros: 0, maxSteps: 3, maxModelCalls: 2, maxToolCalls: 1, maxDurationMs: 120_000 },
        permissions: { allow: ['model:prototype-local', 'tool:workspace.save-checklist', 'effect:write'] },
      }],
      authenticate: async ({ token: bearer, signal }) => {
        if (signal.aborted || !tokenMatches(bearer)) return null;
        return {
          scope,
          agentIds: [agentId],
          capabilities: ['runs:read', 'runs:submit', 'runs:approve', 'runs:cancel', 'threads:read', 'threads:write'],
          expiresAtMs: Date.now() + 600_000,
        };
      },
    });
    server = native;
    const replyState = { citations: sources, artifacts: replyArtifactFixtures };
    const agUi = createAgUiAdapter({
      server: native,
      publicOrigin: origin,
      agentId,
      interruptKey: key,
      permissions: { allow: ['ag-ui:serve', 'ag-ui:state', 'ag-ui:stream'] },
      input: message => typeof message.content === 'string' ? message.content : '',
      state: { read: () => ({ revision: 1, state: replyState }) },
      streaming: 'guarded',
    });
    const history = createThreadHistory({ agentId, origin, replyState, nativeFetch: request => native.fetch(request) });
    let closing: Promise<void> | undefined;
    return {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const browserOrigin = request.headers.get('origin');
        const fetchSite = request.headers.get('sec-fetch-site');
        if (url.origin !== origin || (browserOrigin !== null && browserOrigin !== origin)
          || (fetchSite !== null && !['same-origin', 'none'].includes(fetchSite))) {
          return new Response(null, { status: 403, headers: noStore });
        }
        if (!url.search && url.pathname === '/session' && request.method === 'GET') {
          return Response.json({ token: token.toString('hex') }, { headers: noStore });
        }
        const bearer = /^Bearer ([a-f0-9]{64})$/u.exec(request.headers.get('authorization') ?? '')?.[1];
        const historyMatch = historyPath.exec(url.pathname);
        if (historyMatch && !url.search && request.method === 'GET') {
          if (!bearer || !tokenMatches(bearer)) return new Response(null, { status: 401, headers: noStore });
          return history.read(bearer, historyMatch[1], request.signal);
        }
        if (url.pathname === '/ag-ui') {
          if (url.search || request.method !== 'POST' || !bearer || !tokenMatches(bearer)) return agUi.fetch(request);
          const echo = request.clone();
          const response = await agUi.fetch(request);
          if (!response.ok) {
            void echo.body?.cancel().catch(() => {});
            return response;
          }
          // The adapter validates this exact body and applies its byte limit before opening the stream.
          const input = await echo.json() as AgUiRunInput;
          return history.capture(response, input);
        }
        if (request.method === 'POST' && /^\/v1\/runs\/[a-f0-9-]{36}\/cancel$/.test(url.pathname)) return native.fetch(request);
        return new Response(null, { status: 404, headers: noStore });
      },
      close(): Promise<void> {
        if (!closing) {
          agUi.close();
          closing = native.close().finally(() => store.close());
        }
        return closing;
      },
    };
  } catch (error) {
    await server?.close().catch(() => {});
    await store.close().catch(() => {});
    throw error;
  }
}
