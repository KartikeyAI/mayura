import { createElement, useId, useMemo, type ReactElement } from 'react';
import type { ThreadCompactionController, ThreadCompactionState } from '@mayura/client/headless';
import { MayuraReactError, useMayuraThreadCompactionCommand } from './index.js';

export interface MayuraThreadCompactionControlProps {
  readonly controller: ThreadCompactionController;
  readonly label?: string;
  /** Accessible context when several conversations have controls on the same screen. */
  readonly subject?: string;
  /** Maximum displayed summary characters; default 8,192, at most 65,536. Truncation is explicit. */
  readonly maxSummaryChars?: number;
}
function text(value: string | undefined, fallback: string): string {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || !selected.length || selected.length > 128 || selected.includes('\0')) throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  return selected;
}
/** Derive availability from current state, including synchronous event-time rechecks before every command. */
function availability(state: ThreadCompactionState) {
  const closed = state.status === 'disposed'; const busy = ['submitting', 'loading'].includes(state.status);
  const committed = state.result !== null || state.compaction?.status === 'committed' || state.cancellation?.status === 'committed';
  const cancelled = state.cancellation?.status === 'cancelled';
  return {
    start: !closed && !state.cancelling && state.status === 'idle' && !committed && !cancelled && state.compaction === null && state.cancellation === null,
    publish: !closed && !state.cancelling && state.status === 'ready' && state.errorCode === null && !committed && !cancelled && state.compaction?.status === 'ready',
    inspect: !closed && !busy && !state.cancelling,
    cancel: !closed && !state.cancelling && !committed && !cancelled && state.status !== 'idle' && state.compaction?.status !== 'failed',
  };
}
function feedback(state: ThreadCompactionState): string {
  if (state.status === 'disposed') return 'Compaction controller closed';
  if (state.cancelling) return 'Cancelling compaction';
  if (state.status === 'loading') return 'Inspecting compaction command';
  if (state.status === 'submitting') return 'Submitting compaction command';
  if (state.errorCode !== null || state.status === 'failed') return 'Request outcome uncertain; inspect this command before continuing';
  if (state.result || state.compaction?.status === 'committed' || state.cancellation?.status === 'committed') return 'Summary saved; refresh thread history to read the current conversation';
  if (state.cancellation?.status === 'cancelled') return 'Compaction cancelled; late summary publication is blocked';
  if (state.compaction?.status === 'failed') return 'Compaction failed; a new paid attempt requires a new command';
  if (state.compaction?.status === 'ready') return 'Summary staged; publish the saved summary without another model call';
  if (state.compaction?.status === 'pending') return 'Compaction pending; inspect again or cancel';
  if (state.cancellation?.status === 'missing') return 'No reservation observed; an in-flight request may still reserve this command. Inspect again';
  return 'Ready to summarize earlier conversation';
}
/**
 * Explicit controls for one captured command. Mounting, SSR, StrictMode and unmounting start no work.
 * Ambiguous failures require inspection; only a durably staged summary offers publication with the same command.
 */
export function MayuraThreadCompactionControl({ controller, label, subject, maxSummaryChars }: MayuraThreadCompactionControlProps): ReactElement {
  const state = useMayuraThreadCompactionCommand(controller); const accessibleLabel = text(label, 'Thread compaction');
  const context = text(subject, state.threadId); const maximum = maxSummaryChars ?? 8_192;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65_536) throw new MayuraReactError('INVALID_COMPONENT_PROPS');
  const detailId = useId(); const allowed = availability(state);
  const summary = state.result?.entry.content;
  const displayed = useMemo(() => {
    if (summary === undefined) return null;
    const end = summary.length > maximum && /[\uD800-\uDBFF]/.test(summary[maximum - 1]!) ? maximum - 1 : maximum;
    return { content: summary.slice(0, end), truncated: summary.length > maximum };
  }, [summary, maximum]);
  const invoke = (action: 'compact' | 'refresh' | 'cancel'): void => {
    const current = controller.getSnapshot(); const next = availability(current);
    if (action === 'compact' ? !(next.start || next.publish) : action === 'refresh' ? !next.inspect : !next.cancel) return;
    // Errors belong to the shared controller state; never automatically retry or generate another command id.
    void controller[action]().catch(() => {});
  };
  const progress = state.compaction;
  const publish = progress?.status === 'ready' && !state.result;
  return createElement('section', { 'aria-label': accessibleLabel, 'aria-busy': ['submitting', 'loading'].includes(state.status) || state.cancelling,
    'data-mayura-component': 'thread-compaction-control' },
    createElement('div', { id: detailId },
      createElement('p', null, `Thread: ${state.threadId}`),
      createElement('p', null, `Command: ${state.commandId}`),
      createElement('p', null, `Summarize entries 1–${state.command.through}`),
      state.command.previousSummarySequence === undefined ? null : createElement('p', null, `Previous summary: entry ${state.command.previousSummarySequence}`),
      createElement('p', null, 'Starting may use the host-configured model budget. Original conversation entries are retained.')),
    createElement('p', { role: 'status', 'aria-live': 'polite', 'data-command-status': state.status }, feedback(state)),
    state.errorCode === null ? null : createElement('p', { role: 'alert' }, 'The request could not be confirmed. Inspect the same command; do not start a replacement while its outcome is unknown.'),
    progress === null ? null : createElement('dl', { 'aria-label': 'Last inspected compaction' },
      createElement('dt', null, 'Last inspected status'), createElement('dd', null, progress.status),
      createElement('dt', null, 'Budget ceiling (micros)'), createElement('dd', null, String(progress.maxCostMicros)),
      createElement('dt', null, 'Recorded cost (micros)'), createElement('dd', null, progress.costMicros === null ? 'Unknown; account for the budget ceiling' : String(progress.costMicros))),
    state.result === null ? null : createElement('p', null, `Saved summary: entry ${state.result.entry.sequence}; recorded cost ${state.result.costMicros} micros`),
    displayed === null ? null : createElement('div', { 'data-mayura-summary': true },
      createElement('p', null, 'Saved summary (untrusted conversation text)'), createElement('pre', null, displayed.content),
      displayed.truncated ? createElement('p', { 'data-mayura-truncated': true }, 'Display truncated; read the complete saved summary in thread history') : null),
    createElement('button', { type: 'button', 'aria-label': `${publish ? 'Publish saved summary' : 'Start compaction'} for ${context}`,
      'aria-disabled': !(allowed.start || allowed.publish), 'aria-describedby': detailId, onClick: () => invoke('compact') }, publish ? 'Publish saved summary' : 'Start compaction'),
    createElement('button', { type: 'button', 'aria-label': `Inspect compaction for ${context}`, 'aria-disabled': !allowed.inspect, onClick: () => invoke('refresh') }, 'Inspect command'),
    createElement('button', { type: 'button', 'aria-label': `Cancel compaction for ${context}`, 'aria-disabled': !allowed.cancel, onClick: () => invoke('cancel') }, 'Cancel compaction'));
}
