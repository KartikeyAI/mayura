import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { sections, type DocHeading, type DocPage } from 'virtual:mayura-docs';
import { site } from '../lib/site';
import { Html } from './Html';

const order = sections.flatMap(section => section.pages.map(page => ({ ...page, section: section.title })));

export function DocView({ page }: { page: DocPage }) {
  const index = order.findIndex(entry => entry.slug === page.slug);
  const previous = index > 0 ? order[index - 1] : undefined;
  const next = page.slug === 'README' ? order[0] : index >= 0 ? order[index + 1] : undefined;
  const section = order[index]?.section ?? 'Documentation';

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-12">
      <article className="mx-auto w-full max-w-3xl min-w-0 py-10 lg:py-12">
        <p className="mb-2 text-sm font-medium text-primary">{section}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-[2.15rem]">{page.title}</h1>
        {page.description && <p className="mt-3 text-lg leading-relaxed text-pretty text-muted">{page.description}</p>}
        <Html html={page.html} className="doc mt-8" />

        <div className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm">
          <a href={`${site.repository}/edit/main/${page.file}`} target="_blank" rel="noopener noreferrer"
            className="text-muted hover:text-fg">
            Edit this page on GitHub
          </a>
          <a href={`${import.meta.env.BASE_URL}${page.file}`} className="text-muted hover:text-fg">View as Markdown</a>
        </div>
        <nav aria-label="Previous and next pages" className="mt-6 grid gap-3 sm:grid-cols-2">
          {previous ? <PagerLink label="Previous" page={previous} /> : <span />}
          {next && <PagerLink label="Next" page={next} align="right" />}
        </nav>
      </article>
      {page.headings.length > 1 && <OnThisPage headings={page.headings} />}
    </div>
  );
}

function PagerLink({ label, page, align }: { label: string; page: { slug: string; title: string }; align?: 'right' }) {
  return (
    <Link to="/docs/$/" params={{ _splat: page.slug }}
      className={`rounded-xl border border-line px-4 py-3 hover:border-primary/60 ${align === 'right' ? 'text-right sm:col-start-2' : ''}`}>
      <span className="block text-xs text-muted">{label}</span>
      <span className="font-medium text-fg">{page.title}</span>
    </Link>
  );
}

/** The page's sections, with the one being read highlighted. */
function OnThisPage({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState<string>();

  useEffect(() => {
    const elements = headings.map(heading => document.getElementById(heading.id)).filter(element => element !== null);
    const onScroll = () => {
      let current = elements[0]?.id;
      for (const element of elements) if (element.getBoundingClientRect().top < 120) current = element.id;
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [headings]);

  return (
    <aside className="hidden xl:block">
      <nav aria-label="On this page" className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-12 text-sm">
        <h2 className="mb-3 text-xs font-semibold tracking-wide text-fg uppercase">On this page</h2>
        <ul className="space-y-1.5">
          {headings.map(heading => (
            <li key={heading.id} className={heading.depth === 3 ? 'pl-3' : ''}>
              <a href={`#${heading.id}`} dangerouslySetInnerHTML={{ __html: heading.html }}
                className={`block leading-snug [&_code]:text-[0.8em] ${active === heading.id ? 'text-primary' : 'text-muted hover:text-fg'}`} />
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
