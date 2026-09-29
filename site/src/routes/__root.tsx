/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { NotFound } from '../components/NotFound';
import { themeScript } from '../components/ThemeToggle';
import { asset, site } from '../lib/site';
import styles from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#0a756f' },
      { title: `${site.name}: ${site.tagline}` },
      { name: 'description', content: site.description },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      { rel: 'icon', href: asset('favicon.svg'), type: 'image/svg+xml' },
    ],
    scripts: [{ children: themeScript }],
  }),
  shellComponent: Shell,
  component: Outlet,
  notFoundComponent: NotFound,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen font-sans">
        <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-on-primary">
          Skip to content
        </a>
        <Header />
        <div id="content">{children}</div>
        <Footer />
        <Scripts />
      </body>
    </html>
  );
}
