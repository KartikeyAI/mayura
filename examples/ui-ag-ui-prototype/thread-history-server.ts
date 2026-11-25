import { createHash } from 'node:crypto';
import type { AgUiEvent, AgUiRunInput, AgUiInterrupt } from 'mayura/ag-ui';
import { ClientError, createClient, type MayuraClient, type RemoteThread, type RemoteThreadEntry } from 'mayura/client';
import { attachmentContextDivider } from '@mayurajs/ui';

export const historyPath = /^\/history(?:\/([a-f0-9-]{36}))?$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const maxApprovalHolds = 100;
const maxHistoryEntries = 2_000;

type Prompt = Extract<AgUiRunInput['messages'][number], { role: 'user' }> & { readonly content: string };
type Interruption = Pick<AgUiInterrupt, 'id' | 'toolCallId' | 'message' | 'expiresAt'> & {
  readonly toolName: string;
  readonly arguments: string;
};
interface HeldApproval {
  readonly nativeRunId: string;
  readonly interruption: Interruption;
  readonly prompt?: Prompt;
}

interface HistoryMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly retryable?: boolean;
}

const digest = (value: readonly (string | number)[]) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runMarker = (entry: RemoteThreadEntry | undefined): entry is Extract<RemoteThreadEntry, { kind: 'run' }> => entry?.kind === 'run';

/** This projects native history into the same IDs and content used by AG-UI messages. */
function messagesFor(threadId: string, entries: readonly RemoteThreadEntry[]) {
  const workTurns = new Set(entries.filter(entry => ['tool_calls', 'tool_result', 'approval'].includes(entry.kind)).map(entry => entry.turnId));
  const succeeded = new Set(entries.filter(entry => runMarker(entry) && entry.status === 'succeeded').map(entry => entry.turnId));
  return entries.flatMap<HistoryMessage>(entry => {
    const id = 'm-' + digest([threadId, entry.sequence]);
    if (entry.kind === 'user' && typeof entry.content === 'string' && !entry.omitted) {
      return [{ id, role: 'user' as const, content: entry.content }];
    }
    if (entry.kind === 'assistant' && !entry.omitted) {
      return [{ id, role: 'assistant' as const, content: typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output),
        retryable: succeeded.has(entry.turnId) && !workTurns.has(entry.turnId) }];
    }
    return [];
  });
}

function titleFor(thread: RemoteThread, first: RemoteThreadEntry | undefined, prompt: Prompt | undefined): string {
  const title = first?.kind === 'user' && typeof first.content === 'string' ? first.content : prompt?.content;
  return thread.title ?? (title?.split(attachmentContextDivider, 1)[0]?.replace(/\s+/gu, ' ').trim().slice(0, 100) || 'New conversation');
}

