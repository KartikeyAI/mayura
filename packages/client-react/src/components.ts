import { createElement, useCallback, type ReactElement } from 'react';
import type { RemoteHumanRequest } from '@mayura/client';
import type { HeadlessRunStore } from '@mayura/client/headless';
import type { WorkflowViewInput } from '@mayura/client/workflows';
import { MayuraReactError, useMayuraHumanRequest, useMayuraRun, useMayuraRunActivity, useMayuraWorkflowGraph } from './index.js';

export interface MayuraRunSummaryProps { readonly store: HeadlessRunStore; readonly label?: string }
export interface MayuraWorkflowGraphProps { readonly input: WorkflowViewInput; readonly label?: string }
export interface MayuraHumanRequestCardProps {
  readonly request: RemoteHumanRequest; readonly nowMs: number; readonly label?: string;
  readonly onRespond?: (request: { readonly id: string; readonly digest: string }) => void;
}
function label(value: string | undefined, fallback: string): string {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || selected.length < 1 || selected.length > 128 || selected.includes('\0')) throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  return selected;
}

/** Accessible run summary over one caller-owned store. Rendering starts no remote operation. */
export function MayuraRunSummary({ store, label: suppliedLabel }: MayuraRunSummaryProps): ReactElement {
  const state = useMayuraRun(store); const activity = useMayuraRunActivity(state); const accessibleLabel = label(suppliedLabel, 'Run status');
  const status = state.snapshot?.status ?? state.connection;
  const items = activity.items.length === 0
    ? createElement('p', { 'data-mayura-empty': true }, 'No activity recorded')
    : createElement('ol', { 'aria-label': 'Run activity' }, activity.items.map(item => createElement('li', {
      key: item.id, 'data-kind': item.kind, 'data-status': item.status,
    }, `${item.label}: ${item.status}`)));
  return createElement('section', { 'aria-label': accessibleLabel, 'data-mayura-component': 'run-summary' },
    createElement('p', { role: 'status', 'aria-live': 'polite' }, `Run ${status}`), items);
}

/** Accessible ordered representation of a validated durable DAG; it performs no layout or command. */
export function MayuraWorkflowGraph({ input, label: suppliedLabel }: MayuraWorkflowGraphProps): ReactElement {
  const graph = useMayuraWorkflowGraph(input); const accessibleLabel = label(suppliedLabel, 'Workflow progress');
  const dependencies = new Map<string, string[]>();
  for (const edge of graph.edges) { const list = dependencies.get(edge.to) ?? []; list.push(edge.from); dependencies.set(edge.to, list); }
  return createElement('section', { 'aria-label': accessibleLabel, 'data-mayura-component': 'workflow-graph' },
    createElement('p', { role: 'status', 'aria-live': 'polite' }, `${graph.progress.terminal} of ${graph.progress.total} steps terminal`),
    createElement('ol', { 'aria-label': 'Workflow steps' }, graph.nodes.map(node => {
      const parents = dependencies.get(node.id) ?? [];
      return createElement('li', { key: node.id, 'data-kind': node.kind, 'data-status': node.status, 'data-depth': node.depth },
        createElement('span', null, `${node.id}: ${node.status}`),
        parents.length > 0 ? createElement('span', null, `; depends on ${parents.join(', ')}`) : null,
        node.childRunId !== null ? createElement('span', null, '; required child attached') : null);
    })));
}

/** Text-only request presentation. The optional callback is invoked only by the explicit button event. */
export function MayuraHumanRequestCard({ request, nowMs, label: suppliedLabel, onRespond }: MayuraHumanRequestCardProps): ReactElement {
  const view = useMayuraHumanRequest(request, nowMs); const accessibleLabel = label(suppliedLabel, 'Human request');
  const respond = useCallback(() => { onRespond?.(Object.freeze({ id: request.id, digest: request.digest })); }, [onRespond, request.id, request.digest]);
  const action = view.canRespond && onRespond !== undefined
    ? createElement('button', { type: 'button', onClick: respond }, view.actionText)
    : null;
  return createElement('article', { 'aria-label': accessibleLabel, 'data-mayura-component': 'human-request' },
    createElement('p', { 'data-mayura-prompt': true }, view.prompt),
    createElement('p', { role: 'status', 'aria-live': 'polite' }, view.statusText), action);
}
