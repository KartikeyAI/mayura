import * as React from 'react';
import { ArrowRight, CheckCircle2, Loader2, RefreshCw, ShieldAlert, Shuffle } from 'lucide-react';
import { ClientError, type WorkflowMigrationOffer, type WorkflowMigrationPlan } from '@mayura/client';
import type { WorkflowViewInput } from '@mayura/client/workflows';
import { commandId, errorText, useLoad, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import {
  Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, ErrorAlert, Mono, PageHeader, StatusBadge, short } from '@/components/common';

const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const actionTone: Record<WorkflowMigrationPlan['entries'][number]['action'], 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'> = {
  keep: 'outline', update: 'secondary', reset: 'warning', accept: 'warning', add: 'success', remove: 'destructive',
};
const actionMeaning: Record<WorkflowMigrationPlan['entries'][number]['action'], string> = {
  keep: 'Unchanged; state carried over.',
  update: 'Changed, never started; runs under the new definition.',
  reset: 'Was waiting on a decision; the request is re-issued.',
  accept: 'Changed after it settled; the reviewer accepts the existing result.',
  add: 'New step; starts pending.',
  remove: 'Dropped by the new definition.',
};
/** A migrations endpoint that is not configured answers 404; that is a setup state, not an error. */
const notConfigured = (error: unknown): boolean => error instanceof ClientError && error.status === 404;

