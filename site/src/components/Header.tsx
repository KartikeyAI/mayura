import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { site } from '../lib/site';
import { Logo } from './Logo';
import { SearchButton } from './Search';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[90rem] items-center gap-4 px-4 sm:px-6">
        <Link to="/" aria-label="Mayura home" className="shrink-0"><Logo /></Link>
        <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[0.7rem] text-muted md:inline">
          v{site.version}
        </span>
        <nav className="ml-2 hidden items-center gap-1 text-sm md:flex">
          <HeaderLink to="/docs/$/" params={{ _splat: 'introduction' }}>Docs</HeaderLink>
          <HeaderLink to="/docs/$/" params={{ _splat: 'quickstart' }}>Quickstart</HeaderLink>
          <HeaderLink to="/docs/$/" params={{ _splat: 'reference/entry-points' }}>Reference</HeaderLink>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <SearchButton />
          <a href={site.repository} target="_blank" rel="noopener noreferrer" aria-label="Mayura on GitHub"
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-soft hover:text-fg">
            <GitHubIcon />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ to, params, children }: { to: '/docs/$/'; params: { _splat: string }; children: ReactNode }) {
  return (
    <Link to={to} params={params} className="rounded-md px-2.5 py-1.5 text-muted hover:text-fg"
      activeProps={{ className: 'text-fg font-medium' }}>
      {children}
    </Link>
  );
}

export function GitHubIcon({ className = 'size-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
