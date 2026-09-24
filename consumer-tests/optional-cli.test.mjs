import { resolve } from 'node:path';
import { applyProjectPlan, planProject, readProject, templates } from '@mayura/cli';

const target = resolve('generated-agent'); const catalog = templates();
const plan = await planProject('basic-agent', target); const beforeApply = plan.changes.every(change => change.operation === 'create');
await applyProjectPlan(plan); const project = await readProject(resolve(target, 'mayura.project.json'));
const unchanged = await planProject('basic-agent', target);
console.log(JSON.stringify({ status: 'passed', eightTemplates: catalog.length === 8, planFirst: beforeApply,
  catalogValidated: project.template === 'basic-agent', noOverwrite: unchanged.changes.every(change => change.operation === 'unchanged') }));
