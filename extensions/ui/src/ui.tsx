'use client';

import { Fragment, useId, useState, type ReactNode } from 'react';
import type { Citation } from './ag-ui.js';

const paths = {
  arrow: <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.4" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  list: <><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2"/></>,
  file: <><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/></>,
  shield: <><path d="M12 22c4.4-2.2 7-5.4 7-9V6l-7-3-7 3v7c0 3.6 2.6 6.8 7 9Z"/><path d="m9 12 2 2 4-4"/></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H9l-5 2 1.3-4A7.5 7.5 0 1 1 20 11.5Z" />,
  pulse: <path d="M2 12h5l3-6 4 12 3-6h5" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>,
  moon: <path d="M20.4 15.4A9 9 0 0 1 8.6 3.6a9 9 0 1 0 11.8 11.8Z" />,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></>,
  logout: <><path d="M10 4H5v16h5m3-4 4-4-4-4m-4 4h12"/></>,
} satisfies Record<string, ReactNode>;

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">{paths[name]}</svg>;
}

export const disclosureChevronClassName = 'disclosure-chevron inline-flex motion-safe:[transition:transform_var(--motion-fast)_var(--ease-out)] [[aria-expanded=true]>&]:[transform:rotate(90deg)]';
export const chatDisclosureClassName = 'chat-disclosure invisible grid grid-rows-[0fr] opacity-0 data-[expanded=true]:visible data-[expanded=true]:grid-rows-[1fr] data-[expanded=true]:opacity-100 '
  + 'motion-safe:[transition:grid-template-rows_var(--motion-enter)_var(--ease-out),opacity_var(--motion-fast)_ease,visibility_0s_var(--motion-enter)] data-[expanded=true]:[transition-delay:0s]';

const approvalTransitionClassName = 'motion-safe:[transition:background-color_var(--motion-fast)_ease,color_var(--motion-fast)_ease,transform_var(--motion-fast)_var(--ease-out)]';
const approvalActionClassName = 'approval-action min-h-8 rounded-md py-1.5 text-[13px] font-medium motion-safe:active:[transform:scale(.97)] ' + approvalTransitionClassName;
const approvalInputClassName = 'approval-input m-0 overflow-auto [overflow-wrap:anywhere] [scrollbar-color:var(--color-line-strong)_transparent] focus-visible:outline-offset-[-1px]';

export interface SourceControls {
  readonly citations: readonly Citation[];
  readonly active: string | null;
  readonly panelId: string;
  readonly mobile: boolean;
  onOpen(id: string, trigger: HTMLButtonElement): void;
}

export function AnswerText({ content, citations, active, panelId, mobile, onOpen }: SourceControls & { content: string }) {
  const inline = (value: string) => value.split(/(\[\d{1,2}\]|\*\*[^*\n]+\*\*)/u).map((part, index) => {
    const source = citations.find(citation => part === '[' + citation.id + ']');
    if (source) return <button type="button" key={index} onClick={event => onOpen(source.id, event.currentTarget)}
      aria-label={'Open source: ' + source.title} aria-expanded={active === source.id}
      aria-controls={active === source.id ? panelId : undefined} aria-haspopup={mobile ? 'dialog' : undefined}
      className="citation-marker inline-flex size-6 items-center justify-center rounded-sm align-baseline text-[color:var(--color-accent)] aria-expanded:bg-[var(--color-tint-strong)] [@media(hover:hover)_and_(pointer:fine)]:[&:hover]:text-[color:var(--color-accent-deep)]">
      <sup className="citation-index text-[0.6875rem] font-medium tabular-nums underline underline-offset-[.15em]">{source.id}</sup>
    </button>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>;
    return <Fragment key={index}>{part}</Fragment>;
  });

  const blocks: { kind: 'text' | 'heading' | 'list' | 'ordered'; lines: string[] }[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) blocks.push({ kind: 'heading', lines: [line.slice(3)] });
    else if (/^(?:[-*]|\d{1,2}\.) /u.test(line)) {
      const kind = /^\d/u.test(line) ? 'ordered' : 'list';
      const item = line.slice(line.indexOf(' ') + 1);
      const previous = blocks.at(-1);
      if (previous?.kind === kind) previous.lines.push(item);
      else blocks.push({ kind, lines: [item] });
    } else if (line.trim()) blocks.push({ kind: 'text', lines: [line] });
  }

  return <div className="w-full space-y-3 [overflow-wrap:anywhere] text-[15px] leading-[1.75] text-[color:var(--color-ink)]">
    {blocks.map((block, index) => {
      if (block.kind === 'list' || block.kind === 'ordered') {
        const List = block.kind === 'ordered' ? 'ol' : 'ul';
        return <List key={index} className={'space-y-1 pl-5 marker:text-[color:var(--color-accent)] ' + (List === 'ol' ? 'list-decimal' : 'list-disc')}>
          {block.lines.map((line, i) => <li key={i}>{inline(line)}</li>)}
        </List>;
      }
      const line = block.lines[0] ?? '';
      if (block.kind === 'heading') return <h3 key={index} className="text-base font-semibold tracking-tight">{inline(line)}</h3>;
      return <p key={index}>{inline(line)}</p>;
    })}
  </div>;
}

