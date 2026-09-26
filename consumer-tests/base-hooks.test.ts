import { defineAgent, defineHook, defineTool, type HookContext, type HookDefinition, type HookEvent, type JsonValue, type ModelRequest } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

const readTool = defineTool({ id: 'read.policy', version: '1', description: 'Read policy.', input: z.string(), output: z.boolean(), effects: 'read', capabilities: [], execute: () => true });
const inputHook = defineHook({ id: 'input-policy', version: '1', stage: 'beforeExecution', tools: [], handler: (event, context) => {
  const input: JsonValue = event.input;
  const correlation: HookContext = context;
  // @ts-expect-error Before-execution events are not tool proposals.
  void event.proposal;
  // @ts-expect-error Hook contexts expose no permission authority.
  void context.permissions;
  void input; void correlation;
  return { decision: 'continue' };
} });
const typedDefinition: HookDefinition<'beforeExecution'> = inputHook;
void typedDefinition;
const toolHook = defineHook({ id: 'tool-policy', version: '1', stage: 'beforeToolCall', tools: [], handler: event => {
  const phase: 'proposal' = event.phase;
  const proposal: HookEvent<'beforeToolCall'> = event;
  void phase; void proposal;
  return { decision: 'continue' };
} });
const releaseHook = defineHook({ id: 'release-policy', version: '1', stage: 'beforeOutputRelease', tools: [], handler: event => {
  const source: 'agent' | 'tool' = event.source;
  const candidate: JsonValue = event.candidate;
  void source; void candidate;
  return { decision: 'block' };
} });
const modelHook = defineHook({ id: 'model-policy', version: '1', stage: 'beforeModelCall', tools: [], handler: event => {
  const projection: Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>> = event.request;
  const purpose: 'primary' = event.purpose;
  const modelId: string = event.modelId;
  // @ts-expect-error Private instructions are not exposed in the hook request projection.
  void event.request.instructions;
  // @ts-expect-error Provider continuation is never a hook-request field.
  void event.request.continuation;
  // @ts-expect-error A public hook has no adapter signal through the request projection.
  void event.request.signal;
  // @ts-expect-error A control hook cannot rewrite the model token ceiling.
  event.request.maxOutputTokens = 0;
  // @ts-expect-error Model history is immutable.
  event.request.messages.push({ role: 'user', content: null });
  void projection; void purpose; void modelId;
  return { decision: 'continue' };
} });
const typedModelHook: HookDefinition<'beforeModelCall'> = modelHook;
void typedModelHook;
const finallyHook = defineHook({ id: 'typed-finally', version: '1', stage: 'onFinally', mandatory: false, handler: (event, context) => {
  const status: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown' = event.status;
  const step: number | null = context.step; void status; void step;
} });
const toolObserver = defineHook({ id: 'typed-after-tool', version: '1', stage: 'afterToolCall', handler: event => {
  const toolId: string = event.toolId; void toolId;
  // @ts-expect-error Observer views carry no tool output.
  void event.output;
} });
const typedFinally: HookDefinition<'onFinally'> = finallyHook;
const observerKind: 'mayura.observer-hook' = typedFinally.kind; void observerKind; void toolObserver;
const agent = defineAgent({ id: 'typed-hook-agent', version: '1', instructions: 'Types only.', tools: [], hooks: [inputHook, modelHook, toolHook, releaseHook],
  input: z.string(), output: z.string(), model: scriptedModel([{ type: 'final', output: 'value', usage: { costMicros: 0 } }]) });
if (false) {
  // @ts-expect-error Hook definitions do not expose a callable handler.
  inputHook.handler({ stage: 'beforeExecution', input: null }, {});
  // @ts-expect-error Hook definitions do not reveal their private tool catalogs.
  void inputHook.tools;
  // @ts-expect-error Captured agent hook ordering is immutable.
  agent.hooks.push(inputHook);
  // @ts-expect-error Observers return nothing; a control decision is not an observation.
  defineHook({ id: 'observer-decision', version: '1', stage: 'onFinally', handler: () => ({ decision: 'continue' }) });
  // @ts-expect-error Observers cannot request actions through a tool catalog.
  defineHook({ id: 'observer-tools', version: '1', stage: 'afterToolCall', tools: [readTool], handler: () => {} });
  // @ts-expect-error Control hooks are always fail-closed; mandatory applies to observers only.
  defineHook({ id: 'control-mandatory', version: '1', stage: 'beforeStep', tools: [], mandatory: true, handler: () => ({ decision: 'continue' }) });
  // @ts-expect-error Context hooks belong to assembleContext, not to agent definitions.
  defineHook({ id: 'context', version: '1', stage: 'beforeContextBuild', tools: [], handler: () => ({ decision: 'continue' }) });
  // @ts-expect-error A hook requires an explicit local tool catalog, including an empty one.
  defineHook({ id: 'missing-tools', version: '1', stage: 'beforeExecution', handler: () => ({ decision: 'continue' }) });
  // @ts-expect-error Hook decisions use continue/block, not an authorization-grant result.
  defineHook({ id: 'wrong-decision', version: '1', stage: 'beforeExecution', tools: [], handler: () => ({ decision: 'allow' }) });
}
