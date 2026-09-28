import * as React from 'react';
import { Lock, LockOpen, Pause, Play } from 'lucide-react';
import type { WorkflowFleetSweepOutcome } from '@mayura/client';
import { errorText, useLoad, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/primitives';
import { ConfirmAction, ErrorAlert, Mono, PageHeader, StatusBadge, short } from '@/components/common';

export function Fleet() {
  const { client, can } = useSession(); const operate = can('workflows:fleet');
  const hold = useLoad(signal => client.workflowFleet({ signal }), []);
  const [outcomes, setOutcomes] = React.useState<WorkflowFleetSweepOutcome[]>([]);
  const [sweeping, setSweeping] = React.useState<'pause' | 'resume'>(); const [error, setError] = React.useState<string>();
  const sweep = async (phase: 'pause' | 'resume') => {
    setSweeping(phase); setError(undefined); setOutcomes([]);
    try {
      let cursor = null as Parameters<typeof client.sweepWorkflowFleet>[1]['cursor'];
      do { const page = await client.sweepWorkflowFleet(phase, { cursor, limit: 64 }); setOutcomes(previous => [...previous, ...page.outcomes]); cursor = page.nextCursor; } while (cursor !== null);
    } catch (failure) { setError(errorText(failure)); } finally { setSweeping(undefined); hold.reload(); }
  };
  const counts = outcomes.reduce<Record<string, number>>((total, item) => ({ ...total, [item.outcome]: (total[item.outcome] ?? 0) + 1 }), {});
  const held = hold.data?.held === true;
  return (
    <div className="space-y-6">
      <PageHeader title="Fleet control" description="Durably hold the whole scope, pause every run, and resume exactly the runs the fleet paused." />
      <ErrorAlert error={hold.error} />
      <Card><CardHeader><CardTitle className="flex items-center gap-2">Fleet hold {hold.data ? <StatusBadge status={held ? 'held' : 'released'} /> : null}</CardTitle>
        <CardDescription>{hold.data ? `Generation ${hold.data.generation}${hold.data.changedAtMs ? ` · changed ${new Date(hold.data.changedAtMs).toLocaleString()}` : ''}` : 'Requires workflows:fleet.'}</CardDescription></CardHeader>
        {operate ? <CardContent className="flex flex-wrap gap-2">
          <ConfirmAction label="Hold fleet" icon={<Lock />} disabled={!hold.data || held || sweeping !== undefined} title="Hold the fleet?"
            description={<p>Hosts and coordinators stop driving runs in this scope. Running work finishes its current step; nothing is cancelled.</p>}
            confirm="Hold" onConfirm={() => client.holdWorkflowFleet()} onDone={hold.reload} />
          <Button size="sm" variant="outline" disabled={!held || sweeping !== undefined} onClick={() => sweep('pause')}><Pause />{sweeping === 'pause' ? 'Pausing…' : 'Pause sweep'}</Button>
          <ConfirmAction label="Release fleet" icon={<LockOpen />} disabled={!hold.data || !held || sweeping !== undefined} title="Release the fleet hold?"
            description={<p>Hosts resume driving runs. Runs paused by the sweep stay paused until you run a resume sweep.</p>}
            confirm="Release" onConfirm={() => client.releaseWorkflowFleet()} onDone={hold.reload} />
          <Button size="sm" variant="outline" disabled={held || !hold.data || sweeping !== undefined} onClick={() => sweep('resume')}><Play />{sweeping === 'resume' ? 'Resuming…' : 'Resume sweep'}</Button>
        </CardContent> : <CardContent className="text-muted-foreground text-sm">Holding, releasing and sweeping need workflows:fleet.</CardContent>}</Card>
      <ErrorAlert error={error} title="Sweep stopped" />
      {outcomes.length ? (
        <Card><CardHeader><CardTitle>Sweep results</CardTitle><CardDescription>{Object.entries(counts).map(([key, value]) => `${value} ${key.replaceAll('_', ' ')}`).join(' · ')}</CardDescription></CardHeader>
          <CardContent><Table><TableHeader><TableRow><TableHead>Target</TableHead><TableHead>Run</TableHead><TableHead>Outcome</TableHead></TableRow></TableHeader>
            <TableBody>{outcomes.map(item => <TableRow key={`${item.target}/${item.runId}`}><TableCell>{item.target}</TableCell><TableCell><Mono title={item.runId}>{short(item.runId)}</Mono></TableCell>
              <TableCell><StatusBadge status={item.outcome} />{item.outcome === 'failed' ? <span className="text-muted-foreground ml-2 text-xs">{item.code}</span> : null}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
      ) : null}
    </div>
  );
}
