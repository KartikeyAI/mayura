import { useId, useRef, useState, useSyncExternalStore } from 'react';
import 'virtual:mayura-ui-package.css';
import { AG_UI_PROTOCOL_VERSION, useAgUiConversation, type AgUiApprovalOptions, type AgUiEvent, type AgUiRunInput, type AgUiTransport, type Citation } from '../../../extensions/ui/src/ag-ui.js';
import { AgentWorkspace } from '../../../extensions/ui/src/agent-workspace.js';
import { ArtifactPanel, ReplyArtifacts, type ReplyArtifact } from '../../../extensions/ui/src/artifacts.js';
import { Composer } from '../../../extensions/ui/src/composer.js';
import { Inspector } from '../../../extensions/ui/src/inspector.js';
import { MessageActions } from '../../../extensions/ui/src/message-actions.js';
import { ReplyCards, type ReplyCard } from '../../../extensions/ui/src/reply-cards.js';
import { RunActivity, type RunActivityItem } from '../../../extensions/ui/src/run-activity.js';
import { ThreadHistory, type ThreadSummary } from '../../../extensions/ui/src/thread-history.js';
import { UiRoot } from '../../../extensions/ui/src/ui-root.js';
import { AnswerText, ApprovalCard, SourceInspector, Sources } from '../../../extensions/ui/src/ui.js';
import type { UiSlug } from '../lib/ui-catalog';
import './ui-component-preview.css';

export type { UiSlug } from '../lib/ui-catalog';

const citations = [{
  id: '1', title: 'Rollout runbook', detail: 'Deployment · Canary rollout',
  excerpt: 'Route 5% of traffic to the canary for 15 minutes. Increase the share only when the error rate and latency stay within the release thresholds.',
}, {
  id: '2', title: 'Rollback policy', detail: 'Operations · Rollback criteria',
  excerpt: 'Roll back if the error rate exceeds 1% or p95 latency exceeds 500 ms for five minutes.',
}];
const reply = 'Start with a **5% canary** for 15 minutes [1]. Roll back if errors or latency exceed the release thresholds [2].';
const threads: readonly ThreadSummary[] = [
  { id: 'rollout', title: 'Release rollout', updatedAt: '2026-09-15T12:00:00Z', pendingApproval: true },
  { id: 'latency', title: 'Investigate latency', updatedAt: '2026-09-14T12:00:00Z', pendingApproval: false },
  { id: 'runbook', title: 'Refresh the runbook', updatedAt: '2026-09-12T12:00:00Z', pendingApproval: false },
];
const artifacts = [
  { id: 'canary', type: 'chart', title: 'Traffic by rollout stage', description: 'Share of production traffic', unit: '%',
    points: [{ label: 'Canary', value: 5 }, { label: 'Expand', value: 25 }, { label: 'Release', value: 100 }] },
  { id: 'runbook', type: 'link', title: 'Deployment guide', description: 'Mayura operations documentation', href: 'https://mayurajs.com/docs/guides/deployment/' },
] as const satisfies readonly ReplyArtifact[];
const steps: readonly RunActivityItem[] = [
  { id: 'sources', kind: 'step', label: 'Read the rollout runbook', status: 'complete' },
  { id: 'draft', kind: 'step', label: 'Draft the release checklist', status: 'complete' },
  { id: 'save', kind: 'tool', label: 'Save checklist', status: 'paused' },
];
const change = {
  title: 'Release checklist', destination: 'release/checklist.md',
  content: '# Release checklist\n- Route 5% of traffic to the canary.\n- Check errors and latency for 15 minutes.\n',
};
const toolName = 'docs.save';
const toolArgs = JSON.stringify(change, null, 2);
const approvalPrompt = 'Save the release checklist';
const approvalMessage = 'Save this checklist to the release workspace?';
const rolloutPrompt = 'How should we roll out?';
const replyCards = [{
  id: 'rollout-thresholds', type: 'table', title: 'Rollout thresholds',
  data: { columns: ['Stage', 'Traffic', 'Check'], rows: [['Canary', '5%', '15 minutes'], ['Rollback', '0%', 'Error rate > 1%']] },
}] as const satisfies readonly ReplyCard[];

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => themeListeners.forEach(notify => notify()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0) {
      themeObserver?.disconnect();
      themeObserver = undefined;
    }
  };
}
const readTheme = () => document.documentElement.classList.contains('dark') ? 'dark' as const : 'light' as const;
const mobileQuery = '(max-width: 48rem)';
function subscribeMobile(listener: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function useInspection() {
  const panelId = useId();
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia(mobileQuery).matches, () => false);
  const [active, setActive] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return {
    panelId, mobile, active,
    onOpen(id: string, button: HTMLButtonElement) { trigger.current = button; setActive(id); },
    onClose() {
      setActive(null);
      requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    },
  };
}

