import { useEffect, useState } from 'react';
import { LoaderCircle, Store } from 'lucide-react';
import { Chat } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { demoCustomers, signIn, type DemoCustomer, type Session } from '@/lib/api';

/** Development sign-in: pick a demo customer. In production your own login replaces this screen (see lib/api.ts). */
function SignIn({ onSession }: { readonly onSession: (session: Session) => void }) {
  const [customers, setCustomers] = useState<readonly DemoCustomer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { demoCustomers().then(setCustomers, (reason: unknown) => setError(reason instanceof Error ? reason.message : 'Unavailable.')); }, []);
  const choose = async (customerId: string) => {
    setPending(customerId); setError(null);
    try { onSession(await signIn(customerId)); } catch { setError('Could not start a session.'); } finally { setPending(null); }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Store className="size-5" /> Store support</CardTitle>
          <CardDescription>Development sign-in: choose a demo customer. Each one sees only their own orders and notes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {customers === null && !error && <LoaderCircle className="text-muted-foreground mx-auto size-5 animate-spin" />}
          {customers?.map(customer => (
            <Button key={customer.customerId} variant="outline" className="justify-between" disabled={pending !== null} onClick={() => void choose(customer.customerId)}>
              {customer.name} <span className="text-muted-foreground font-mono text-xs">{pending === customer.customerId ? 'signing in…' : customer.customerId}</span>
            </Button>
          ))}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

export function App() {
  // The session lives in memory only: closing the tab signs out, and nothing is written to storage.
  const [session, setSession] = useState<Session | null>(null);
  return session ? <Chat session={session} onSignOut={() => setSession(null)} /> : <SignIn onSession={setSession} />;
}
