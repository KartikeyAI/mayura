import { resolve } from 'node:path';
import { applyProjectPlan, cancelRun, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth, inspectServerTools, planProject, readProject, respondHumanRequest, templates, waitForRun } from '@mayura/cli';

const target = resolve('generated-agent'); const catalog = templates();
const plan = await planProject('basic-agent', target); const beforeApply = plan.changes.every(change => change.operation === 'create');
await applyProjectPlan(plan); const project = await readProject(resolve(target, 'mayura.project.json'));
const unchanged = await planProject('basic-agent', target);
const digest = 'a'.repeat(64); const human = { id: 'review', agentId: 'agent', kind: 'information', schemaId: 'text-v1', schemaDigest: 'b'.repeat(64), prompt: 'Review.', digest, status: 'waiting' };
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let cancellationCalls = 0;
const operationalFetch = async (url, options) => { const path = new URL(url).pathname; const payload = path.endsWith('/health')
  ? { status: 'ready', checks: [{ id: 'server', status: 'ready' }] }
  : path === '/v1/tools' ? { tools: [], next: null }
  : path === '/v1/human-requests' ? { items: [human], next: null }
  : path === `/v1/runs/${runId}/cancel` ? (cancellationCalls++, { id: runId, cancellationRequested: true })
  : path === `/v1/runs/${runId}` ? { id: runId, status: 'succeeded', budget: { spentMicros: 1, reservedMicros: 0, calls: 1 }, evidence: [], outcome: { status: 'succeeded', output: 'PRIVATE' } }
  : { request: options?.method === 'POST' ? { ...human, status: 'answered' } : human };
  return new Response(JSON.stringify(payload), { status: path.endsWith('/cancel') ? 202 : 200, headers: { 'content-type': 'application/json' } }); };
const operational = { baseUrl: 'https://agent.example.test', token: () => 'explicit-token', fetch: operationalFetch };
const health = await inspectServerHealth(operational); const tools = await inspectServerTools(operational, { limit: 1 });
const humanPage = await inspectHumanRequests(operational, { limit: 1 }); const inspected = await inspectHumanRequest(operational, 'review');
const answered = await respondHumanRequest(operational, { id: 'review', requestDigest: digest, commandId: 'answer', value: true });
const inspectedRun = await inspectRun(operational, runId); const waitedRun = await waitForRun(operational, runId); await cancelRun(operational, runId);
console.log(JSON.stringify({ status: 'passed', eightTemplates: catalog.length === 8, planFirst: beforeApply,
  catalogValidated: project.template === 'basic-agent', noOverwrite: unchanged.changes.every(change => change.operation === 'unchanged'),
  authenticatedOperations: health.status === 'ready' && tools.tools.length === 0,
  authenticatedHuman: humanPage.items.length === 1 && inspected.id === 'review' && answered.status === 'answered',
  authenticatedRuns: inspectedRun.status === 'succeeded' && waitedRun.status === 'succeeded' && !('outcome' in inspectedRun) && cancellationCalls === 1 }));
