import { freezeJson, jsonValue, MayuraError, type ModelHistoryMessage } from '@mayura/core';
import type { ThreadEntry, ThreadHistory, ThreadSummaryProvenance } from './index.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const hash = /^[a-f0-9]{64}$/u;
/** Read backwards within explicit storage/memory bounds. Never mistake a truncated window for the entire history. */
export async function readThreadWindow(read: (paging: { before: number; limit: number }) => Promise<readonly ThreadEntry[]>, lastSequence: number, maxEntries: number, maxBytes: number) {
  const entries: ThreadEntry[] = []; let before = lastSequence + 1; let size = 0;
  while (before > 1 && entries.length < maxEntries) {
    const limit = Math.min(500, maxEntries - entries.length);
    const page = await read({ before, limit });
    if (!page.length) return { entries, truncated: false };
    for (let index = page.length - 1; index >= 0; index--) {
      const entry = page[index]!; const cost = bytes(entry);
      if (size + cost > maxBytes) return { entries, truncated: true };
      entries.push(entry); size += cost;
    }
    before = page[0]!.sequence;
    if (page.length < limit) return { entries, truncated: false };
  }
  return { entries, truncated: before > 1 };
}
/** One turn, in sequence order. Failed, unfinished and compaction-only turns never become source conversation. */
export function turnMessages(entries: readonly ThreadEntry[]): ModelHistoryMessage[] | undefined {
  const run = entries.findLast(entry => entry.kind === 'run');
  if (!run || run.kind !== 'run' || run.status !== 'succeeded' || run.compaction || entries.find(entry => entry.kind !== 'run')?.kind !== 'user') return undefined;
  const messages: ModelHistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user') messages.push({ role: 'user', content: entry.omitted ? { omitted: 'too_large' } : entry.media?.length ? { content: entry.content, mediaReferences: entry.media } as unknown as import('@mayura/core').JsonValue : entry.content });
    else if (entry.kind === 'tool_calls' && !Array.isArray(entry.calls)) return undefined;
    else if (entry.kind === 'tool_calls') messages.push({ role: 'assistant', calls: entry.calls.map(call => ({ id: call.id, toolId: call.toolId, input: call.input })) });
    else if (entry.kind === 'tool_result') messages.push({ role: 'tool', callId: entry.callId, toolId: entry.toolId, result: entry.omitted ? { omitted: 'too_large' } : entry.media?.length ? { result: entry.result, mediaReferences: entry.media } as unknown as import('@mayura/core').JsonValue : entry.result });
    else if (entry.kind === 'assistant') messages.push({ role: 'assistant', output: entry.omitted ? { omitted: 'too_large' } : entry.output });
  }
  return messages;
}
/** Select only generated summaries with complete provenance. Legacy/imported summary text remains display-only. */
export function generatedSummary(entry: ThreadEntry): (ThreadEntry & { readonly kind: 'summary'; readonly compaction: ThreadSummaryProvenance }) | undefined {
  if (entry.kind !== 'summary' || entry.compaction === undefined) return undefined;
  const p = entry.compaction;
  const valid = p && typeof p === 'object' && p.format === 1 && typeof entry.content === 'string' && entry.content.trim()
    && bytes(entry.content) <= 65_536 && entry.covers?.from === 1 && Number.isSafeInteger(entry.covers.to) && entry.covers.to >= 1 && entry.covers.to < entry.sequence
    && [p.commandId, p.agentId, p.agentVersion, p.modelRunId].every(value => typeof value === 'string' && pattern.test(value))
    && typeof p.requestDigest === 'string' && hash.test(p.requestDigest) && typeof p.sourceDigest === 'string' && hash.test(p.sourceDigest)
    && Number.isSafeInteger(p.sourceEntries) && p.sourceEntries >= 1 && p.sourceEntries <= 10_000 && Number.isSafeInteger(p.sourceTurns) && p.sourceTurns >= 1
    && (typeof p.costMicros === 'number' ? Number.isSafeInteger(p.costMicros) && p.costMicros >= 0 : typeof p.costMicros === 'string' && /^[0-9]{1,30}$/u.test(p.costMicros));
  if (!valid) throw new MayuraError('STORAGE_UNAVAILABLE', 'The generated thread summary has invalid provenance.');
  return entry as ThreadEntry & { readonly kind: 'summary'; readonly compaction: ThreadSummaryProvenance };
}
export function newestSummary(entries: readonly ThreadEntry[], through = Number.MAX_SAFE_INTEGER) {
  let selected: ReturnType<typeof generatedSummary>;
  for (const entry of entries) {
    const candidate = generatedSummary(entry);
    if (candidate && candidate.covers.to <= through && (!selected || candidate.covers.to > selected.covers.to
      || (candidate.covers.to === selected.covers.to && candidate.sequence > selected.sequence))) selected = candidate;
  }
  return selected;
}
export function summaryMessage(entry: NonNullable<ReturnType<typeof generatedSummary>>): ModelHistoryMessage {
  return { role: 'user', content: { type: 'thread_summary', untrusted: true, content: entry.content, covers: entry.covers, sourceDigest: entry.compaction.sourceDigest } };
}
/** Group a chronological sequence without splitting tool batches or recording chunks. */
export function wholeTurns(entries: readonly ThreadEntry[]): ThreadEntry[][] {
  const groups: ThreadEntry[][] = [];
  for (const entry of entries) { const last = groups[groups.length - 1]; if (last?.[0]?.turnId === entry.turnId) last.push(entry); else groups.push([entry]); }
  return groups;
}
/** Summary context is explicit untrusted user data, never instructions or a synthetic tool result. */
export function fitThreadHistory(newestFirst: readonly ThreadEntry[], policy: { maxEntries: number; maxBytes: number; useSummaries: boolean; truncated: boolean }): ThreadHistory {
  if (!newestFirst.length && policy.truncated) throw new MayuraError('LIMIT_EXCEEDED', 'The newest entry exceeds the history scan budget.');
  const summary = policy.useSummaries ? newestSummary(newestFirst) : undefined;
  const prefix = summary ? [summaryMessage(summary)] : [];
  let used = prefix.length; let size = bytes(prefix);
  if (used > policy.maxEntries || size > policy.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', 'The saved summary does not fit the history policy. Increase its bounds or explicitly disable summaries.');
  const groups = wholeTurns([...newestFirst].reverse()).reverse(); const kept: ModelHistoryMessage[][] = [];
  let omittedTurns = 0; let full = false;
  for (const turn of groups) {
    const messages = turnMessages(turn);
    if (!messages) {
      const terminal = turn.findLast(entry => entry.kind === 'run');
      if (policy.truncated && turn === groups[groups.length - 1] && terminal?.kind === 'run' && terminal.status === 'succeeded' && !terminal.compaction) {
        if (!kept.length) throw new MayuraError('LIMIT_EXCEEDED', 'The newest whole turn exceeds the history scan budget.');
        omittedTurns++;
      }
      continue;
    }
    if (summary && turn[turn.length - 1]!.sequence <= summary.covers.to) continue;
    if (summary && turn[0]!.sequence <= summary.covers.to) throw new MayuraError('STORAGE_UNAVAILABLE', 'The thread summary splits a conversation turn.');
    const nextSize = size + bytes(messages) - 2 + (used > 0 && messages.length > 0 ? 1 : 0);
    if (full || used + messages.length > policy.maxEntries || nextSize > policy.maxBytes) {
      if (!kept.length) throw new MayuraError('LIMIT_EXCEEDED', 'The newest whole turn and retained summary do not fit the history policy.');
      full = true; omittedTurns++; continue;
    }
    kept.push(messages); used += messages.length; size = nextSize;
  }
  const messages = freezeJson(jsonValue([...prefix, ...kept.reverse().flat()], { maxBytes: policy.maxBytes, maxNodes: 200_000 })) as unknown as readonly ModelHistoryMessage[];
  return Object.freeze({ messages, turns: kept.length, omittedTurns, bytes: size, scanTruncated: policy.truncated,
    ...(summary ? { summary: Object.freeze({ sequence: summary.sequence, covers: summary.covers, turns: summary.compaction.sourceTurns, sourceDigest: summary.compaction.sourceDigest }) } : {}) });
}
