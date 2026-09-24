import { useMayuraHumanRequest, useMayuraHumanResponseCommand, useMayuraRun, useMayuraRunActions, useMayuraRunActivity, useMayuraWorkflowCommand,
  useMayuraWorkflowGraph, type MayuraRunActions } from '@mayura/client-react';
import type { HeadlessRunState, HeadlessRunStore } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';
import type { HumanResponseController } from '@mayura/client/forms';
import type { WorkflowCommandController } from '@mayura/client/workflows';

/** Compile-only public hook signatures contain Mayura contracts without requiring React declarations. */
export function consumeReactBindings(store: HeadlessRunStore, request: RemoteHumanRequest, nowMs: number): HeadlessRunState {
  const state = useMayuraRun(store); const actions: MayuraRunActions = useMayuraRunActions(store); const human = useMayuraHumanRequest(request, nowMs);
  const activity = useMayuraRunActivity(state); const graph = useMayuraWorkflowGraph(Object.freeze({ format: 4 as const, definitionId: 'workflow', definitionVersion: '1',
    runId: 'a'.repeat(64), revision: 1, status: 'running' as const, nodes: Object.freeze([Object.freeze({ id: 'step', kind: 'tool' as const, dependsOn: Object.freeze([]) })]),
    steps: Object.freeze([Object.freeze({ id: 'step', kind: 'tool' as const, status: 'pending' as const })]) }));
  if (human.canRespond || activity.complete || graph.nodes.length > 0) void actions.refresh; return state;
}

export function consumeHumanResponseCommand(controller: HumanResponseController): string {
  return useMayuraHumanResponseCommand(controller).status;
}

export function consumeWorkflowCommand(controller: WorkflowCommandController): string {
  return useMayuraWorkflowCommand(controller).status;
}
