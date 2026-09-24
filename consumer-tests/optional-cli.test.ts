import { applyProjectPlan, planProject, templates, validateProject, type InitPlan } from '@mayura/cli';

const catalog = templates();
const project = validateProject({ format: 'mayura.project.v1', name: 'consumer', template: 'basic-agent',
  definitions: [{ kind: 'agent', id: 'consumer.agent', version: '1', source: 'src/index.ts' }], tools: [] });
export async function compileCliPlan(directory: string): Promise<InitPlan> {
  const plan = await planProject(catalog[0]!.name, directory);
  if (project.name === 'consumer') await applyProjectPlan(plan);
  return plan;
}
