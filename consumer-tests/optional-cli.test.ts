import { applyProjectPlan, approveWorkflow, cancelRun, cancelWorkflow, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth,
  inspectServerTools, inspectWorkflow, planProject, respondHumanRequest, templates, validateProject, waitForRun,
  type InitPlan, type OperationalHealth, type OperationalHumanRequestPage, type OperationalRun, type OperationalToolPage, type OperationalWorkflow } from '@mayura/cli';

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
declare const run: OperationalRun;
declare const workflow: OperationalWorkflow;
void health; void tools; void humans; void run; void workflow; void inspectServerHealth; void inspectServerTools; void inspectHumanRequests; void inspectHumanRequest;
void respondHumanRequest; void inspectRun; void waitForRun; void cancelRun; void inspectWorkflow; void cancelWorkflow; void approveWorkflow;
