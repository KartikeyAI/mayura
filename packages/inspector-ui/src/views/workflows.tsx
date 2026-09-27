import * as React from 'react';
import { ArrowLeft, Ban, Check, ChevronRight, Pause, Play, RefreshCw } from 'lucide-react';
import { createWorkflowGraphProjection, type WorkflowViewApproval, type WorkflowViewInput } from '@mayura/client/workflows';
import { commandId, useLoad, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { ConfirmAction, Empty, ErrorAlert, Mono, PageHeader, StatusBadge, short } from '@/components/common';
import { MigrationPanel } from './migrations';

export function Workflows() {
  const { client } = useSession();
  const [cursor, setCursor] = React.useState<string | undefined>(); const [history, setHistory] = React.useState<(string | undefined)[]>([]);
  const [selected, setSelected] = React.useState<string>(); const [view, setView] = React.useState<'active' | 'settled'>('active');
  const page = useLoad(signal => client.workflows({ limit: 25, view, ...(cursor ? { after: cursor } : {}), signal }), [cursor, view]);
  const switchView = (next: string) => { setView(next === 'settled' ? 'settled' : 'active'); setCursor(undefined); setHistory([]); };
  if (selected) return <WorkflowDetail runId={selected} onBack={() => { setSelected(undefined); page.reload(); }} />;
  return (
    <div className="space-y-6">
      <PageHeader title="Workflows" description="Durable runs visible to this token, across all workflow formats."
        actions={<Button variant="outline" size="sm" onClick={page.reload}><RefreshCw />Refresh</Button>} />
      <Card><CardContent>
        <Tabs value={view} onValueChange={switchView} className="pb-4">
          <TabsList><TabsTrigger value="active">Active</TabsTrigger><TabsTrigger value="settled">Finished</TabsTrigger></TabsList>
        </Tabs>
        {view === 'settled' ? <p className="text-muted-foreground pb-4 text-sm">Recently settled lifecycle runs. Runs with an unknown outcome are kept longest: they still need reconciling.</p> : null}
        <ErrorAlert error={page.error} />
        {page.data?.items.length === 0 ? <Empty>{view === 'settled' ? 'No finished workflow runs.' : 'No workflow runs.'}</Empty> : null}
        {page.data?.items.length ? (
          <Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Definition</TableHead><TableHead>Format</TableHead><TableHead>Revision</TableHead><TableHead>Status</TableHead>
            {view === 'settled' ? <TableHead>Settled</TableHead> : null}<TableHead /></TableRow></TableHeader>
            <TableBody>{page.data.items.map(item => (
              <TableRow key={item.runId} className="cursor-pointer" onClick={() => setSelected(item.runId)}>
                <TableCell><Mono title={item.runId}>{short(item.runId)}</Mono></TableCell>
                <TableCell className="font-medium">{item.definitionId}<span className="text-muted-foreground">@{item.definitionVersion}</span></TableCell>
                <TableCell>{item.format}</TableCell><TableCell>{item.revision}</TableCell><TableCell><StatusBadge status={item.status} /></TableCell>
                {view === 'settled' ? <TableCell className="text-muted-foreground">{item.settledAtMs === undefined ? '' : new Date(item.settledAtMs).toLocaleString()}</TableCell> : null}
                <TableCell className="text-right"><ChevronRight className="text-muted-foreground inline size-4" /></TableCell>
              </TableRow>))}</TableBody></Table>) : null}
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" size="sm" disabled={history.length === 0} onClick={() => { setCursor(history.at(-1)); setHistory(history.slice(0, -1)); }}>Previous</Button>
          <Button variant="outline" size="sm" disabled={!page.data?.next} onClick={() => { setHistory([...history, cursor]); setCursor(page.data!.next!); }}>Next</Button>
        </div>
      </CardContent></Card>
    </div>
  );
}

function WorkflowDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { client } = useSession();
  const view = useLoad(signal => client.workflow(runId, { signal }), [runId]);
  const projection = React.useMemo(() => { try { return view.data ? createWorkflowGraphProjection(view.data) : undefined; } catch { return undefined; } }, [view.data]);
  const run = view.data as WorkflowViewInput | undefined;
  const command = (action: (revision: number) => Promise<unknown>) => async () => { await action(run!.revision); };
  const terminal = run ? ['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(run.status) : true;
  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />All workflows</Button>
      <PageHeader title={run ? `${run.definitionId}@${run.definitionVersion}` : 'Workflow'} description={runId}
        actions={run ? <>
          <ConfirmAction label="Pause" icon={<Pause />} disabled={terminal || run.status === 'paused'} title="Pause this run?"
            description={<p>The run stops at a quiescent point. Pausing is refused while a step is dispatching or leased.</p>} confirm="Pause"
            onConfirm={command(revision => client.pauseWorkflow(runId, revision, { commandId: commandId() }))} onDone={view.reload} />
          <ConfirmAction label="Resume" icon={<Play />} disabled={run.status !== 'paused'} title="Resume this run?"
            description={<p>Workers continue the run from where it paused.</p>} confirm="Resume"
            onConfirm={command(revision => client.resumeWorkflow(runId, revision, { commandId: commandId() }))} onDone={view.reload} />
          <ConfirmAction label="Cancel" icon={<Ban />} destructive disabled={terminal} title="Cancel this run?"
            description={<><p>No new step starts. Steps with unknown effects stay unknown and need reconciliation.</p><p className="font-medium">This cannot be undone.</p></>}
            confirm="Cancel run" onConfirm={command(revision => client.cancelWorkflow(runId, revision, { commandId: commandId() }))} onDone={view.reload} />
          <Button variant="outline" size="sm" onClick={view.reload}><RefreshCw />Refresh</Button>
        </> : null} />
      <ErrorAlert error={view.error} />
      {run && projection ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Steps</CardTitle><CardDescription>Ordered by dependency depth.</CardDescription>
            <CardAction><StatusBadge status={run.status} /></CardAction></CardHeader><CardContent>
            <Table><TableHeader><TableRow><TableHead>Step</TableHead><TableHead>Kind</TableHead><TableHead>Depends on</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{[...projection.nodes].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)).map(node => (
                <TableRow key={node.id}><TableCell><Mono>{node.id}</Mono>{node.ready ? <span className="text-muted-foreground ml-2 text-xs">ready</span> : null}</TableCell>
                  <TableCell>{node.kind}</TableCell>
                  <TableCell className="text-muted-foreground">{projection.edges.filter(edge => edge.to === node.id).map(edge => edge.from).join(', ') || '—'}</TableCell>
                  <TableCell><StatusBadge status={node.status} /></TableCell></TableRow>))}</TableBody></Table>
          </CardContent></Card>
          <div className="space-y-4">
            <ApprovalPanel run={run} onApproved={view.reload} />
            <Card><CardHeader><CardTitle>Progress</CardTitle></CardHeader><CardContent className="space-y-3">
              <div className="bg-muted h-2 overflow-hidden rounded-full"><div className="bg-success h-full" style={{ width: `${projection.progress.total ? projection.progress.succeeded / projection.progress.total * 100 : 0}%` }} /></div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(projection.progress).map(([key, value]) => <div key={key}><dt className="text-muted-foreground capitalize">{key}</dt><dd className="font-medium">{value}</dd></div>)}
              </dl>
              <p className="text-muted-foreground text-xs">Format {run.format} · revision {run.revision}</p>
            </CardContent></Card>
            <MigrationPanel run={run} onMigrated={view.reload} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Tool steps waiting for approval: what will run, until when, and the exact digest the approval names. */
