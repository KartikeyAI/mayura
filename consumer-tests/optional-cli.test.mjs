import { resolve } from 'node:path';
import { applyProjectPlan, inspectHumanRequest, inspectHumanRequests, inspectServerHealth, inspectServerTools, planProject, readProject, respondHumanRequest, templates } from '@mayura/cli';

const target = resolve('generated-agent'); const catalog = templates();
const plan = await planProject('basic-agent', target); const beforeApply = plan.changes.every(change => change.operation === 'create');
await applyProjectPlan(plan); const project = await readProject(resolve(target, 'mayura.project.json'));
const unchanged = await planProject('basic-agent', target);
const digest = 'a'.repeat(64); const human = { id: 'review', agentId: 'agent', kind: 'information', schemaId: 'text-v1', schemaDigest: 'b'.repeat(64), prompt: 'Review.', digest, status: 'waiting' };
const operationalFetch = async (url, options) => { const path = new URL(url).pathname; const payload = path.endsWith('/health')
  ? { status: 'ready', checks: [{ id: 'server', status: 'ready' }] }
  : path === '/v1/tools' ? { tools: [], next: null }
  : path === '/v1/human-requests' ? { items: [human], next: null }
  : { request: options?.method === 'POST' ? { ...human, status: 'answered' } : human };
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }); };
const operational = { baseUrl: 'https://agent.example.test', token: () => 'explicit-token', fetch: operationalFetch };
const health = await inspectServerHealth(operational); const tools = await inspectServerTools(operational, { limit: 1 });
const humanPage = await inspectHumanRequests(operational, { limit: 1 }); const inspected = await inspectHumanRequest(operational, 'review');
const answered = await respondHumanRequest(operational, { id: 'review', requestDigest: digest, commandId: 'answer', value: true });
console.log(JSON.stringify({ status: 'passed', eightTemplates: catalog.length === 8, planFirst: beforeApply,
  catalogValidated: project.template === 'basic-agent', noOverwrite: unchanged.changes.every(change => change.operation === 'unchanged'),
  authenticatedOperations: health.status === 'ready' && tools.tools.length === 0,
  authenticatedHuman: humanPage.items.length === 1 && inspected.id === 'review' && answered.status === 'answered' }));
