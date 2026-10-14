import { defineHook, type AnyTool, type Guard, type HookContext, type HookDefinition, type JsonValue } from 'mayura';

/**
 * Dvar's action contract, expressed structurally so Mayura does not load the
 * Node-specific Dvar package merely by importing unrelated integrations.
 * An actual createDvar() runtime is assignable to FirewallEngine.
 */
export interface FirewallAction {
  id: string;
  principal: { id: string; type: 'user' | 'service' | 'workload' | 'agent' };
  agent: { id: string; framework?: string };
  tenant?: { id: string };
  session?: { id: string };
  task?: { id: string };
  environment: string;
  server: { id: string; transport?: 'function' | 'streamable-http' | 'stdio' | 'custom' };
  tool: { name: string; capabilities?: string[] };
  arguments: unknown;
  metadata?: Record<string, unknown>;
}

export interface FirewallDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  reasonCode: string;
  ruleId: string;
  observedEffect?: 'would_allow' | 'would_deny' | 'would_require_approval';
}

/** Supply a real createDvar() runtime; this is intentionally not a second policy engine. */
export interface FirewallEngine {
  authorize(action: FirewallAction, options?: { approvalGrant?: string }): Promise<FirewallDecision>;
  recordOutcome(action: FirewallAction, outcome: { success: boolean; errorCode?: string }): Promise<void>;
}

export interface FirewallOutputFilter {
  filter<T>(input: { value: T; source?: 'tool' | 'custom' }): {
    value: T;
    summary: { status: 'allowed' | 'redacted' | 'denied'; reasonCode?: string };
  };
}

export interface AgentFirewallOptions {
  /** Runtime returned by createDvar(). */
  dvar: FirewallEngine;
  /** An explicit deployment environment; never inferred from model input. */
  environment: string;
  /** Only tools in this trusted application-defined list can be forwarded. */
  tools: readonly Pick<AnyTool, 'id' | 'effects' | 'capabilities'>[];
  /** Distinguishes independently configured firewalls attached to one agent. */
  id?: string;
  /** Resolve a previously approved Dvar grant; never place it in model-visible input. */
  approvalGrant?: (action: FirewallAction, context: HookContext) => string | undefined | Promise<string | undefined>;
  /** Optional metadata-only decision observer. */
  onDecision?: (event: {
    toolId: string; runId: string; callId: string; effect: FirewallDecision['effect'];
    ruleId: string; reasonCode: string; observedEffect?: FirewallDecision['observedEffect'];
  }) => void | Promise<void>;
  /** Pass createOutputGuard({policy}) from @rokadhq/dvar/output-guard. */
  outputFilter?: FirewallOutputFilter;
}

export interface AgentFirewall {
  readonly hooks: readonly HookDefinition[];
  /** Add to agent.guards.output to redact/block tool results and final responses. */
  readonly outputGuard?: Guard;
}

function requireOptions(options: AgentFirewallOptions): void {
  if (!options || !options.dvar ||
    typeof options.dvar.authorize !== 'function' ||
    typeof options.dvar.recordOutcome !== 'function') {
    throw new TypeError('Firewall requires a Dvar runtime with authorize() and recordOutcome().');
  }
  if (typeof options.environment !== 'string' || options.environment.trim() === '') {
    throw new TypeError('Firewall environment must be a non-empty string.');
  }
  if (!Array.isArray(options.tools)) {
    throw new TypeError('Firewall needs the trusted Mayura tool definitions.');
  }
}

