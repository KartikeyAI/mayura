import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BookOpen, Bot, LoaderCircle, LogOut, NotebookPen, Package, Send, ShieldCheck, Truck, Undo2, User, type LucideIcon } from 'lucide-react';
import { ClientError } from '@mayura/client';
import { createHeadlessRunStore, createRunActivityProjection, type HeadlessRunStore, type RunActivityItem } from '@mayura/client/headless';
import { useMayuraRun, useMayuraRunActivity } from '@mayura/client-react';
import { Button } from '@/components/ui/button';
import { Badge, Textarea } from '@/components/ui/primitives';
import { assistantId, replySchema, supportClient, toolLabels, type Session, type Turn } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ToolChip { readonly id: string; readonly toolId: string; readonly status: RunActivityItem['status'] }
interface Message {
  readonly id: string;
  readonly role: 'customer' | 'assistant';
  readonly text: string;
  readonly state: 'pending' | 'done' | 'error';
  readonly tools: readonly ToolChip[];
}

const icons: Readonly<Record<string, LucideIcon>> = { 'orders.list': Package, 'orders.track': Truck, 'returns.start': Undo2,
  'memory.remember': NotebookPen, 'memory.recall': BookOpen };
const suggestions = ['Where is my order?', 'I want to return my last delivery', 'Remember that I prefer weekend deliveries', 'What do you remember about me?'];

/** Tool calls from the run's content-free event stream: which tool ran and how it ended, never its data. */
function chips(items: readonly RunActivityItem[]): ToolChip[] {
  return items.filter(item => item.kind === 'tool').map(item => ({ id: item.id, toolId: item.label, status: item.status }));
}
/** The conversation the model sees: the last 20 finished turns, each within the API's bounds. */
function historyOf(messages: readonly Message[]): Turn[] {
  return messages.filter(message => message.state === 'done' && message.text.length > 0).slice(-20).map(message => ({ role: message.role, text: message.text.slice(0, 4_000) }));
}
function failureText(status: string): string {
  if (status === 'blocked') return 'That reply was withheld by a safety check. Please rephrase your question.';
  if (status === 'outcome_unknown') return 'I could not confirm whether that action completed. Please check before asking again.';
  return 'Sorry, something went wrong. Please try again.';
}

function ToolChips({ tools }: { readonly tools: readonly ToolChip[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map(tool => {
        const Icon = icons[tool.toolId] ?? Bot; const active = tool.status === 'active';
        return (
          <Badge key={tool.id} variant={tool.status === 'completed' ? 'success' : active ? 'secondary' : 'warning'}>
            {active ? <LoaderCircle className="animate-spin" /> : <Icon />}
            {toolLabels[tool.toolId] ?? tool.toolId}
          </Badge>
        );
      })}
    </div>
  );
}

/** Live tool activity for the run in flight, straight from the headless store as events stream in. */
function LiveActivity({ store }: { readonly store: HeadlessRunStore }) {
  const activity = useMayuraRunActivity(useMayuraRun(store));
  return <ToolChips tools={chips(activity.items)} />;
}

/** The reply as it streams in; provisional until the run completes and the validated reply replaces it. */
function LiveReply({ store }: { readonly store: HeadlessRunStore }) {
  const streamed = useMayuraRun(store).streamedOutput;
  if (!streamed?.text) return <div className="text-muted-foreground flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" /> Working on it…</div>;
  return <div className="bg-muted rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">{streamed.text}<span className="bg-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" /></div>;
}

