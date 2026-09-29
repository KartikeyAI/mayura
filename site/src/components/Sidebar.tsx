import { Link } from '@tanstack/react-router';
import { sections } from 'virtual:mayura-docs';

/** Every docs page, in the order and sections of docs/README.md. */
export function Sidebar() {
  return (
    <nav aria-label="Documentation" className="space-y-7 text-sm">
      <Link to="/docs/" activeOptions={{ exact: true }} className="block font-medium text-muted hover:text-fg"
        activeProps={{ className: '!text-primary' }}>
        All pages
      </Link>
      {sections.map(section => (
        <div key={section.title}>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-fg uppercase">{section.title}</h2>
          <ul className="space-y-px border-l border-line">
            {section.pages.map(page => (
              <li key={page.slug}>
                <Link to="/docs/$/" params={{ _splat: page.slug }}
                  className="-ml-px block border-l border-transparent py-1.5 pl-3.5 text-muted hover:border-muted/50 hover:text-fg"
                  activeProps={{ className: '!border-primary !text-primary font-medium' }}>
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
