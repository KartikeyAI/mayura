import { createElement, useCallback, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ClientJson, RemoteThreadEntry } from '@mayura/client';
import type { HeadlessThreadStore, RunApprovalController, RunApprovalCommandState } from '@mayura/client/headless';
import { MayuraReactError, useMayuraThread, useMayuraRunApprovalCommand } from './index.js';

export interface MayuraThreadHistoryProps {
  readonly store: HeadlessThreadStore; readonly label?: string;
  /** Maximum displayed characters per entry (default 8,192, at most 65,536). Truncation is explicit. */
  readonly maxContentChars?: number;
  /** Explicit page intents; route these to store.refresh with the store's configured limit. */
  readonly onLoadEarlier?: (page: { readonly before: number }) => void;
  readonly onLoadLater?: (page: { readonly after: number }) => void;
}
export interface MayuraRunApprovalControlProps {
  readonly controller: RunApprovalController;
  /** Caller-owned clock: update this to reflect expiry; the component starts no timer. */
  readonly nowMs: number;
  readonly label?: string;
  /** Optional accessible context when several runs have pending approvals. */
  readonly subject?: string;
  /** Default 8,192, at most 65,536. Approval is unavailable if the input cannot be displayed in full. */
  readonly maxInputChars?: number;
}
function invalid(): never { throw new MayuraReactError('INVALID_COMPONENT_PROPS'); }
function label(value: string | undefined, fallback: string): string {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.length < 1 || result.length > 128 || result.includes('\0')) return invalid(); return result;
}
function bound(value: number | undefined): number {
  const result = value ?? 8_192; if (!Number.isSafeInteger(result) || result < 1 || result > 65_536) return invalid(); return result;
}
/** Values remain text, including strings that resemble HTML, Markdown, URLs or tool instructions. */
function display(value: ClientJson, maximum: number, json = false): { readonly text: string; readonly truncated: boolean } {
  const raw = typeof value === 'string' && !json ? value : JSON.stringify(value, null, 2);
  // Do not split a UTF-16 surrogate pair at the display boundary.
  const end = raw.length > maximum && /[\uD800-\uDBFF]/.test(raw[maximum - 1]!) ? maximum - 1 : maximum;
  return { text: raw.slice(0, end), truncated: raw.length > maximum };
}
function entryContent(entry: RemoteThreadEntry): { readonly name: string; readonly content: ClientJson } {
  switch (entry.kind) {
    case 'user': return { name: 'You', content: entry.content };
    case 'assistant': return { name: 'Assistant', content: entry.output };
    case 'tool_calls': return { name: 'Tool calls', content: entry.calls };
    case 'tool_result': return { name: `Tool result: ${entry.toolId}`, content: entry.result };
    case 'approval': return { name: `Approval: ${entry.toolId}`, content: `${entry.decision}${entry.actorId ? ` by ${entry.actorId}` : ''}` };
    case 'run': return { name: 'Run', content: `${entry.status}${entry.errorCode ? ` (${entry.errorCode})` : ''}` };
    case 'summary': return { name: `Summary of entries ${entry.covers.from}–${entry.covers.to}`, content: entry.content };
  }
}
function historyEntry(entry: RemoteThreadEntry, maximum: number): ReactElement {
  const content = entryContent(entry); const text = display(content.content, maximum);
  const omitted = 'omitted' in entry && entry.omitted === 'too_large';
  const media = 'mediaOmitted' in entry ? entry.mediaOmitted : undefined;
  return createElement('li', { key: entry.sequence, value: entry.sequence, 'data-kind': entry.kind, 'data-turn-id': entry.turnId },
    createElement('p', null, content.name, ' · ', createElement('time', { dateTime: entry.createdAt }, entry.createdAt)),
    omitted ? createElement('p', { 'data-mayura-omitted': true }, 'Content omitted from the saved history because it was too large')
      : createElement('pre', { 'data-mayura-content': true }, text.text),
    !omitted && text.truncated ? createElement('p', { 'data-mayura-truncated': true }, 'Display truncated; the saved entry contains more content') : null,
    'media' in entry && entry.media?.length ? createElement('ul', { 'aria-label': 'Saved media references' }, ...entry.media.map((reference,index) => createElement('li', { key: `${reference.id}-${index}` }, `${reference.name ?? reference.mediaType} · ${reference.id}`))) : null,
    media ? createElement('p', null, `${media} media item${media === 1 ? '' : 's'} omitted from the saved history`) : null);
}
/** One bounded history page. Rendering never fetches, paginates, scrolls, starts a run or disposes a shared store. */
export function MayuraThreadHistory({ store, label: suppliedLabel, maxContentChars, onLoadEarlier, onLoadLater }: MayuraThreadHistoryProps): ReactElement {
  const state = useMayuraThread(store); const accessibleLabel = label(suppliedLabel, 'Thread history'); const maximum = bound(maxContentChars);
  if ((onLoadEarlier !== undefined && typeof onLoadEarlier !== 'function') || (onLoadLater !== undefined && typeof onLoadLater !== 'function')) return invalid();
  const first = state.entries[0]?.sequence; const last = state.entries.at(-1)?.sequence;
  const locked = !['ready', 'failed'].includes(state.status);
  const page = (direction: 'earlier' | 'later'): void => {
    const current = store.getSnapshot(); if (!['ready', 'failed'].includes(current.status)) return;
    const before = current.entries[0]?.sequence; const after = current.entries.at(-1)?.sequence;
    if (direction === 'earlier' && before !== undefined && before > 1) onLoadEarlier?.(Object.freeze({ before }));
    else if (direction === 'later' && after !== undefined && after < (current.thread?.lastSequence ?? 0)) onLoadLater?.(Object.freeze({ after }));
  };
  // Durable recording markers are bookkeeping between chunks, rather than conversation messages.
  const entries = useMemo(() => state.entries.filter(entry => entry.kind !== 'run' || !entry.recording), [state.entries]);
  const renderedEntries = useMemo(() => entries.map(entry => historyEntry(entry, maximum)), [entries, maximum]);
  const feedback = state.status === 'loading' ? 'Loading conversation history' : state.status === 'deleted' ? 'Conversation deleted'
    : state.status === 'disposed' ? 'History view closed' : state.status === 'idle' ? 'History not loaded' : 'Conversation history';
  return createElement('section', { 'aria-label': accessibleLabel, 'aria-busy': state.status === 'loading', 'data-mayura-component': 'thread-history' },
    createElement('p', { role: 'status', 'aria-live': 'polite', 'data-history-status': state.status }, feedback),
    state.errorCode === null ? null : createElement('p', { role: 'alert' }, entries.length ? 'History could not be refreshed. Showing the last loaded page.' : 'History could not be loaded.'),
    entries.length ? createElement('ol', { 'aria-label': 'Conversation entries', start: entries[0]!.sequence }, renderedEntries)
      : createElement('p', { 'data-mayura-empty': true }, state.status === 'ready' ? 'No conversation entries on this page' : 'No conversation entries displayed'),
    onLoadEarlier !== undefined && first !== undefined && first > 1
      ? createElement('button', { type: 'button', 'aria-disabled': locked, onClick: () => page('earlier') }, 'Load earlier entries') : null,
    onLoadLater !== undefined && last !== undefined && last < (state.thread?.lastSequence ?? 0)
      ? createElement('button', { type: 'button', 'aria-disabled': locked, onClick: () => page('later') }, 'Load later entries') : null);
}
interface ApprovalBodyProps {
  readonly controller: RunApprovalController; readonly state: RunApprovalCommandState; readonly nowMs: number;
  readonly accessibleLabel: string; readonly subject: string | undefined; readonly maximum: number;
}
/** Keyed to the captured approval, so a new request gets a fresh reason field and local validation state. */
function ApprovalBody({ controller, state, nowMs, accessibleLabel, subject, maximum }: ApprovalBodyProps): ReactElement {
  const reasonId = useId(); const inputId = useId(); const errorId = useId(); const reason = useRef<HTMLTextAreaElement | null>(null);
  const [invalidReason, setInvalidReason] = useState(false); const approval = state.approval;
  const input = useMemo(() => display(approval.input, maximum, true), [approval.input, maximum]); const expired = nowMs >= approval.expiresAtMs;
  // A failed transport can have applied a decision. Require a fresh inspection instead of presenting a retry button.
  const locked = state.status !== 'idle' || expired;
  const decide = useCallback((decision: 'approved' | 'rejected') => {
    const current = controller.getSnapshot();
    // Recheck synchronously: two click events may arrive before React has painted submitting feedback.
    if (current.status !== 'idle' || current.approval.digest !== approval.digest || current.approval.callId !== approval.callId
      || nowMs >= current.approval.expiresAtMs || (decision === 'approved' && input.truncated)) return;
    const value = reason.current?.value ?? ''; if (value.length > 1_000) { setInvalidReason(true); return; }
    setInvalidReason(false);
    // The controller publishes errors and accepted decisions; rendering never owns or retries the command.
    void controller.submit(decision, value.length ? { reason: value } : undefined).catch(() => {});
  }, [controller, approval.callId, approval.digest, nowMs, input.truncated]);
  const feedback = state.status === 'submitting' ? 'Submitting decision' : state.status === 'succeeded' ? 'Decision submitted'
    : state.status === 'conflict' ? 'Approval changed or expired; refresh the run before deciding'
      : state.status === 'failed' ? 'Decision outcome unknown; refresh the run before deciding'
        : state.status === 'disposed' ? 'Approval controller closed' : expired ? 'Approval expired; refresh the run' : 'Awaiting your decision';
  const context = subject ?? `${approval.toolId}, call ${approval.callId}`;
  return createElement('section', { 'aria-label': accessibleLabel, 'aria-busy': state.status === 'submitting', 'data-mayura-component': 'run-approval-control' },
    createElement('p', null, `Review ${approval.toolId} (version ${approval.toolVersion})`),
    createElement('p', null, `Call ${approval.callId}`),
    createElement('p', null, 'Expires ', createElement('time', { dateTime: new Date(approval.expiresAtMs).toISOString() }, new Date(approval.expiresAtMs).toISOString())),
    createElement('pre', { id: inputId, 'data-mayura-approval-input': true }, input.text),
    input.truncated ? createElement('p', { 'data-mayura-truncated': true }, 'Input truncated. Review the full input outside this view before approving. You can still reject this request.') : null,
    createElement('label', { htmlFor: reasonId }, 'Reason (optional)'),
    createElement('textarea', { key: 'reason', ref: reason, id: reasonId, maxLength: 1_000, disabled: locked,
      'aria-invalid': invalidReason, 'aria-describedby': invalidReason ? errorId : undefined, onInput: () => setInvalidReason(false) }),
    invalidReason ? createElement('p', { id: errorId, role: 'alert' }, 'Reason must be at most 1,000 characters') : null,
    createElement('p', { role: 'status', 'aria-live': 'polite', 'data-command-status': state.status }, feedback),
    createElement('button', { type: 'button', 'aria-label': `Approve for ${context}`, 'aria-disabled': locked || input.truncated,
      'aria-describedby': inputId, onClick: () => decide('approved') }, 'Approve'),
    createElement('button', { type: 'button', 'aria-label': `Reject for ${context}`, 'aria-disabled': locked,
      'aria-describedby': inputId, onClick: () => decide('rejected') }, 'Reject'));
}
/** Review and decide one captured approval. Buttons keep focus while busy; neither mounting nor expiry starts work. */
export function MayuraRunApprovalControl({ controller, nowMs, label: suppliedLabel, subject, maxInputChars }: MayuraRunApprovalControlProps): ReactElement {
  const state = useMayuraRunApprovalCommand(controller); const accessibleLabel = label(suppliedLabel, 'Run approval');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(state.approval.expiresAtMs).getTime())) return invalid();
  const subjectText = subject === undefined ? undefined : label(subject, 'run');
  return createElement(ApprovalBody, { key: `${state.approval.callId}:${state.approval.digest}`, controller, state, nowMs,
    accessibleLabel, subject: subjectText, maximum: bound(maxInputChars) });
}