function ComposerPreview({ thumbnail, featured }: { thumbnail: boolean; featured: boolean }) {
  const [sent, setSent] = useState(false);
  return <>
    <Composer onSend={() => { setSent(true); return true; }} onStop={() => {}} streaming={false} disabled={false}
      quotedReply={featured ? 'Route 5% of traffic to the canary for 15 minutes.' : null} />
    {!thumbnail && sent && <p className="ui-preview-status" role="status">Draft sent in this preview.</p>}
  </>;
}

function HistoryPreview({ thumbnail }: { thumbnail: boolean }) {
  const [activeId, setActiveId] = useState('rollout');
  return <div className="ui-preview-history">
    <ThreadHistory threads={thumbnail ? threads.slice(0, 2) : threads} activeId={activeId} loading={false} locked={false} error={null}
      onOpen={setActiveId} onRefresh={() => {}} />
  </div>;
}

function ReplyPreview({ content = reply, sources = citations, actions = false }: {
  content?: string; sources?: readonly Citation[]; actions?: boolean;
}) {
  const inspection = useInspection();
  const source = sources.find(item => item.id === inspection.active);
  const [quote, setQuote] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const displayedReply = retried ? 'Keep the canary at 5% for 15 minutes before increasing traffic [1].' : content;
  return <div className="ui-preview-inspection">
    <div className="ui-preview-inspection-body">
      <AnswerText content={displayedReply} citations={sources} {...inspection} />
      {sources.length > 0 && <Sources citations={sources} {...inspection} />}
      {actions && <MessageActions content={displayedReply} feedbackKey="site-ui-gallery-reply" onQuote={() => setQuote(displayedReply)} onRetry={() => setRetried(value => !value)} />}
      {quote !== null && <Composer quotedReply={quote} onQuoteChange={setQuote}
        onSend={() => { setQuote(null); return true; }} onStop={() => {}} streaming={false} disabled={false} />}
    </div>
    {source && <Inspector id={inspection.panelId} title={source.title} mobile={inspection.mobile} contentKey={source.id} onClose={inspection.onClose}>
      <SourceInspector source={source} />
    </Inspector>}
  </div>;
}

function ArtifactsPreview() {
  const inspection = useInspection();
  const artifact = artifacts.find(item => item.id === inspection.active);
  return <div className="ui-preview-inspection">
    <div className="ui-preview-inspection-body"><ReplyArtifacts items={artifacts} {...inspection} /></div>
    {artifact && <Inspector id={inspection.panelId} title={artifact.title} mobile={inspection.mobile} contentKey={artifact.id} onClose={inspection.onClose}>
      <ArtifactPanel artifact={artifact} />
    </Inspector>}
  </div>;
}

function ApprovalPreview() {
  const [approved, setApproved] = useState<boolean | null>(null);
  if (approved !== null) return <div className="ui-preview-controls">
    <p role="status">{approved ? 'Approved in this preview.' : 'Declined in this preview.'}</p>
    <button type="button" onClick={() => setApproved(null)}>Review again</button>
  </div>;
  return <ApprovalCard toolName={toolName} args={toolArgs} change={change} message={approvalMessage} onDecide={setApproved} />;
}

const approval: AgUiApprovalOptions = {
  validate: request => request.toolName === toolName && request.arguments === toolArgs,
  toolLabel: () => 'Save checklist',
  resultStatus: ({ approved, content }) => content === (approved ? 'accepted' : 'declined')
    ? approved ? 'complete' : 'declined' : 'unconfirmed',
};

