import { ClientError, type ClientEvent, type RemoteHumanRequest, type RemoteRun, type RemoteSnapshot } from './index.js';

export type RunConnection = 'idle' | 'loading' | 'observing' | 'stopped' | 'error' | 'disposed';
export interface HeadlessRunState {
  readonly revision: number; readonly connection: RunConnection; readonly snapshot: RemoteSnapshot | null;
  readonly events: readonly ClientEvent[]; readonly lastSequence: number; readonly hasGap: boolean;
  readonly activity: { readonly models: number | null; readonly tools: number | null; readonly hooks: number | null };
  readonly errorCode: string | null;
  /**
   * Text streamed so far for the latest model call of an agent that streams its output, or null. Provisional: the
   * run's final output is authoritative. `withheld` means a batch guard stopped the stream; `complete` is false when
   * an event gap or the size bound means some text is missing.
   */
  readonly streamedOutput: { readonly modelCall: number; readonly text: string; readonly withheld: boolean; readonly complete: boolean } | null;
}
export interface HeadlessRunStoreOptions {
  readonly run: RemoteRun; readonly maxEvents?: number; readonly maxSubscribers?: number;
  /** Most streamed characters kept (default 65,536). */
  readonly maxStreamedChars?: number;
}
export interface HeadlessRunStore {
  getSnapshot(): HeadlessRunState;
  subscribe(listener: () => void): () => void;
  refresh(options?: { readonly signal?: AbortSignal }): Promise<HeadlessRunState>;
  observe(options?: { readonly signal?: AbortSignal }): Promise<HeadlessRunState>;
  cancel(options?: { readonly signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}
export interface HumanRequestView {
  readonly id: string; readonly agentId: string; readonly kind: RemoteHumanRequest['kind']; readonly status: RemoteHumanRequest['status'];
  readonly prompt: string; readonly canRespond: boolean; readonly urgency: 'normal' | 'due_soon' | 'expired' | 'resolved';
  readonly statusText: string; readonly actionText: string | null; readonly deadlineAtMs: number | null;
}
export type RunActivityKind = 'run' | 'step' | 'model' | 'tool' | 'hook' | 'delegate';
export type RunActivityStatus = 'active' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown' | 'unknown';
export interface RunActivityItem {
  readonly id: string; readonly kind: RunActivityKind; readonly label: string; readonly status: RunActivityStatus;
  readonly startedSequence: number | null; readonly completedSequence: number | null;
  readonly startedAt: string | null; readonly completedAt: string | null;
}
export interface RunActivityProjection {
  readonly revision: number; readonly complete: boolean; readonly items: readonly RunActivityItem[];
}

const runStatuses = new Set(['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const eventTypes = new Set(['run.started', 'model.started', 'model.completed', 'tool.started', 'tool.completed', 'hook.started', 'hook.completed',
  'step.started', 'step.completed', 'delegate.started', 'delegate.completed', 'run.completed', 'events.gap', 'output.delta', 'output.withheld']);
type StreamedOutput = HeadlessRunState['streamedOutput'];
/** Append one streamed event to the provisional output; a new model call starts over. */
function streamed(current: StreamedOutput, item: ClientEvent, gap: boolean, maxChars: number): StreamedOutput {
  const modelCall = item.metadata['modelCall'] as number;
  const base = current && current.modelCall === modelCall ? current : { modelCall, text: '', withheld: false, complete: true };
  if (item.type === 'output.withheld') return Object.freeze({ ...base, withheld: true });
  const text = base.text + String(item.metadata['text']);
  return Object.freeze({ modelCall, withheld: base.withheld, text: text.slice(0, maxChars), complete: base.complete && !gap && text.length <= maxChars });
}
const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const remoteErrorCodes = new Set(['ABORTED', 'TRANSPORT_FAILED', 'REDIRECT_DENIED', 'HTTP_ERROR', 'INVALID_RESPONSE', 'INVALID_JSON', 'RESPONSE_LIMIT',
  'INVALID_OUTPUT', 'INVALID_REQUEST', 'INVALID_CURSOR', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_STREAM', 'OBSERVATION_FAILED', 'STREAM_LIMIT', 'TRUNCATED_STREAM',
  'INVALID_VIEW_INPUT']);
const encoder = new TextEncoder();
function viewError(error: unknown): ClientError { return error instanceof ClientError && remoteErrorCodes.has(error.code) ? error : new ClientError('VIEW_FAILED'); }
function snapshot(value: RemoteSnapshot, id: string): RemoteSnapshot {
  if (!value || !Object.isFrozen(value)) throw new ClientError('INVALID_VIEW_INPUT');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 4 || ['id', 'status', 'budget', 'evidence'].some(key => !fields[key] || !('value' in fields[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
  const observedId = fields['id']!.value; const status = fields['status']!.value; const observedBudget: unknown = fields['budget']!.value; const observedEvidence: unknown = fields['evidence']!.value;
  if (observedId !== id || typeof status !== 'string' || !runStatuses.has(status) || !observedBudget || typeof observedBudget !== 'object' || !Object.isFrozen(observedBudget)
    || !Array.isArray(observedEvidence) || !Object.isFrozen(observedEvidence) || observedEvidence.length > 4_096) throw new ClientError('INVALID_VIEW_INPUT');
  const budget = Object.getOwnPropertyDescriptors(observedBudget);
  if (Reflect.ownKeys(budget).length !== 3 || ['spentMicros', 'reservedMicros', 'calls'].some(key => !budget[key] || !('value' in budget[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
  const spent: unknown = budget['spentMicros']!.value; const reserved: unknown = budget['reservedMicros']!.value; const calls: unknown = budget['calls']!.value;
  if ((typeof spent === 'string' ? !/^\d{1,64}$/.test(spent) : typeof spent !== 'number' || !Number.isSafeInteger(spent) || spent < 0)
    || typeof reserved !== 'number' || !Number.isSafeInteger(reserved) || reserved < 0 || typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 0) throw new ClientError('INVALID_VIEW_INPUT');
  for (const raw of observedEvidence) { if (!raw || typeof raw !== 'object' || !Object.isFrozen(raw)) throw new ClientError('INVALID_VIEW_INPUT');
    const entry = Object.getOwnPropertyDescriptors(raw); if (Reflect.ownKeys(entry).length !== 2 || ['runId', 'receipt'].some(key => !entry[key] || !('value' in entry[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
    const runId: unknown = entry['runId']!.value; const rawReceipt: unknown = entry['receipt']!.value;
    if (typeof runId !== 'string' || runId.length > 36 || !rawReceipt || typeof rawReceipt !== 'object' || !Object.isFrozen(rawReceipt)) throw new ClientError('INVALID_VIEW_INPUT');
    const receipt = Object.getOwnPropertyDescriptors(rawReceipt); if (Reflect.ownKeys(receipt).length !== 4 || ['callId', 'toolId', 'execution', 'disclosure'].some(key => !receipt[key] || !('value' in receipt[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
    if (typeof receipt['callId']!.value !== 'string' || receipt['callId']!.value.length > 256 || typeof receipt['toolId']!.value !== 'string' || receipt['toolId']!.value.length > 256
      || !['not_started', 'succeeded', 'failed', 'unknown'].includes(String(receipt['execution']!.value)) || !['released', 'withheld'].includes(String(receipt['disclosure']!.value))) throw new ClientError('INVALID_VIEW_INPUT'); }
  return value;
}
function event(value: ClientEvent, id: string, after: number): ClientEvent {
  if (!value || !Object.isFrozen(value)) throw new ClientError('INVALID_VIEW_INPUT'); const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 5 || ['runId', 'sequence', 'timestamp', 'type', 'metadata'].some(key => !descriptors[key] || !('value' in descriptors[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
  const runId: unknown = descriptors['runId']!.value; const sequence: unknown = descriptors['sequence']!.value; const type: unknown = descriptors['type']!.value;
  const timestamp: unknown = descriptors['timestamp']!.value; const observedMetadata: unknown = descriptors['metadata']!.value;
  if (runId !== id || typeof type !== 'string' || !eventTypes.has(type) || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= after
    || (type !== 'events.gap' && sequence !== after + 1) || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))
    || !observedMetadata || typeof observedMetadata !== 'object' || !Object.isFrozen(observedMetadata)) throw new ClientError('INVALID_VIEW_INPUT');
  const metadata = Object.getOwnPropertyDescriptors(observedMetadata); const keys = Reflect.ownKeys(metadata);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
      || !('value' in metadata[key]!) || !['string', 'number', 'boolean'].includes(typeof metadata[key]!.value)
      || (typeof metadata[key]!.value === 'number' && !Number.isFinite(metadata[key]!.value)))) throw new ClientError('INVALID_VIEW_INPUT');
  if (type === 'events.gap' && (metadata['from']?.value !== after + 1 || metadata['to']?.value !== sequence)) throw new ClientError('INVALID_VIEW_INPUT');
  if (type === 'output.delta' || type === 'output.withheld') {
    const required = type === 'output.delta' ? ['step', 'modelCall', 'index', 'text'] : ['step', 'modelCall'];
    if (keys.length !== required.length || required.some(key => !metadata[key])
      || ['step', 'modelCall', ...(type === 'output.delta' ? ['index'] : [])].some(key => !Number.isSafeInteger(metadata[key]!.value) || (metadata[key]!.value as number) < 0)
      || (type === 'output.delta' && (typeof metadata['text']!.value !== 'string' || (metadata['text']!.value as string).length > 4_096))) throw new ClientError('INVALID_VIEW_INPUT');
  }
  return value;
}
function frozen(state: Omit<HeadlessRunState, 'activity' | 'events'> & { readonly activity: HeadlessRunState['activity']; readonly events: readonly ClientEvent[] }): HeadlessRunState {
  return Object.freeze({ ...state, activity: Object.freeze({ ...state.activity }), events: Object.freeze([...state.events]) });
}

/** Framework-neutral external store for React, Vue, Svelte and DOM adapters. It never retries commands or opens a connection implicitly. */
export function createHeadlessRunStore(options: HeadlessRunStoreOptions): HeadlessRunStore {
  if (!options || !options.run || typeof options.run.inspect !== 'function' || typeof options.run.events !== 'function' || typeof options.run.cancel !== 'function'
    || typeof options.run.id !== 'string') throw new ClientError('INVALID_VIEW_CONFIG');
  const maxEvents = options.maxEvents ?? 256; const maxSubscribers = options.maxSubscribers ?? 64; const maxStreamedChars = options.maxStreamedChars ?? 65_536;
  if (!Number.isSafeInteger(maxStreamedChars) || maxStreamedChars < 1 || maxStreamedChars > 1_048_576) throw new ClientError('INVALID_VIEW_CONFIG');
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_024 || !Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > 256) throw new ClientError('INVALID_VIEW_CONFIG');
  const run = options.run; const subscribers = new Set<() => void>(); const controllers = new Set<AbortController>();
  let observing = false; let cancelling = false; let disposed = false; let refreshGeneration = 0;
  let state = frozen({ revision: 0, connection: 'idle', snapshot: null, events: [], lastSequence: 0, hasGap: false,
    activity: { models: 0, tools: 0, hooks: 0 }, errorCode: null, streamedOutput: null });
  const publish = (change: Partial<Omit<HeadlessRunState, 'revision'>>): HeadlessRunState => {
    if (disposed && change.connection !== 'disposed') return state;
    state = frozen({ ...state, ...change, revision: state.revision + 1 });
    for (const listener of [...subscribers]) { try { listener(); } catch { /* UI callbacks cannot break the store. */ } }
    return state;
  };
  const operation = (external?: AbortSignal) => {
    const controller = new AbortController(); const abort = (): void => controller.abort(); controllers.add(controller);
    external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) abort();
    return { signal: controller.signal, close: () => { external?.removeEventListener('abort', abort); controllers.delete(controller); } };
  };
  const fail = (error: unknown, connection: RunConnection = observing ? 'observing' : 'error'): ClientError => {
    const safe = viewError(error); if (!disposed) publish({ connection, errorCode: safe.code }); return safe;
  };
  const refresh = async (settings?: { readonly signal?: AbortSignal }): Promise<HeadlessRunState> => {
    if (disposed) throw new ClientError('VIEW_DISPOSED'); const generation = ++refreshGeneration; const control = operation(settings?.signal);
    publish({ connection: observing ? 'observing' : 'loading', errorCode: null });
    try { const current = snapshot(await run.inspect({ signal: control.signal }), run.id);
      if (generation !== refreshGeneration || disposed) return state;
      return publish({ snapshot: current, connection: observing ? 'observing' : 'stopped',
        ...(terminal.has(current.status) ? { activity: { models: 0, tools: 0, hooks: 0 } } : {}), errorCode: null });
    } catch (error) { if (generation !== refreshGeneration || disposed) throw viewError(error); throw fail(error); } finally { control.close(); }
  };
  return Object.freeze<HeadlessRunStore>({
    getSnapshot: () => state,
    subscribe: listener => { if (disposed) throw new ClientError('VIEW_DISPOSED'); if (typeof listener !== 'function') throw new ClientError('INVALID_VIEW_INPUT');
      if (subscribers.size >= maxSubscribers) throw new ClientError('VIEW_SUBSCRIBER_LIMIT');
      subscribers.add(listener); let active = true; return () => { if (active) { active = false; subscribers.delete(listener); } }; },
    refresh,
    observe: async settings => {
      if (disposed) throw new ClientError('VIEW_DISPOSED'); if (observing) throw new ClientError('VIEW_BUSY'); observing = true;
      const control = operation(settings?.signal); publish({ connection: 'observing', errorCode: null });
      try {
        for await (const received of run.events({ after: state.lastSequence, signal: control.signal })) {
          const item = event(received, run.id, state.lastSequence); const gap = state.hasGap || item.type === 'events.gap';
          const activity = gap ? { models: null, tools: null, hooks: null } : { ...state.activity };
          if (!gap) {
            const field = item.type.startsWith('model.') ? 'models' : item.type.startsWith('tool.') ? 'tools' : item.type.startsWith('hook.') ? 'hooks' : null;
            if (field) activity[field] = Math.max(0, (activity[field] ?? 0) + (item.type.endsWith('.started') ? 1 : -1));
          }
          const output = item.type === 'output.delta' || item.type === 'output.withheld' ? { streamedOutput: streamed(state.streamedOutput, item, gap, maxStreamedChars) }
            : item.type === 'events.gap' && state.streamedOutput ? { streamedOutput: Object.freeze({ ...state.streamedOutput, complete: false }) } : {};
          publish({ events: [...state.events, item].slice(-maxEvents), lastSequence: item.sequence, hasGap: gap, activity, ...output });
        }
        const current = snapshot(await run.inspect({ signal: control.signal }), run.id);
        return publish({ snapshot: current, connection: 'stopped', errorCode: null,
          ...(terminal.has(current.status) ? { activity: { models: 0, tools: 0, hooks: 0 } } : {}) });
      } catch (error) { if (disposed) return state; observing = false; throw fail(error, 'error'); }
      finally { observing = false; control.close(); }
    },
    cancel: async settings => { if (disposed) throw new ClientError('VIEW_DISPOSED'); if (cancelling) throw new ClientError('VIEW_BUSY'); cancelling = true;
      const control = operation(settings?.signal); try { await run.cancel({ signal: control.signal }); } catch (error) { throw fail(error); }
      finally { cancelling = false; control.close(); } },
    dispose: () => { if (disposed) return; disposed = true; refreshGeneration += 1; for (const controller of controllers) controller.abort();
      publish({ connection: 'disposed', errorCode: null }); subscribers.clear(); },
  });
}

/** Safe text-only presentation metadata for an authenticated human request. Rendering code must still use `textContent`. */
export function createHumanRequestView(request: RemoteHumanRequest, nowMs: number): HumanRequestView {
  if (!request || !Object.isFrozen(request) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new ClientError('INVALID_VIEW_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(request); const allowed = new Set(['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status', 'context', 'subjectDigest', 'deadlineAtMs']);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key) || !('value' in descriptors[key]!))) throw new ClientError('INVALID_VIEW_INPUT');
  const values = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
  if (typeof values['id'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(values['id']) || typeof values['agentId'] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(values['agentId']) || !['information', 'correction', 'plan_selection'].includes(String(values['kind']))
    || typeof values['schemaId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(values['schemaId'])
    || typeof values['schemaDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(values['schemaDigest']) || typeof values['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(values['digest'])
    || !['waiting', 'answered', 'cancelled', 'timed_out'].includes(String(values['status'])) || typeof values['prompt'] !== 'string'
    || encoder.encode(values['prompt']).byteLength < 1 || encoder.encode(values['prompt']).byteLength > 1_024
    || (values['subjectDigest'] !== undefined && (typeof values['subjectDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(values['subjectDigest'])))
    || ((values['kind'] === 'correction') !== (values['subjectDigest'] !== undefined))
    || (values['deadlineAtMs'] !== undefined && (!Number.isSafeInteger(values['deadlineAtMs']) || (values['deadlineAtMs'] as number) < 0))) throw new ClientError('INVALID_VIEW_INPUT');
  const item = values as unknown as RemoteHumanRequest;
  const waiting = item.status === 'waiting'; const deadline = item.deadlineAtMs ?? null; const remaining = deadline === null ? null : deadline - nowMs;
  const urgency: HumanRequestView['urgency'] = !waiting ? 'resolved' : remaining !== null && remaining <= 0 ? 'expired' : remaining !== null && remaining <= 300_000 ? 'due_soon' : 'normal';
  const statusText = item.status === 'waiting' ? (urgency === 'expired' ? 'Response deadline passed' : 'Response required')
    : item.status === 'answered' ? 'Answered' : item.status === 'cancelled' ? 'Cancelled' : 'Timed out';
  const actionText = !waiting || urgency === 'expired' ? null : item.kind === 'information' ? 'Provide information'
    : item.kind === 'correction' ? 'Submit correction' : 'Select plan';
  return Object.freeze({ id: item.id, agentId: item.agentId, kind: item.kind, status: item.status, prompt: item.prompt,
    canRespond: actionText !== null, urgency, statusText, actionText, deadlineAtMs: deadline });
}

function activityIdentity(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) ? value : null;
}
function activityStatus(value: unknown): Exclude<RunActivityStatus, 'active' | 'completed' | 'unknown'> | null {
  return typeof value === 'string' && ['failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(value)
    ? value as Exclude<RunActivityStatus, 'active' | 'completed' | 'unknown'> : null;
}

/** Project validated, content-free run events into a stable presentation timeline. Missing history remains explicit. */
export function createRunActivityProjection(state: HeadlessRunState): RunActivityProjection {
  if (!state || !Object.isFrozen(state) || !Array.isArray(state.events) || !Object.isFrozen(state.events)
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.events.length > 1_024) throw new ClientError('INVALID_VIEW_INPUT');
  type MutableItem = { id: string; kind: RunActivityKind; label: string; status: RunActivityStatus; startedSequence: number | null;
    completedSequence: number | null; startedAt: string | null; completedAt: string | null };
  const items = new Map<string, MutableItem>(); let prior = 0; let terminalSeen = false;
  let observedRunId: string | null = state.snapshot?.id ?? null; let complete = !state.hasGap;
  const keyFor = (item: ClientEvent): { key: string; kind: RunActivityKind; label: string } | null => {
    const metadata = item.metadata;
    if (item.type.startsWith('run.')) return { key: 'run', kind: 'run', label: 'Run' };
    if (item.type.startsWith('tool.')) { const id = activityIdentity(metadata['callId']); const label = activityIdentity(metadata['toolId']);
      return { key: `tool:${id ?? item.sequence}`, kind: 'tool', label: label ?? 'Tool call' }; }
    if (item.type.startsWith('hook.')) { const id = activityIdentity(metadata['invocationId']); const label = activityIdentity(metadata['hookId']);
      return { key: `hook:${id ?? item.sequence}`, kind: 'hook', label: label ?? 'Lifecycle hook' }; }
    if (item.type.startsWith('step.')) { const step = Number.isSafeInteger(metadata['step']) && (metadata['step'] as number) >= 0 ? metadata['step'] as number : null;
      return { key: `step:${step ?? item.sequence}`, kind: 'step', label: step === null ? 'Step' : `Step ${step + 1}` }; }
    if (item.type.startsWith('delegate.')) { const id = activityIdentity(metadata['childRunId']); const label = activityIdentity(metadata['childAgentId']);
      return { key: `delegate:${id ?? item.sequence}`, kind: 'delegate', label: label ?? 'Delegated run' }; }
    if (item.type.startsWith('model.')) {
      const purpose = metadata['purpose'] === 'guardrail' ? 'guardrail' : 'primary';
      const discriminator = purpose === 'guardrail'
        ? [activityIdentity(metadata['modelId']), activityIdentity(metadata['checkId']), activityIdentity(metadata['callId'])].filter(Boolean).join(':')
        : Number.isSafeInteger(metadata['step']) && (metadata['step'] as number) >= 0 ? `step:${metadata['step']}` : '';
      return { key: `model:${purpose}:${discriminator || item.sequence}`, kind: 'model', label: purpose === 'guardrail' ? 'Guardrail model call' : 'Model call' };
    }
    return null;
  };
  for (const item of state.events) {
    if (!item || !Object.isFrozen(item) || (observedRunId !== null && item.runId !== observedRunId)
      || !Number.isSafeInteger(item.sequence) || item.sequence <= prior || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp))
      || !Object.isFrozen(item.metadata)) throw new ClientError('INVALID_VIEW_INPUT');
    observedRunId ??= item.runId;
    if ((prior === 0 && item.sequence !== 1) || (prior !== 0 && item.sequence !== prior + 1)) complete = false;
    prior = item.sequence; if (item.type === 'events.gap') { complete = false; continue; }
    // Streamed output is text, not activity; `streamedOutput` carries it.
    if (item.type === 'output.delta' || item.type === 'output.withheld') continue;
    const identity = keyFor(item); if (!identity) throw new ClientError('INVALID_VIEW_INPUT'); const started = item.type.endsWith('.started');
    if (item.type === 'run.completed') terminalSeen = true;
    const existing = items.get(identity.key);
    if (started) {
      if (!existing) items.set(identity.key, { id: identity.key, kind: identity.kind, label: identity.label, status: 'active',
        startedSequence: item.sequence, completedSequence: null, startedAt: item.timestamp, completedAt: null });
      else complete = false;
      continue;
    }
    const status = activityStatus(item.metadata['status']) ?? (item.metadata['decision'] === 'block' ? 'blocked' : 'completed');
    if (existing && existing.status === 'active') { existing.status = status; existing.completedSequence = item.sequence; existing.completedAt = item.timestamp; }
    else { complete = false; items.set(`${identity.key}:completed:${item.sequence}`, { id: `${identity.key}:completed:${item.sequence}`, kind: identity.kind,
      label: identity.label, status, startedSequence: null, completedSequence: item.sequence, startedAt: null, completedAt: item.timestamp }); }
  }
  const result = [...items.values()].map(item => Object.freeze({ ...item, ...(item.status === 'active' && (!complete || terminalSeen) ? { status: 'unknown' as const } : {}) }));
  return Object.freeze({ revision: state.revision, complete, items: Object.freeze(result) });
}
