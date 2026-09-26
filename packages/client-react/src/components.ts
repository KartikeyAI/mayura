import { createElement, useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ClientError, type RemoteHumanRequest } from '@mayura/client';
import { validateHumanResponse, type HumanResponseCommandState, type HumanResponseField, type HumanResponseFormDefinition,
  type HumanResponseSubmission } from '@mayura/client/forms';
import type { HeadlessRunStore } from '@mayura/client/headless';
import type { WorkflowCommandState, WorkflowViewInput } from '@mayura/client/workflows';
import { MayuraReactError, useMayuraHumanRequest, useMayuraRun, useMayuraRunActivity, useMayuraWorkflowGraph } from './index.js';

export interface MayuraRunSummaryProps { readonly store: HeadlessRunStore; readonly label?: string }
export interface MayuraWorkflowGraphProps { readonly input: WorkflowViewInput; readonly label?: string }
export interface MayuraHumanRequestCardProps {
  readonly request: RemoteHumanRequest; readonly nowMs: number; readonly label?: string;
  readonly onRespond?: (request: { readonly id: string; readonly digest: string }) => void;
}
export interface MayuraHumanResponseFormProps {
  readonly request: RemoteHumanRequest; readonly definition: HumanResponseFormDefinition; readonly nowMs: number;
  readonly label?: string; readonly submitText?: string; readonly commandState?: HumanResponseCommandState;
  readonly onSubmit: (submission: HumanResponseSubmission) => void;
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

export interface MayuraWorkflowPauseControlProps {
  readonly workflow: WorkflowViewInput; readonly commandState?: WorkflowCommandState; readonly label?: string;
  /** Distinguishes otherwise identical buttons for assistive technology, e.g. "run 7d2ddd96" gives "Pause workflow for run 7d2ddd96". */
  readonly subject?: string;
  readonly onPause?: (target: { readonly runId: string; readonly revision: number }) => void;
  readonly onResume?: (target: { readonly runId: string; readonly revision: number }) => void;
}
/** Explicit per-run pause/resume intent. Mounting performs no request; the application routes each event to its command controller. */
export function MayuraWorkflowPauseControl({ workflow, commandState, label: suppliedLabel, subject, onPause, onResume }: MayuraWorkflowPauseControlProps): ReactElement {
  const accessibleLabel = label(suppliedLabel, 'Workflow pause control'); const subjectText = subject === undefined ? undefined : label(subject, 'workflow');
  if (commandState !== undefined && (!Object.isFrozen(commandState) || commandState.runId !== workflow.runId)) throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  // Feedback describes one revision; once the view has moved on (another operator, a fleet sweep) it is stale and hidden.
  const current = commandState !== undefined && (commandState.status === 'submitting' || commandState.workflowRevision === workflow.revision);
  const status = current ? commandState!.status : 'idle'; const busy = status === 'submitting' || status === 'disposed';
  const pausable = ['running', 'waiting'].includes(workflow.status) && onPause !== undefined;
  const resumable = workflow.status === 'paused' && onResume !== undefined;
  const target = Object.freeze({ runId: workflow.runId, revision: workflow.revision });
  const act = useCallback(() => {
    // aria-disabled keeps focus on the control while a command is in flight; the handler itself enforces the lock.
    if (busy) return;
    if (pausable) onPause!(target); else if (resumable) onResume!(target);
  }, [busy, pausable, resumable, onPause, onResume, target.runId, target.revision]);
  const action = current ? commandState!.action : null;
  const feedback = status === 'submitting' ? (action === 'pause' ? 'Pausing workflow' : action === 'resume' ? 'Resuming workflow' : 'Command in progress')
    : status === 'succeeded' ? (action === 'pause' ? 'Pause applied' : action === 'resume' ? 'Resume requested' : 'Command applied')
      : status === 'conflict' ? 'Workflow changed or has an effect in flight; refresh before retrying'
        : status === 'failed' ? 'Command outcome unknown; refresh before retrying'
          : status === 'disposed' ? 'Command controller closed' : null;
  return createElement('section', { 'aria-label': accessibleLabel, 'data-mayura-component': 'workflow-pause-control', 'aria-busy': status === 'submitting' },
    createElement('p', { role: 'status', 'aria-live': 'polite', 'data-workflow-status': workflow.status, 'data-command-status': status },
      feedback === null ? `Workflow ${workflow.status}` : `Workflow ${workflow.status}. ${feedback}`),
    pausable || resumable ? createElement('button', { key: 'action', type: 'button', onClick: act, 'aria-disabled': busy,
      'data-action': pausable ? 'pause' : 'resume',
      ...(subjectText === undefined ? {} : { 'aria-label': `${pausable ? 'Pause workflow' : 'Resume workflow'} for ${subjectText}` }) },
    pausable ? 'Pause workflow' : 'Resume workflow') : null);
}

export interface MayuraFleetHoldControlProps {
  readonly fleet: { readonly held: boolean; readonly generation: number; readonly changedAtMs: number | null };
  readonly status?: 'idle' | 'submitting' | 'succeeded' | 'conflict' | 'failed'; readonly label?: string;
  readonly onHold?: () => void; readonly onRelease?: () => void;
}
/** Fleet hold/release intent with a two-step confirmation before holding every run in the scope. */
export function MayuraFleetHoldControl({ fleet, status = 'idle', label: suppliedLabel, onHold, onRelease }: MayuraFleetHoldControlProps): ReactElement {
  const accessibleLabel = label(suppliedLabel, 'Fleet hold control'); const [confirming, setConfirming] = useState(false);
  const primary = useRef<HTMLButtonElement | null>(null); const wasConfirming = useRef(false);
  // Return focus to the primary action when the confirmation closes, so keyboard users are not dropped to the page body.
  useEffect(() => { if (wasConfirming.current && !confirming) primary.current?.focus(); wasConfirming.current = confirming; }, [confirming]);
  if (!fleet || typeof fleet.held !== 'boolean' || !Number.isSafeInteger(fleet.generation) || fleet.generation < 0
    || !['idle', 'submitting', 'succeeded', 'conflict', 'failed'].includes(status)) throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  const busy = status === 'submitting';
  const request = useCallback(() => { if (!busy) setConfirming(true); }, [busy]);
  const cancel = useCallback(() => { setConfirming(false); }, []);
  const confirm = useCallback(() => { if (busy) return; setConfirming(false); onHold?.(); }, [busy, onHold]);
  const release = useCallback(() => { if (!busy) onRelease?.(); }, [busy, onRelease]);
  const summary = fleet.held ? `Fleet held (generation ${fleet.generation}); hosts and coordinators drive no runs` : 'Fleet running';
  const feedback = status === 'submitting' ? 'Updating fleet hold' : status === 'conflict' ? 'Fleet state changed; refresh before retrying'
    : status === 'failed' ? 'Fleet command outcome unknown; refresh before retrying' : null;
  const actions = fleet.held
    ? (onRelease === undefined ? null : createElement('button', { key: 'primary', ref: primary, type: 'button', onClick: release, 'aria-disabled': busy }, 'Release fleet hold'))
    : onHold === undefined ? null : confirming
      ? createElement('div', { key: 'confirm', role: 'group', 'aria-label': 'Confirm fleet hold' },
        createElement('p', { id: 'mayura-fleet-hold-warning' }, 'Holding stops every host and coordinator in this scope from driving runs.'),
        createElement('button', { type: 'button', onClick: confirm, 'aria-disabled': busy, 'aria-describedby': 'mayura-fleet-hold-warning', autoFocus: true }, 'Confirm hold'),
        createElement('button', { type: 'button', onClick: cancel }, 'Cancel'))
      : createElement('button', { key: 'primary', ref: primary, type: 'button', onClick: request, 'aria-disabled': busy }, 'Hold fleet');
  return createElement('section', { 'aria-label': accessibleLabel, 'data-mayura-component': 'fleet-hold-control', 'aria-busy': busy },
    createElement('p', { role: 'status', 'aria-live': 'polite', 'data-fleet-held': fleet.held, 'data-command-status': status },
      feedback === null ? summary : `${summary}. ${feedback}`), actions);
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
export function MayuraHumanResponseForm({ request, definition, nowMs, label: suppliedLabel, submitText, commandState, onSubmit }: MayuraHumanResponseFormProps): ReactElement {
  const view = useMayuraHumanRequest(request, nowMs); const accessibleLabel = label(suppliedLabel, 'Human response');
  const actionText = label(submitText, 'Submit response'); const [errorCode, setErrorCode] = useState<string | null>(null);
  if (commandState !== undefined && (!Object.isFrozen(commandState) || commandState.requestId !== request.id || commandState.requestDigest !== request.digest))
    throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  const commandStatus = commandState?.status ?? 'idle'; const locked = ['submitting', 'succeeded', 'conflict', 'disposed'].includes(commandStatus);
  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!view.canRespond || locked) { setErrorCode('INVALID_FORM_VALUE'); return; }
    const data = new FormData(event.currentTarget); const draft: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
    for (const field of definition.fields) {
      if (field.kind === 'boolean') { draft[field.name] = data.has(field.name); continue; }
      const value = data.get(field.name); if (typeof value === 'string') draft[field.name] = value;
    }
    let submission: HumanResponseSubmission;
    try { submission = validateHumanResponse(request, definition, Object.freeze(draft)); }
    catch (error) { if (error instanceof ClientError) { setErrorCode(error.code); return; } throw error; }
    setErrorCode(null); onSubmit(submission);
  }, [definition, locked, onSubmit, request, view.canRespond]);
  const feedback = commandStatus === 'submitting' ? 'Submitting response' : commandStatus === 'succeeded' ? 'Response submitted'
    : commandStatus === 'conflict' ? 'Request changed; refresh required' : commandStatus === 'failed' ? 'Response submission failed'
      : commandStatus === 'disposed' ? 'Response controller disposed' : null;
  return createElement('form', { 'aria-label': accessibleLabel, 'data-mayura-component': 'human-response-form', onSubmit: submit },
    createElement('p', { 'data-mayura-prompt': true }, view.prompt),
    createElement('fieldset', { disabled: !view.canRespond || locked },
      createElement('legend', null, accessibleLabel),
      definition.fields.map(field => createElement('label', { key: field.name }, field.label, fieldControl(field))),
      view.canRespond && !locked ? createElement('button', { type: 'submit' }, actionText) : null),
    feedback === null ? null : createElement('p', { role: 'status', 'aria-live': 'polite', 'data-command-status': commandStatus }, feedback),
    errorCode === null ? null : createElement('p', { role: 'alert', 'data-error-code': errorCode }, 'Response values are invalid'));
}