function demoEvents(input: AgUiRunInput, includeArtifacts = false): AgUiEvent[] {
  const { threadId, runId } = input;
  const events: AgUiEvent[] = [{ type: 'RUN_STARTED', threadId, runId, metadata: { mayura: { runId } } }];
  const success = { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } } as const;
  const messageId = `${runId}-reply`;
  const decision = input.resume?.[0];
  if (decision?.status === 'resolved') {
    const approved = decision.payload.approved;
    const toolCallId = decision.interruptId.replace(/^gallery-approval-/u, 'gallery-save-');
    return [...events,
      { type: 'TOOL_CALL_RESULT', role: 'tool', messageId: `${runId}-result`, toolCallId, content: approved ? 'accepted' : 'declined' },
      { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId },
      { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: approved ? 'Checklist approved in the preview.' : 'Checklist declined in the preview.' },
      { type: 'TEXT_MESSAGE_END', messageId }, success];
  }
  const toolCallId = 'gallery-save-' + runId;
  if (input.messages.at(-1)?.content === approvalPrompt) return [...events,
    { type: 'TOOL_CALL_START', parentMessageId: messageId, toolCallName: toolName, toolCallId },
    { type: 'TOOL_CALL_ARGS', toolCallId, delta: toolArgs }, { type: 'TOOL_CALL_END', toolCallId },
    { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'interrupt', interrupts: [{
      id: 'gallery-approval-' + runId, reason: 'tool_call', toolCallId, message: approvalMessage, responseSchema: {},
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }] } }];
  return [...events,
    { type: 'STEP_STARTED', stepName: 'Read the rollout runbook' },
    { type: 'STATE_SNAPSHOT', snapshot: { citations, artifacts, replyCards }, metadata: { mayura: { stateRevision: 1 } } },
    { type: 'STEP_FINISHED', stepName: 'Read the rollout runbook' },
    { type: 'TEXT_MESSAGE_START', role: 'assistant', messageId },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'Start with a **5% canary** for 15 minutes [1]. ' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'Roll back if errors or latency exceed the release thresholds [2].'
      + (includeArtifacts ? '\n\n[[artifact:canary]] [[artifact:runbook]]' : '') },
    { type: 'TEXT_MESSAGE_END', messageId }, success];
}

