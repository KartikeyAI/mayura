import * as React from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { createHumanRequestView } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';
import { commandId, errorText, useLoad, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Empty, ErrorAlert, JsonBlock, PageHeader, StatusBadge } from '@/components/common';

export function Humans() {
  const { client } = useSession();
  const page = useLoad(signal => client.humanRequests({ limit: 50, signal }), []);
  return (
    <div className="space-y-6">
      <PageHeader title="Human requests" description="Information, correction and plan-selection requests waiting on a person."
        actions={<Button variant="outline" size="sm" onClick={page.reload}><RefreshCw />Refresh</Button>} />
      <Card><CardContent>
        <ErrorAlert error={page.error} />
        {page.data?.items.length === 0 ? <Empty>Nothing is waiting on a person.</Empty> : null}
        {page.data?.items.length ? (
          <Table><TableHeader><TableRow><TableHead>Request</TableHead><TableHead>Agent</TableHead><TableHead>Kind</TableHead><TableHead>Prompt</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{page.data.items.map(item => {
              const view = createHumanRequestView(item, Date.now());
              return (
                <TableRow key={item.id}><TableCell className="font-medium">{item.id}</TableCell><TableCell>{item.agentId}</TableCell><TableCell>{item.kind.replaceAll('_', ' ')}</TableCell>
                  <TableCell className="max-w-md truncate whitespace-normal">{item.prompt}</TableCell>
                  <TableCell><StatusBadge status={view.urgency === 'expired' ? 'timed_out' : item.status} /></TableCell>
                  <TableCell className="text-right">{view.canRespond ? <Respond request={item} action={view.actionText ?? 'Respond'} onDone={page.reload} /> : null}</TableCell></TableRow>
              );
            })}</TableBody></Table>) : null}
      </CardContent></Card>
    </div>
  );
}

function Respond({ request, action, onDone }: { request: RemoteHumanRequest; action: string; onDone: () => void }) {
  const { client } = useSession();
  const [open, setOpen] = React.useState(false); const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string>(); const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { setError('The response must be valid JSON (for a plain answer, use a quoted string).'); return; }
    setBusy(true); setError(undefined);
    try { await client.respondHumanRequest(request.id, request.digest, value, { commandId: commandId() }); setOpen(false); onDone(); }
    catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(undefined); } }}>
      <DialogTrigger asChild><Button size="sm"><Send />{action}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{action}</DialogTitle><DialogDescription>Answering <strong>{request.id}</strong> for {request.agentId}. The server validates the value against schema <code>{request.schemaId}</code>.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="bg-muted rounded-md p-3 text-sm whitespace-pre-wrap">{request.prompt}</div>
          {request.context !== undefined ? <JsonBlock value={request.context} /> : null}
          <div className="space-y-2"><Label htmlFor="human-response">Response (JSON)</Label>
            <Textarea id="human-response" rows={5} value={text} onChange={event => setText(event.target.value)} placeholder='"approve"' /></div>
          <ErrorAlert error={error} title="Response rejected" />
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button onClick={submit} disabled={busy || !text.trim()}>Submit response</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