export function Sources({ citations, active, panelId, mobile, onOpen }: SourceControls) {
  return <section aria-label="Sources" className="mt-5">
    <h3 className="text-xs font-medium text-[color:var(--color-muted)]">Sources</h3>
    <div className="mt-0.5 flex flex-wrap items-center gap-x-5">
      {citations.map(source => <button key={source.id} type="button" aria-expanded={active === source.id}
        aria-controls={active === source.id ? panelId : undefined} aria-haspopup={mobile ? 'dialog' : undefined}
        onClick={event => onOpen(source.id, event.currentTarget)}
        className="source-button group/mayura-source inline-flex min-h-9 max-w-full items-baseline gap-1.5 py-2 text-left text-[13px] leading-5 text-[color:var(--color-secondary)] aria-expanded:text-[color:var(--color-accent-deep)] [@media(pointer:coarse)]:min-h-[2.75rem]">
        <span className="citation-index shrink-0 text-[0.6875rem] text-[color:var(--color-accent)] tabular-nums">{source.id}</span>
        <span className="source-title min-w-0 [overflow-wrap:anywhere] underline-offset-[.22em] group-aria-expanded/mayura-source:underline [@media(hover:hover)_and_(pointer:fine)]:group-hover/mayura-source:underline">{source.title}</span>
      </button>)}
    </div>
  </section>;
}

export function SourceInspector({ source }: { source: Citation }) {
  return <figure className="m-0 min-w-0">
    <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-[color:var(--color-secondary)] [overflow-wrap:anywhere]">
      <span>{source.detail}</span>
      <span className="text-xs text-[color:var(--color-muted)]">Citation {source.id}</span>
    </figcaption>
    <blockquote aria-label="Exact citation excerpt"
      className="mt-6 border-s border-[var(--color-line-strong)] ps-4 text-[15px] leading-7 whitespace-pre-wrap text-[color:var(--color-ink)] [overflow-wrap:anywhere]">
      {source.excerpt}
    </blockquote>
  </figure>;
}

/** Exact added text and destination for a proposed document creation. */
export interface DocumentChange {
  readonly title: string;
  readonly destination: string;
  readonly content: string;
}

