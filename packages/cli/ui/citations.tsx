import './ui.css';
/** The host supplies released citations; unsafe URL schemes and embedded credentials are never links. */
export function Citations({ sources }: { readonly sources: readonly { readonly id: string; readonly title: string; readonly url?: string }[] }) {
  function href(value?: string) { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } }
  return <section className="mayura-ui" aria-label="Sources"><h3>Sources</h3><ol>{sources.slice(0,64).map((source,index) => <li key={`${source.id}-${index}`}>
    {href(source.url) ? <a href={href(source.url)} target="_blank" rel="noopener noreferrer">{source.title.slice(0,500)}</a> : source.title.slice(0,500)}</li>)}</ol></section>;
}
