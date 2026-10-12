import { Link, useLocation } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { site } from '../lib/site';
import { Logo } from './Logo';
import { SearchButton } from './Search';
import { ThemeToggle } from './ThemeToggle';

const items = [
  { label: 'Docs', link: { to: '/docs/$/' as const, params: { _splat: 'introduction' } }, prefix: '/docs' },
  { label: 'Articles', link: { to: '/articles/' as const }, prefix: '/articles' },
  { label: 'Integrations', link: { to: '/integrations/' as const }, prefix: '/integrations' },
  { label: 'Roadmap', link: { to: '/roadmap/' as const }, prefix: '/roadmap' },
];

export function Header() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  const path = pathname.replace(import.meta.env.BASE_URL.replace(/\/$/u, ''), '');
  // Articles live under their kind's address (/guides/..., /compare/...); the Articles item covers them too.
  const current = (prefix: string) => path.startsWith(prefix) || (prefix === '/articles' && /^\/(?:guides|compare|research)\//u.test(path));
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[90rem] items-center gap-4 px-4 sm:px-6">
        <Link to="/" aria-label="Mayura home" className="shrink-0"><Logo /></Link>
        <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[0.7rem] text-muted md:inline">
          v{site.version}
        </span>
        <nav aria-label="Main" className="ml-2 hidden items-center gap-1 text-sm md:flex">
          {items.map(item => (
            <Link key={item.label} {...item.link} aria-current={current(item.prefix) ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1.5 ${current(item.prefix) ? 'font-medium text-fg' : 'text-muted hover:text-fg'}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <SearchButton />
          <a href={site.repository} target="_blank" rel="noopener noreferrer" aria-label="Mayura on GitHub"
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-soft hover:text-fg">
            <GitHubIcon />
          </a>
          <ThemeToggle />
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="main-menu" aria-label="Menu"
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-soft hover:text-fg md:hidden">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d={open ? 'M6 6l12 12M18 6 6 18' : 'M4 7h16M4 12h16M4 17h16'} strokeLinecap="round" />
            </svg>
          </button>
          <Link to="/docs/$/" params={{ _splat: 'quickstart' }}
            className="ml-1 hidden rounded-lg bg-fg px-3.5 py-1.5 text-sm font-medium text-bg transition hover:opacity-85 sm:block">
            Get started
          </Link>
        </div>
      </div>
      {open && (
        <nav id="main-menu" aria-label="Main" className="border-t border-line px-4 py-3 md:hidden">
          <ul className="space-y-1">
            {items.map(item => (
              <li key={item.label}>
                <Link {...item.link} aria-current={current(item.prefix) ? 'page' : undefined}
                  className={`block rounded-lg px-3 py-2.5 text-base ${current(item.prefix) ? 'bg-soft font-medium text-fg' : 'text-muted hover:text-fg'}`}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}

export function GitHubIcon({ className = 'size-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
