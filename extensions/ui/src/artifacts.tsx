'use client';

import { Icon } from './ui.js';

interface ArtifactDetails {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export type ReplyArtifact = ArtifactDetails & (
  | { readonly type: 'chart'; readonly unit: string; readonly points: readonly { label: string; value: number }[] }
  | { readonly type: 'video'; readonly src: string; readonly captions: string; readonly poster: string }
  | { readonly type: 'audio'; readonly src: string; readonly transcript: string }
  | { readonly type: 'link'; readonly href: string }
);

const artifactId = /^[a-z][a-z0-9-]{0,47}$/u;
const chartFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const artifactKinds = {
  chart: {
    label: 'Chart',
    icon: <path d="M4 4v16h16M8 15v-3m4 3V8m4 7V5" />,
  },
  video: {
    label: 'Video',
    icon: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3Z" /></>,
  },
  audio: {
    label: 'Audio',
    icon: <path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4" />,
  },
  link: {
    label: 'Link',
    icon: <path d="M10 14l4-4m-5.5 7.5-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m1 5a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1" />,
  },
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  return value.trim() || undefined;
}

function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_024) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(url.hostname)) return url.href;
  } catch { /* Invalid URLs have no interactive representation. */ }
  return undefined;
}

function localMediaPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1_024
    && /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(value)
    && !value.split('/').some(segment => segment === '.' || segment === '..');
}

function allowedMedia(value: unknown, paths: readonly string[]): value is string {
  return localMediaPath(value) && paths.includes(value);
}

