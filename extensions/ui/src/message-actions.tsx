'use client';

import { useEffect, useState, type ReactNode } from 'react';

type Feedback = 'helpful' | 'unhelpful';
type FeedbackEntry = readonly [key: string, value: Feedback];

const storageKey = 'mayura-ui-reply-feedback-v1';
const maxFeedbackEntries = 128;
const maxFeedbackKey = 200;

function feedbackEntries(): FeedbackEntry[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 48_000) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.slice(-maxFeedbackEntries).filter((entry): entry is FeedbackEntry =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
      && entry[0].length > 0 && entry[0].length <= maxFeedbackKey
      && (entry[1] === 'helpful' || entry[1] === 'unhelpful'));
  } catch {
    return [];
  }
}

function storeFeedback(key: string, value: Feedback | null): boolean {
  if (!key || key.length > maxFeedbackKey) return false;
  try {
    const entries = feedbackEntries().filter(entry => entry[0] !== key);
    if (value) entries.push([key, value]);
    localStorage.setItem(storageKey, JSON.stringify(entries.slice(-maxFeedbackEntries)));
    return true;
  } catch {
    return false;
  }
}

const thumb = <path d="M7 10v10M4 10h3l4-6a2 2 0 0 1 3.5 1.7L13.5 9H19a2 2 0 0 1 2 2.4l-1.4 6.4a2.7 2.7 0 0 1-2.7 2.2H4z" />;
const glyphs = {
  copy: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  quote: <path d="M10 6c-3.4 1.1-5 3.4-5 6.6V17h5v-5H7.5M19 6c-3.4 1.1-5 3.4-5 6.6V17h5v-5h-2.5" />,
  retry: <path d="M19.5 10a7.5 7.5 0 1 0-.8 6.3M20 4.5v6h-6" />,
  helpful: thumb,
  unhelpful: <g transform="rotate(180 12 12)">{thumb}</g>,
} satisfies Record<string, ReactNode>;

export interface MessageActionsProps {
  readonly content: string;
  readonly feedbackKey: string;
  readonly onQuote?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}

function Action({ label, icon, onClick, pressed }: {
  label: string;
  icon: keyof typeof glyphs;
  onClick(): void;
  pressed?: boolean;
}) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}
    className="motion-button grid size-8 shrink-0 place-items-center rounded-md text-[color:var(--color-muted)] hover:bg-[var(--color-wash)] hover:text-[color:var(--color-ink)] aria-pressed:bg-[var(--color-tint-strong)] aria-pressed:text-[color:var(--color-accent-deep)] motion-safe:[transition:transform_var(--motion-fast)_var(--ease-out),background-color_var(--motion-fast)_ease,color_var(--motion-fast)_ease] motion-safe:enabled:active:[transform:scale(.98)] [@media(pointer:coarse)]:size-11">
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{glyphs[icon]}</svg>
  </button>;
}

function ReplyActions({ content, feedbackKey, onQuote, onRetry }: MessageActionsProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setFeedback(feedbackEntries().find(entry => entry[0] === feedbackKey)?.[1] ?? null);
  }, [feedbackKey]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setNotice('Reply copied.');
    } catch {
      setNotice('Couldn’t copy. Select the reply text to copy it manually.');
    }
  }

  function rate(value: Feedback) {
    const next = value === feedback ? null : value;
    setFeedback(next);
    const saved = storeFeedback(feedbackKey, next);
    setNotice(next === null ? 'Feedback cleared.'
      : saved ? 'Feedback saved on this device.' : 'Feedback saved for this session.');
  }

  return <div role="group" aria-label="Reply actions" className="-ml-1 mt-2 flex flex-wrap items-center gap-x-2">
    <div className="flex flex-wrap items-center gap-0.5">
      <Action label="Copy reply" icon="copy" onClick={() => void copy()} />
      {onQuote && <Action label="Quote in reply" icon="quote" onClick={onQuote} />}
      {onRetry && <Action label="Retry reply" icon="retry" onClick={onRetry} />}
      <Action label="Helpful" icon="helpful" pressed={feedback === 'helpful'} onClick={() => rate('helpful')} />
      <Action label="Not helpful" icon="unhelpful" pressed={feedback === 'unhelpful'} onClick={() => rate('unhelpful')} />
    </div>
    <span role="status" className="text-xs text-[color:var(--color-muted)]">{notice}</span>
  </div>;
}

export function MessageActions(props: MessageActionsProps) {
  return <ReplyActions key={props.feedbackKey} {...props} />;
}
