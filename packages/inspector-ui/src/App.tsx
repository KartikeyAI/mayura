import * as React from 'react';
import { Activity, GitBranch, KeyRound, LayoutDashboard, LogOut, MessageSquare, Moon, PauseCircle, Shuffle, Sun, Workflow } from 'lucide-react';
import { createClient, type RemoteSession } from '@mayura/client';
import { SessionProvider, errorText, useSession, type Session } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Separator } from '@/components/ui/primitives';
import { ErrorAlert } from '@/components/common';
import { Overview } from '@/views/overview';
import { Workflows } from '@/views/workflows';
import { Humans } from '@/views/humans';
import { Fleet } from '@/views/fleet';
import { Runs } from '@/views/runs';
import { Migrations } from '@/views/migrations';

/** Each view is listed only when the token may use it and the server offers what it needs. */
const views = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, render: () => <Overview />,
    usable: (session: Session) => session.can('operations:read') || session.can('runs:read') || (session.can('workflows:read') && session.offers('workflowFleet')) },
  { id: 'workflows', label: 'Workflows', icon: Workflow, render: () => <Workflows />, usable: (session: Session) => session.can('workflows:read') && session.offers('workflowIndex') },
  { id: 'humans', label: 'Human requests', icon: MessageSquare, render: () => <Humans />, usable: (session: Session) => session.can('humans:read') && session.offers('humanRequests') },
  { id: 'fleet', label: 'Fleet control', icon: PauseCircle, render: () => <Fleet />, usable: (session: Session) => session.can('workflows:read') && session.offers('workflowFleet') },
  { id: 'migrations', label: 'Migrations', icon: Shuffle, render: () => <Migrations />,
    usable: (session: Session) => session.can('workflows:read') && session.offers('workflowIndex') && session.offers('workflowMigrations') },
  { id: 'runs', label: 'Agent runs', icon: Activity, render: () => <Runs />, usable: (session: Session) => session.can('runs:read') },
] as const;
type ViewId = typeof views[number]['id'];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = React.useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  React.useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  return [dark, () => setDark(value => !value)];
}

export function App() {
  const [connected, setConnected] = React.useState<{ token: string; info: RemoteSession }>();
  const forget = React.useCallback(() => setConnected(undefined), []);
  const [dark, toggle] = useTheme();
  if (!connected) return <Connect onConnect={(token, info) => setConnected({ token, info })} dark={dark} toggle={toggle} />;
  return <SessionProvider token={connected.token} info={connected.info} onForget={forget}><Shell dark={dark} toggle={toggle} /></SessionProvider>;
}

function Connect({ onConnect, dark, toggle }: { onConnect: (token: string, info: RemoteSession) => void; dark: boolean; toggle: () => void }) {
  const [value, setValue] = React.useState(''); const [error, setError] = React.useState<string>(); const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); const token = value.trim(); if (!token) return;
    setBusy(true); setError(undefined);
    // The session read needs no capability, so any accepted token connects and sees only what it may use.
    try { const info = await createClient({ baseUrl: window.location.origin, token: () => token }).session(); setValue(''); onConnect(token, info); }
    catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Button variant="ghost" size="icon" className="absolute top-4 right-4" onClick={toggle} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
      <Card className="w-full max-w-md">
        <CardHeader><div className="bg-primary text-primary-foreground mb-2 flex size-10 items-center justify-center rounded-lg"><GitBranch className="size-5" /></div>
          <CardTitle className="text-xl">Mayura console</CardTitle>
          <CardDescription>Paste an access token. It stays in this page's memory only and is never stored.</CardDescription></CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} autoComplete="off">
            <div className="space-y-2"><Label htmlFor="token">Access token</Label>
              <Input id="token" type="password" value={value} onChange={event => setValue(event.target.value)} autoFocus required /></div>
            <ErrorAlert error={error} title="Could not connect" />
            <Button type="submit" className="w-full" disabled={busy}><KeyRound />{busy ? 'Connecting…' : 'Connect'}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Shell({ dark, toggle }: { dark: boolean; toggle: () => void }) {
  const session = useSession(); const { forget, info } = session;
  const usable = views.filter(item => item.usable(session));
  const [view, setView] = React.useState<ViewId | undefined>(() => usable[0]?.id);
  const main = React.useRef<HTMLElement>(null);
  const current = usable.find(item => item.id === view);
  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 px-4 font-semibold"><div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md"><GitBranch className="size-4" /></div>Mayura</div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 p-2" aria-label="Sections">
          {usable.map(item => (
            <button key={item.id} type="button" onClick={() => { setView(item.id); main.current?.focus(); }} aria-current={item.id === view ? 'page' : undefined}
              className={cn('hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors', item.id === view && 'bg-accent font-medium')}>
              <item.icon className="size-4" />{item.label}</button>))}
        </nav>
        <Separator />
        <p className="text-muted-foreground truncate px-4 pt-2 text-xs" title={info.capabilities.join(', ')}>{info.scope.principalId} · {info.scope.projectId}</p>
        <div className="flex items-center gap-1 p-2">
          <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={forget}><LogOut />Forget token</Button>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <select className="bg-background rounded-md border px-2 py-1 text-sm" value={view ?? ''} onChange={event => setView(event.target.value as ViewId)} aria-label="Section">
            {usable.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={forget}><LogOut />Forget</Button>
        </header>
        <main ref={main} tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 p-4 outline-none md:p-8">{current ? current.render() : (
          <Card className="mx-auto max-w-lg"><CardHeader><CardTitle>Nothing to show for this token</CardTitle>
            <CardDescription>The token is valid, but its capabilities ({info.capabilities.join(', ') || 'none'}) do not match any view this server offers.</CardDescription></CardHeader></Card>)}</main>
      </div>
    </div>
  );
}
