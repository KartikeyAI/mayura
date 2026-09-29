import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Sidebar } from '../../components/Sidebar';

export const Route = createFileRoute('/docs')({ component: DocsLayout });

function DocsLayout() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="mx-auto max-w-[90rem] px-4 sm:px-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain py-10 pr-3 lg:block">
        <Sidebar />
      </aside>

      <div className="sticky top-16 z-30 -mx-4 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 lg:hidden">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="docs-menu"
          className="flex items-center gap-2 rounded-md py-1 text-sm text-muted hover:text-fg">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d={open ? 'M6 6l12 12M18 6 6 18' : 'M4 7h16M4 12h16M4 17h16'} strokeLinecap="round" />
          </svg>
          Menu
        </button>
      </div>
      {open && (
        <div id="docs-menu" className="fixed inset-x-0 top-[6.75rem] bottom-0 z-30 overflow-y-auto bg-bg px-4 py-6 sm:px-6 lg:hidden">
          <Sidebar />
        </div>
      )}

      <main className="min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