export function createThreadHistory(options: {
  readonly origin: string;
  readonly agentId: string;
  readonly nativeFetch: (request: Request) => Promise<Response>;
  readonly replyState: { readonly citations: unknown; readonly artifacts: unknown };
}) {
  // The sealed handle is only useful with the current process key and matching scoped native approval.
  const pending = new Map<string, HeldApproval>();
  const clientFor = (credential: string) => createClient({ baseUrl: options.origin, token: () => credential,
    requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576, maxReconnectAttempts: 0,
    fetch: (target, init) => options.nativeFetch(new Request(target, init)) });
  const isLocalThread = (thread: RemoteThread) => uuid.test(thread.id) && thread.agentId === options.agentId && thread.status === 'active';

  async function currentApproval(client: MayuraClient, thread: RemoteThread, tail: RemoteThreadEntry | undefined, signal: AbortSignal) {
    const held = pending.get(thread.id);
    if (!runMarker(tail) || tail.status !== 'running') return { pendingApproval: false, busy: thread.activeTurnId !== null };
    // Resolve the run through this authorized thread's own durable marker. A handle never grants read access.
    const snapshot = await client.run(tail.runId).inspect({ signal });
    const approval = snapshot.approval;
    const pendingApproval = snapshot.status === 'waiting' && !!approval && approval.expiresAtMs > Date.now();
    const matches = held && held.nativeRunId === tail.runId && pendingApproval && approval
      && held.interruption.toolCallId === 't-' + digest([tail.turnId, approval.callId])
      && held.interruption.toolName === approval.toolId
      && held.interruption.arguments === JSON.stringify(approval.input)
      && Date.parse(held.interruption.expiresAt) === approval.expiresAtMs;
    return { pendingApproval, busy: !matches, ...(matches ? { held } : {}) };
  }

  function capture(response: Response, input: AgUiRunInput): Response {
    const nativeRunId = response.headers.get('x-mayura-run-id');
    if (!response.ok || !response.body || !nativeRunId || !uuid.test(nativeRunId) || !uuid.test(input.threadId)) return response;
    const last = input.messages.at(-1);
    const prompt = last?.role === 'user' && typeof last.content === 'string' && last.content.length <= 2_000
      ? { id: last.id, role: last.role, content: last.content } : undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    let proposal: { id: string; name: string; arguments: string; ended: boolean } | undefined;
    const observe = (event: AgUiEvent) => {
      if (event.type === 'TOOL_CALL_START') {
        proposal = { id: event.toolCallId, name: event.toolCallName, arguments: '', ended: false };
      } else if (event.type === 'TOOL_CALL_ARGS' && proposal?.id === event.toolCallId && !proposal.ended) {
        const args = proposal.arguments + event.delta;
        if (args.length <= 65_536) proposal.arguments = args;
        else proposal = undefined;
      } else if (event.type === 'TOOL_CALL_END' && proposal?.id === event.toolCallId) {
        proposal.ended = true;
      } else if (event.type === 'RUN_FINISHED' && event.threadId === input.threadId && event.runId === input.runId) {
        const previous = pending.get(input.threadId);
        if (event.outcome.type !== 'interrupt') {
          if (previous?.nativeRunId === nativeRunId) pending.delete(input.threadId);
          return;
        }
        const interrupt = event.outcome.interrupts[0];
        if (event.outcome.interrupts.length !== 1 || !interrupt || interrupt.reason !== 'tool_call'
          || !proposal?.ended || proposal.id !== interrupt.toolCallId) return;
        for (const [id, item] of pending) {
          if (Date.parse(item.interruption.expiresAt) <= Date.now()) pending.delete(id);
        }
        if (!previous && pending.size >= maxApprovalHolds) return;
        pending.set(input.threadId, { nativeRunId, prompt: prompt ?? (previous?.nativeRunId === nativeRunId ? previous.prompt : undefined),
          interruption: { id: interrupt.id, toolCallId: interrupt.toolCallId, toolName: proposal.name,
            arguments: proposal.arguments, message: interrupt.message, expiresAt: interrupt.expiresAt } });
      }
    };
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        // Inspect only the adapter's bounded LF-delimited data frames. Forward the original bytes unchanged.
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith('data: ')) observe(JSON.parse(frame.slice(6)) as AgUiEvent);
          boundary = buffer.indexOf('\n\n');
        }
        output.enqueue(chunk);
      },
    })), { status: response.status, headers: response.headers });
  }

  return {
    capture,
    async read(credential: string, id: string | undefined, signal: AbortSignal): Promise<Response> {
      const client = clientFor(credential);
      try {
        if (id === undefined) {
          const { threads } = await client.threads({ limit: 60, status: 'active', signal });
          const history = await Promise.all(threads.filter(isLocalThread).map(async thread => {
            const first = (await client.threadEntries(thread.id, { after: 0, limit: 4, signal })).find(entry => entry.kind === 'user');
            const cached = pending.get(thread.id);
            let pendingApproval = false;
            if (cached || thread.activeTurnId) {
              const [tail] = await client.threadEntries(thread.id, { before: thread.lastSequence + 1, limit: 1, signal });
              ({ pendingApproval } = await currentApproval(client, thread, tail, signal));
            }
            return { id: thread.id, title: titleFor(thread, first, cached?.prompt), updatedAt: thread.updatedAt, pendingApproval };
          }));
          return Response.json({ threads: history }, { headers: noStore });
        }
        if (!uuid.test(id)) return new Response(null, { status: 404, headers: noStore });
        const thread = await client.thread(id, { signal });
        if (!isLocalThread(thread)) return new Response(null, { status: 404, headers: noStore });
        if (thread.entryCount > maxHistoryEntries) return new Response(null, { status: 413, headers: noStore });
        const entries: RemoteThreadEntry[] = [];
        let cursor = 0;
        while (cursor < thread.lastSequence) {
          const page = await client.threadEntries(id, { after: cursor, limit: 100, signal });
          if (!page.length) return new Response(null, { status: 409, headers: noStore });
          for (const entry of page) {
            if (entry.sequence !== cursor + 1) return new Response(null, { status: 409, headers: noStore });
            if (entry.sequence > thread.lastSequence) break;
            cursor = entry.sequence;
            entries.push(entry);
          }
        }
        const messages = messagesFor(id, entries);
        if (messages.length > 500) return new Response(null, { status: 413, headers: noStore });
        const latest = await client.thread(id, { signal });
        if (!isLocalThread(latest) || latest.lastSequence !== thread.lastSequence) return new Response(null, { status: 409, headers: noStore });
        const { held, busy } = await currentApproval(client, latest, entries.at(-1), signal);
        return Response.json({ messages, ...options.replyState, interruption: held?.interruption ?? null, busy,
          ...(held ? { nativeRunId: held.nativeRunId, pendingPrompt: held.prompt } : {}) }, { headers: noStore });
      } catch (error) {
        const status = error instanceof ClientError && (error.status === 404 || error.status === 403 || error.status === 401)
          ? error.status : 503;
        return new Response(null, { status, headers: noStore });
      }
    },
  };
}
