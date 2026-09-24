import { Budget, createRuntime, defineAgent, defineTool, type Guard, type JsonValue, type ManagedGuardDefinition, type ModelAdapter, type Schema } from '@mayura/sdk';
import { createPipeline, defineModerationGuard, prepareOutputDisclosure, protectLiterals, releaseBufferedOutput,
  type ManagedModerationOptions, type OutputDisclosurePart } from '@mayura/guardrails';
import { assertBudgetTicket, readManagedGuardDefinition, registerManagedGuardDefinition, type ManagedGuardDescriptor } from '@mayura/core/host';
import { bindToolBudgetTicket, type ToolBudgetTicketBinding } from '@mayura/tools/host';
import { createObserver, type ObservedRun } from '@mayura/observability';

const number: Schema<number> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const input: Schema<string, number> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'string' ? { value: value.length } : { issues: [] } } };
const output: Schema<number, { answer: number }> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } } };
const moderator: ModelAdapter = { id: 'consumer.moderator', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 1,
  generate: async () => ({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 1 } }),
};
const primary: ModelAdapter = { id: 'consumer.primary', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 1,
  generate: async () => ({ type: 'final', output: 3, usage: { costMicros: 1 } }),
};
const local: Guard = { id: 'consumer.local', check: (value, context) => {
  const candidate: JsonValue = value; const runId: string = context.runId;
  if (false) {
    // @ts-expect-error No runtime budget is exposed to local guard callbacks.
    void context.budget;
    // @ts-expect-error No model execution gateway is exposed to local guard callbacks.
    void context.evaluate;
  }
  void candidate; void runId; return { decision: 'allow' };
} };
const options: ManagedModerationOptions = { id: 'consumer.policy', version: '1', model: moderator, instructions: 'Explicit policy.', egressGuards: [local] };
const guard: ManagedGuardDefinition = defineModerationGuard(options);
async function* streamed(): AsyncIterable<string> { yield 'safe'; }
const buffered = await releaseBufferedOutput(streamed(), createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] }),
  { runId: 'consumer.stream', callId: 'consumer.stream.output', scope: { principalId: 'consumer', projectId: 'fixture' },
    boundary: 'output', signal: new AbortController().signal });
const bufferedValue: JsonValue = buffered.value;
void bufferedValue;
const disclosureParts: readonly OutputDisclosurePart[] = [{ kind: 'text', text: 'safe' },
  { kind: 'tool_preview', toolId: 'consumer.private', preview: { value: 'withheld' } }];
void await prepareOutputDisclosure(disclosureParts, createPipeline(),
  { runId: 'consumer.disclosure', callId: 'consumer.disclosure.output', scope: { principalId: 'consumer', projectId: 'fixture' },
    boundary: 'output', signal: new AbortController().signal });
const descriptor: Readonly<ManagedGuardDescriptor> | undefined = readManagedGuardDefinition(guard);
if (descriptor) {
  const registered: ManagedGuardDefinition = registerManagedGuardDefinition({ ...descriptor, id: 'consumer.second-policy' });
  const captured: ModelAdapter = descriptor.model;
  // @ts-expect-error Host descriptors are immutable snapshots.
  descriptor.limits.timeoutMs = 5;
  void registered; void captured;
}
const agent = defineAgent({ id: 'consumer.agent', version: '1', instructions: 'Private primary instructions.', input, output,
  model: primary, tools: [], guards: { input: [local, guard], output: [guard] },
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:consumer.primary', 'model:consumer.moderator'] },
  limits: { maxCostMicros: 3, maxModelCalls: 3, maxSteps: 1, maxConcurrentOperations: 1 },
});
const handle = runtime.submit(agent, { input: 'abc' });
const observer = createObserver(); const subscription = observer.observe(handle);
const outcome = await handle.result();
if (outcome.status === 'succeeded') {
  const answer: number = outcome.output.answer;
  // @ts-expect-error Managed guards do not erase transformed agent output inference.
  const incorrect: string = outcome.output.answer;
  void answer; void incorrect;
}
await subscription.done();
const observed: ObservedRun | undefined = observer.inspect(handle.id);
if (observed) { const count: number | string = observed.counters.modelCompleted; void count; }

const budget = new Budget(1, 1); const ticket = budget.reserveBundle([{ id: 'consumer.ticket', maxCostMicros: 1 }]).tickets[0]!;
assertBudgetTicket(ticket, budget);
const tool = defineTool({ id: 'consumer.tool', version: '1', description: 'Typed host binding.', input: number, output: number,
  effects: 'none', capabilities: [], costMicros: 1, execute: value => value + 1,
});
const context = { budget, runId: 'consumer.run', callId: 'consumer.call', scope: { principalId: 'consumer', projectId: 'fixture' }, signal: new AbortController().signal };
const binding: ToolBudgetTicketBinding = bindToolBudgetTicket(tool, ticket, context);
void binding;
if (false) {
  // @ts-expect-error Authoring requires an explicit local egress list, even when it is empty.
  defineModerationGuard({ id: 'consumer.missing', version: '1', model: moderator, instructions: 'Policy.' });
  // @ts-expect-error Managed definitions cannot capture a caller-owned budget.
  defineModerationGuard({ ...options, budget });
  // @ts-expect-error Permissions belong to the runtime, not the managed definition.
  defineModerationGuard({ ...options, permissions: { allow: [] } });
  // @ts-expect-error Managed handles are not directly callable local guards.
  guard.check(1, {});
  // @ts-expect-error Managed handles do not expose their model executor.
  void guard.model;
  // @ts-expect-error Agent guard arrays remain readonly.
  agent.guards.input.push(guard);
  // @ts-expect-error Submission requires the original string, not the transformed numeric input.
  runtime.submit(agent, { input: 3 });
  // @ts-expect-error Host binding still requires a genuine Budget-shaped authority type.
  bindToolBudgetTicket(tool, ticket, { ...context, budget: {} });
  // @ts-expect-error Binding metadata does not expose the dispatch ticket.
  void binding.ticket;
}
await observer.close(); await runtime.close();
