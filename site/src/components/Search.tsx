import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SearchEntry } from 'virtual:mayura-search';

interface Result { entry: SearchEntry; score: number; snippet: string }

// The index holds the text of every page, so it loads only when someone opens search.
let index: Promise<SearchEntry[]> | undefined;
const loadIndex = () => (index ??= import('virtual:mayura-search').then(module => module.default));

/** Sections containing every word typed; matches in titles rank above matches in the text. */
function find(entries: SearchEntry[], query: string): Result[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const results: Result[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase(); const page = entry.page.toLowerCase(); const text = entry.text.toLowerCase();
    if (!words.every(word => title.includes(word) || page.includes(word) || text.includes(word))) continue;
    let score = entry.id ? 0 : 2;
    for (const word of words) {
      if (title.startsWith(word)) score += 14; else if (title.includes(word)) score += 10;
      if (page.includes(word)) score += 4;
      score += Math.min(occurrences(text, word), 5);
    }
    results.push({ entry, score, snippet: snippet(entry.text, words) });
  }
  return results.sort((left, right) => right.score - left.score).slice(0, 20);
}

function occurrences(text: string, word: string) {
  let count = 0; for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) count++;
  return count;
}

/** About 150 characters of the text around the first word found. */
function snippet(text: string, words: string[]) {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map(word => lower.indexOf(word)).filter(position => position >= 0), text.length));
  const start = Math.max(0, at - 50);
  return `${start ? '…' : ''}${text.slice(start, start + 150).trim()}${start + 150 < text.length ? '…' : ''}`;
}

function Highlighted({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  return <>{text.split(pattern).map((part, i) => i % 2
    ? <mark key={i} className="rounded-sm bg-gold/25 text-inherit">{part}</mark>
    : <Fragment key={i}>{part}</Fragment>)}</>;
}

export function SearchButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !isTyping(event))) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} onPointerEnter={() => void loadIndex()} aria-label="Search docs"
        className="flex h-9 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-sm text-muted hover:border-muted/40 hover:text-fg sm:w-56">
        <SearchIcon />
        <span className="hidden sm:inline">Search docs</span>
        <kbd className="ml-auto hidden rounded border border-line px-1.5 font-sans text-[0.7rem] sm:inline">Ctrl K</kbd>
      </button>
      {/* Rendered into <body>: the header's backdrop-filter makes it the containing block of any fixed element
          inside it, which would shrink the full-screen overlay to the header's height. */}
      {open && createPortal(<SearchDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<SearchEntry[]>();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const words = useMemo(() => query.toLowerCase().split(/\s+/u).filter(Boolean), [query]);
  const results = useMemo(() => entries ? find(entries, query) : [], [entries, query]);

  useEffect(() => {
    input.current?.focus();
    void loadIndex().then(setEntries);
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${scrollbar}px`;
    return () => { document.body.style.overflow = ''; document.body.style.paddingRight = ''; };
  }, []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => { list.current?.querySelector(`#search-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const go = (result: Result | undefined) => {
    if (!result) return;
    onClose();
    void navigate({ to: '/docs/$/', params: { _splat: result.entry.slug }, ...(result.entry.id ? { hash: result.entry.id } : {}) });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); go(results[active]); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Search the documentation"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-raised shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <SearchIcon />
          <input ref={input} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
            placeholder="Search the documentation" aria-label="Search the documentation"
            role="combobox" aria-expanded={results.length > 0} aria-controls="search-results" aria-autocomplete="list"
            aria-activedescendant={results[active] ? `search-${active}` : undefined}
            className="h-12 w-full bg-transparent text-[0.95rem] text-fg outline-none placeholder:text-muted" />
          <kbd className="rounded border border-line px-1.5 text-[0.7rem] text-muted">Esc</kbd>
        </div>
        <ul ref={list} id="search-results" role="listbox" className="max-h-[65vh] overflow-y-auto p-2">
          {!entries && query && <li className="px-3 py-6 text-center text-sm text-muted">Loading…</li>}
          {entries && query && !results.length && <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches “{query}”.</li>}
          {!query && <li className="px-3 py-6 text-center text-sm text-muted">Search every page of the documentation.</li>}
          {results.map((result, i) => (
            <li key={`${result.entry.slug}#${result.entry.id}`} id={`search-${i}`} role="option" aria-selected={i === active}
              onMouseMove={() => setActive(i)} onClick={() => go(result)}
              className={`cursor-pointer rounded-lg px-3 py-2.5 ${i === active ? 'bg-primary/10' : ''}`}>
              <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
                <span className={`text-sm font-medium ${i === active ? 'text-primary' : 'text-fg'}`}>
                  <Highlighted text={result.entry.title} words={words} />
                </span>
                <span className="text-xs text-muted sm:truncate">
                  {result.entry.id ? `${result.entry.page} · ` : ''}{result.entry.section}
                </span>
              </div>
              {result.snippet && (
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted"><Highlighted text={result.snippet} words={words} /></p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

function isTyping(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