/** Review one migration against one run and apply it at the run's exact revision. */
function ReviewDialog({ run, offer, open, onOpenChange, onMigrated }: {
  run: { readonly runId: string; readonly revision: number; readonly status: string }; offer: WorkflowMigrationOffer; open: boolean;
  onOpenChange: (open: boolean) => void; onMigrated: () => void;
}) {
  const { client, can } = useSession();
  const [generation, setGeneration] = React.useState(0);
  const [plan, setPlan] = React.useState<WorkflowMigrationPlan>(); const [error, setError] = React.useState<string>();
  const [applying, setApplying] = React.useState(false); const [applied, setApplied] = React.useState(false);
  React.useEffect(() => {
    if (!open) return; const controller = new AbortController(); setPlan(undefined); setError(undefined); setApplied(false);
    client.planWorkflowMigration(run.runId, offer.id, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPlan(value); }, failure => { if (!controller.signal.aborted) setError(errorText(failure)); });
    return () => controller.abort();
  }, [open, generation, client, run.runId, offer.id]);
  const apply = async () => {
    setApplying(true); setError(undefined);
    try { await client.migrateWorkflow(run.runId, offer.id, run.revision, { commandId: commandId() }); setApplied(true); onMigrated(); }
    catch (failure) {
      // 409: the run changed or storage refused; show the fresh plan so the reviewer sees why.
      setError(failure instanceof ClientError && failure.status === 409 ? 'The run changed or the migration was refused. The plan below is current.' : errorText(failure));
      setGeneration(value => value + 1);
    } finally { setApplying(false); }
  };
  const paused = run.status === 'paused';
  return (
    <Dialog open={open} onOpenChange={value => { if (!applying) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Shuffle className="size-4" />{offer.id}</DialogTitle>
          <DialogDescription>
            Version {offer.fromVersion} <ArrowRight className="inline size-3" /> {offer.toVersion} for run <Mono title={run.runId}>{short(run.runId)}</Mono> at revision {run.revision}.
            {offer.description ? <span className="mt-1 block">{offer.description}</span> : null}
          </DialogDescription>
        </DialogHeader>
        {applied ? (
          <Alert><CheckCircle2 /><AlertTitle>Migrated</AlertTitle>
            <AlertDescription>The run now uses version {offer.toVersion} and is still paused. Review it, then resume it from the run page.</AlertDescription></Alert>
        ) : (<>
          <ErrorAlert error={error} title="Migration not applied" />
          {!plan && !error ? <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div> : null}
          {plan ? (<>
            {plan.blockers.length ? (
              <Alert variant="destructive"><ShieldAlert /><AlertTitle>Blocked</AlertTitle>
                <AlertDescription><ul className="list-disc space-y-1 pl-4">{plan.blockers.map(blocker => (
                  <li key={`${blocker.node}:${blocker.reason}`}>{blocker.node === '*' ? null : <Mono>{blocker.node}</Mono>} {blocker.reason}</li>))}</ul></AlertDescription></Alert>
            ) : <Alert><CheckCircle2 /><AlertTitle>Ready to apply</AlertTitle><AlertDescription>Storage re-checks every step when the migration is applied.</AlertDescription></Alert>}
            <div className="max-h-72 overflow-auto rounded-md border">
              <Table><TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Step</TableHead><TableHead>Current status</TableHead><TableHead className="hidden sm:table-cell">Meaning</TableHead></TableRow></TableHeader>
                <TableBody>{plan.entries.map(entry => (
                  <TableRow key={`${entry.action}:${entry.source ?? ''}:${entry.target ?? ''}`}>
                    <TableCell><Badge variant={actionTone[entry.action]}>{entry.action}</Badge></TableCell>
                    <TableCell><Mono>{entry.target ?? entry.source}</Mono>{entry.source && entry.target && entry.source !== entry.target
                      ? <span className="text-muted-foreground ml-1 text-xs">(was {entry.source})</span> : null}</TableCell>
                    <TableCell>{entry.status ? <StatusBadge status={entry.status} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">{actionMeaning[entry.action]}</TableCell>
                  </TableRow>))}</TableBody></Table>
            </div>
          </>) : null}
        </>)}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>{applied ? 'Close' : 'Cancel'}</Button>
          {applied || !can('workflows:migrate') ? null : <Button onClick={apply} disabled={applying || !plan?.allowed || !paused}
            title={!paused ? 'Pause the run first.' : undefined}>{applying ? <Loader2 className="animate-spin" /> : null}Apply migration</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Migrations offered for one run, shown on its detail page. */
export function MigrationPanel({ run, onMigrated }: { run: WorkflowViewInput; onMigrated: () => void }) {
  const { client } = useSession();
  const offers = useLoad(async signal => {
    try { return await client.workflowMigrations(run.runId, { signal }); } catch (error) { if (notConfigured(error)) return null; throw error; }
  }, [run.runId, run.revision]);
  const [reviewing, setReviewing] = React.useState<WorkflowMigrationOffer>();
  if (terminal.has(run.status)) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Migrations</CardTitle>
        <CardDescription>Move this run to a newer definition version without restarting it.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <ErrorAlert error={offers.error} />
        {offers.loading && !offers.data ? <Skeleton className="h-8 w-full" /> : null}
        {offers.data === null ? <p className="text-muted-foreground text-sm">This server does not offer migrations.</p> : null}
        {offers.data?.length === 0 ? <p className="text-muted-foreground text-sm">No reviewed migration starts from version {run.definitionVersion}.</p> : null}
        {offers.data?.map(offer => (
          <div key={offer.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0 space-y-0.5"><p className="truncate text-sm font-medium">{offer.id}</p>
              <p className="text-muted-foreground text-xs">v{offer.fromVersion} → v{offer.toVersion}</p></div>
            <Button size="sm" variant="outline" onClick={() => setReviewing(offer)}>Review</Button>
          </div>))}
        {offers.data?.length && run.status !== 'paused' ? <p className="text-muted-foreground text-xs">Pause the run before applying a migration.</p> : null}
        {reviewing ? <ReviewDialog run={run} offer={reviewing} open onOpenChange={value => { if (!value) setReviewing(undefined); }} onMigrated={onMigrated} /> : null}
      </CardContent>
    </Card>
  );
}

interface Candidate { readonly runId: string; readonly definitionId: string; readonly definitionVersion: string; readonly revision: number; readonly status: string }
interface Group { readonly offer: WorkflowMigrationOffer; readonly definitionId: string; readonly runs: Candidate[] }

/** Every migration currently applicable to a page of active runs, grouped by migration. */
export function Migrations() {
  const { client } = useSession();
  const [cursor, setCursor] = React.useState<string | undefined>(); const [history, setHistory] = React.useState<(string | undefined)[]>([]);
  const scan = useLoad(async signal => {
    const page = await client.workflows({ limit: 50, ...(cursor ? { after: cursor } : {}), signal });
    const active = page.items.filter(item => !terminal.has(item.status));
    const groups = new Map<string, Group>(); let configured = true;
    // Bounded fan-out: at most four offer reads in flight.
    for (let index = 0; index < active.length && configured; index += 4) {
      const batch = await Promise.all(active.slice(index, index + 4).map(async item => {
        try { return { item, offers: await client.workflowMigrations(item.runId, { signal }) }; }
        catch (error) { if (notConfigured(error)) { configured = false; return { item, offers: [] }; } throw error; }
      }));
      for (const { item, offers } of batch) for (const offer of offers) {
        const group = groups.get(offer.id) ?? { offer, definitionId: item.definitionId, runs: [] };
        group.runs.push(item); groups.set(offer.id, group);
      }
    }
    return { configured, examined: page.items.length, active: active.length, next: page.next, groups: [...groups.values()].sort((a, b) => a.offer.id.localeCompare(b.offer.id)) };
  }, [cursor]);
  const [reviewing, setReviewing] = React.useState<{ run: Candidate; offer: WorkflowMigrationOffer }>();
  return (
    <div className="space-y-6">
      <PageHeader title="Migrations" description="Reviewed migrations move paused runs to a new definition version in place. Every step is re-checked against the run's real state."
        actions={<Button variant="outline" size="sm" onClick={scan.reload}><RefreshCw />Refresh</Button>} />
      <Card><CardHeader><CardTitle>How it works</CardTitle></CardHeader><CardContent>
        <ol className="text-muted-foreground grid gap-3 text-sm sm:grid-cols-3">
          <li><span className="text-foreground font-medium">1. Pause.</span> Pause the run (or hold the fleet). Nothing may be dispatching.</li>
          <li><span className="text-foreground font-medium">2. Review.</span> The plan shows what happens to every step and why anything is blocked.</li>
          <li><span className="text-foreground font-medium">3. Apply, then resume.</span> The run stays paused on the new version until you resume it.</li>
        </ol>
      </CardContent></Card>
      <ErrorAlert error={scan.error} />
      {scan.loading && !scan.data ? <Card><CardContent className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></CardContent></Card> : null}
      {scan.data && !scan.data.configured ? <Card><CardContent><Empty>This server does not offer migrations. Configure the <Mono>workflowMigrations</Mono> transport.</Empty></CardContent></Card> : null}
      {scan.data?.configured && scan.data.groups.length === 0
        ? <Card><CardContent><Empty>No migration applies to the {scan.data.active} active run{scan.data.active === 1 ? '' : 's'} on this page.</Empty></CardContent></Card> : null}
      {scan.data?.groups.map(group => (
        <Card key={group.offer.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2"><Shuffle className="size-4" />{group.offer.id}
              <Badge variant="outline">{group.definitionId} v{group.offer.fromVersion} → v{group.offer.toVersion}</Badge></CardTitle>
            <CardDescription>{group.offer.description || 'No description.'} {group.runs.length} run{group.runs.length === 1 ? '' : 's'} on this page,
              {' '}{group.runs.filter(run => run.status === 'paused').length} paused.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{group.runs.map(run => (
                <TableRow key={run.runId}>
                  <TableCell><Mono title={run.runId}>{short(run.runId)}</Mono></TableCell><TableCell>{run.revision}</TableCell>
                  <TableCell><StatusBadge status={run.status} /></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setReviewing({ run, offer: group.offer })}>Review</Button></TableCell>
                </TableRow>))}</TableBody></Table>
          </CardContent>
        </Card>))}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={history.length === 0} onClick={() => { setCursor(history.at(-1)); setHistory(history.slice(0, -1)); }}>Previous page</Button>
        <Button variant="outline" size="sm" disabled={!scan.data?.next} onClick={() => { setHistory([...history, cursor]); setCursor(scan.data!.next!); }}>Next page</Button>
      </div>
      {reviewing ? <ReviewDialog run={reviewing.run} offer={reviewing.offer} open onOpenChange={value => { if (!value) setReviewing(undefined); }} onMigrated={scan.reload} /> : null}
    </div>
  );
}
