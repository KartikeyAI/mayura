import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { uiCatalog } from '../lib/ui-catalog';
import { Icon } from './Icon';
import { UiComponentPreview } from './UiComponentPreview';
import './ui-library.css';

const filters = ['All', 'Conversation', 'Run controls', 'Integration'] as const;

export function UiCatalog() {
  const [category, setCategory] = useState<(typeof filters)[number]>('All');
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const components = uiCatalog.filter(item =>
    (category === 'All' || item.category === category) &&
    `${item.title} ${item.slug} ${item.description}`.toLowerCase().includes(search));

  return (
    <main className="ui-library mx-auto max-w-[82rem] px-5 pt-8 pb-20 sm:px-8 sm:pt-10 lg:px-12">
      <section className="ui-gallery-intro" aria-labelledby="ui-gallery-title">
        <div className="ui-gallery-intro-copy">
          <p className="ui-library-package">@mayurajs/ui</p>
          <h1 id="ui-gallery-title">Components for<br className="hidden lg:block" /> agent interfaces.</h1>
          <p className="ui-gallery-lead">Start with Agent Workspace or compose your own interface. Install the React package or copy editable Tailwind components with shadcn.</p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link to="/ui/$slug/" params={{ slug: 'chat-workspace' }} className="ui-library-action ui-library-action-primary">
              Explore Agent Workspace <Icon name="arrow" className="size-4" />
            </Link>
            <Link to="/docs/$/" params={{ _splat: 'integrations/ui' }} className="ui-library-text-link">
              Installation guide
            </Link>
          </div>
        </div>
        <div className="ui-gallery-feature" aria-hidden="true" inert>
          <div className="ui-gallery-feature-preview">
            <UiComponentPreview slug="composer" variant="featured" />
          </div>
        </div>
      </section>

      <section className="mt-11 sm:mt-12" aria-labelledby="ui-library-components">
        <h2 id="ui-library-components" className="text-[1.65rem] font-semibold tracking-[-0.035em]">Browse components</h2>
        <div className="ui-catalog-controls">
          <div className="ui-catalog-filters" role="group" aria-label="Component category">
            {filters.map(filter => (
              <button key={filter} type="button" aria-pressed={category === filter} onClick={() => setCategory(filter)}>
                {filter}
              </button>
            ))}
          </div>
          <label className="ui-library-search">
            <span className="sr-only">Search components</span>
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search components…" />
          </label>
        </div>
        <p className="sr-only" role="status">{components.length} {components.length === 1 ? 'component' : 'components'}</p>
        {components.length ? (
          <ul className="ui-catalog-grid">
            {components.map(item => (
              <li className="ui-catalog-card" key={item.slug}>
                <div className={`ui-catalog-thumbnail ui-catalog-thumbnail--${item.slug}`} inert aria-hidden="true">
                  <UiComponentPreview slug={item.slug} variant="thumbnail" />
                </div>
                <div className="ui-catalog-card-copy">
                  <h3><Link to="/ui/$slug/" params={{ slug: item.slug }}>{item.title}</Link></h3>
                  <p>{item.description}</p>
                  <Icon name="arrow" className="ui-catalog-card-arrow size-4" />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ui-catalog-empty">
            <p>No components match your search.</p>
            <button type="button" className="ui-library-text-link mt-2" onClick={() => { setQuery(''); setCategory('All'); }}>Clear filters</button>
          </div>
        )}
      </section>
      <div className="ui-catalog-legacy">
        <div>
          <h2 className="font-semibold tracking-tight">Mayura CLI copy-in</h2>
          <p className="mt-1 text-sm text-muted">Browse the original components available through <code>mayura add ui</code>.</p>
        </div>
        <Link to="/ui/copy-in/" className="ui-library-action">
          Browse copy-in previews <Icon name="arrow" className="size-4" />
        </Link>
      </div>
    </main>
  );
}
