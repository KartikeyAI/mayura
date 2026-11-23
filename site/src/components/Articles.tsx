import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { articles, type Article, type ArticleSummary, type Section } from 'virtual:mayura-content';
import { formatDate, sectionOrder, sections } from '../lib/content';
import { site } from '../lib/site';
import { OnThisPage } from './DocView';
import { Html } from './Html';

const articleLink = (entry: ArticleSummary) => ({ to: `/${entry.section}/$slug/` as '/guides/$slug/', params: { slug: entry.slug } });

/** Every article in one place, newest first: a search box, a filter per kind, and the latest article first. */
export function ArticleHub({ initial = 'all' }: { initial?: Section | 'all' }) {
  const [kind, setKind] = useState<Section | 'all'>(initial);
  const [query, setQuery] = useState('');
  const all = sectionOrder.flatMap(section => articles[section]).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (entry: ArticleSummary) => terms.every(term => `${entry.title} ${entry.description} ${entry.tags.join(' ')} ${sections[entry.section].title}`.toLowerCase().includes(term));
  const visible = all.filter(entry => (kind === 'all' || entry.section === kind) && matches(entry));
  const [first, ...rest] = visible;
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-medium text-primary">Articles</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">
          Guides, comparisons and research
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">
          End-to-end builds, setups for the stacks people use, honest comparisons with other ways to build agents, and
          long-form writing on how Mayura works.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
            {(['all', ...sectionOrder] as const).map(item => {
              const count = (item === 'all' ? all : articles[item]).filter(matches).length;
              return (
                <button key={item} type="button" onClick={() => setKind(item)} aria-pressed={kind === item}
                  className={`rounded-full border px-3 py-1 text-sm transition ${kind === item ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:text-fg'}`}>
                  {item === 'all' ? 'All' : sections[item].title} <span className="ml-0.5 font-mono text-xs opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
          <label className="block sm:w-72">
            <span className="sr-only">Search articles</span>
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search articles"
              className="w-full rounded-xl border border-line bg-raised px-4 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none" />
          </label>
        </div>
        <p className="sr-only" aria-live="polite">{visible.length} articles shown</p>
        {!first
          ? <p className="mt-14 text-muted">No articles match. Try another word, or show all kinds.</p>
          : (
            <>
              <Link {...articleLink(first)} className="group mt-10 grid gap-6 rounded-3xl border border-line bg-raised p-7 transition hover:border-muted/40 sm:p-10 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-end">
                <div>
                  <Kind entry={first} />
                  <h2 className="mt-4 text-2xl font-semibold tracking-tight text-balance group-hover:text-primary sm:text-3xl">{first.title}</h2>
                  <p className="mt-3 max-w-2xl leading-relaxed text-pretty text-muted">{first.description}</p>
                  {first.tags.length > 0 && <Tags tags={first.tags} />}
                </div>
                <div className="lg:text-right"><ArticleMeta entry={first} /></div>
              </Link>
              {rest.length > 0 && (
                <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rest.map(entry => (
                    <li key={`${entry.section}/${entry.slug}`}>
                      <Link {...articleLink(entry)} className="group flex h-full flex-col rounded-2xl border border-line bg-raised p-6 transition hover:border-muted/40">
                        <Kind entry={entry} />
                        <h2 className="mt-3 text-lg font-semibold tracking-tight text-balance group-hover:text-primary">{entry.title}</h2>
                        <p className="mt-2 flex-1 text-sm leading-relaxed text-pretty text-muted">{entry.description}</p>
                        <div className="mt-4"><ArticleMeta entry={entry} /></div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
      </div>
    </main>
  );
}

function Kind({ entry }: { entry: ArticleSummary }) {
  return <span className="inline-block w-fit self-start rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary first-letter:uppercase">{sections[entry.section].noun}</span>;
}

/** One article, laid out like a docs page, with its date and reading time. */
export function ArticleView({ article }: { article: Article }) {
  const meta = sections[article.section];
  const others = articles[article.section].filter(entry => entry.slug !== article.slug).slice(0, 2);
  return (
    <div className="mx-auto max-w-[90rem] px-4 sm:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-12">
      <article className="mx-auto w-full max-w-3xl min-w-0 py-10 lg:py-14">
        <Link to="/articles/" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          Articles <span aria-hidden="true" className="text-muted">/</span> <span className="text-muted">{meta.title}</span>
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-[2.4rem] sm:leading-[1.15]">{article.title}</h1>
        <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">{article.description}</p>
        <div className="mt-5 border-b border-line pb-6"><ArticleMeta entry={article} /></div>
        <Html html={article.html} className="doc mt-8" />

        <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm">
          <a href={`${site.repository}/edit/main/${article.file}`} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg">
            Edit this {meta.noun} on GitHub
          </a>
          <Link to="/articles/" className="text-muted hover:text-fg">All articles</Link>
        </div>
        {others.length > 0 && (
          <nav aria-label={`More ${meta.title.toLowerCase()}`} className="mt-6 grid gap-3 sm:grid-cols-2">
            {others.map(entry => (
              <Link key={entry.slug} {...articleLink(entry)} className="rounded-xl border border-line px-4 py-3 hover:border-primary/60">
                <span className="block text-xs text-muted">Next {meta.noun}</span>
                <span className="font-medium text-fg">{entry.title}</span>
              </Link>
            ))}
          </nav>
        )}
      </article>
      {article.headings.length > 1 && <OnThisPage headings={article.headings} />}
    </div>
  );
}

function ArticleMeta({ entry }: { entry: ArticleSummary }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <time dateTime={entry.date}>{formatDate(entry.date)}</time>
      {entry.updated && entry.updated !== entry.date && <><span aria-hidden="true">·</span><span>Updated <time dateTime={entry.updated}>{formatDate(entry.updated)}</time></span></>}
      <span aria-hidden="true">·</span>
      <span>{entry.minutes} min read</span>
    </p>
  );
}

function Tags({ tags }: { tags: string[] }) {
  return (
    <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Topics">
      {tags.map(tag => <li key={tag} className="rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-muted">{tag}</li>)}
    </ul>
  );
}
