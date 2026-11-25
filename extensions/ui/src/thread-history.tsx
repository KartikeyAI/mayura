import { useId, useState } from 'react';

export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pendingApproval: boolean;
}

export interface ThreadHistoryProps {
  readonly threads: readonly ThreadSummary[];
  readonly activeId: string | null;
  readonly loading: boolean;
  readonly locked: boolean;
  readonly error: string | null;
  onOpen(id: string): void;
  onRefresh(): void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function formatThreadTime(updatedAt: string, today: string): string | null {
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return (date.toDateString() === today ? timeFormat : dateFormat).format(date);
}

export function ThreadHistory({ threads, activeId, loading, locked, error, onOpen, onRefresh }: ThreadHistoryProps) {
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const matches = query ? threads.filter(thread => thread.title.toLocaleLowerCase().includes(query)) : threads;
  const today = new Date().toDateString();

  return <section aria-labelledby={headingId} className="mt-6 flex min-h-0 min-w-0 flex-1 flex-col">
    <h2 id={headingId} className="shrink-0 px-2.5 pb-2 text-[11px] font-medium text-muted">Thread history</h2>
    <label htmlFor={searchId} className="sr-only">Search threads</label>
    <div className="mx-0.5 mb-2 flex min-w-0 shrink-0 items-center gap-2 rounded-lg bg-canvas/75 px-2.5 text-muted focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-focus">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.65" strokeLinecap="round" className="shrink-0">
        <circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" />
      </svg>
      <input id={searchId} type="search" value={search} onChange={event => setSearch(event.target.value)}
        maxLength={160} autoComplete="off" placeholder="Search threads"
        className="min-h-8 min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-muted focus-visible:outline-none" />
    </div>
    {error && <div className="px-2.5 py-1 text-xs leading-5 text-muted">
      <p role="status">{error}</p>
      <button type="button" onClick={onRefresh} className="rounded-sm font-medium text-accent-deep underline underline-offset-3">
        Retry history
      </button>
    </div>}
    {matches.length > 0 ? <ul aria-busy={loading}
      className="min-h-0 space-y-0.5 overflow-y-auto pb-1 [scrollbar-color:var(--color-line-strong)_transparent] [scrollbar-width:thin]">
      {matches.map(thread => {
        const time = formatThreadTime(thread.updatedAt, today);
        return <li key={thread.id}>
          <button type="button" aria-current={activeId === thread.id ? 'true' : undefined} disabled={locked}
            title={locked ? 'Wait for the current run to finish or stop it.' : thread.title} onClick={() => onOpen(thread.id)}
            className="motion-button block w-full rounded-lg px-2.5 py-1.5 text-start leading-5 hover:bg-nav-active focus-visible:outline-offset-[-2px] aria-[current=true]:bg-nav-active">
            <span className="block truncate text-[13px] font-medium text-ink">{thread.title}</span>
            <span className="flex min-h-4 flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-muted">
              {thread.pendingApproval && <span className="inline-flex items-center gap-1.5 font-medium text-warning-ink">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-warning-ink" />Approval pending
              </span>}
              {time && <time dateTime={thread.updatedAt} className={thread.pendingApproval ? 'ms-auto' : undefined}>{time}</time>}
            </span>
          </button>
        </li>;
      })}
    </ul> : !error && <p role="status" className="px-2.5 pt-0.5 text-xs leading-5 text-muted">
      {loading ? 'Loading threads…' : query ? 'No matching threads.' : 'No threads yet.'}
    </p>}
  </section>;
}
