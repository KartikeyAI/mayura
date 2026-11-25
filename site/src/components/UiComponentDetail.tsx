import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import detailCode from 'virtual:mayura-ui-detail-code';
import { site } from '../lib/site';
import { uiCatalog, type UiSlug } from '../lib/ui-catalog';
import { Html } from './Html';
import { Icon } from './Icon';
import { UiComponentPreview } from './UiComponentPreview';
import './ui-library.css';

const sections = [
  ['preview', 'Preview'],
  ['installation', 'Installation'],
  ['usage', 'Usage'],
  ['api-reference', 'API reference'],
] as const;

function Tabs({ id, label, options, active, change }: {
  id: string; label: string; options: readonly string[]; active: number; change: (index: number) => void;
}) {
  return (
    <div className="ui-library-tabs" role="tablist" aria-label={label}>
      {options.map((name, index) => (
        <button key={name} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
          aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => change(index)}
          onKeyDown={event => {
            const target = {
              ArrowLeft: (index + options.length - 1) % options.length,
              ArrowRight: (index + 1) % options.length,
              Home: 0,
              End: options.length - 1,
            }[event.key];
            if (target === undefined) return;
            event.preventDefault();
            change(target);
            document.getElementById(`${id}-tab-${target}`)?.focus();
          }}>
          {name}
        </button>
      ))}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState('');
  return (
    <button type="button" className="ui-library-copy" aria-label={label} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setStatus('Copied');
      } catch {
        setStatus('Copy unavailable');
      }
    }}>
      <span aria-live="polite">{status || 'Copy'}</span>
    </button>
  );
}

function Code({ text, html, label }: { text: string; html?: string; label: string }) {
  return (
    <div className="ui-library-code">
      <div className="ui-library-code-header">
        <span>{label}</span>
        <CopyButton key={text} label={`Copy ${label}`} text={text} />
      </div>
      {html ? <Html html={html} /> : <pre><code>{text}</code></pre>}
    </div>
  );
}

function ComponentLinks({ slug }: { slug: UiSlug }) {
  return (
    <nav className="ui-detail-components" aria-label="UI components">
      {uiCatalog.map(item => (
        <Link key={item.slug} to="/ui/$slug/" params={{ slug: item.slug }} aria-current={item.slug === slug ? 'page' : undefined}>
          {item.title}
        </Link>
      ))}
    </nav>
  );
}

