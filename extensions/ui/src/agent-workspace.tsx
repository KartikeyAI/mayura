'use client';

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  listThreadHistory, useAgUiConversation, type AgUiConversationOptions, type ApprovalInterrupt, type ConversationMessage,
} from './ag-ui.js';
import { ArtifactPanel, ReplyArtifacts } from './artifacts.js';
import { Composer, type ComposerProps } from './composer.js';
import { attachmentContextDivider, maxQuoteLength } from './draft-context.js';
import { Inspector } from './inspector.js';
import { MessageActions } from './message-actions.js';
import { ReplyCards, type ReplyCardsProps } from './reply-cards.js';
import { RunActivity, type RunActivityProps } from './run-activity.js';
import { ThreadHistory, type ThreadHistoryProps } from './thread-history.js';
import { AnswerText, ApprovalCard, Icon, SourceInspector, Sources, type DocumentChange, type SourceControls } from './ui.js';
import { UiRoot, type UiRootProps } from './ui-root.js';

export interface AgentWorkspaceSidebarProps extends ThreadHistoryProps {
  readonly title: string;
  readonly onNew: () => void;
}

export interface AgentWorkspaceMessageProps {
  readonly message: ConversationMessage;
  readonly latest: boolean;
  readonly streaming: boolean;
}

export interface AgentWorkspaceProps extends AgUiConversationOptions {
  readonly theme?: UiRootProps['theme'];
  /** Set --mayura-workspace-height to size an embedded workspace. */
  readonly className?: string;
  readonly title?: string;
  readonly emptyTitle?: string;
  readonly suggestions?: readonly string[];
  /** Thread to read on mount. The host owns persistence for this ID. */
  readonly initialThreadId?: string;
  readonly onThreadChange?: (threadId: string | null) => void;
  /** Return a preview of the exact arguments or null to require declining an invalid projection. */
  readonly reviewChange?: (interruption: ApprovalInterrupt) => DocumentChange | null | undefined;
  readonly replyCards?: Omit<ReplyCardsProps, 'cards'>;
  readonly renderSidebar?: (state: AgentWorkspaceSidebarProps, defaultContent: ReactNode) => ReactNode;
  readonly renderComposer?: (props: ComposerProps) => ReactNode;
  readonly renderMessage?: (state: AgentWorkspaceMessageProps, defaultContent: ReactNode) => ReactNode;
}

const desktopWidth = 1024;
const sideButton = 'flex min-h-9 items-center justify-center gap-2 rounded-lg px-2.5 text-sm font-medium hover:bg-[var(--color-nav-active)] disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';
const textButton = 'min-h-8 rounded-md px-2.5 text-[13px] font-medium text-[color:var(--color-accent-deep)] underline-offset-4 hover:bg-[var(--color-wash)] hover:underline';
const transcriptWidth = 'mx-auto w-full max-w-[640px]';

