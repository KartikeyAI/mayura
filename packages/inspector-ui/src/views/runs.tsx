import * as React from 'react';
import { Ban, Search } from 'lucide-react';
import type { ClientEvent, RemoteSnapshot } from '@mayura/client';
import { errorText, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/primitives';
import { ConfirmAction, Empty, ErrorAlert, Mono, PageHeader, StatusBadge } from '@/components/common';

const runPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function Runs() {
  const { client } = useSession();
  const [input, setInput] = React.useState(''); const [runId, setRunId] = React.useState<string>();
  const [snapshot, setSnapshot] = React.useState<RemoteSnapshot>(); const [events, setEvents] = React.useState<ClientEvent[]>([]);
  const [error, setError] = React.useState<string>(); const [live, setLive] = React.useState(false);
  React.useEffect(() => {
    if (!runId) return;
    const controller = new AbortController(); const run = client.run(runId);
    setSnapshot(undefined); setEvents([]); setError(undefined); setLive(true);
    (async () => {
      try {
        setSnapshot(await run.inspect({ signal: controller.signal }));
        for await (const event of run.events({ signal: controller.signal })) setEvents(previous => [...previous.slice(-499), event]);
        setSnapshot(await run.inspect({ signal: controller.signal }));
      } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)); } finally { if (!controller.signal.aborted) setLive(false); }
    })();
    return () => controller.abort();
  }, [client, runId]);
  const terminal = snapshot ? snapshot.status !== 'running' : true;
  return (
    <div className="space-y-6">
      <PageHeader title="Agent runs" description="Inspect an ephemeral agent run and follow its metadata event stream live." />
      <Card><CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (runPattern.test(input.trim())) setRunId(input.trim()); else setError('Enter a run id (UUID).'); }}>
          <div className="min-w-80 flex-1 space-y-2"><Label htmlFor="run-id">Run id</Label><Input id="run-id" value={input} onChange={event => setInput(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" /></div>
          <Button type="submit"><Search />Inspect</Button>
        </form>
      </CardContent></Card>
      <ErrorAlert error={error} />
      {snapshot && runId ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card><CardHeader><CardTitle className="flex items-center gap-2">Run <StatusBadge status={snapshot.status} /></CardTitle><CardDescription><Mono>{runId}</Mono></CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div><dt className="text-muted-foreground">Spent</dt><dd className="font-medium">{String(snapshot.budget.spentMicros)} µ</dd></div>
                <div><dt className="text-muted-foreground">Reserved</dt><dd className="font-medium">{snapshot.budget.reservedMicros} µ</dd></div>
                <div><dt className="text-muted-foreground">Calls</dt><dd className="font-medium">{snapshot.budget.calls}</dd></div>
              </dl>
              <p className="text-muted-foreground text-xs">{snapshot.evidence.length} tool receipt(s) · {live ? 'following live' : 'stream ended'}</p>
              <ConfirmAction label="Cancel run" icon={<Ban />} destructive disabled={terminal} title="Cancel this run?" confirm="Cancel run"
                description={<p>The run and its children stop admitting work. Effects already started keep their truthful outcome.</p>}
                onConfirm={() => client.run(runId).cancel()} />
            </CardContent></Card>
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Events</CardTitle><CardDescription>Content-free metadata only.</CardDescription></CardHeader><CardContent>
            {events.length === 0 ? <Empty>No events yet.</Empty> : (
              <Table><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Type</TableHead><TableHead>Metadata</TableHead></TableRow></TableHeader>
                <TableBody>{events.map(event => <TableRow key={event.sequence}><TableCell>{event.sequence}</TableCell><TableCell><Mono>{event.type}</Mono></TableCell>
                  <TableCell className="text-muted-foreground max-w-lg truncate text-xs">{Object.entries(event.metadata).map(([key, value]) => `${key}=${String(value)}`).join('  ')}</TableCell></TableRow>)}</TableBody></Table>)}
          </CardContent></Card>
        </div>
      ) : null}
    </div>
  );
}
