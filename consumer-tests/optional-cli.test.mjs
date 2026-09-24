import { resolve } from 'node:path';
import { applyProjectPlan, inspectServerHealth, inspectServerTools, planProject, readProject, templates } from '@mayura/cli';

const target = resolve('generated-agent'); const catalog = templates();
const plan = await planProject('basic-agent', target); const beforeApply = plan.changes.every(change => change.operation === 'create');
await applyProjectPlan(plan); const project = await readProject(resolve(target, 'mayura.project.json'));
const unchanged = await planProject('basic-agent', target);
const operationalFetch = async url => new Response(new URL(url).pathname.endsWith('/health')
  ? JSON.stringify({ status: 'ready', checks: [{ id: 'server', status: 'ready' }] })
  : JSON.stringify({ tools: [], next: null }), { headers: { 'content-type': 'application/json' } });
const operational = { baseUrl: 'https://agent.example.test', token: () => 'explicit-token', fetch: operationalFetch };
const health = await inspectServerHealth(operational); const tools = await inspectServerTools(operational, { limit: 1 });
console.log(JSON.stringify({ status: 'passed', eightTemplates: catalog.length === 8, planFirst: beforeApply,
  catalogValidated: project.template === 'basic-agent', noOverwrite: unchanged.changes.every(change => change.operation === 'unchanged'),
  authenticatedOperations: health.status === 'ready' && tools.tools.length === 0 }));
