import { Link } from '@tanstack/react-router';
import { articles, type Article, type ArticleSummary, type Section } from 'virtual:mayura-content';
import { formatDate, sectionOrder, sections } from '../lib/content';
import { site } from '../lib/site';
import { OnThisPage } from './DocView';
import { Html } from './Html';

const sectionLink = (section: Section) => ({ to: `/${section}/` as '/guides/' });
const articleLink = (entry: ArticleSummary) => ({ to: `/${entry.section}/$slug/` as '/guides/$slug/', params: { slug: entry.slug } });

/** A section's landing page: what it is for, then every article in it, newest first. */
export function ArticleIndex({ section }: { section: Section }) {
  const meta = sections[section];
  const entries = articles[section];
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <SectionTabs current={section} />
        <h1 className="mt-10 text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">{meta.heading}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">{meta.description}</p>
        {entries.length === 0
          ? <p className="mt-14 text-muted">The first {meta.noun} is on its way.</p>
          : (
            <ul className="mt-14 grid gap-4 sm:grid-cols-2">
              {entries.map(entry => (
                <li key={entry.slug}>
                  <Link {...articleLink(entry)}
                    className="group flex h-full flex-col rounded-2xl border border-line bg-raised p-6 transition hover:border-muted/40">
                    <ArticleMeta entry={entry} />
                    <h2 className="mt-3 text-lg font-semibold tracking-tight text-balance group-hover:text-primary">{entry.title}</h2>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-pretty text-muted">{entry.description}</p>
                    {entry.tags.length > 0 && <Tags tags={entry.tags} />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </div>
    </main>
  );
}

/** One article, laid out like a docs page, with its date and reading time. */
export function ArticleView({ article }: { article: Article }) {
  const meta = sections[article.section];
  const others = articles[article.section].filter(entry => entry.slug !== article.slug).slice(0, 2);
  return (
    <div className="mx-auto max-w-[90rem] px-4 sm:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-12">
      <article className="mx-auto w-full max-w-3xl min-w-0 py-10 lg:py-14">
        <Link {...sectionLink(article.section)} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          {meta.title}
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-[2.4rem] sm:leading-[1.15]">{article.title}</h1>
        <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">{article.description}</p>
        <div className="mt-5 border-b border-line pb-6"><ArticleMeta entry={article} /></div>
        <Html html={article.html} className="doc mt-8" />

        <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm">
          <a href={`${site.repository}/edit/main/${article.file}`} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg">
            Edit this {meta.noun} on GitHub
          </a>
          <Link {...sectionLink(article.section)} className="text-muted hover:text-fg">All {meta.title.toLowerCase()}</Link>
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

/** Links between the four sections, with the current one marked. */
function SectionTabs({ current }: { current: Section }) {
  return (
    <nav aria-label="Resources" className="flex flex-wrap gap-2">
      {sectionOrder.map(section => (
        <Link key={section} {...sectionLink(section)} aria-current={section === current ? 'page' : undefined}
          className={`rounded-full border px-3 py-1 text-sm transition ${section === current ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:text-fg'}`}>
          {sections[section].title}
        </Link>
      ))}
    </nav>
  );
}
