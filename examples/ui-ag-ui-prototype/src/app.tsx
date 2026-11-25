import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import mark from '../../../site/public/favicon.svg?url';
import {
  AnswerText, ApprovalCard, ArtifactPanel, Composer, Icon, Inspector, MessageActions, ReplyArtifacts, RunActivity,
  SourceInspector, Sources, ThreadHistory, UiRoot, attachmentContextDivider, maxQuoteLength, type ThreadSummary,
} from '@mayurajs/ui';
import { listThreadHistory, useAgUiConversation, type ConversationMessage } from '@mayurajs/ui/ag-ui';
import { checklistToolId, readChecklistChange } from './change-review.js';
import { demoConversationOptions, demoTransport } from './demo-ag-ui.js';

const prompts = {
  stream: 'Draft a rollout checklist',
  dashboard: 'Show the rollout dashboard',
  approval: 'Save the rollout checklist',
} as const;

const previews = [
  { id: 'empty', label: 'Empty composer', icon: 'chat' },
  { id: 'stream', label: 'Streaming with citations', icon: 'pulse' },
  { id: 'dashboard', label: 'Rich reply', icon: 'list' },
  { id: 'approval', label: 'Paused for approval', icon: 'shield' },
] as const;
type Preview = typeof previews[number]['id'];
const suggestions = [
  { text: prompts.stream, preview: 'stream' },
  { text: prompts.dashboard, preview: 'dashboard' },
  { text: prompts.approval, preview: 'approval' },
] as const;

const sidebarBreakpoint = '(min-width: 64rem)';
const reducedMotion = '(prefers-reduced-motion: reduce)';
const themePreference = 'mayura-preview-theme';
const logoutPreference = 'mayura-preview-signed-out';
const inspectorId = 'reply-inspector';

interface Inspection {
  readonly kind: 'source' | 'artifact';
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  readonly streamedText?: string;
}

function readPreference(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  try { return window[storage].getItem(key); } catch { return null; }
}

function writePreference(storage: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  try { window[storage].setItem(key, value); } catch { /* The preview still works without browser storage. */ }
}

