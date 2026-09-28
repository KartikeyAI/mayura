import { Activity, Bot, PauseCircle, Wrench } from 'lucide-react';
import { useLoad, useSession } from '@/lib/session';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/primitives';
import { Empty, ErrorAlert, Mono, PageHeader, StatusBadge } from '@/components/common';

interface Health { readonly status: string; readonly checks: readonly { readonly id: string; readonly status: string }[] }
interface Tool { readonly agentId: string; readonly id: string; readonly version: string; readonly effects: string; readonly capabilities: readonly string[] }

export function Overview() {
  const { client, get, can, offers } = useSession();
  // Only what this token may read is requested; the rest is shown as not available.
  const health = useLoad(signal => get<Health>('/v1/operations/health', signal), [], can('operations:read'));
  const agents = useLoad(signal => client.agents({ signal }), [], can('runs:read'));
  const tools = useLoad(signal => get<{ tools: Tool[] }>('/v1/tools?limit=100', signal), [], can('operations:read'));
  const fleet = useLoad(signal => client.workflowFleet({ signal }), [], can('workflows:read') && offers('workflowFleet'));
  const stat = (icon: React.ReactNode, title: string, value: React.ReactNode, detail: string) => (
    <Card className="gap-2 py-4"><CardHeader className="px-4"><CardDescription className="flex items-center gap-2">{icon}{title}</CardDescription>
      <CardTitle className="text-2xl">{value}</CardTitle></CardHeader><CardContent className="text-muted-foreground px-4 text-xs">{detail}</CardContent></Card>
  );
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Readiness, registered agents and tools, and the fleet hold for this scope." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stat(<Activity className="size-4" />, 'Readiness', health.data ? <StatusBadge status={health.data.status} /> : health.loading ? <Skeleton className="h-7 w-20" /> : 'unavailable',
          health.data ? `${health.data.checks.length} check(s)` : 'operations:read')}
        {stat(<Bot className="size-4" />, 'Agents', agents.data?.length ?? '–', 'visible to this token')}
        {stat(<Wrench className="size-4" />, 'Tools', tools.data?.tools.length ?? '–', 'across visible agents')}
        {stat(<PauseCircle className="size-4" />, 'Fleet', fleet.data ? <StatusBadge status={fleet.data.held ? 'held' : 'released'} /> : '–',
          fleet.data ? `generation ${fleet.data.generation}` : 'workflows:fleet')}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Readiness checks</CardTitle></CardHeader><CardContent>
          <ErrorAlert error={health.error} />
          {health.data ? <Table><TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>{health.data.checks.map(check => <TableRow key={check.id}><TableCell><Mono>{check.id}</Mono></TableCell><TableCell><StatusBadge status={check.status} /></TableCell></TableRow>)}</TableBody></Table> : null}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Agents</CardTitle></CardHeader><CardContent>
          <ErrorAlert error={agents.error} />
          {agents.data?.length === 0 ? <Empty>No agents are visible to this token.</Empty> : null}
          {agents.data?.length ? <Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Version</TableHead></TableRow></TableHeader>
            <TableBody>{agents.data.map(agent => <TableRow key={agent.id}><TableCell className="font-medium">{agent.id}</TableCell><TableCell>{agent.version}</TableCell></TableRow>)}</TableBody></Table> : null}
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Tools</CardTitle><CardDescription>Declared effects and required capabilities.</CardDescription></CardHeader><CardContent>
        <ErrorAlert error={tools.error} />
        {tools.data?.tools.length === 0 ? <Empty>No tools are registered for these agents.</Empty> : null}
        {tools.data?.tools.length ? <Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Tool</TableHead><TableHead>Effects</TableHead><TableHead>Capabilities</TableHead></TableRow></TableHeader>
          <TableBody>{tools.data.tools.map(tool => <TableRow key={`${tool.agentId}/${tool.id}`}><TableCell>{tool.agentId}</TableCell><TableCell><Mono>{tool.id}@{tool.version}</Mono></TableCell>
            <TableCell><StatusBadge status={tool.effects} /></TableCell><TableCell className="text-muted-foreground">{tool.capabilities.join(', ') || '—'}</TableCell></TableRow>)}</TableBody></Table> : null}
      </CardContent></Card>
    </div>
  );
}
