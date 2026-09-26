import { createClient, type ClientSchema, type RemoteOutcome } from '@mayura/client';
import { createHeadlessRunStore, createHumanRequestView, createRunActivityProjection } from '@mayura/client/headless';
import { createHumanResponseController, defineHumanResponseForm, validateHumanResponse } from '@mayura/client/forms';
import { createWorkflowCommandController, createWorkflowGraphProjection } from '@mayura/client/workflows';

const output: ClientSchema<{ answer: number }> = {
  '~standard': { version: 1, validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } },
};

/** Executed from a browser-target bundle with Web globals only; the supplied Fetch is a local fixture. */
export async function verifyBrowserClient(transport: typeof fetch): Promise<number> {
  const client = createClient({ baseUrl: 'https://consumer.invalid', token: () => 'bundler-fixture', fetch: transport });
  const agents = await client.agents();
  const view = createHumanRequestView(Object.freeze({ id: 'review', agentId: 'agent', kind: 'information' as const, schemaId: 'answer-v1',
    schemaDigest: 'a'.repeat(64), prompt: 'Provide evidence.', digest: 'b'.repeat(64), status: 'waiting' as const }), 1_000);
  if (!view.canRespond || view.actionText !== 'Provide information') throw new Error('Headless human view failed.');
  const request = Object.freeze({ id: 'review', agentId: 'agent', kind: 'information' as const, schemaId: 'answer-v1', schemaDigest: 'a'.repeat(64),
    prompt: 'Provide evidence.', digest: 'b'.repeat(64), status: 'waiting' as const });
  const form = defineHumanResponseForm({ schemaId: 'answer-v1', schemaDigest: 'a'.repeat(64), fields: [
    { kind: 'integer', name: 'answer', label: 'Answer', required: true, minimum: 1, maximum: 5 },
  ] });
  const submission = validateHumanResponse(request, form, Object.freeze({ answer: '3' }));
  if (submission.id !== 'review' || submission.digest !== 'b'.repeat(64) || submission.value['answer'] !== 3) throw new Error('Human response form failed.');
  const controller = createHumanResponseController({ request, client: { respondHumanRequest: async () => Object.freeze({ ...request, status: 'answered' as const }) } });
  await controller.submit(submission, { commandId: 'response-1' });
  if (controller.getSnapshot().status !== 'succeeded') throw new Error('Human response command state failed.'); controller.dispose();
  const store = createHeadlessRunStore({ run: client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') });
  if (store.getSnapshot().connection !== 'idle' || createRunActivityProjection(store.getSnapshot()).items.length !== 0) throw new Error('Headless run store performed implicit work.'); store.dispose();
  const workflow = await client.workflow('a'.repeat(64)); const graph = createWorkflowGraphProjection(workflow);
  if (!graph.nodes[0]?.ready) throw new Error('Durable workflow graph projection failed.');
  const workflowPage = await client.workflows({ limit: 1 });
  if (workflowPage.items[0]?.runId !== 'a'.repeat(64) || workflowPage.next !== null) throw new Error('Durable workflow index failed.');
  const workflowController = createWorkflowCommandController({ workflow, client });
  if ((await workflowController.cancel({ commandId: 'cancel-1' })).revision !== 2 || workflowController.getSnapshot().status !== 'succeeded')
    throw new Error('Workflow cancellation state failed.'); workflowController.dispose();
  if ((await client.approveWorkflow('a'.repeat(64), { revision: 2, nodeId: 'step', approvalDigest: 'c'.repeat(64) },
    { commandId: 'approve-1' })).revision !== 3) throw new Error('Workflow approval failed.');
  const signalController = createWorkflowCommandController({ workflow, client });
  if ((await signalController.signal({ signalId: 'ready/1', signalName: 'ready', value: { accepted: true } },
    { commandId: 'signal-1' })).revision !== 4 || signalController.getSnapshot().action !== 'signal') throw new Error('Workflow signal state failed.');
  signalController.dispose();
  const resumeController = createWorkflowCommandController({ workflow, client });
  if ((await resumeController.resume({ commandId: 'resume-1' })).revision !== 5 || resumeController.getSnapshot().action !== 'resume')
    throw new Error('Workflow continuation state failed.');
  resumeController.dispose();
  const pauseController = createWorkflowCommandController({ workflow, client });
  if ((await pauseController.pause({ commandId: 'pause-1' })).revision !== 6 || pauseController.getSnapshot().action !== 'pause')
    throw new Error('Workflow pause state failed.');
  pauseController.dispose();
  return agents.length;
}

/** Compile-only assertions preserve output inference and reject accidental Node ambient dependencies. */
export async function verifyBrowserTypes(transport: typeof fetch): Promise<void> {
  const client = createClient({ baseUrl: 'https://consumer.invalid', token: () => 'type-fixture', fetch: transport });
  const store = createHeadlessRunStore({ run: client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') });
  const unsubscribe: () => void = store.subscribe(() => {}); unsubscribe(); store.dispose();
  const outcome: RemoteOutcome<{ answer: number }> | undefined = await client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').result(output);
  if (outcome?.status === 'succeeded') {
    const answer: number = outcome.output.answer;
    // @ts-expect-error Output remains schema-derived, not any.
    const invalid: string = outcome.output.answer;
    void answer; void invalid;
  } else if (outcome) {
    // @ts-expect-error Non-success cannot disclose an output field.
    void outcome.output;
  }
  if (false) {
    // @ts-expect-error Browser consumers do not acquire Node globals from Mayura declarations.
    void process;
    // @ts-expect-error Browser consumers do not acquire Node Buffer types.
    void Buffer;
  }
}