function parseArtifact(value: unknown, mediaPaths: readonly string[]): ReplyArtifact | undefined {
  const data = record(value);
  if (!data || typeof data['id'] !== 'string' || !artifactId.test(data['id'])) return undefined;
  const title = text(data['title'], 100);
  const description = text(data['description'], 240);
  if (!title) return undefined;

  const details = { id: data['id'], title, ...(description ? { description } : {}) };
  switch (data['type']) {
    case 'chart': {
      const unit = text(data['unit'], 16);
      if (!unit || !Array.isArray(data['points']) || data['points'].length < 1 || data['points'].length > 8) return undefined;
      const max = unit === '%' ? 100 : 1_000_000_000;
      const points: { label: string; value: number }[] = [];
      for (const point of data['points']) {
        const input = record(point);
        const label = text(input?.['label'], 64);
        const value = input?.['value'];
        if (!label || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return undefined;
        points.push({ label, value });
      }
      return { type: 'chart', ...details, unit, points };
    }
    case 'video':
      if (!allowedMedia(data['src'], mediaPaths) || !allowedMedia(data['captions'], mediaPaths)
        || !allowedMedia(data['poster'], mediaPaths)) return undefined;
      return { type: 'video', ...details, src: data['src'], captions: data['captions'], poster: data['poster'] };
    case 'audio': {
      const transcript = text(data['transcript'], 1_200);
      if (!transcript || !allowedMedia(data['src'], mediaPaths)) return undefined;
      return { type: 'audio', ...details, src: data['src'], transcript };
    }
    case 'link': {
      const href = safeLink(data['href']);
      return href ? { type: 'link', ...details, href } : undefined;
    }
    default: return undefined;
  }
}

export interface ArtifactReadOptions {
  /** Exact same-origin path names that this host has approved for media playback or display. */
  readonly mediaPaths?: readonly string[] | undefined;
}

/** Accept bounded artifact data. Only explicitly allowed same-origin media can be loaded. */
export function readArtifacts(value: unknown, { mediaPaths = [] }: ArtifactReadOptions = {}): readonly ReplyArtifact[] {
  if (!Array.isArray(value) || value.length > 8) return [];
  const items: ReplyArtifact[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const artifact = parseArtifact(candidate, mediaPaths);
    if (!artifact || ids.has(artifact.id)) continue;
    ids.add(artifact.id);
    items.push(artifact);
  }
  return items;
}

function Chart({ artifact }: { artifact: Extract<ReplyArtifact, { type: 'chart' }> }) {
  const maximum = artifact.unit === '%' ? 100 : Math.max(1, ...artifact.points.map(point => point.value));
  return <dl className="chart-values grid gap-3 text-[0.8125rem] leading-[1.4]">
    {artifact.points.map(({ label, value }, index) => <div className="chart-row grid grid-cols-[minmax(0,27%)_minmax(0,1fr)] items-center gap-[0.8rem]" key={index}>
      <dt className="[overflow-wrap:anywhere] text-[var(--color-secondary)]">{label}</dt>
      <dd className="grid grid-cols-[minmax(0,1fr)_minmax(3rem,36%)] items-center gap-[0.6rem]">
        <span aria-hidden="true" className="chart-track block h-1.5 rounded-full bg-[var(--color-wash)]">
          <span className="chart-bar block h-full rounded-[inherit] bg-[var(--color-accent)]" style={{ width: (value / maximum * 100) + '%' }} />
        </span>
        <span className="chart-value text-end text-[var(--color-ink)] tabular-nums [overflow-wrap:anywhere]">
          {chartFormat.format(value)}{artifact.unit === '%' ? '%' : ' ' + artifact.unit}
        </span>
      </dd>
    </div>)}
  </dl>;
}

function stopOnRemoval(element: HTMLMediaElement | null) {
  if (element) return () => element.pause();
}

function ArtifactContent({ artifact }: { artifact: ReplyArtifact }) {
  switch (artifact.type) {
    case 'chart': return <Chart artifact={artifact} />;
    case 'video': return localMediaPath(artifact.src) && localMediaPath(artifact.captions) && localMediaPath(artifact.poster) && <video ref={stopOnRemoval}
      className="artifact-video block aspect-[720/404] [inline-size:100%] rounded-xl bg-[var(--color-wash)] object-contain" aria-label={artifact.title}
      controls playsInline preload="none" poster={artifact.poster}>
      <source src={artifact.src} type="video/webm" />
      <track src={artifact.captions} kind="captions" srcLang="en" label="English" />
      <a href={artifact.src}>Open video</a>
    </video>;
    case 'audio': return localMediaPath(artifact.src) && <>
      <audio ref={stopOnRemoval} className="artifact-audio block [block-size:2.5rem] [inline-size:100%]" aria-label={artifact.title} controls preload="none">
        <source src={artifact.src} type="audio/wav" />
        <a href={artifact.src}>Open audio</a>
      </audio>
      <details className="artifact-transcript text-[0.8125rem] leading-[1.55] text-[var(--color-secondary)]">
        <summary className="cursor-pointer [inline-size:fit-content] py-[0.3rem]">Read transcript</summary>
        <p className="[margin-block-start:0.2rem]">{artifact.transcript}</p>
      </details>
    </>;
    case 'link': {
      const href = safeLink(artifact.href);
      return href && <a className="artifact-link inline-flex [inline-size:fit-content] [max-inline-size:100%] items-center gap-[0.35rem] text-[0.875rem] font-medium text-[var(--color-accent-deep)] [overflow-wrap:anywhere] [&:hover]:underline [&:hover]:underline-offset-[0.2em]"
        href={href} target="_blank" rel="noopener noreferrer">
        {new URL(href).hostname}
        <span className="sr-only"> (opens in a new tab)</span>
        <svg aria-hidden="true" className="shrink-0" width="15" height="15" fill="none" viewBox="0 0 16 16">
          <path d="M5 11 11 5M6.5 5H11v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>;
    }
  }
}

export function ArtifactPanel({ artifact }: { artifact: ReplyArtifact }) {
  return <div className="artifact-panel grid [min-inline-size:0] gap-4">
    {artifact.description && <p className="artifact-description text-[0.875rem] leading-[1.6] text-[var(--color-secondary)] [overflow-wrap:anywhere]">{artifact.description}</p>}
    <ArtifactContent key={artifact.id + ':' + artifact.type} artifact={artifact} />
  </div>;
}

export interface ReplyArtifactsProps {
  readonly items: readonly ReplyArtifact[];
  readonly active: string | null;
  readonly panelId: string;
  readonly mobile: boolean;
  onOpen(id: string, trigger: HTMLButtonElement): void;
}

export function ReplyArtifacts({ items, active, panelId, mobile, onOpen }: ReplyArtifactsProps) {
  if (items.length === 0) return null;
  return <ul className="reply-artifacts grid gap-x-2 gap-y-[0.2rem] [margin-block:1.05rem_0.25rem] @min-[38rem]:grid-cols-2" role="list" aria-label="Reply artifacts">
    {items.map(artifact => {
      const kind = artifactKinds[artifact.type];
      const expanded = active === artifact.id;
      return <li key={artifact.id} className="min-w-0">
        <button type="button" aria-expanded={expanded}
          className="artifact-trigger motion-button grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-[0.55rem] [min-block-size:2.375rem] [inline-size:100%] rounded-lg bg-[var(--color-wash)] px-2.5 py-1.5 text-start text-[var(--color-muted)] [&:hover]:bg-[var(--color-tint-strong)] [&:hover]:text-[var(--color-accent-deep)] aria-expanded:bg-[var(--color-tint-strong)] aria-expanded:text-[var(--color-accent-deep)] motion-safe:[transition:transform_var(--motion-fast)_var(--ease-out),background-color_var(--motion-fast)_ease,color_var(--motion-fast)_ease] motion-safe:enabled:active:[transform:scale(.98)] [@media(pointer:coarse)]:[min-block-size:2.75rem]"
          aria-controls={expanded ? panelId : undefined} aria-haspopup={mobile ? 'dialog' : undefined}
          onClick={event => onOpen(artifact.id, event.currentTarget)}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{kind.icon}</svg>
          <span className="artifact-trigger-title text-[0.8125rem] font-medium leading-[1.4] text-[var(--color-ink)] [overflow-wrap:anywhere]">{artifact.title}</span>
          <span className="artifact-trigger-type text-[0.6875rem]">{kind.label}</span>
          <Icon name="chevron" size={13} />
        </button>
      </li>;
    })}
  </ul>;
}
