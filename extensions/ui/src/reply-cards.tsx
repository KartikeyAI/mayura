'use client';

import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { AgUiJson } from './ag-ui-protocol.js';

export interface ReplyCard {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly data: AgUiJson;
}

export interface ReplyCardComponentProps<Value> {
  readonly id: string;
  readonly title: string;
  readonly data: Value;
}

export interface ReplyCardRenderer {
  readonly type: string;
  render(card: ReplyCard): ReactNode;
}

export interface ReplyCardActionRequest {
  readonly cardId: string;
  readonly actionId: string;
}

/** Register an exact card/action pair with host-authored text that describes the operation. */
export interface ReplyCardAction extends ReplyCardActionRequest {
  readonly label: string;
  readonly description: string;
}

export interface ReplyCardsProps {
  readonly cards: readonly ReplyCard[];
  readonly renderers?: readonly ReplyCardRenderer[];
  /** Exact same-origin paths that the app allows this reply to offer as downloads. */
  readonly downloadPaths?: readonly string[];
  readonly confirmActions?: readonly ReplyCardAction[];
  /** Authorize and deduplicate the request on the host, including across reloads. */
  readonly onConfirm?: (request: ReplyCardActionRequest) => void | Promise<void>;
}

const cardKey = /^[a-z][a-z0-9-]{0,63}$/u;
const reservedTypes = new Set(['table', 'download', 'confirmation']);
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const downloadPath = /^\/(?:[a-z0-9._~-]+\/)*[a-z0-9._~-]+$/iu;
const fileName = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function ownValue(value: object, key: string | number): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  return value.trim() || undefined;
}

function copyJson(value: unknown, remaining: { nodes: number; chars: number }, depth = 0): AgUiJson | undefined {
  if (depth > 6 || --remaining.nodes < 0) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    remaining.chars -= value.length;
    return value.length <= 2_048 && remaining.chars >= 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 48) return undefined;
    const result: AgUiJson[] = [];
    for (let index = 0; index < value.length; index++) {
      const entry = copyJson(ownValue(value, index), remaining, depth + 1);
      if (entry === undefined) return undefined;
      result.push(entry);
    }
    return result;
  }
  const data = record(value);
  if (!data) return undefined;
  const keys = Object.keys(data);
  if (keys.length > 32) return undefined;
  const result: Record<string, AgUiJson> = {};
  for (const key of keys) {
    remaining.chars -= key.length;
    if (key.length > 80 || remaining.chars < 0 || reservedKeys.has(key)) return undefined;
    const entry = copyJson(ownValue(data, key), remaining, depth + 1);
    if (entry === undefined) return undefined;
    result[key] = entry;
  }
  return result;
}

/** Read bounded JSON from AG-UI state. Keep the first valid occurrence of each card ID. */
export function readReplyCards(input: unknown): readonly ReplyCard[] {
  if (!Array.isArray(input) || input.length > 8) return [];
  const cards: ReplyCard[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const item = record(ownValue(input, index));
    if (!item) continue;
    const id = ownValue(item, 'id');
    const type = ownValue(item, 'type');
    const title = boundedText(ownValue(item, 'title'), 100);
    if (typeof id !== 'string' || !cardKey.test(id) || ids.has(id)
      || typeof type !== 'string' || !cardKey.test(type) || !title) continue;
    const data = copyJson(ownValue(item, 'data'), { nodes: 384, chars: 16_384 });
    if (data === undefined) continue;
    cards.push({ id, type, title, data });
    ids.add(id);
  }
  return cards;
}

/** A custom renderer receives only the data returned by its host-provided parser. */
export function defineReplyCard<Value>(type: string, config: {
  readonly parse: (data: AgUiJson) => Value | undefined;
  readonly Component: ComponentType<ReplyCardComponentProps<Value>>;
}): ReplyCardRenderer {
  if (!cardKey.test(type) || reservedTypes.has(type)) throw new TypeError('Invalid custom reply card type.');
  const { parse, Component } = config;
  return { type, render(card) {
    if (card.type !== type) return undefined;
    let data: Value | undefined;
    try { data = parse(card.data); } catch { return undefined; }
    return data === undefined ? undefined : <Component id={card.id} title={card.title} data={data} />;
  } };
}

type TableCell = null | boolean | number | string;
function isTableCell(value: unknown): value is TableCell {
  return value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 240);
}

