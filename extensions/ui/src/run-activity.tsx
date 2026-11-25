import { useId, useState } from 'react';
import { Icon } from './ui.js';

export interface RunActivityItem {
  readonly id: string;
  readonly kind: 'step' | 'tool';
  readonly label: string;
  readonly status: 'running' | 'complete' | 'paused' | 'declined' | 'failed' | 'stopped' | 'unconfirmed';
}

export interface RunActivityProps {
  readonly items: readonly RunActivityItem[];
  readonly status: 'streaming' | 'paused' | 'complete' | 'error' | 'stopped';
  readonly streamingLabel: string;
  readonly thinking?: boolean;
}

const runStatus = {
  paused: 'Waiting for approval',
  complete: 'Complete',
  error: 'Run unconfirmed',
  stopped: 'Stopped',
} satisfies Record<Exclude<RunActivityProps['status'], 'streaming'>, string>;

const activityStatus = {
  running: { label: 'In progress', icon: 'pulse' },
  complete: { label: 'Complete', icon: 'check' },
  paused: { label: 'Interrupted', icon: 'shield' },
  declined: { label: 'Declined', icon: 'close' },
  failed: { label: 'Failed', icon: 'close' },
  stopped: { label: 'Stopped', icon: 'stop' },
  unconfirmed: { label: 'Unconfirmed', icon: 'pulse' },
} as const;

function itemLabel(item: RunActivityItem): string {
  if (item.kind === 'tool' && item.status === 'running') return 'Preparing';
  if (item.kind === 'tool' && item.status === 'paused') return 'Awaiting approval';
  return activityStatus[item.status].label;
}

export function RunActivity({ items, status, streamingLabel, thinking = false }: RunActivityProps) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const summary = status === 'streaming' ? streamingLabel : runStatus[status];

  return <div className="run-activity min-w-0">
    <button type="button" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(value => !value)}
      className="stream-status motion-button -ml-2 min-h-8 max-w-full rounded-md px-2 py-1 text-left hover:bg-wash aria-expanded:bg-wash"
      data-thinking={status === 'streaming' && thinking}>
      {status === 'streaming' && thinking
        ? <span className="stream-dots shrink-0" aria-hidden="true"><i /><i /><i /></span>
        : <Icon name="pulse" size={15} />}
      <span className="shrink-0 text-secondary">Run activity</span>
      <span aria-hidden="true" className="size-0.5 shrink-0 rounded-full bg-muted" />
      <span className="min-w-0 truncate font-normal">{summary}</span>
      <span className="disclosure-chevron shrink-0"><Icon name="chevron" size={12} /></span>
    </button>
    <span role="status" className="sr-only">{status === 'streaming' ? 'Run in progress' : summary}</span>
    <div id={detailsId} data-expanded={expanded} inert={!expanded} className="chat-disclosure">
      <div className="chat-disclosure-inner">
        {items.length ? <ol role="list" aria-label="Run events" className="mt-1 max-w-md space-y-1">
          {items.map(item => {
            return <li key={item.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2.5 py-0.5 text-xs leading-5">
              <span className="mt-[3px] text-muted"><Icon name={activityStatus[item.status].icon} size={14} /></span>
              <span className="[overflow-wrap:anywhere] text-secondary">{item.label}</span>
              <span className="text-right text-muted">{itemLabel(item)}</span>
            </li>;
          })}
        </ol> : <p className="mt-2 text-xs text-muted">
          {status === 'streaming' ? 'Waiting for the first activity event.' : 'No steps or tools were reported.'}
        </p>}
      </div>
    </div>
  </div>;
}
