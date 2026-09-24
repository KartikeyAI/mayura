import { applyProjectPlan, inspectHumanRequest, inspectHumanRequests, inspectServerHealth, inspectServerTools, planProject, respondHumanRequest, templates, validateProject,
  type InitPlan, type OperationalHealth, type OperationalHumanRequestPage, type OperationalToolPage } from '@mayura/cli';

const catalog = templates();
const project = validateProject({ format: 'mayura.project.v1', name: 'consumer', template: 'basic-agent',
  definitions: [{ kind: 'agent', id: 'consumer.agent', version: '1', source: 'src/index.ts' }], tools: [] });
export async function compileCliPlan(directory: string): Promise<InitPlan> {
  const plan = await planProject(catalog[0]!.name, directory);
  if (project.name === 'consumer') await applyProjectPlan(plan);
  return plan;
}
declare const health: OperationalHealth; declare const tools: OperationalToolPage;
declare const humans: OperationalHumanRequestPage;
void health; void tools; void humans; void inspectServerHealth; void inspectServerTools; void inspectHumanRequests; void inspectHumanRequest; void respondHumanRequest;