function Bubble({ message, live }: { readonly message: Message; readonly live: HeadlessRunStore | null }) {
  const customer = message.role === 'customer';
  return (
    <div className={cn('flex gap-3', customer && 'flex-row-reverse')}>
      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full border', customer ? 'bg-primary text-primary-foreground' : 'bg-card')}>
        {customer ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>
      <div className={cn('flex max-w-[80%] flex-col gap-2', customer && 'items-end')}>
        {!customer && (live ? <LiveActivity store={live} /> : <ToolChips tools={message.tools} />)}
        {message.state === 'pending'
          ? (live ? <LiveReply store={live} /> : <div className="text-muted-foreground flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" /> Working on it…</div>)
          : <div className={cn('rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap', customer ? 'bg-primary text-primary-foreground' : 'bg-muted',
              message.state === 'error' && 'bg-destructive/10 text-destructive')}>{message.text}</div>}
      </div>
    </div>
  );
}

export function Chat({ session, onSignOut }: { readonly session: Session; readonly onSignOut: () => void }) {
  const client = useMemo(() => supportClient(session), [session]);
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<{ readonly messageId: string; readonly store: HeadlessRunStore } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages, live]);
  const busy = live !== null || messages.some(message => message.state === 'pending');

  const update = (id: string, change: Partial<Message>) => setMessages(current => current.map(message => message.id === id ? { ...message, ...change } : message));

  async function send(text: string): Promise<void> {
    const message = text.trim().slice(0, 2_000);
    if (!message || busy) return;
    const history = historyOf(messages); const replyId = crypto.randomUUID();
    setDraft('');
    setMessages(current => [...current, { id: crypto.randomUUID(), role: 'customer', text: message, state: 'done', tools: [] },
      { id: replyId, role: 'assistant', text: '', state: 'pending', tools: [] }]);
    let store: HeadlessRunStore | undefined;
    try {
      // A fresh idempotency key per message: a retried request would find this run instead of starting a second one.
      const run = await client.submit(assistantId, { message, history }, { idempotencyKey: crypto.randomUUID() });
      store = createHeadlessRunStore({ run });
      setLive({ messageId: replyId, store });
      // Stream the run's events (tool activity) until it settles, then read the result.
      await store.observe().catch(() => undefined);
      const outcome = await run.result(replySchema);
      const tools = chips(createRunActivityProjection(store.getSnapshot()).items);
      if (outcome?.status === 'succeeded') update(replyId, { text: outcome.output.reply, state: 'done', tools });
      else update(replyId, { text: failureText(outcome?.status ?? 'failed'), state: 'error', tools });
    } catch (error) {
      const expired = error instanceof ClientError && error.status === 401;
      update(replyId, { text: expired ? 'Your session has expired. Please sign in again.' : failureText('failed'), state: 'error' });
      if (expired) onSignOut();
    } finally {
      store?.dispose(); setLive(null);
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(draft); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(draft); }
  };

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h1 className="font-semibold">Store support</h1>
          <p className="text-muted-foreground text-xs">Signed in as {session.name} · {session.customerId}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut /> Sign out</Button>
      </header>
      <main className="flex-1 space-y-5 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center gap-4 py-12 text-center text-sm">
            <Bot className="size-10" />
            <p>Hi {session.name.split(' ')[0]}! I can track your orders, open a return and remember your preferences.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map(suggestion => <Button key={suggestion} variant="outline" size="sm" onClick={() => void send(suggestion)}>{suggestion}</Button>)}
            </div>
          </div>
        )}
        {messages.map(message => <Bubble key={message.id} message={message} live={live?.messageId === message.id ? live.store : null} />)}
        <div ref={end} />
      </main>
      <form onSubmit={submit} className="flex items-end gap-2 border-t px-4 py-3">
        <Textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKey} maxLength={2_000} rows={1}
          placeholder="Ask about an order, a return…" aria-label="Message" disabled={busy} />
        <Button type="submit" size="icon" disabled={busy || draft.trim().length === 0} aria-label="Send"><Send /></Button>
      </form>
      <p className="text-muted-foreground flex items-center justify-center gap-1.5 pb-3 text-xs">
        <ShieldCheck className="size-3.5" /> Card numbers, emails and phone numbers are removed before the assistant sees them.
      </p>
    </div>
  );
}
