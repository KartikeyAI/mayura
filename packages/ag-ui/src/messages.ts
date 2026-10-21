import type { MayuraClient, RemoteApproval, RemoteThreadEntry } from '@mayura/client';
import { sha256Hex, utf8ByteLength } from '@mayura/core/host';
import { AgUiFailure, type AgUiMessage } from './protocol.js';

export const messageId = (threadId: string, sequence: number) => `m-${sha256Hex(JSON.stringify([threadId, sequence]))}`;
export const toolCallId = (turnId: string, callId: string) => `t-${sha256Hex(JSON.stringify([turnId, callId]))}`;
export const proposalId = (turnId: string, callId: string) => `p-${sha256Hex(JSON.stringify([turnId, callId]))}`;
const text = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value);
export interface ThreadView { readonly entries: readonly RemoteThreadEntry[]; readonly messages: readonly AgUiMessage[] }
/** Scan to a fixed authorized high-water mark. Never label a truncated or omitted history as a complete snapshot. */
export async function threadView(client: MayuraClient, threadId: string, maximum: number, maxBytes: number, signal: AbortSignal, mediaEnabled = false): Promise<ThreadView> {
  const thread = await client.thread(threadId, { signal });
  if (thread.entryCount > maximum) throw new AgUiFailure('THREAD_HISTORY_LIMIT', 413);
  const entries: RemoteThreadEntry[] = []; let after = 0; let size = 2;
  while (after < thread.lastSequence) {
    const page = await client.threadEntries(threadId, { after, limit: Math.min(100, maximum - entries.length + 1), signal });
    if (!page.length) throw new AgUiFailure('THREAD_HISTORY_INCOMPLETE', 409);
    for (const entry of page) {
      if (entry.sequence > thread.lastSequence) {
        if (after < thread.lastSequence) throw new AgUiFailure('THREAD_HISTORY_INCOMPLETE', 409);
        break;
      }
      if (entry.sequence !== after + 1) throw new AgUiFailure('THREAD_HISTORY_INCOMPLETE', 409);
      size += utf8ByteLength(JSON.stringify(entry)) + 1;
      if (size > maxBytes || entries.length >= maximum) throw new AgUiFailure('THREAD_HISTORY_LIMIT', 413);
      if (('omitted' in entry && entry.omitted) || ('mediaOmitted' in entry && entry.mediaOmitted)) throw new AgUiFailure('UNSUPPORTED_THREAD_CONTENT', 409);
      if ('media' in entry && entry.media?.length && !mediaEnabled) throw new AgUiFailure('UNSUPPORTED_THREAD_CONTENT', 409);
      entries.push(entry); after = entry.sequence;
    }
  }
  // A fresh read is a disclosure check even when the thread was empty or permission changed while paging.
  const latest = await client.thread(threadId, { signal });
  if (latest.status !== 'active') throw new AgUiFailure('THREAD_UNAVAILABLE', 409);
  const messages: AgUiMessage[] = [];
  for (const entry of entries) {
    const id = messageId(threadId, entry.sequence);
    switch (entry.kind) {
      case 'user':
        if (entry.media?.length && !mediaEnabled) throw new AgUiFailure('UNSUPPORTED_THREAD_CONTENT', 409);
        messages.push({ id, role: 'user', content: entry.media?.length ? [{ type: 'text', text: text(entry.content) }, ...entry.media.map(ref => ({
          type: ref.mediaType === 'application/pdf' ? 'document' as const : 'image' as const,
          source: { type: 'file' as const, value: ref.id, provider: 'mayura' as const, mimeType: ref.mediaType },
        }))] : text(entry.content) }); break;
      case 'assistant': messages.push({ id, role: 'assistant', content: text(entry.output) }); break;
      case 'tool_calls':
        if (!entry.calls) throw new AgUiFailure('UNSUPPORTED_THREAD_CONTENT', 409);
        for (const call of entry.calls) messages.push({ id: proposalId(entry.turnId, call.id), role: 'assistant', toolCalls: [
          { id: toolCallId(entry.turnId, call.id), type: 'function', function: { name: call.toolId, arguments: JSON.stringify(call.input) } },
        ] });
        break;
      case 'tool_result': messages.push({ id, role: 'tool', toolCallId: toolCallId(entry.turnId, entry.callId), content: entry.media?.length ? JSON.stringify({ result: entry.result, media: entry.media }) : text(entry.result) }); break;
      // Summaries describe model history compaction, not additional conversation messages. Source entries remain.
      case 'summary': case 'approval': case 'run': break;
    }
  }
  if (utf8ByteLength(JSON.stringify(messages)) > maxBytes) throw new AgUiFailure('THREAD_HISTORY_LIMIT', 413);
  return { entries, messages };
}
export function runTurn(view: ThreadView, nativeRunId: string): string {
  const marker = view.entries.find(entry => entry.kind === 'run' && entry.runId === nativeRunId);
  if (!marker) throw new AgUiFailure('RUN_THREAD_MISMATCH', 409);
  return marker.turnId;
}
/** Same IDs as the eventual persisted tool call; an interrupt does not invent a successful tool result. */
export function pendingMessage(turnId: string, approval: RemoteApproval): AgUiMessage {
  return { id: proposalId(turnId, approval.callId), role: 'assistant', toolCalls: [{ id: toolCallId(turnId, approval.callId), type: 'function',
    function: { name: approval.toolId, arguments: JSON.stringify(approval.input) } }] };
}
