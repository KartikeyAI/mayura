import { MayuraError, type JsonValue } from '@mayura/core';
import type { AnyTool } from './index.js';

/** Opaque trusted-host proof that a person approved one exact call; it carries no authority beyond that call. */
export interface ToolApprovalBinding { readonly kind: 'mayura.tool-approval' }
export interface ToolApprovalContext {
  readonly runId: string;
  readonly callId: string;
  /** The input that was approved. */
  readonly input: JsonValue;
}
interface Binding { readonly tool: AnyTool; readonly runId: string; readonly callId: string; readonly input: string; claimed: boolean }
const bindings = new WeakMap<ToolApprovalBinding, Binding>();

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

/** Record that a person approved this call of `tool`, with this input, in this run. Host plumbing for the runtime. */
export function bindToolApproval(tool: AnyTool, context: ToolApprovalContext): ToolApprovalBinding {
  const handle: ToolApprovalBinding = Object.freeze({ kind: 'mayura.tool-approval' });
  bindings.set(handle, { tool, runId: context.runId, callId: context.callId, input: canonical(context.input), claimed: false });
  return handle;
}

/** Internal broker seam: an approval admits one call only, the exact one approved. */
export function claimToolApproval(value: ToolApprovalBinding | undefined, tool: AnyTool, context: ToolApprovalContext): void {
  if (value === undefined) {
    throw new MayuraError('APPROVAL_UNAVAILABLE', `Tool ${tool.id} needs a person's approval before this call; run it in an agent run, which asks for one.`);
  }
  const binding = bindings.get(value);
  if (!binding || binding.tool !== tool || binding.runId !== context.runId || binding.callId !== context.callId || binding.input !== canonical(context.input)) {
    throw new MayuraError('APPROVAL_UNAVAILABLE', `The approval presented for ${tool.id} is not for this call.`);
  }
  if (binding.claimed) throw new MayuraError('CONFLICT', 'The approval was already used.');
  binding.claimed = true;
}
