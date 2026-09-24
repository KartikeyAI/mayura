import { createElement, useCallback, useState, type FormEvent, type ReactElement } from 'react';
import { ClientError, type RemoteHumanRequest } from '@mayura/client';
import { validateHumanResponse, type HumanResponseField, type HumanResponseFormDefinition, type HumanResponseSubmission } from '@mayura/client/forms';
import type { HeadlessRunStore } from '@mayura/client/headless';
import type { WorkflowViewInput } from '@mayura/client/workflows';
import { MayuraReactError, useMayuraHumanRequest, useMayuraRun, useMayuraRunActivity, useMayuraWorkflowGraph } from './index.js';

export interface MayuraRunSummaryProps { readonly store: HeadlessRunStore; readonly label?: string }
export interface MayuraWorkflowGraphProps { readonly input: WorkflowViewInput; readonly label?: string }
export interface MayuraHumanRequestCardProps {
  readonly request: RemoteHumanRequest; readonly nowMs: number; readonly label?: string;
  readonly onRespond?: (request: { readonly id: string; readonly digest: string }) => void;
}
export interface MayuraHumanResponseFormProps {
  readonly request: RemoteHumanRequest; readonly definition: HumanResponseFormDefinition; readonly nowMs: number;
  readonly label?: string; readonly submitText?: string; readonly onSubmit: (submission: HumanResponseSubmission) => void;
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

function fieldControl(field: HumanResponseField): ReactElement {
  const common = { name: field.name, required: field.required, 'aria-label': field.label };
  if (field.kind === 'textarea') return createElement('textarea', { ...common, minLength: field.minLength, maxLength: field.maxLength });
  if (field.kind === 'text') return createElement('input', { ...common, type: 'text', minLength: field.minLength, maxLength: field.maxLength });
  if (field.kind === 'number' || field.kind === 'integer') return createElement('input', {
    ...common, type: 'number', min: field.minimum, max: field.maximum, step: field.kind === 'integer' ? 1 : 'any',
  });
  if (field.kind === 'boolean') return createElement('input', { ...common, type: 'checkbox' });
  if (field.kind !== 'select') throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  return createElement('select', common,
    createElement('option', { value: '' }, 'Select an option'),
    field.options.map(option => createElement('option', { key: option.value, value: option.value }, option.label)));
}

/** Schema-bound uncontrolled form. Validation and the application callback run only on an explicit submit event. */
export function MayuraHumanResponseForm({ request, definition, nowMs, label: suppliedLabel, submitText, onSubmit }: MayuraHumanResponseFormProps): ReactElement {
  const view = useMayuraHumanRequest(request, nowMs); const accessibleLabel = label(suppliedLabel, 'Human response');
  const actionText = label(submitText, 'Submit response'); const [errorCode, setErrorCode] = useState<string | null>(null);
  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!view.canRespond) { setErrorCode('INVALID_FORM_VALUE'); return; }
    const data = new FormData(event.currentTarget); const draft: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
    for (const field of definition.fields) {
      if (field.kind === 'boolean') { draft[field.name] = data.has(field.name); continue; }
      const value = data.get(field.name); if (typeof value === 'string') draft[field.name] = value;
    }
    let submission: HumanResponseSubmission;
    try { submission = validateHumanResponse(request, definition, Object.freeze(draft)); }
    catch (error) { if (error instanceof ClientError) { setErrorCode(error.code); return; } throw error; }
    setErrorCode(null); onSubmit(submission);
  }, [definition, onSubmit, request, view.canRespond]);
  return createElement('form', { 'aria-label': accessibleLabel, 'data-mayura-component': 'human-response-form', onSubmit: submit },
    createElement('p', { 'data-mayura-prompt': true }, view.prompt),
    createElement('fieldset', { disabled: !view.canRespond },
      createElement('legend', null, accessibleLabel),
      definition.fields.map(field => createElement('label', { key: field.name }, field.label, fieldControl(field))),
      view.canRespond ? createElement('button', { type: 'submit' }, actionText) : null),
    errorCode === null ? null : createElement('p', { role: 'alert', 'data-error-code': errorCode }, 'Response values are invalid'));
}