/** The conversation hook consumes real SSE frames. This demo synthesizes them in memory. */
function demoStream(events: readonly AgUiEvent[], runId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const frames = events.values();
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (cancelled || signal.aborted) return;
      const item = frames.next();
      if (item.done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${JSON.stringify(item.value)}\n\n`));
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-mayura-run-id': runId } });
}

const transport: AgUiTransport = {
  async run(input, signal) { return demoStream(demoEvents(input), input.runId, signal); },
  async cancel(_runId, signal) { return !signal.aborted; },
};

const inProgressThread = { id: 'rollout-in-progress', title: 'Rollout in progress', updatedAt: '2026-09-15T12:00:00Z', pendingApproval: false };
const inProgressRun = '45ac5eb8-1a41-4dda-be3b-5d60f65405aa';
const inProgressPrompt = { id: 'rollout-prompt', role: 'user', content: rolloutPrompt } as const;

const workspaceTransport: AgUiTransport = {
  ...transport,
  async run(input, signal) { return demoStream(demoEvents(input, true), input.runId, signal); },
  async listThreads(signal) {
    signal.throwIfAborted();
    return { threads: [inProgressThread] };
  },
  async readThread(id, signal) {
    signal.throwIfAborted();
    if (id !== inProgressThread.id) throw new Error('Unknown preview thread.');
    return { messages: [inProgressPrompt], busy: true, activeRunId: inProgressRun };
  },
  async observeRun({ threadId, runId }, signal) {
    if (threadId !== inProgressThread.id || runId !== inProgressRun) return new Response(null, { status: 404 });
    const events = demoEvents({ protocolVersion: AG_UI_PROTOCOL_VERSION, threadId, runId, messages: [inProgressPrompt] }, true);
    events.splice(1, 0, { type: 'MESSAGES_SNAPSHOT', messages: [inProgressPrompt] });
    return demoStream(events, runId, signal);
  },
};

function ChatWorkspacePreview({ theme }: { theme: 'light' | 'dark' }) {
  return <AgentWorkspace className="ui-preview-workspace" theme={theme} title="Release workspace"
    transport={workspaceTransport} approval={approval} reviewChange={request => approval.validate?.(request) ? change : null}
    emptyTitle="Plan your rollout" suggestions={[rolloutPrompt, approvalPrompt]} />;
}

const cardAction = {
  cardId: 'acknowledge-incident', actionId: 'acknowledge', label: 'Acknowledge incident',
  description: 'Record an acknowledgement for incident 19 in this demo.',
};
const demoCards: readonly ReplyCard[] = [...replyCards, {
  id: cardAction.cardId, type: 'confirmation', title: 'Incident 19',
  data: { actionId: cardAction.actionId, message: 'The incident needs an acknowledgement to confirm it has an owner.' },
}];

function ReplyCardsPreview({ thumbnail }: { thumbnail: boolean }) {
  return <ReplyCards cards={thumbnail ? replyCards : demoCards}
    confirmActions={[cardAction]} onConfirm={() => { /* The gallery acknowledges only in local UI state. */ }} />;
}

const labels = {
  idle: 'Ready', streaming: 'Streaming', paused: 'Waiting for approval', complete: 'Complete',
  stopped: 'Stopped', error: 'Run unconfirmed', reconnecting: 'Reconnecting', disconnected: 'Disconnected',
} as const;

function AgUiPreview() {
  const run = useAgUiConversation({ transport, approval });
  const locked = run.status === 'paused' || run.status === 'streaming' || run.connection === 'disconnected';
  const lastReply = run.messages.findLast(message => message.role === 'assistant');
  const { status } = run;
  const activityStatus = run.connection ? null : status;
  return <div className="ui-preview-ag-ui">
    <div className="ui-preview-controls">
      <button type="button" disabled={locked} onClick={() => run.send(rolloutPrompt)}>Stream a reply</button>
      <button type="button" disabled={locked} onClick={() => run.send(approvalPrompt)}>Request approval</button>
      <button type="button" disabled={status === 'idle' || status === 'streaming'} onClick={run.reset}>Reset</button>
      <output aria-label="AG-UI run status">{labels[run.connection ?? status]}</output>
    </div>
    {run.activity && activityStatus && activityStatus !== 'idle' && <RunActivity status={activityStatus} items={run.activity.items} thinking={!lastReply}
      streamingLabel="Receiving events" />}
    {lastReply && <ReplyPreview key={lastReply.id} content={lastReply.content} sources={run.citations} />}
    {run.interruption && <ApprovalCard toolName={run.interruption.toolName} args={run.interruption.arguments}
      message={run.interruption.message} change={change} onDecide={run.decide} />}
    {run.error && <p role="alert">{run.error}</p>}
    <Composer onSend={run.send} onStop={run.stop} streaming={status === 'streaming'} disabled={locked && status !== 'streaming'} />
  </div>;
}

function PreviewContent({ slug, thumbnail, featured, theme }: {
  slug: UiSlug; thumbnail: boolean; featured: boolean; theme: 'light' | 'dark';
}) {
  switch (slug) {
    case 'chat-workspace': return thumbnail ? <ReplyCardsPreview thumbnail /> : <ChatWorkspacePreview theme={theme} />;
    case 'reply-cards': return <ReplyCardsPreview thumbnail={thumbnail} />;
    case 'composer': return <ComposerPreview thumbnail={thumbnail} featured={featured} />;
    case 'thread-history': return <HistoryPreview thumbnail={thumbnail} />;
    case 'reply': return <ReplyPreview actions={!thumbnail} />;
    case 'artifacts': return <ArtifactsPreview />;
    case 'approvals': return <ApprovalPreview />;
    case 'run-activity': return <RunActivity items={steps} status="paused" streamingLabel="Preparing the release" />;
    case 'ag-ui': return thumbnail
      ? <RunActivity items={steps} status="streaming" streamingLabel="Receiving events" thinking />
      : <AgUiPreview />;
  }
}

export function UiComponentPreview({ slug, variant = 'playground' }: {
  slug: UiSlug; variant?: 'playground' | 'thumbnail' | 'featured';
}) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'light' as const);
  return <UiRoot theme={theme} className={`ui-component-preview ui-component-preview--${variant}`}>
    <PreviewContent key={slug} slug={slug} thumbnail={variant !== 'playground'} featured={variant === 'featured'} theme={theme} />
  </UiRoot>;
}