function displayReply(content: string) {
  const artifactIds = new Set<string>();
  let text = content.replace(/\[\[artifact:([a-z][a-z0-9-]{0,47})\]\]/gu, (_, id: string) => {
    artifactIds.add(id);
    return '';
  });
  const partial = text.lastIndexOf('[[');
  if (partial >= 0) {
    const suffix = text.slice(partial);
    if ('[[artifact:'.startsWith(suffix) || /^\[\[artifact:[a-z0-9-]{0,48}\]?$/u.test(suffix)) text = text.slice(0, partial);
  }
  return { text: text.trim(), artifactIds };
}

function UserMessage({ content }: { content: string }) {
  const boundary = content.indexOf(attachmentContextDivider);
  const message = boundary < 0 ? content : content.slice(0, boundary);
  const context = boundary < 0 ? '' : content.slice(boundary + attachmentContextDivider.length);
  return <div className="ms-auto w-fit max-w-[88%] rounded-2xl bg-[var(--color-wash)] px-4 py-2.5 text-[15px] leading-6 [overflow-wrap:anywhere]">
    <p className="whitespace-pre-wrap">{message}</p>
    {context && <details className="mt-1.5 text-[13px] leading-5 text-[color:var(--color-secondary)]">
      <summary className="w-fit cursor-pointer rounded-sm">Message context</summary>
      <p className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-[color:var(--color-muted)]">{context}</p>
    </details>}
  </div>;
}

/** Compose a complete AG-UI chat around a caller-owned transport and optional replacement renderers. */
export function AgentWorkspace({
  theme, className, title = 'Agent Workspace', emptyTitle = 'What are we working on?', suggestions = [],
  initialThreadId, onThreadChange, reviewChange, replyCards, renderSidebar, renderComposer, renderMessage, ...options
}: AgentWorkspaceProps) {
  const chat = useAgUiConversation(options);
  const { transport } = options;
  const { status, connection, messages, interruption, threadId, openingThreadId } = chat;
  const [mobile, setMobile] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [inspected, setInspected] = useState<{ kind: 'source' | 'artifact'; id: string } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<{
    threads: ThreadHistoryProps['threads']; loading: boolean; error: string | null;
  }>({ threads: [], loading: Boolean(transport.listThreads), error: null });
  const [readingEarlier, setReadingEarlier] = useState(false);
  const follow = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const review = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const sidebarDialog = useRef<HTMLDialogElement>(null);
  const composerHadFocus = useRef(false);
  const inspectorId = useId();
  const sidebarId = useId();
  const titleId = useId();
  const latest = messages.at(-1);
  const latestPrompt = messages.findLast(message => message.role === 'user');
  const reply = latest?.role === 'assistant' ? displayReply(latest.content) : null;
  const citations = reply ? chat.citations.filter(citation => reply.text.includes('[' + citation.id + ']')) : [];
  const artifacts = reply ? chat.artifacts.filter(artifact => reply.artifactIds.has(artifact.id)) : [];
  const source = inspected?.kind === 'source' ? citations.find(item => item.id === inspected.id) : undefined;
  const artifact = inspected?.kind === 'artifact' ? artifacts.find(item => item.id === inspected.id) : undefined;
  const inspectionTitle = source?.title ?? artifact?.title;
  const empty = status === 'idle' || (status === 'complete' && !messages.length);
  const reconnecting = connection === 'reconnecting';
  const streaming = status === 'streaming' && !reconnecting;
  const locked = streaming || reconnecting || openingThreadId !== null;
  const showComposer = empty || streaming || status === 'complete';
  // Keep the current thread's local draft through pauses and observer transitions.
  const keepComposer = showComposer || threadId !== null;
  const canReadHistory = Boolean(transport.listThreads && transport.readThread);
  const openThread = useRef(chat.openThread);
  const restoreId = useRef(initialThreadId);
  const reportedThread = useRef<string | null>(null);

  useEffect(() => { openThread.current = chat.openThread; }, [chat.openThread]);
  useEffect(() => {
    if (restoreId.current) void openThread.current(restoreId.current);
  }, []);
  useEffect(() => {
    if (reportedThread.current === threadId) return;
    reportedThread.current = threadId;
    restoreId.current = undefined;
    onThreadChange?.(threadId);
  }, [onThreadChange, threadId]);

  useLayoutEffect(() => {
    const workspace = root.current;
    if (!workspace) return;
    const measure = () => setMobile(workspace.clientWidth < desktopWidth);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(workspace);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (!canReadHistory || locked) return;
    const controller = new AbortController();
    setHistory(current => ({ ...current, loading: true, error: null }));
    void listThreadHistory(transport, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(threads => {
      if (!controller.signal.aborted) setHistory({ threads, loading: false, error: null });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setHistory(current => ({ ...current, loading: false, error: 'Thread history is unavailable.' }));
      }
    });
    return () => controller.abort();
  }, [canReadHistory, historyRevision, locked, status, threadId, transport]);

  useLayoutEffect(() => {
    const box = composer.current;
    const area = stage.current;
    if (empty || !showComposer || !box || !area) return;
    const reserve = () => {
      area.style.setProperty('--mayura-composer-height', box.offsetHeight + 'px');
      if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    };
    reserve();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserve);
    observer?.observe(box);
    return () => {
      observer?.disconnect();
      area.style.removeProperty('--mayura-composer-height');
    };
  }, [empty, showComposer]);

  useLayoutEffect(() => {
    if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [latest?.content, latest?.id, messages.length, status, chat.replyCards]);

  useLayoutEffect(() => {
    if (status === 'paused' && composerHadFocus.current && document.activeElement === document.body) {
      review.current?.focus({ preventScroll: true });
    }
  }, [status]);

  useLayoutEffect(() => {
    const dialog = sidebarDialog.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [mobile, showSidebar]);

  useEffect(() => {
    if (!mobile) setShowSidebar(false);
  }, [mobile]);

  useEffect(() => {
    if (inspected && inspectionTitle === undefined) closeInspector(document.activeElement === document.body);
  }, [inspected, inspectionTitle]);

  function closeInspector(restoreFocus = true) {
    setInspected(null);
    const trigger = opener.current;
    opener.current = null;
    if (restoreFocus) requestAnimationFrame(() => (trigger?.isConnected ? trigger : transcript.current)?.focus({ preventScroll: true }));
  }

  function inspect(kind: 'source' | 'artifact', id: string, trigger: HTMLButtonElement) {
    if (inspected?.kind === kind && inspected.id === id) {
      closeInspector();
      return;
    }
    opener.current = trigger;
    setInspected({ kind, id });
  }

  function closeSidebar(restoreFocus = true) {
    if (!showSidebar) return;
    setShowSidebar(false);
    if (restoreFocus) requestAnimationFrame(() => sidebarToggle.current?.focus());
  }

  function resetDraft() {
    follow.current = true;
    setReadingEarlier(false);
    setDraftRevision(value => value + 1);
    setQuote(null);
    setInspected(null);
    opener.current = null;
  }

  function send(text: string) {
    if (!chat.send(text)) return false;
    follow.current = true;
    setReadingEarlier(false);
    setInspected(null);
    opener.current = null;
    return true;
  }

  function returnToLatest() {
    follow.current = true;
    setReadingEarlier(false);
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  function focusConversation() {
    requestAnimationFrame(() => {
      const target = review.current ?? (
        transcript.current?.tabIndex === 0
          ? transcript.current
          : composer.current?.querySelector<HTMLElement>('textarea,[contenteditable=true],input:not([type=hidden])') ?? composer.current
      );
      target?.focus({ preventScroll: true });
    });
  }

  const sourceControls: SourceControls = {
    citations, active: source?.id ?? null, panelId: inspectorId, mobile,
    onOpen: (id, trigger) => inspect('source', id, trigger),
  };
  const activityStatus: RunActivityProps['status'] | null = status === 'idle' ? null : status;
  const activity = activityStatus && (chat.activity || streaming || reconnecting) && <RunActivity status={activityStatus}
    items={chat.activity?.items ?? []}
    streamingLabel={reconnecting ? 'Reconnecting…' : reply ? 'Streaming response…' : 'Thinking…'}
    thinking={streaming && !reply} />;
  const freshReply = status === 'complete' && latest?.role === 'assistant' && reply
    ? { id: latest.id, content: reply.text.replace(/\s*\[\d+\]/gu, '') } : null;
  const composerProps: ComposerProps = {
    onSend: send, onStop: chat.stop, streaming, disabled: !showComposer || openingThreadId !== null,
    assistantReply: freshReply, quotedReply: quote, onQuoteChange: setQuote,
  };
  const sidebarProps: AgentWorkspaceSidebarProps = {
    title, threads: history.threads, loading: history.loading, activeId: threadId, locked, error: history.error,
    onRefresh: () => setHistoryRevision(revision => revision + 1),
    onOpen: id => {
      if (locked) return;
      if (id === threadId && status !== 'error') {
        closeSidebar(false);
        focusConversation();
        return;
      }
      void chat.openThread(id).then(opened => {
        if (!opened) return;
        resetDraft();
        closeSidebar(false);
        focusConversation();
      });
    },
    onNew: () => {
      if (locked) return;
      if (restoreId.current && reportedThread.current === null) onThreadChange?.(null);
      restoreId.current = undefined;
      chat.reset();
      resetDraft();
      closeSidebar(false);
      focusConversation();
    },
  };
  const defaultSidebar = <>
    <button type="button" disabled={locked} onClick={sidebarProps.onNew}
      className={sideButton + ' w-fit text-[color:var(--color-accent-deep)]'}>
      <Icon name="plus" size={16} />New chat
    </button>
    {canReadHistory && <ThreadHistory {...sidebarProps} />}
  </>;
  const sidebar = renderSidebar ? renderSidebar(sidebarProps, defaultSidebar) : defaultSidebar;
  let change: DocumentChange | null | undefined;
  if (interruption && reviewChange) {
    try { change = reviewChange(interruption); } catch { change = null; }
  }
  const hasNotice = chat.error || chat.historyError;
  const latestButton = <button type="button" onClick={returnToLatest}
    className="rounded-full bg-[var(--color-paper)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-secondary)] shadow-[0_2px_10px_#25271912] hover:bg-[var(--color-wash)]">
    Return to latest
  </button>;

  return <UiRoot theme={theme ?? 'light'} className={className ?? ''}>
    <div ref={root} className="@container/mayura-workspace flex h-[var(--mayura-workspace-height,100dvh)] min-h-0 min-w-0 overflow-hidden">
      {!mobile && <aside id={sidebarId} aria-label="Conversation navigation"
        className="hidden min-h-0 w-60 shrink-0 flex-col bg-[var(--color-sidebar)] px-4 py-5 @min-[1024px]/mayura-workspace:flex">
        <p className="mb-7 truncate px-2.5 text-[15px] font-semibold">{title}</p>
        {sidebar}
      </aside>}
      {mobile && showSidebar && <dialog id={sidebarId} ref={sidebarDialog} aria-label="Conversation navigation"
        className="fixed inset-y-0 start-0 end-auto m-0 h-dvh max-h-none w-[min(20rem,calc(100vw-2rem))] max-w-none border-0 bg-[var(--color-sidebar)] p-0 text-[color:var(--color-ink)] backdrop:bg-black/25 [&:not([open])]:hidden"
        onCancel={event => { event.preventDefault(); closeSidebar(); }}
        onClick={event => { if (event.target === event.currentTarget) closeSidebar(); }}>
        <div className="flex h-full min-h-0 flex-col px-4 py-5">
          <div className="mb-4 flex items-center justify-between gap-3 ps-2.5">
            <p className="truncate text-[15px] font-semibold">{title}</p>
            <button autoFocus type="button" aria-label="Close conversation navigation" onClick={() => closeSidebar()}
              className={sideButton}><Icon name="close" size={17} /></button>
          </div>
          {sidebar}
          {chat.historyError && <p role="alert" className="mt-2 px-2.5 text-sm text-[color:var(--color-warning-ink)]">{chat.historyError}</p>}
        </div>
      </dialog>}
      <section aria-labelledby={titleId} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 min-w-0 shrink-0 items-center gap-2 px-4">
          <button ref={sidebarToggle} type="button" aria-label="Open conversation navigation"
            aria-expanded={showSidebar} aria-controls={showSidebar ? sidebarId : undefined} aria-haspopup="dialog"
            onClick={() => setShowSidebar(true)} className={sideButton + ' @min-[1024px]/mayura-workspace:hidden'}>
            <Icon name="panel" size={18} />
          </button>
          <h1 id={titleId} className="truncate text-sm font-semibold @min-[1024px]/mayura-workspace:sr-only">{title}</h1>
          {openingThreadId && <p role="status" className="ms-auto text-xs text-[color:var(--color-muted)]">Opening thread…</p>}
        </header>
        <div ref={stage} className={'relative isolate flex min-h-0 flex-1 flex-col ' + (empty ? 'justify-center' : '')}>
          {empty && <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_44%,var(--color-tint-strong),transparent_60%)] opacity-70" />}
          <div ref={transcript} role="region" tabIndex={empty ? -1 : 0} aria-label="Conversation transcript"
            className={empty ? 'hidden' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 [scrollbar-color:var(--color-line-strong)_transparent] [scrollbar-width:thin] '
              + (showComposer ? 'pb-[calc(var(--mayura-composer-height,7rem)+1rem)]' : 'pb-12')}
            onScroll={event => {
              const area = event.currentTarget;
              const atEnd = area.scrollHeight - area.scrollTop - area.clientHeight < 72;
              follow.current = atEnd;
              setReadingEarlier(!atEnd);
            }}>
            <div className={transcriptWidth + ' space-y-6'}>
              {!latestPrompt && activity}
              {messages.map(message => {
                const isLatest = message === latest;
                const parsed = isLatest && reply ? reply : displayReply(message.content);
                const body = message.role === 'user' ? <UserMessage content={message.content} /> : <>
                  <AnswerText {...sourceControls} citations={isLatest ? citations : []} content={parsed.text} />
                  {isLatest && citations.length > 0 && <Sources {...sourceControls} />}
                  {isLatest && artifacts.length > 0 && <ReplyArtifacts items={artifacts} active={artifact?.id ?? null}
                    mobile={mobile} panelId={inspectorId} onOpen={(id, trigger) => inspect('artifact', id, trigger)} />}
                  {isLatest && status === 'complete' && <ReplyCards {...replyCards} cards={chat.replyCards ?? []} />}
                  {(!isLatest || status === 'complete') && parsed.text && <MessageActions
                    content={parsed.text} feedbackKey={JSON.stringify([threadId, message.id])}
                    onQuote={showComposer ? () => {
                      setQuote(parsed.text.slice(0, maxQuoteLength).trim());
                      requestAnimationFrame(() => composer.current?.querySelector('textarea')?.focus());
                    } : undefined}
                    onRetry={isLatest && message.retryable ? () => {
                      if (chat.retry(message.id)) returnToLatest();
                    } : undefined} />}
                </>;
                return <Fragment key={message.id}>
                  <article aria-label={message.role === 'user' ? 'User message' : 'Assistant reply'}>
                    {renderMessage ? renderMessage({ message, latest: isLatest, streaming: isLatest && streaming }, body) : body}
                  </article>
                  {message === latestPrompt && activity}
                </Fragment>;
              })}
              {interruption && <div tabIndex={-1} ref={review}>
                <ApprovalCard key={interruption.id} toolName={interruption.toolName} args={interruption.arguments}
                  message={interruption.message} change={change} onDecide={approved => {
                    chat.decide(approved);
                    returnToLatest();
                  }} />
              </div>}
              {!empty && hasNotice && <div className="space-y-2 text-sm text-[color:var(--color-secondary)]">
                <p role="alert">
                  {chat.historyError ?? chat.error}
                </p>
                {connection === 'disconnected' && chat.reconnect && <button type="button" className={textButton}
                  onClick={() => { void chat.reconnect?.(); }}>Reconnect to run</button>}
              </div>}
            </div>
          </div>
          {readingEarlier && !showComposer && <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <div className="pointer-events-auto">{latestButton}</div>
          </div>}
          {keepComposer && <div ref={composer} tabIndex={-1} hidden={!showComposer}
            onFocusCapture={() => { composerHadFocus.current = true; }}
            onBlurCapture={event => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) composerHadFocus.current = false;
            }}
            className={empty
              ? 'mx-auto w-full max-w-[572px] overflow-y-auto px-4 pb-12'
              : 'pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-[max(.75rem,env(safe-area-inset-bottom))]'}>
            <div className={empty ? 'mx-auto max-w-[540px]' : transcriptWidth + ' pointer-events-auto'}>
              {empty && <>
                <h2 className="mb-6 text-center text-[clamp(1.5rem,3vw,2rem)] leading-tight font-semibold tracking-[-.035em] text-balance">{emptyTitle}</h2>
                {chat.historyError && <p role="alert" className="mb-3 text-sm text-[color:var(--color-warning-ink)]">{chat.historyError}</p>}
              </>}
              {readingEarlier && showComposer && !empty && <div className="mb-2 flex justify-center">{latestButton}</div>}
              <div key={draftRevision} className={empty ? undefined : 'rounded-[1.125rem] shadow-[0_5px_20px_#25271914]'}>
                {renderComposer ? renderComposer(composerProps) : <Composer {...composerProps} />}
              </div>
              {empty && suggestions.length > 0 && <div aria-label="Suggested prompts" className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map(suggestion => <button key={suggestion} type="button" disabled={openingThreadId !== null}
                  onClick={() => send(suggestion)}
                  className="min-h-8 rounded-full bg-[var(--color-prompt-surface)] px-3 py-1.5 text-[13px] font-medium text-[color:var(--color-secondary)] hover:bg-[var(--color-wash)] disabled:opacity-50">
                  {suggestion}
                </button>)}
              </div>}
            </div>
          </div>}
        </div>
      </section>
      {inspectionTitle !== undefined && <Inspector id={inspectorId} title={inspectionTitle} mobile={mobile}
        contentKey={inspected?.id ?? ''} onClose={closeInspector}>
        {source && <SourceInspector source={source} />}
        {artifact && <ArtifactPanel artifact={artifact} />}
      </Inspector>}
    </div>
  </UiRoot>;
}
