import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { areas, directory, type AreaKey, type DirectoryEntry } from '../lib/integrations';
import { BrandLogo } from './BrandLogo';

const kindLabel: Record<DirectoryEntry['kind'], string> = { package: 'Package', 'built-in': 'Built in', guide: 'Guide' };

/** Searchable directory of every integration: packages, what mayura has built in, and framework and platform guides. */
export function Directory() {
  const entries = useMemo(() => directory(), []);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState<AreaKey | 'all'>('all');

  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (entry: DirectoryEntry) => terms.every(term =>
    `${entry.name} ${entry.label} ${entry.description} ${areas.find(item => item.key === entry.area)?.title ?? ''}`.toLowerCase().includes(term));
  const visible = entries.filter(entry => (area === 'all' || entry.area === area) && matches(entry));
  const counts = new Map(areas.map(item => [item.key, entries.filter(entry => entry.area === item.key && matches(entry)).length]));
  const packages = entries.filter(entry => entry.kind === 'package').length;

  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <p className="text-sm font-medium text-primary">Integrations</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">
          Connect Mayura to the services you already use
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
          {packages} optional <code className="font-mono text-[0.9em]">@mayurajs</code> packages, released with every
          version of Mayura, plus what <code className="font-mono text-[0.9em]">mayura</code> connects to on its own. Every
          package takes its credentials from you, reads nothing from the environment, and works under the same
          permissions and budgets as the rest of your app.
        </p>

        <div className="sticky top-16 z-20 -mx-4 mt-10 border-b border-line bg-bg/90 px-4 py-4 backdrop-blur-md sm:-mx-6 sm:px-6">
          <label className="relative block max-w-xl">
            <span className="sr-only">Search integrations</span>
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name, package or what it does"
              className="w-full rounded-xl border border-line bg-raised py-2.5 pr-4 pl-10 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none" />
          </label>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by area">
            <Chip active={area === 'all'} onClick={() => setArea('all')} label="All" count={entries.filter(matches).length} />
            {areas.map(item => (
              <Chip key={item.key} active={area === item.key} onClick={() => setArea(item.key)} label={item.title} count={counts.get(item.key) ?? 0} />
            ))}
          </div>
        </div>

        <p className="sr-only" aria-live="polite">{visible.length} integrations shown</p>
        {visible.length === 0
          ? <p className="mt-12 text-muted">Nothing matches “{query}”. Try a vendor name such as Postgres, or an area such as sandboxes.</p>
          : areas.filter(item => visible.some(entry => entry.area === item.key)).map(item => (
            <section key={item.key} aria-labelledby={`area-${item.key}`} className="mt-12">
              <h2 id={`area-${item.key}`} className="text-sm font-semibold tracking-wide text-muted uppercase">{item.title}</h2>
              <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.filter(entry => entry.area === item.key).map(entry => <li key={`${entry.kind}-${entry.label}-${entry.name}`}><Card entry={entry} /></li>)}
              </ul>
            </section>
          ))}
      </div>
    </main>
  );
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} disabled={!active && count === 0}
      className={`rounded-full border px-3 py-1 text-sm transition disabled:opacity-40 ${active ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:text-fg'}`}>
      {label} <span className={`ml-0.5 font-mono text-xs ${active ? 'opacity-70' : 'opacity-60'}`}>{count}</span>
    </button>
  );
}

function Card({ entry }: { entry: DirectoryEntry }) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <BrandLogo logo={entry.logo} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold tracking-tight text-fg group-hover:text-primary">{entry.name}</h3>
          <p className="truncate font-mono text-xs text-muted">{entry.label}</p>
        </div>
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[0.65rem] text-muted">{kindLabel[entry.kind]}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-pretty text-muted">{entry.description}</p>
    </>
  );
  const className = 'group block h-full rounded-2xl border border-line bg-raised p-5 transition hover:border-muted/40';
  if (entry.docs) {
    return <Link to="/docs/$/" params={{ _splat: entry.docs.slug }} {...(entry.docs.hash ? { hash: entry.docs.hash } : {})} className={className}>{body}</Link>;
  }
  return <Link to={entry.path as '/'} className={className}>{body}</Link>;
}
