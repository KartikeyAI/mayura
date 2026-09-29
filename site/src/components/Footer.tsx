import { Link } from '@tanstack/react-router';
import { sectionOrder, sections } from '../lib/content';
import { asset, site } from '../lib/site';
import { Logo } from './Logo';

const columns = [
  { title: 'Learn', links: [
    { label: 'Introduction', slug: 'introduction' },
    { label: 'Quickstart', slug: 'quickstart' },
    { label: 'Concepts', slug: 'concepts/agent' },
    { label: 'Durable workflows', slug: 'guides/durable-workflows' },
  ] },
  { title: 'Build', links: [
    { label: 'Model providers', slug: 'guides/model-providers' },
    { label: 'Server and client', slug: 'guides/server-and-client' },
    { label: 'Deployment', slug: 'guides/deployment' },
    { label: 'CLI', slug: 'cli/overview' },
  ] },
  { title: 'Project', links: [
    { label: 'Versioning', slug: 'project/versioning' },
    { label: 'Security model', slug: 'project/security' },
    { label: 'Credits', slug: 'project/credits' },
    { label: 'Supported platforms', slug: 'project/support' },
    { label: 'AI coding agents', slug: 'ai-agents' },
  ] },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-soft/60">
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm leading-relaxed text-muted">
            A TypeScript framework for AI agents, typed tools and durable workflows. Open source under Apache-2.0.
          </p>
          <div className="flex gap-4 text-sm">
            <a className="text-muted hover:text-fg" href={site.repository} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a className="text-muted hover:text-fg" href={site.npm} target="_blank" rel="noopener noreferrer">npm</a>
            <a className="text-muted hover:text-fg" href={asset('llms.txt')}>llms.txt</a>
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold text-fg">Resources</h2>
          <ul className="space-y-2 text-sm">
            {sectionOrder.map(section => (
              <li key={section}>
                <Link to={`/${section}/` as '/guides/'} className="text-muted hover:text-fg">{sections[section].title}</Link>
              </li>
            ))}
          </ul>
        </div>
        {columns.map(column => (
          <div key={column.title}>
            <h2 className="mb-3 text-sm font-semibold text-fg">{column.title}</h2>
            <ul className="space-y-2 text-sm">
              {column.links.map(link => (
                <li key={link.slug}>
                  <Link to="/docs/$/" params={{ _splat: link.slug }} className="text-muted hover:text-fg">{link.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-[90rem] px-4 py-5 text-xs text-muted sm:px-6">
          Mayura {site.version}. Licensed under Apache-2.0.
        </p>
      </div>
    </footer>
  );
}