function ApprovalPanel({ run, onApproved }: { run: WorkflowViewInput; onApproved: () => void }) {
  const { client } = useSession();
  const pending = run.steps.flatMap(step => step.approval ? [{ id: step.id, approval: step.approval }] : []);
  if (pending.length === 0) return null;
  return (
    <Card><CardHeader><CardTitle>Awaiting approval</CardTitle><CardDescription>Nothing below runs until it is approved.</CardDescription></CardHeader>
      <CardContent className="space-y-4">{pending.map(({ id, approval }) => (
        <div key={id} className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
          <div className="flex items-center justify-between gap-2">
            <div><Mono>{id}</Mono>{approval.subject ? <span className="text-muted-foreground ml-2 text-xs">{approval.subject.toolId}@{approval.subject.toolVersion}</span> : null}</div>
            <ConfirmAction label="Approve" icon={<Check />} title={`Approve ${id}?`}
              description={<ApprovalSummary approval={approval} />} confirm="Approve"
              onConfirm={async () => { await client.approveWorkflow(run.runId, { revision: run.revision, nodeId: id, approvalDigest: approval.digest }, { commandId: commandId() }); }}
              onDone={onApproved} />
          </div>
          <ApprovalSummary approval={approval} />
        </div>))}
      </CardContent></Card>
  );
}

function ApprovalSummary({ approval }: { approval: WorkflowViewApproval }) {
  return (
    <div className="space-y-2 text-sm">
      {approval.subject
        ? <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 text-xs">{JSON.stringify(approval.subject.input, null, 2)}</pre>
        : <p className="text-muted-foreground">The tool input is too large to show here; the digest identifies it exactly.</p>}
      <p className="text-muted-foreground text-xs">Expires {new Date(approval.expiresAtMs).toLocaleString()} · digest <Mono title={approval.digest}>{short(approval.digest)}</Mono></p>
      <p className="text-muted-foreground text-xs">An expired request is re-issued with a new digest; approve the current one.</p>
    </div>
  );
}