export function UiComponentDetail({ slug }: { slug: UiSlug }) {
  const item = uiCatalog.find(component => component.slug === slug)!;
  const code = detailCode[slug]!;
  const [preview, setPreview] = useState(0);
  const [install, setInstall] = useState(1);
  const previewId = useId();
  const installId = useId();
  const index = uiCatalog.findIndex(component => component.slug === slug);
  const previous = uiCatalog[index - 1];
  const next = uiCatalog[index + 1];

  return (
    <main className="ui-library ui-detail">
      <aside className="ui-detail-sidebar">
        <Link to="/ui/" className="ui-detail-back">
          <Icon name="arrow" className="size-4 rotate-180" /> UI gallery
        </Link>
        <ComponentLinks slug={slug} />
        <Link to="/ui/copy-in/" className="ui-detail-copy-in">Mayura CLI copy-in</Link>
      </aside>

      <article className="ui-detail-content">
        <div className="ui-detail-mobile">
          <Link to="/ui/" className="ui-detail-back"><Icon name="arrow" className="size-4 rotate-180" /> UI gallery</Link>
          <details>
            <summary>Components</summary>
            <ComponentLinks slug={slug} />
          </details>
        </div>
        <header className="ui-detail-header">
          <Link to="/docs/$/" params={{ _splat: 'integrations/ui' }} className="ui-library-package">@mayurajs/ui</Link>
          <h1>{item.title}</h1>
          <p>{item.description}</p>
        </header>

        <section id="preview" className="ui-detail-preview" aria-label="Component preview">
          <div className="ui-detail-preview-toolbar">
            <Tabs id={previewId} label="Example view" options={['Preview', 'Code']} active={preview} change={setPreview} />
            {preview === 0 && <span className="ui-detail-fixture"><span aria-hidden="true" /> Local demo</span>}
          </div>
          <div role="tabpanel" tabIndex={0} id={`${previewId}-panel-0`} aria-labelledby={`${previewId}-tab-0`} hidden={preview !== 0}>
            <div className="ui-detail-stage" data-component={slug}><UiComponentPreview slug={slug} /></div>
          </div>
          <div role="tabpanel" tabIndex={0} id={`${previewId}-panel-1`} aria-labelledby={`${previewId}-tab-1`} hidden={preview !== 1}>
            <Code text={item.usage} html={code.usageHtml} label="example.tsx · v1.4 npm" />
          </div>
        </section>

        <section id="installation" className="ui-detail-section">
          <h2>Installation</h2>
          <Tabs id={installId} label="Installation method" options={['npm package', 'shadcn registry']} active={install} change={setInstall} />
          <div role="tabpanel" tabIndex={0} id={`${installId}-panel-0`} aria-labelledby={`${installId}-tab-0`} hidden={install !== 0} className="mt-3">
            <p>The npm examples target v1.4. For the existing v1.3 components, see the <Link to="/docs/$/" params={{ _splat: 'integrations/ui' }} hash="compiled-css-for-existing-components">compiled stylesheet setup</Link>.</p>
            <Code text="npm install @mayurajs/ui@1.4 react@19 react-dom@19" label="terminal" />
            <p>In a Tailwind v4 app, add the Mayura theme import after Tailwind in your global stylesheet.</p>
            <Code text={'@import "tailwindcss";\n@import "@mayurajs/ui/tailwind.css";'} label="global.css" />
            <p>For other CSS toolchains, import the compiled fallback once at your app entry. Mayura is an optional peer.</p>
            <Code text="import '@mayurajs/ui/styles.css';" label="app entry · compiled fallback" />
          </div>
          <div role="tabpanel" tabIndex={0} id={`${installId}-panel-1`} aria-labelledby={`${installId}-tab-1`} hidden={install !== 1} className="mt-3">
            <p>In a React 19 app with Tailwind v4 and shadcn initialized, configure the <Link to="/docs/$/" params={{ _splat: 'integrations/ui' }} hash="shadcn-registry">Mayura namespace</Link> in <code>components.json</code>.</p>
            <Code text={`npx shadcn@latest add @mayura/${slug}`} label="terminal" />
            <p>The command copies React files with inline utilities and merges the shared theme into your configured app stylesheet. The imports below use the default shadcn UI alias.</p>
            <Code text={item.registryImports} html={code.registryImportsHtml} label="component imports" />
          </div>
        </section>

        <section id="usage" className="ui-detail-section">
          <h2>Usage</h2>
          <p>This example uses the v1.4 npm imports. For a shadcn install, use the copied component imports above.</p>
          <Code text={item.usage} html={code.usageHtml} label="example.tsx" />
        </section>

        <section id="api-reference" className="ui-detail-section">
          <h2>API reference</h2>
          <div className="ui-detail-api">
            <table>
              <thead><tr><th scope="col">Option</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
              <tbody>
                {item.props.map(prop => (
                  <tr key={prop.name}>
                    <th scope="row"><code>{prop.name}</code></th>
                    <td><code>{prop.type}</code></td>
                    <td>{prop.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="ui-detail-source">
            <summary>Component source</summary>
            <p><a href={`${site.repository}/blob/main/extensions/ui/src/${item.sourceFile}`}>View {item.sourceFile} on GitHub</a></p>
            <Code text={code.source} html={code.sourceHtml} label={item.sourceFile} />
          </details>
        </section>

        <nav className="ui-detail-pagination" aria-label="Adjacent components">
          {previous && (
            <Link to="/ui/$slug/" params={{ slug: previous.slug }} rel="prev">
              <span>Previous</span><span><Icon name="arrow" className="size-4 rotate-180" /> {previous.title}</span>
            </Link>
          )}
          {next && (
            <Link to="/ui/$slug/" params={{ slug: next.slug }} rel="next">
              <span>Next</span><span>{next.title} <Icon name="arrow" className="size-4" /></span>
            </Link>
          )}
        </nav>
      </article>

      <nav aria-label="On this page" className="ui-detail-sections">
        <p>On this page</p>
        {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>
    </main>
  );
}
