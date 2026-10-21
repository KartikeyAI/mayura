import { useMayuraThreads } from 'mayura/client-react';
import type { HeadlessThreadsStore } from 'mayura/client/headless';
import './ui.css';
/** Select only listed scoped threads; pagination/loading belongs to the host. */
export function ThreadList({ store, onSelect }: { readonly store: HeadlessThreadsStore; readonly onSelect: (id: string) => void }) {
  const state = useMayuraThreads(store);
  return <nav className="mayura-ui" aria-label="Conversations"><h2>Your conversations</h2><ul>{(state.page?.threads ?? []).map(thread => <li key={thread.id}><button type="button" onClick={() => onSelect(thread.id)}>{thread.title || 'Untitled conversation'}</button></li>)}</ul>
    {(state.page?.threads.length ?? 0) === 0 ? <p>Create a conversation to get started.</p> : null}</nav>;
}
