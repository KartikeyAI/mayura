export type UiCategory = 'Conversation' | 'Run controls' | 'Integration';

export interface UiProp {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly required?: boolean;
}

interface UiCatalogEntry {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly category: UiCategory;
  readonly sourceFile: string;
  readonly usage: string;
  readonly registryImports: string;
  readonly props: readonly UiProp[];
}

export const uiCatalog = [
  {
    slug: 'chat-workspace',
    title: 'Agent Workspace',
    description: 'Open threads, stream replies, inspect sources, and review exact changes in a customizable AG-UI workspace.',
    category: 'Conversation',
    sourceFile: 'agent-workspace.tsx',
    usage: `'use client';

import { AgentWorkspace } from '@mayurajs/ui';
import type { AgUiTransport } from '@mayurajs/ui/ag-ui';

export function SupportWorkspace({ transport }: { transport: AgUiTransport }) {
  return (
    <AgentWorkspace
      transport={transport}
      title="Support workspace"
      emptyTitle="What can I help you resolve?"
      suggestions={['Check rollout status', 'Summarize the latest incident']}
    />
  );
}
`,
    registryImports: `import { AgentWorkspace } from '@/components/ui/mayura/agent-workspace';
import type { AgUiTransport } from '@/components/ui/mayura/ag-ui';
`,
    props: [
      { name: 'transport', type: 'AgUiTransport', description: 'Connect the AG-UI stream, scoped thread reads and optional read-only run observation.', required: true },
      { name: 'initialThreadId', type: 'string', description: 'Load a saved thread when the workspace mounts.' },
      { name: 'onThreadChange', type: '(threadId: string | null) => void', description: 'Let the host remember or clear the current thread.' },
      { name: 'suggestions', type: 'readonly string[]', description: 'Offer prompts before the first message.' },
      { name: 'reviewChange', type: '(interrupt: ApprovalInterrupt) => DocumentChange | null | undefined', description: 'Show a host-validated preview of the exact arguments. Return null to require declining an invalid preview.' },
      { name: 'replyCards', type: "Omit<ReplyCardsProps, 'cards'>", description: 'Supply custom renderers, approved download paths and authorized card actions.' },
      { name: 'renderSidebar', type: '(state: AgentWorkspaceSidebarProps, defaultContent: ReactNode) => ReactNode', description: 'Customize thread navigation.' },
      { name: 'renderComposer', type: '(props: ComposerProps) => ReactNode', description: 'Replace message composition while keeping the same conversation controls.' },
      { name: 'renderMessage', type: '(state: AgentWorkspaceMessageProps, defaultContent: ReactNode) => ReactNode', description: 'Customize the rendering of any message.' },
    ],
  },
  {
    slug: 'composer',
    title: 'Composer',
    description: 'Draft a message, attach text or a quote, and stop an active response from one input.',
    category: 'Conversation',
    sourceFile: 'composer.tsx',
    usage: `'use client';

import { useState } from 'react';
import { Composer, UiRoot } from '@mayurajs/ui';

export function ComposerExample() {
  const [message, setMessage] = useState('');
  return (
    <UiRoot>
      <Composer
        onSend={text => {
          setMessage(text);
          return true;
        }}
        onStop={() => {}}
        streaming={false}
        disabled={false}
      />
      <p aria-live="polite">{message}</p>
    </UiRoot>
  );
}
`,
    registryImports: `import { Composer } from '@/components/ui/mayura/composer';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'onSend', type: '(text: string) => boolean', description: 'Accept a draft with its text context. Return true to clear it.', required: true },
      { name: 'onStop', type: '() => void', description: 'Handle the stop control during a response.', required: true },
      { name: 'streaming', type: 'boolean', description: 'Show the stop control while a response is in progress.', required: true },
      { name: 'disabled', type: 'boolean', description: 'Disable text entry, attachments, and voice input.', required: true },
      { name: 'assistantReply', type: '{ id: string; content: string } | null', description: 'Provide the reply for the voice conversation mode.', required: false },
      { name: 'quotedReply', type: 'string | null', description: 'Supply selected reply text as draft context.', required: false },
      { name: 'onQuoteChange', type: '(quote: string | null) => void', description: 'Update the host’s quote state when the composer clears a quote.', required: false },
    ],
  },
  {
    slug: 'thread-history',
    title: 'Thread History',
    description: 'Search conversation titles, reopen threads, and spot pending approvals from the list.',
    category: 'Conversation',
    sourceFile: 'thread-history.tsx',
    usage: `'use client';

import { useState } from 'react';
import { ThreadHistory, UiRoot } from '@mayurajs/ui';

const threads = [
  { id: 'rollout', title: 'Release rollout', updatedAt: '2026-11-24T09:00:00Z', pendingApproval: true },
  { id: 'notes', title: 'Release notes', updatedAt: '2026-11-23T11:00:00Z', pendingApproval: false },
];

export function ThreadHistoryExample() {
  const [activeId, setActiveId] = useState<string | null>(null);
  return (
    <UiRoot>
      <ThreadHistory
        threads={threads}
        activeId={activeId}
        loading={false}
        locked={false}
        error={null}
        onOpen={setActiveId}
        onRefresh={() => {}}
      />
    </UiRoot>
  );
}
`,
    registryImports: `import { ThreadHistory } from '@/components/ui/mayura/thread-history';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'threads', type: 'readonly ThreadSummary[]', description: 'Supply thread IDs, titles, timestamps, and pending approval flags.', required: true },
      { name: 'activeId', type: 'string | null', description: 'Mark the open thread as current.', required: true },
      { name: 'loading', type: 'boolean', description: 'Mark history as busy while data loads.', required: true },
      { name: 'locked', type: 'boolean', description: 'Prevent opening another thread during a run.', required: true },
      { name: 'error', type: 'string | null', description: 'Display an error and offer a retry.', required: true },
      { name: 'onOpen', type: '(id: string) => void', description: 'Load the selected thread in the host application.', required: true },
      { name: 'onRefresh', type: '() => void', description: 'Request thread data again after a loading error.', required: true },
    ],
  },
  {
    slug: 'reply',
    title: 'Reply and Sources',
    description: 'Render a reply with inline citation markers, exact excerpts, and actions for copy, quote, retry, and feedback.',
    category: 'Conversation',
    sourceFile: 'ui.tsx',
    usage: `'use client';

import { useId, useState } from 'react';
import { AnswerText, Inspector, MessageActions, SourceInspector, Sources, UiRoot } from '@mayurajs/ui';

const citations = [{
  id: '1', title: 'Release handbook', detail: 'Rollout policy',
  excerpt: 'Keep the canary at 10% for the first 30 minutes.',
}];
const content = 'Start with a **10% canary** for 30 minutes [1].';

export function ReplyExample() {
  const panelId = useId();
  const [active, setActive] = useState<string | null>(null);
  const source = citations.find(item => item.id === active);
  const controls = { citations, active, panelId, mobile: false, onOpen: (id: string) => setActive(id) };

  return (
    <UiRoot>
      <AnswerText content={content} {...controls} />
      <Sources {...controls} />
      <MessageActions content={content} feedbackKey="rollout:reply-1" />
      {source && (
        <Inspector id={panelId} title={source.title} mobile={false} onClose={() => setActive(null)}>
          <SourceInspector source={source} />
        </Inspector>
      )}
    </UiRoot>
  );
}
`,
    registryImports: `import { AnswerText, SourceInspector, Sources } from '@/components/ui/mayura/ui';
import { Inspector } from '@/components/ui/mayura/inspector';
import { MessageActions } from '@/components/ui/mayura/message-actions';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'content', type: 'string', description: 'Render text, headings, lists, bold text, and numeric citation markers.', required: true },
      { name: 'citations', type: 'readonly Citation[]', description: 'Match citation IDs to titles, details, and exact excerpts.', required: true },
      { name: 'active', type: 'string | null', description: 'Identify the citation whose inspector is open.', required: true },
      { name: 'panelId', type: 'string', description: 'Connect the citation trigger to the inspector it opens.', required: true },
      { name: 'mobile', type: 'boolean', description: 'Mark citation triggers as opening a dialog when the inspector is a mobile sheet.', required: true },
      { name: 'onOpen', type: '(id: string, trigger: HTMLButtonElement) => void', description: 'Open a citation. Use its trigger to restore focus after closing.', required: true },
      { name: 'MessageActions.feedbackKey', type: 'string', description: 'Identify local feedback for this reply with a stable key.', required: true },
      { name: 'MessageActions.onQuote', type: '() => void', description: 'Handle quoting this reply in the host composer.', required: false },
      { name: 'MessageActions.onRetry', type: '() => void', description: 'Offer retry when the host can safely start another response.', required: false },
    ],
  },
  {
    slug: 'reply-cards',
    title: 'Reply Cards',
    description: 'Render structured tables, downloads, exact confirmations, and typed application components in an agent reply.',
    category: 'Conversation',
    sourceFile: 'reply-cards.tsx',
    usage: `'use client';

import { defineReplyCard, readReplyCards, ReplyCards, UiRoot } from '@mayurajs/ui';

const status = defineReplyCard('service-status', {
  parse: data => data === 'healthy' || data === 'degraded' ? data : undefined,
  Component: ({ data }) => <output>{data === 'healthy' ? 'Operational' : 'Degraded'}</output>,
});

const cards = readReplyCards([
  { id: 'api-status', type: 'service-status', title: 'API status', data: 'healthy' },
  {
    id: 'rollout', type: 'table', title: 'Rollout schedule',
    data: { columns: ['Stage', 'Traffic'], rows: [['Canary', '5%'], ['Release', '100%']] },
  },
]);

export function ReplyCardExample() {
  return <UiRoot><ReplyCards cards={cards} renderers={[status]} /></UiRoot>;
}
`,
    registryImports: `import { defineReplyCard, readReplyCards, ReplyCards } from '@/components/ui/mayura/reply-cards';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'cards', type: 'readonly ReplyCard[]', description: 'Pass the bounded cards from AG-UI state or use readReplyCards to read untrusted data.', required: true },
      { name: 'renderers', type: 'readonly ReplyCardRenderer[]', description: 'Register trusted React components with host-defined data parsers.' },
      { name: 'downloadPaths', type: 'readonly string[]', description: 'Allow exact same-origin download paths.' },
      { name: 'confirmActions', type: 'readonly ReplyCardAction[]', description: 'Bind exact card and action IDs to the label and operation description provided by your app.' },
      { name: 'onConfirm', type: '(request: ReplyCardActionRequest) => void | Promise<void>', description: 'Handle one explicit confirmation. Authorize and deduplicate the action in the host.' },
    ],
  },
  {
    slug: 'artifacts',
    title: 'Artifacts',
    description: 'Show charts, audio, video, and links beside a reply, with a shared inspector for the selected item.',
    category: 'Conversation',
    sourceFile: 'artifacts.tsx',
    usage: `'use client';

import { useId, useState } from 'react';
import { ArtifactPanel, Inspector, ReplyArtifacts, UiRoot, readArtifacts } from '@mayurajs/ui';

const items = readArtifacts([{
  id: 'rollout', title: 'Rollout progress', type: 'chart', unit: '%',
  points: [{ label: 'Canary', value: 100 }, { label: 'Production', value: 40 }],
}]);

export function ArtifactsExample() {
  const panelId = useId();
  const [active, setActive] = useState<string | null>(null);
  const artifact = items.find(item => item.id === active);

  return (
    <UiRoot>
      <ReplyArtifacts items={items} active={active} panelId={panelId} mobile={false} onOpen={id => setActive(id)} />
      {artifact && (
        <Inspector id={panelId} title={artifact.title} mobile={false} onClose={() => setActive(null)}>
          <ArtifactPanel artifact={artifact} />
        </Inspector>
      )}
    </UiRoot>
  );
}
`,
    registryImports: `import { ArtifactPanel, ReplyArtifacts, readArtifacts } from '@/components/ui/mayura/artifacts';
import { Inspector } from '@/components/ui/mayura/inspector';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'items', type: 'readonly ReplyArtifact[]', description: 'List chart, video, audio, or link artifacts. Use readArtifacts for untrusted data.', required: true },
      { name: 'active', type: 'string | null', description: 'Identify the currently open artifact.', required: true },
      { name: 'panelId', type: 'string', description: 'Connect the selected artifact trigger to the inspector.', required: true },
      { name: 'mobile', type: 'boolean', description: 'Mark artifact triggers as opening a dialog when the inspector is a full-screen sheet.', required: true },
      { name: 'onOpen', type: '(id: string, trigger: HTMLButtonElement) => void', description: 'Open the selected artifact. Use its trigger to restore focus after closing.', required: true },
      { name: 'ArtifactPanel.artifact', type: 'ReplyArtifact', description: 'Render the selected artifact inside the panel.', required: true },
      { name: 'readArtifacts.mediaPaths', type: 'readonly string[]', description: 'Allow exact same-origin paths for audio, video, captions, and posters.', required: false },
    ],
  },
  {
    slug: 'approvals',
    title: 'Approval and Change Review',
    description: 'Show exact tool arguments and the lines a proposed document will add before the user decides.',
    category: 'Run controls',
    sourceFile: 'ui.tsx',
    usage: `'use client';

import { useState } from 'react';
import { ApprovalCard, UiRoot } from '@mayurajs/ui';

const change = {
  title: 'Release checklist',
  destination: 'docs/release.md',
  content: '- Verify canary metrics.',
};

export function ApprovalExample() {
  const [decision, setDecision] = useState<boolean | null>(null);
  return (
    <UiRoot>
      {decision === null ? (
        <ApprovalCard
          toolName="save_document"
          args={JSON.stringify(change, null, 2)}
          message="Save these lines to the release checklist?"
          change={change}
          onDecide={setDecision}
        />
      ) : (
        <p role="status">{decision ? 'Approved' : 'Declined'}</p>
      )}
    </UiRoot>
  );
}
`,
    registryImports: `import { ApprovalCard, ChangeReview } from '@/components/ui/mayura/ui';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'toolName', type: 'string', description: 'Show the name of the tool awaiting a decision.', required: true },
      { name: 'args', type: 'string', description: 'Display the original tool arguments for exact review.', required: true },
      { name: 'message', type: 'string', description: 'Explain the proposed action to the reviewer.', required: true },
      { name: 'change', type: 'DocumentChange | null', description: 'Show a validated preview of the arguments. Pass null to disable approval when validation fails.', required: false },
      { name: 'onDecide', type: '(approved: boolean) => void', description: 'Pass the decision to the host for server-side enforcement.', required: true },
    ],
  },
  {
    slug: 'run-activity',
    title: 'Run Activity',
    description: 'Show a compact run status that expands into the reported steps and tool activity.',
    category: 'Run controls',
    sourceFile: 'run-activity.tsx',
    usage: `import { RunActivity, UiRoot, type RunActivityItem } from '@mayurajs/ui';

const items: readonly RunActivityItem[] = [
  { id: 'sources', kind: 'step', label: 'Read release notes', status: 'complete' },
  { id: 'save', kind: 'tool', label: 'Save checklist', status: 'paused' },
];

export function RunActivityExample() {
  return (
    <UiRoot>
      <RunActivity items={items} status="paused" streamingLabel="Working" />
    </UiRoot>
  );
}
`,
    registryImports: `import { RunActivity, type RunActivityItem } from '@/components/ui/mayura/run-activity';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'items', type: 'readonly RunActivityItem[]', description: 'Render the current run’s ordered step and tool statuses.', required: true },
      { name: 'status', type: "'streaming' | 'paused' | 'complete' | 'error' | 'stopped'", description: 'Choose the summary state for the run.', required: true },
      { name: 'streamingLabel', type: 'string', description: 'Set the in-progress label while streaming.', required: true },
      { name: 'thinking', type: 'boolean', description: 'Animate the waiting indicator while a run is streaming.', required: false },
    ],
  },
  {
    slug: 'ag-ui',
    title: 'AG-UI Conversation',
    description: 'Connect React chat to a host-owned AG-UI transport for streaming replies, thread history, and approval interrupts.',
    category: 'Integration',
    sourceFile: 'ag-ui.ts',
    usage: String.raw`'use client';

import { UiRoot } from '@mayurajs/ui';
import { useAgUiConversation, type AgUiEvent, type AgUiTransport } from '@mayurajs/ui/ag-ui';

const transport: AgUiTransport = {
  async run({ runId, threadId }, signal) {
    signal.throwIfAborted();
    const messageId = runId + '-reply';
    const events: AgUiEvent[] = [
      { type: 'RUN_STARTED', runId, threadId, metadata: { mayura: { runId } } },
      { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'The release checklist is ready.' },
      { type: 'TEXT_MESSAGE_END', messageId },
      { type: 'RUN_FINISHED', runId, threadId, outcome: { type: 'success' } },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
};

export function ConversationExample() {
  const chat = useAgUiConversation({ transport });
  return (
    <UiRoot>
      <button type="button" disabled={chat.status === 'streaming'} onClick={() => chat.send('Prepare the checklist')}>
        Ask for a checklist
      </button>
      <div aria-live="polite">
        {chat.messages.filter(message => message.role === 'assistant').map(message => (
          <p key={message.id}>{message.content}</p>
        ))}
      </div>
    </UiRoot>
  );
}
`,
    registryImports: `import { useAgUiConversation, type AgUiEvent, type AgUiTransport } from '@/components/ui/mayura/ag-ui';
import { UiRoot } from '@/components/ui/mayura/ui-root';
`,
    props: [
      { name: 'transport', type: 'AgUiTransport', description: 'Return an SSE Response for a run request. Optionally provide cancellation and scoped thread reads.', required: true },
      { name: 'mediaPaths', type: 'readonly string[]', description: 'Allow exact same-origin media paths in artifact events.', required: false },
      { name: 'approval', type: 'AgUiApprovalOptions', description: 'Validate displayable proposals and interpret observed tool outcomes.', required: false },
      { name: 'projectStoredAnswer', type: '(content: string) => string', description: 'Extract display text from a stored assistant message.', required: false },
    ],
  },
] as const satisfies readonly UiCatalogEntry[];

export type UiSlug = (typeof uiCatalog)[number]['slug'];