/** Native Mayura hooks + optional native output guard, backed by the supplied Dvar runtime. */
export function createAgentFirewall(options: AgentFirewallOptions): AgentFirewall {
  requireOptions(options);
  const id = options.id ?? 'firewall.dvar';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/u.test(id)) {
    throw new TypeError('Firewall id must be a valid, short Mayura hook identifier.');
  }
  const tools = new Map<string, Pick<AnyTool, 'id' | 'effects' | 'capabilities'>>();
  for (const tool of options.tools) {
    if (!tool || typeof tool.id !== 'string' || tools.has(tool.id) ||
      !['none', 'read', 'write', 'host'].includes(tool.effects) ||
      !Array.isArray(tool.capabilities)) {
      throw new TypeError('Firewall tools must have unique ids, effects and capabilities.');
    }
    tools.set(tool.id, tool);
  }

  // Key by BOTH run and call: descendant runs can use the same call id.
  // onFinally cleans up calls denied by later Mayura schema/permission checks.
  const admitted = new Map<string, Map<string, FirewallAction>>();

  const beforeToolCall = defineHook({
    id: `${id}.before-tool`,
    version: '1',
    stage: 'beforeToolCall',
    tools: [],
    handler: async (event, context) => {
      const tool = tools.get(event.proposal.toolId);
      if (!tool) return { decision: 'block' };
      const action: FirewallAction = {
        id: `${context.runId}/${event.proposal.callId}`,
        principal: { id: context.scope.principalId, type: 'user' },
        agent: { id: context.agentId, framework: 'mayura' },
        tenant: { id: context.scope.projectId },
        session: { id: context.rootId },
        task: { id: context.runId },
        environment: options.environment,
        server: { id: 'mayura', transport: 'function' },
        tool: { name: tool.id, capabilities: [...tool.capabilities] },
        // Mayura explicitly exposes the RAW proposed input here, before schema conversion.
        arguments: event.proposal.input,
        metadata: { mayuraEffect: tool.effects, mayuraCallId: event.proposal.callId }
      };
      const grant = await options.approvalGrant?.(action, context);
      const decision = await options.dvar.authorize(action,
        grant === undefined ? undefined : { approvalGrant: grant });
      await options.onDecision?.({
        toolId: tool.id,
        runId: context.runId,
        callId: event.proposal.callId,
        effect: decision.effect,
        ruleId: decision.ruleId,
        reasonCode: decision.reasonCode,
        ...(decision.observedEffect === undefined ? {} : { observedEffect: decision.observedEffect })
      });
      if (decision.effect !== 'allow') return { decision: 'block' };
      const calls = admitted.get(context.runId) ?? new Map<string, FirewallAction>();
      calls.set(event.proposal.callId, action);
      admitted.set(context.runId, calls);
      return { decision: 'continue' };
    }
  });

  const afterToolCall = defineHook({
    id: `${id}.after-tool`,
    version: '1',
    stage: 'afterToolCall',
    mandatory: true,
    handler: async (event, context) => {
      const calls = admitted.get(context.runId);
      const action = calls?.get(event.callId);
      if (!action) return;
      calls!.delete(event.callId);
      if (calls!.size === 0) admitted.delete(context.runId);
      // Mayura may reject validated inputs without starting execution;
      // those should not count as failures against a Dvar circuit breaker.
      if (event.execution === 'not_started') return;
      const success = event.execution === 'succeeded' ||
        (event.execution === undefined && event.status === 'succeeded');
      await options.dvar.recordOutcome(action, { success });
    }
  });

  const onFinally = defineHook({
    id: `${id}.cleanup`,
    version: '1',
    stage: 'onFinally',
    handler: (_event, context) => { admitted.delete(context.runId); }
  });

  const outputGuard: Guard | undefined = options.outputFilter === undefined ? undefined : {
    id: `${id}.output`,
    check(value: JsonValue) {
      const result = options.outputFilter!.filter({ value, source: 'tool' });
      if (result.summary.status === 'denied') return { decision: 'block' as const };
      if (result.summary.status === 'redacted') return {
        decision: 'rewrite' as const,
        value: result.value as JsonValue
      };
      return { decision: 'allow' as const };
    }
  };
  return {
    hooks: [beforeToolCall, afterToolCall, onFinally],
    ...(outputGuard === undefined ? {} : { outputGuard })
  };
}

/** Convenience re-exports: consumer apps only install @mayurajs/firewall. */
export { createDvar, createOutputGuard } from '@rokadhq/dvar';
