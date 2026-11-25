import { Workspace } from './workspace';

export default async function Page({ searchParams }: { searchParams: Promise<{ thread?: string | string[] }> }) {
  const { thread } = await searchParams;
  const id = typeof thread === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(thread) ? thread : null;
  return <Workspace initialThreadId={id} />;
}