function ReplyTable({ card }: { readonly card: ReplyCard }) {
  const data = record(card.data);
  const columns: unknown = data?.['columns'];
  const rows: unknown = data?.['rows'];
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 8
    || !columns.every((column): column is string => typeof column === 'string' && !!boundedText(column, 80))
    || !Array.isArray(rows) || rows.length > 24
    || !rows.every((row): row is TableCell[] => Array.isArray(row) && row.length === columns.length && row.every(isTableCell))) {
    return <Unavailable />;
  }
  return <div role="region" aria-label={card.title} tabIndex={0}
    className="max-w-full overflow-x-auto rounded-lg bg-[var(--color-paper)] focus-visible:outline-offset-0">
    <table className="w-full border-collapse text-left text-[0.8125rem] leading-5">
      <thead className="bg-[var(--color-wash)] text-[color:var(--color-ink)]">
        <tr>{columns.map((column, index) => <th key={index} scope="col"
          className="px-3 py-2 font-medium [overflow-wrap:anywhere]">{column}</th>)}</tr>
      </thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className="even:bg-[var(--color-wash)]/40">
        {row.map((cell, index) => <td key={index}
          className="min-w-24 px-3 py-2 align-top tabular-nums [overflow-wrap:anywhere]">
          {cell === null ? '—' : String(cell)}
        </td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

function DownloadCard({ data, paths }: { readonly data: AgUiJson; readonly paths?: readonly string[] | undefined }) {
  const input = record(data);
  const path = input?.['path'];
  const filename = input?.['filename'];
  if (typeof path !== 'string' || path.length > 1_024 || !downloadPath.test(path)
    || path.split('/').some(part => part === '.' || part === '..') || !paths?.includes(path)
    || (filename !== undefined && (typeof filename !== 'string' || !fileName.test(filename)))) return <Unavailable />;
  return <a href={path} download={filename ?? true}
    className="inline-flex min-h-8 w-fit items-center rounded-md bg-[var(--color-wash)] px-2.5 text-xs font-medium text-[color:var(--color-accent-deep)] hover:bg-[var(--color-tint-strong)] [@media(pointer:coarse)]:min-h-11">
    Download{filename && ` ${filename}`}
  </a>;
}

function Unavailable() {
  return <p className="text-xs leading-5 text-[color:var(--color-muted)]">This card is unavailable.</p>;
}

function ConfirmCard({ action, run }: {
  readonly action: ReplyCardAction;
  readonly run: NonNullable<ReplyCardsProps['onConfirm']>;
}) {
  const [status, setStatus] = useState<'ready' | 'pending' | 'confirmed' | 'unconfirmed'>('ready');
  const submitted = useRef(false);
  async function confirm() {
    if (submitted.current) return;
    submitted.current = true;
    setStatus('pending');
    try {
      await run({ cardId: action.cardId, actionId: action.actionId });
      setStatus('confirmed');
    } catch {
      // A rejection can follow a completed external action. Keep the control closed.
      setStatus('unconfirmed');
    }
  }
  return <form className="grid justify-items-start gap-2 rounded-lg bg-[var(--color-warning)] p-3"
    onSubmit={event => { event.preventDefault(); void confirm(); }}>
    <p className="text-[0.8125rem] leading-5 text-[color:var(--color-warning-ink)]">{action.description}</p>
    <button type="submit" disabled={status !== 'ready'}
      className="min-h-8 rounded-md bg-[var(--color-action)] px-2.5 text-xs font-medium text-white hover:bg-[var(--color-action-hover)] disabled:opacity-60 [@media(pointer:coarse)]:min-h-11">
      {action.label}
    </button>
    {status !== 'ready' && <p role="status" className="text-xs text-[color:var(--color-warning-ink)]">
      {status === 'pending' ? 'Submitting…' : status === 'confirmed' ? 'Confirmed.' : 'Could not confirm the outcome.'}
    </p>}
  </form>;
}

function CardContent({ card, options }: { readonly card: ReplyCard; readonly options: ReplyCardsProps }) {
  switch (card.type) {
    case 'table': return <ReplyTable card={card} />;
    case 'download': return <DownloadCard data={card.data} paths={options.downloadPaths} />;
    case 'confirmation': {
      const data = record(card.data);
      const message = boundedText(data?.['message'], 500);
      const action = options.confirmActions?.find(item => item.cardId === card.id && item.actionId === data?.['actionId']);
      if (!message || !action || !options.onConfirm) return <Unavailable />;
      return <>
        <p className="mb-2 text-[0.8125rem] leading-5 text-[color:var(--color-secondary)]">{message}</p>
        <ConfirmCard key={action.actionId} action={action} run={options.onConfirm} />
      </>;
    }
    default: {
      return options.renderers?.find(renderer => renderer.type === card.type)?.render(card) ?? <Unavailable />;
    }
  }
}

/** Render trusted host extensions and display built-in cards with bounded content. */
export function ReplyCards(options: ReplyCardsProps) {
  if (!options.cards.length) return null;
  return <ul aria-label="Reply cards" className="my-3 grid min-w-0 list-none gap-3 p-0">
    {options.cards.map(card => <li key={card.id} className="min-w-0 [overflow-wrap:anywhere]">
      <p className="mb-1.5 text-[0.8125rem] font-medium text-[color:var(--color-ink)]">{card.title}</p>
      <CardContent card={card} options={options} />
    </li>)}
  </ul>;
}