export function ChangeReview({ change }: { change: DocumentChange }) {
  // A line terminator closes the preceding line without creating another addition.
  const lines = (change.content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? []).filter(Boolean);
  return <figure className="mt-4 min-w-0">
    <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
      <div className="flex min-w-0 items-baseline gap-1.5 [overflow-wrap:anywhere]">
        <strong className="font-semibold text-[color:var(--color-ink)]">{change.title}</strong>
        <span aria-hidden="true" className="text-[color:var(--color-muted)]">·</span>
        <span className="text-[color:var(--color-secondary)]">{change.destination}</span>
      </div>
      <span className="font-medium text-[color:var(--color-accent)]">New document</span>
    </figcaption>
    {lines.length > 0 ? <pre tabIndex={0} aria-label="Added document lines"
      className={approvalInputClassName + ' max-h-60 rounded-lg bg-[var(--color-paper)] py-2 font-mono text-[12px] leading-5.5 text-[color:var(--color-ink)]'}><code className="block">
      {lines.map((line, index) => <span key={index} className="grid grid-cols-[minmax(3ch,max-content)_1ch_minmax(0,1fr)] items-baseline gap-x-2 px-2.5">
        <span aria-hidden="true" className="text-right text-[color:var(--color-muted)] select-none">{index + 1}</span>
        <span aria-hidden="true" className="font-semibold text-[color:var(--color-accent)] select-none">+</span>
        <span className="min-w-0 [overflow-wrap:anywhere] [white-space:break-spaces]">{line.replace(/(?:\r\n|\n|\r)$/u, '')}</span>
      </span>)}
    </code></pre> : <p className="rounded-lg bg-[var(--color-paper)] px-3 py-2 text-xs text-[color:var(--color-secondary)]">Empty document</p>}
  </figure>;
}

export interface ApprovalCardProps {
  readonly toolName: string;
  readonly args: string;
  readonly message: string;
  /** Pass a preview derived from these exact arguments, or null if validation failed. Omit for raw review. */
  readonly change?: DocumentChange | null | undefined;
  onDecide(approved: boolean): void;
}

export function ApprovalCard({ toolName, args, message, change, onDecide }: ApprovalCardProps) {
  const title = useId();
  const inputId = useId();
  const [expanded, setExpanded] = useState(!change);
  return <section aria-labelledby={title} className="approval-card rounded-2xl bg-[var(--color-warning)] p-4 motion-safe:animate-[mayura-ui-approval-appear_var(--motion-enter)_var(--ease-out)_both] sm:p-5">
    <h3 id={title} className="text-[15px] font-semibold tracking-tight text-[color:var(--color-ink)]">Approval required</h3>
    <p className="mt-1 text-sm leading-5.5 text-[color:var(--color-secondary)]">{message || 'Review the proposed action before continuing.'}</p>
    {change && <ChangeReview change={change} />}
    {change === null && <p role="alert" className="mt-3 text-sm text-[color:var(--color-warning-ink)]">The proposed change could not be verified. Decline it and try again.</p>}
    <button type="button" aria-expanded={expanded} aria-controls={inputId} onClick={() => setExpanded(value => !value)}
      className={'approval-disclosure mt-2 inline-flex min-h-9 w-fit items-center gap-1.5 text-sm font-medium text-[color:var(--color-warning-ink)] underline-offset-[.22em] [@media(pointer:coarse)]:min-h-[2.75rem] [@media(hover:hover)_and_(pointer:fine)]:[&:hover]:underline ' + approvalTransitionClassName}>
      Review exact tool input
      <span className={disclosureChevronClassName}><Icon name="chevron" size={13} /></span>
    </button>
    <div id={inputId} data-expanded={expanded} inert={!expanded} className={chatDisclosureClassName}>
      <div className="chat-disclosure-inner min-h-0 min-w-0 overflow-hidden px-1">
        <p className="mt-1 break-words font-mono text-xs text-[color:var(--color-warning-ink)]">{toolName}</p>
        <pre tabIndex={0} aria-label="Exact tool input"
          className={approvalInputClassName + ' mt-1.5 mb-1 max-h-44 whitespace-pre-wrap text-xs leading-5 text-[color:var(--color-secondary)]'}>{args}</pre>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" onClick={() => onDecide(false)} className={approvalActionClassName + ' approval-decline px-2.5 text-[color:var(--color-secondary)] underline-offset-[.22em] [@media(hover:hover)_and_(pointer:fine)]:[&:hover]:underline'}>Decline</button>
      <button type="button" disabled={change === null} onClick={() => onDecide(true)}
        className={approvalActionClassName + ' approval-confirm bg-[var(--color-action)] px-3 text-white disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:[&:hover]:bg-[var(--color-action-hover)]'}>Approve</button>
    </div>
  </section>;
}