function replyContent(content: string) {
  const artifactIds = new Set<string>();
  let text = content.replace(/\[\[artifact:([a-z][a-z0-9-]{0,47})\]\]/gu, (_marker, id: string) => {
    artifactIds.add(id);
    return '';
  });
  const markerStart = text.lastIndexOf('[[');
  if (markerStart >= 0) {
    const suffix = text.slice(markerStart);
    if ('[[artifact:'.startsWith(suffix) || /^\[\[artifact:[a-z0-9-]{0,48}\]?$/u.test(suffix)) text = text.slice(0, markerStart);
  }
  return { text: text.trim(), artifactIds };
}

function inspectedReply(messages: readonly ConversationMessage[], selection: Inspection | null): number {
  if (!selection) return -1;
  const index = messages.findIndex(message => message.role === 'assistant' && message.id === selection.messageId);
  if (index !== -1) return index;

  // Settled AG-UI messages use a different ID. Match the same visible slot and the observed text.
  const candidate = messages[selection.position];
  return selection.streamedText && candidate?.role === 'assistant' && candidate.content.startsWith(selection.streamedText)
    ? selection.position : -1;
}

function UserMessage({ content, entering }: { content: string; entering: string }) {
  const boundary = content.indexOf(attachmentContextDivider);
  const message = boundary < 0 ? content : content.slice(0, boundary);
  const context = boundary < 0 ? '' : content.slice(boundary + attachmentContextDivider.length);
  return <div className={'ml-auto max-w-[88%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl bg-wash px-4 py-2.5 text-[15px] leading-6 text-ink' + entering}>
    <p>{message}</p>
    {context && <details className="mt-1.5 text-[13px] leading-5 text-secondary">
      <summary className="w-fit cursor-pointer rounded-sm">{context.startsWith('Quoted reply\n') ? 'Message context' : 'Attached text'}</summary>
      <p className="mt-1.5 max-h-32 overflow-auto text-muted">{context}</p>
    </details>}
  </div>;
}

export function App() {
  const conversation = useAgUiConversation(demoConversationOptions);
  const { status, threadId, openingThreadId, historyError, messages, citations, artifacts, interruption, activity, error } = conversation;
  const [preview, setPreview] = useState<Preview | null>('empty');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [dark, setDark] = useState(() => readPreference('localStorage', themePreference) === 'dark');
  const [signedOut, setSignedOut] = useState(() => readPreference('sessionStorage', logoutPreference) === 'true');
  const [narrow, setNarrow] = useState(() => !matchMedia(sidebarBreakpoint).matches);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [decision, setDecision] = useState<boolean | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [quotedReply, setQuotedReply] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<{ threads: readonly ThreadSummary[]; loading: boolean; error: string | null }>({
    threads: [], loading: true, error: null,
  });
  const [detached, setDetached] = useState(false);
  const chatBody = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const dockFrame = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const dockOrigin = useRef<number | null>(null);
  const dockAnimation = useRef<Animation | null>(null);
  const approval = useRef<HTMLDivElement>(null);
  const composerHadFocus = useRef(false);
  const showNav = useRef<HTMLButtonElement>(null);
  const hideNav = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const notificationButton = useRef<HTMLButtonElement>(null);
  const resumePreview = useRef<HTMLButtonElement>(null);
  const inspectorOpener = useRef<HTMLButtonElement | null>(null);
  const follow = useRef(true);
  const empty = status === 'idle';
  const streaming = status === 'streaming';
  const paused = status === 'paused';
  const otherPending = history.threads.find(item => item.pendingApproval && item.id !== threadId);
  const hasPending = paused || !!otherPending;
  const composerAvailable = empty || streaming || status === 'complete';
  const latest = messages.at(-1);
  const visibleMessages = messages.filter(message => message.content);
  const inspectedIndex = inspectedReply(visibleMessages, inspection);
  const selectedReply = inspectedIndex >= 0 ? replyContent(visibleMessages[inspectedIndex].content) : null;
  const source = inspection?.kind === 'source' && selectedReply?.text.includes('[' + inspection.id + ']')
    ? citations.find(item => item.id === inspection.id) : undefined;
  const artifact = inspection?.kind === 'artifact' && selectedReply?.artifactIds.has(inspection.id)
    ? artifacts.find(item => item.id === inspection.id) : undefined;
  const inspectorTitle = source?.title ?? artifact?.title;
  const latestPrompt = messages.findLast(message => message.role === 'user');
  const loadingAnswer = streaming && latest?.role !== 'assistant';
  const streamingLabel = decision !== null ? (decision ? 'Sending approval…' : 'Sending decline…')
    : loadingAnswer ? 'Thinking…' : 'Streaming response…';
  const settledReply = status === 'complete' && latest?.role === 'assistant'
    ? { id: latest.id, content: replyContent(latest.content).text.replace(/\s*\[\d+\]/gu, '') } : null;

  useEffect(() => {
    const theme = dark ? 'dark' : 'light';
    writePreference('localStorage', themePreference, theme);
  }, [dark]);

  useLayoutEffect(() => {
    if (signedOut) resumePreview.current?.focus();
  }, [signedOut]);

  useEffect(() => {
    if (signedOut || streaming) return;
    const controller = new AbortController();
    setHistory(previous => ({ ...previous, loading: true, error: null }));
    void listThreadHistory(demoTransport, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(threads => {
      if (!controller.signal.aborted) setHistory({ threads, loading: false, error: null });
    }).catch(() => {
      if (!controller.signal.aborted) setHistory(previous => ({ ...previous, loading: false, error: 'Thread history is unavailable.' }));
    });
    return () => controller.abort();
  }, [signedOut, streaming, status, threadId, historyRevision]);

  useEffect(() => {
    if (!inspection || inspectorTitle !== undefined) return;
    // A state delta or the final answer can withdraw an item. Close with the latest AG-UI state.
    const opener = inspectorOpener.current;
    inspectorOpener.current = null;
    setInspection(null);
    if (document.activeElement === document.body) (opener?.isConnected ? opener : area.current)?.focus();
  }, [inspection, inspectorTitle]);

  useEffect(() => {
    if (!notificationsOpen) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !toolbar.current?.contains(event.target)) setNotificationsOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [notificationsOpen]);

  useLayoutEffect(() => {
    const element = dock.current;
    const from = dockOrigin.current;
    dockOrigin.current = null;
    dockAnimation.current?.cancel();
    if (!element || from === null || !element.getClientRects().length || matchMedia(reducedMotion).matches) return;
    const distance = from - element.getBoundingClientRect().top;
    if (Math.abs(distance) < 2) return;
    // The composer keeps its DOM, focus, and draft while the layout underneath it changes.
    dockAnimation.current = element.animate([
      { transform: 'translateY(' + distance + 'px)' },
      { transform: 'translateY(0)' },
    ], { duration: 285, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
  }, [empty]);

  useLayoutEffect(() => {
    const body = chatBody.current;
    const frame = dockFrame.current;
    const viewport = area.current;
    if (empty || !composerAvailable || !body || !frame || !viewport) return;
    const reserveRoom = () => {
      body.style.setProperty('--composer-height', frame.offsetHeight + 'px');
      if (follow.current) viewport.scrollTop = viewport.scrollHeight;
    };
    reserveRoom();
    // Text, attachments, and voice controls can all change the floating composer’s height.
    const observer = new ResizeObserver(reserveRoom);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      body.style.removeProperty('--composer-height');
    };
  }, [composerAvailable, empty]);

  useEffect(() => {
    if (area.current && follow.current) area.current.scrollTop = area.current.scrollHeight;
  }, [latest?.content, status, messages.length]);

  useEffect(() => {
    const wide = matchMedia(sidebarBreakpoint);
    const resize = () => {
      setNarrow(!wide.matches);
      if (wide.matches) setNavigationOpen(false);
    };
    wide.addEventListener('change', resize);
    return () => wide.removeEventListener('change', resize);
  }, []);

  useLayoutEffect(() => {
    if (navigationOpen) hideNav.current?.focus();
  }, [navigationOpen]);

  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (paused && composerHadFocus.current && (focused === document.body || dock.current?.contains(focused))) {
      approval.current?.focus({ preventScroll: true });
    }
  }, [paused]);

  const closeNavigation = () => {
    setNotificationsOpen(false);
    setNavigationOpen(false);
    requestAnimationFrame(() => showNav.current?.focus());
  };

  const prepareForRun = () => {
    if (empty) dockOrigin.current = dock.current?.getBoundingClientRect().top ?? null;
    follow.current = true;
    setDetached(false);
    setDecision(null);
    setPreview(null);
  };
  const send = (text: string) => {
    if (!conversation.send(text)) return false;
    prepareForRun();
    return true;
  };
  const resetView = () => {
    follow.current = true;
    setDetached(false);
    setDecision(null);
    setDraftVersion(previous => previous + 1);
    setQuotedReply(null);
    inspectorOpener.current = null;
    setInspection(null);
    setNotificationsOpen(false);
  };
  const openPreview = (next: Preview) => {
    if (next === 'empty' && !empty && composerAvailable) dockOrigin.current = dock.current?.getBoundingClientRect().top ?? null;
    conversation.reset();
    resetView();
    if (navigationOpen) closeNavigation();
    if (next !== 'empty') send(prompts[next]);
    setPreview(next);
  };
  const openHistoryThread = async (id: string) => {
    if (streaming) return;
    if (id === threadId && status !== 'error') {
      setNotificationsOpen(false);
      setNavigationOpen(false);
      requestAnimationFrame(() => (approval.current ?? area.current)?.focus({ preventScroll: true }));
      return;
    }
    if (!await conversation.openThread(id)) return;
    resetView();
    setPreview(null);
    setNavigationOpen(false);
    requestAnimationFrame(() => (approval.current ?? area.current)?.focus({ preventScroll: true }));
  };
  const quoteReply = (value: string) => {
    const excerpt = value.trim();
    setQuotedReply(excerpt.length > maxQuoteLength ? excerpt.slice(0, maxQuoteLength - 1) + '…' : excerpt);
    requestAnimationFrame(() => dock.current?.querySelector<HTMLTextAreaElement>('.rich-composer-input')?.focus());
  };
  const closeInspector = () => {
    const opener = inspectorOpener.current;
    const replacement = area.current?.querySelector<HTMLButtonElement>('button[aria-controls="' + inspectorId + '"][aria-expanded="true"]');
    inspectorOpener.current = null;
    setInspection(null);
    requestAnimationFrame(() => {
      if (inspectorOpener.current) return;
      const target = opener?.isConnected ? opener : replacement?.isConnected ? replacement : area.current;
      target?.focus({ preventScroll: true });
    });
  };
  const openInspector = (kind: Inspection['kind'], position: number, id: string, opener: HTMLButtonElement) => {
    if (inspectedIndex === position && inspection?.kind === kind && inspection.id === id) {
      closeInspector();
      return;
    }
    const message = visibleMessages[position];
    inspectorOpener.current = opener;
    setInspection({ kind, id, messageId: message.id, position,
      ...(streaming && latest?.id === message.id ? { streamedText: message.content } : {}) });
  };

  const decide = (accepted: boolean) => {
    if (!paused || openingThreadId) return;
    setDecision(accepted);
    conversation.decide(accepted);
    area.current?.focus({ preventScroll: true });
  };
  const reviewApproval = () => {
    setNotificationsOpen(false);
    setNavigationOpen(false);
    requestAnimationFrame(() => approval.current?.focus());
  };
  const logOut = () => {
    openPreview('empty');
    writePreference('sessionStorage', logoutPreference, 'true');
    setSignedOut(true);
  };
  const continuePreview = () => {
    writePreference('sessionStorage', logoutPreference, 'false');
    setSignedOut(false);
    requestAnimationFrame(() => dock.current?.querySelector('textarea')?.focus());
  };
  const jumpToLatest = () => {
    const viewport = area.current;
    if (!viewport) return;
    follow.current = true;
    setDetached(false);
    viewport.focus({ preventScroll: true });
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: streaming || matchMedia(reducedMotion).matches ? 'instant' : 'smooth' });
  };
  const theme = dark ? 'dark' : 'light';
  if (signedOut) return <UiRoot theme={theme}><main className="grid min-h-dvh place-items-center px-5 text-center">
    <div>
      <img src={mark} alt="" className="mx-auto mb-4 size-8" />
      <h1 className="text-xl font-medium tracking-tight">Logged out of the preview</h1>
      <button ref={resumePreview} type="button" onClick={continuePreview}
        className="session-continue motion-button mt-5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep">Continue to preview</button>
    </div>
  </main></UiRoot>;
  return <UiRoot theme={theme}><div className="app-shell isolate">
    <button type="button" aria-label="Close navigation" aria-hidden={!navigationOpen} inert={!navigationOpen}
      data-open={navigationOpen} tabIndex={-1} onClick={closeNavigation} className="navigation-scrim" />
    <aside id="preview-navigation" aria-label="Prototype navigation" inert={narrow && !navigationOpen} data-open={navigationOpen}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        if (notificationsOpen) {
          setNotificationsOpen(false);
          notificationButton.current?.focus();
        } else if (navigationOpen) closeNavigation();
      }}
      className="side-panel">
      <div className="flex items-center gap-2.5 px-2.5">
        <img alt="" src={mark} className="size-6" />
        <span className="text-[18px] font-semibold tracking-[-0.035em]">Mayura</span>
        <button ref={hideNav} type="button" aria-label="Close preview navigation" onClick={closeNavigation}
          className="ml-auto rounded-lg p-2 text-muted hover:bg-wash lg:hidden"><Icon name="close" /></button>
      </div>
      <button type="button" onClick={() => openPreview('empty')}
        className="motion-button mt-9 flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm font-semibold text-accent-deep hover:bg-nav-active">
        <Icon name="plus" size={17} /> New chat
      </button>
      <nav aria-label="Preview states" className="mt-9">
        <h2 className="mb-2 px-2.5 text-[11px] font-medium text-muted">Preview states</h2>
        <div className="space-y-0.5">
          {previews.map(item => <button type="button" key={item.id} aria-current={preview === item.id ? 'true' : undefined}
            onClick={() => openPreview(item.id)}
            className="motion-button flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-secondary hover:bg-nav-active aria-[current=true]:bg-nav-active aria-[current=true]:font-semibold aria-[current=true]:text-ink">
            <Icon name={item.icon} size={17} /> {item.label}
          </button>)}
        </div>
      </nav>
      <ThreadHistory threads={history.threads} activeId={openingThreadId ?? threadId} locked={streaming}
        loading={history.loading || openingThreadId !== null} error={historyError ?? history.error}
        onRefresh={() => {
          conversation.clearHistoryError();
          setHistoryRevision(value => value + 1);
        }} onOpen={id => { void openHistoryThread(id); }} />
      <div ref={toolbar} role="group" aria-label="Workspace controls" className="workspace-controls relative mt-2 flex shrink-0 items-center gap-1.5 px-1.5">
        {notificationsOpen && <section id="workspace-notifications" aria-label="Notifications"
          className="notification-panel absolute inset-x-0 bottom-full z-20 mb-2.5 rounded-xl bg-paper px-3.5 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {paused && interruption ? <>
            <p className="mt-2 text-sm text-secondary">Approval required</p>
            <button type="button" className="mt-1 rounded px-0.5 py-1 text-sm font-medium text-accent underline-offset-3 hover:underline"
              onClick={reviewApproval}>Review request</button>
          </> : otherPending ? <>
            <p className="mt-2 text-sm text-secondary">Approval required</p>
            <button type="button" disabled={streaming} className="mt-1 block max-w-full truncate rounded px-0.5 py-1 text-left text-sm font-medium text-accent underline-offset-3 hover:underline"
              onClick={() => { void openHistoryThread(otherPending.id); }}>{otherPending.title}</button>
          </> : <p className="mt-1.5 text-xs leading-5 text-muted">You’re all caught up.</p>}
        </section>}
        <button ref={notificationButton} type="button" className="workspace-control motion-button" aria-label="Notifications" title="Notifications"
          aria-expanded={notificationsOpen} aria-controls={notificationsOpen ? 'workspace-notifications' : undefined}
          aria-describedby={hasPending ? 'pending-notification' : undefined} onClick={() => setNotificationsOpen(open => !open)}>
          <Icon name="bell" size={17} />
          {hasPending && <><span aria-hidden="true" className="notification-dot" /><span id="pending-notification" className="sr-only">Pending approvals</span></>}
        </button>
        <button type="button" className="workspace-control motion-button" aria-label="Dark mode" aria-pressed={dark}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setDark(value => !value)}>
          <Icon name={dark ? 'sun' : 'moon'} size={17} />
        </button>
        <button type="button" className="workspace-control motion-button" aria-label="Log out" title="Log out of the local preview" onClick={logOut}>
          <Icon name="logout" size={17} />
        </button>
      </div>
    </aside>

    <main className="chat-main" inert={navigationOpen}
      onFocusCapture={event => { composerHadFocus.current = dock.current?.contains(event.target) === true; }}>
      <header className="flex min-h-15 shrink-0 items-center gap-2 px-4 sm:px-8 lg:sr-only">
        <button ref={showNav} type="button" aria-label="Open preview navigation" aria-expanded={navigationOpen} aria-controls="preview-navigation"
          onClick={() => setNavigationOpen(true)} className="-ml-1 grid size-10 place-items-center rounded-lg text-secondary hover:bg-wash lg:hidden"><Icon name="panel" /></button>
        <h1 className="text-sm font-semibold tracking-tight">Agent chat</h1>
      </header>

      <div ref={chatBody} className="chat-body" data-empty={empty} data-composer={composerAvailable}>
        {empty && <div className="welcome-ambient" aria-hidden="true" />}
        {empty ? <section className="welcome-intro chat-column mb-6 text-center sm:mb-7">
          <h2 className="text-balance text-[28px] leading-tight font-medium tracking-[-0.035em] sm:text-[36px]">What are we working on?</h2>
        </section> : <div className="transcript-stage">
          <div ref={area} tabIndex={0} role="region" aria-label="Conversation transcript" className="transcript min-h-0 flex-1 overflow-y-auto"
            onScroll={event => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
              setDetached(!follow.current);
            }}>
            <section aria-label="Conversation" className="transcript-content chat-column flex flex-col gap-9 sm:gap-10">
              {visibleMessages.flatMap((message, position) => {
                const entering = streaming && latest?.id === message.id ? ' transcript-enter' : '';
                if (message.role === 'user') {
                  const prompt = <UserMessage key={message.id} content={message.content} entering={entering} />;
                  if (!activity || message.id !== latestPrompt?.id) return [prompt];
                  return [prompt, <div key={activity.id + ':activity'} className="transcript-enter -mt-3 -mb-5 sm:-mb-6">
                    <RunActivity items={activity.items} status={status} streamingLabel={streamingLabel}
                      thinking={loadingAnswer && decision === null} />
                  </div>];
                }
                const reply = replyContent(message.content);
                const sources = citations.filter(source => reply.text.includes('[' + source.id + ']'));
                const embeds = artifacts.filter(item => reply.artifactIds.has(item.id));
                const sourceControls = { citations: sources, active: inspectedIndex === position ? source?.id ?? null : null,
                  panelId: inspectorId, mobile: narrow,
                  onOpen: (id: string, opener: HTMLButtonElement) => openInspector('source', position, id, opener) };
                return [<article key={message.id} className={'min-w-0' + entering}>
                  <h2 className="mb-3 text-[13px] font-semibold text-secondary">Mayura</h2>
                  <AnswerText content={reply.text} {...sourceControls} />
                  {embeds.length > 0 && <ReplyArtifacts items={embeds} panelId={inspectorId} mobile={narrow}
                    active={inspectedIndex === position ? artifact?.id ?? null : null}
                    onOpen={(id, opener) => openInspector('artifact', position, id, opener)} />}
                  {sources.length > 0 && <Sources {...sourceControls} />}
                  {threadId && reply.text && !(streaming && latest?.id === message.id) && <MessageActions
                    content={reply.text} feedbackKey={threadId + ':' + message.id}
                    onQuote={composerAvailable && !openingThreadId ? () => quoteReply(reply.text) : undefined}
                    onRetry={status === 'complete' && !openingThreadId && latest?.id === message.id && message.retryable
                      ? () => { if (conversation.retry(message.id)) prepareForRun(); } : undefined} />}
                </article>];
              })}
              {interruption && paused && <div ref={approval} tabIndex={-1} inert={openingThreadId !== null} className="rounded-2xl">
                <ApprovalCard key={interruption.id} message={interruption.toolName === checklistToolId
                    ? 'Mayura is asking to save the rollout checklist to the Release workspace.' : interruption.message}
                  toolName={interruption.toolName} args={interruption.arguments} onDecide={decide}
                  {...(interruption.toolName === checklistToolId ? { change: readChecklistChange(interruption.arguments) } : {})} />
              </div>}
              {status === 'stopped' && !error && <p role="status" className="text-sm font-medium text-secondary">Response stopped. Start a new chat to continue.</p>}
              {error && <div role="alert" className="rounded-xl bg-warning px-4 py-3 text-sm text-warning-ink">
                <p>{error}</p>
                <button type="button" className="mt-2 font-semibold underline underline-offset-4" onClick={() => openPreview('empty')}>Start a new chat</button>
              </div>}
            </section>
          </div>
          {detached && <button type="button" onClick={jumpToLatest} className="jump-latest motion-button">
            <span className="rotate-180"><Icon name="arrow" size={15} /></span> Jump to latest
          </button>}
        </div>}
        <div ref={dockFrame} hidden={!composerAvailable} className="composer-dock chat-column">
          <div ref={dock} className="composer-position">
            <Composer key={draftVersion} onSend={send} onStop={conversation.stop} streaming={streaming}
              disabled={!composerAvailable || openingThreadId !== null} assistantReply={settledReply}
              quotedReply={quotedReply} onQuoteChange={setQuotedReply} />
          </div>
        </div>
        {empty && <div className="suggested-prompts chat-column mt-4 flex flex-wrap justify-center gap-2" aria-label="Suggested prompts">
          {suggestions.map(({ text, preview: next }) => <button type="button" key={text}
            onClick={() => { if (send(text)) setPreview(next); }}
            className="suggestion motion-button inline-flex min-h-8 items-center rounded-full px-3 py-1.5 text-[12px] font-medium leading-4 text-secondary">
            {text}
          </button>)}
        </div>}
      </div>
    </main>
    {inspectorTitle !== undefined && inspection && <Inspector id={inspectorId} title={inspectorTitle} mobile={narrow}
      contentKey={inspection.messageId + ':' + inspection.kind + ':' + inspection.id} onClose={closeInspector}>
      {source && <SourceInspector source={source} />}
      {artifact && <ArtifactPanel key={artifact.id} artifact={artifact} />}
    </Inspector>}
  </div></UiRoot>;
}
