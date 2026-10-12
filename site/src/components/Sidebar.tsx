import { Link, useLocation } from '@tanstack/react-router';
import { sections, type NavSection } from 'virtual:mayura-docs';

const INTEGRATIONS = 'Integrations: ';

/** Every docs page, in the order and sections of docs/README.md; the per-package pages fold into one Integrations group. */
export function Sidebar() {
  const { pathname } = useLocation();
  const inIntegrations = pathname.includes('/docs/integrations/');
  const integrations = sections.filter(section => section.title.startsWith(INTEGRATIONS));
  const firstIntegration = sections.findIndex(section => section.title.startsWith(INTEGRATIONS));
  return (
    <nav aria-label="Documentation" className="space-y-7 text-sm">
      <Link to="/docs/" activeOptions={{ exact: true }} className="block font-medium text-muted hover:text-fg"
        activeProps={{ className: '!text-primary' }}>
        All pages
      </Link>
      {sections.map((section, index) => {
        if (section.title.startsWith(INTEGRATIONS)) {
          if (index !== firstIntegration) return null;
          return (
            <details key="integrations" open={inIntegrations} className="group">
              <summary className="mb-2 flex cursor-pointer list-none items-center justify-between text-xs font-semibold tracking-wide text-fg uppercase">
                Integrations
                <svg viewBox="0 0 24 24" className="size-3.5 text-muted transition group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </summary>
              <div className="space-y-5">
                {integrations.map(group => <Group key={group.title} section={group} title={group.title.slice(INTEGRATIONS.length)} small />)}
              </div>
            </details>
          );
        }
        return <Group key={section.title} section={section} title={section.title} />;
      })}
    </nav>
  );
}

function Group({ section, title, small }: { section: NavSection; title: string; small?: boolean }) {
  return (
    <div>
      <h2 className={small ? 'mb-1.5 text-xs font-medium text-muted' : 'mb-2 text-xs font-semibold tracking-wide text-fg uppercase'}>{title}</h2>
      <ul className="space-y-px border-l border-line">
        {section.pages.map(page => (
          <li key={page.slug}>
            <Link to="/docs/$/" params={{ _splat: page.slug }}
              className="-ml-px block border-l border-transparent py-1.5 pl-3.5 text-muted hover:border-muted/50 hover:text-fg"
              activeProps={{ className: '!border-primary !text-primary font-medium' }}>
              {page.integration?.vendor && small ? page.integration.vendor : page.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
