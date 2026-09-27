import * as React from 'react';
import { AlertCircle, Info, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle, Badge } from './ui/primitives';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from './ui/dialog';
import { errorText } from '@/lib/session';

const tone: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  succeeded: 'success', completed: 'success', answered: 'success', ready: 'success', continued: 'success', active: 'success', released: 'success',
  running: 'secondary', dispatching: 'secondary', pending: 'outline', approved: 'secondary',
  waiting: 'warning', paused: 'warning', degraded: 'warning', held: 'warning', timed_out: 'warning', skipped: 'outline',
  failed: 'destructive', blocked: 'destructive', cancelled: 'outline', outcome_unknown: 'destructive', unknown: 'destructive',
};
/** Status is always rendered as text; colour only reinforces it. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={tone[status] ?? 'outline'}>{status.replaceAll('_', ' ')}</Badge>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Access and setup answers are explained, not shown as failures: a token without a capability, or an API this server does not offer. */
const explained: Record<string, { title: string; text: string }> = {
  '403': { title: 'Not available to this token', text: 'The access token does not carry the capability this view needs.' },
  '404': { title: 'Not available', text: 'This server does not offer this API, or the item no longer exists.' },
};
export function ErrorAlert({ error, title = 'Request failed' }: { error: string | undefined; title?: string }) {
  if (!error) return null;
  const known = explained[/\(HTTP (\d{3})\)$/.exec(error)?.[1] ?? ''];
  if (known) return <Alert><Info /><AlertTitle>{known.title}</AlertTitle><AlertDescription>{known.text} <span className="text-muted-foreground">({error})</span></AlertDescription></Alert>;
  return <Alert variant="destructive"><AlertCircle /><AlertTitle>{title}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground py-8 text-center text-sm">{children}</p>;
}

export function Mono({ children, title }: { children: React.ReactNode; title?: string }) {
  return <code className="bg-muted rounded px-1.5 py-0.5 text-xs" title={title}>{children}</code>;
}
export const short = (id: string): string => id.length > 14 ? `${id.slice(0, 12)}…` : id;

/** A confirmed operator command. The action runs once per confirmation and reports its own failure. */
export function ConfirmAction({ label, title, description, confirm, destructive = false, disabled = false, icon, onConfirm, onDone, variant }: {
  label: string; title: string; description: React.ReactNode; confirm: string; destructive?: boolean; disabled?: boolean; icon?: React.ReactNode;
  variant?: 'default' | 'outline' | 'destructive' | 'secondary'; onConfirm: () => Promise<unknown>; onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<string>();
  const run = async (event: React.MouseEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await onConfirm(); setOpen(false); onDone?.(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <AlertDialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(undefined); } }}>
      <AlertDialogTrigger asChild><Button size="sm" variant={variant ?? (destructive ? 'destructive' : 'outline')} disabled={disabled}>{icon}{label}</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-2 text-sm">{description}</div></AlertDialogDescription></AlertDialogHeader>
        <ErrorAlert error={error} title="Command failed" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction destructive={destructive} disabled={busy} onClick={run}>{busy ? <Loader2 className="animate-spin" /> : null}{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
