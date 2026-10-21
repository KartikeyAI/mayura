import './ui.css';
/** Only a host-validated released screenshot URL is displayed; remote browser sessions are never embedded. */
export function BrowserView({ screenshot, allowedOrigin, title = 'Browser view' }: { readonly screenshot?: string; readonly allowedOrigin: string; readonly title?: string }) {
  let source: string | undefined; try { const url = new URL(screenshot || ''); if (url.protocol === 'https:' && url.origin === allowedOrigin && !url.username && !url.password) source = url.href; } catch { /* An absent image has a useful empty state. */ }
  return <figure className="mayura-ui">{source ? <img src={source} alt={title.slice(0,500)} loading="lazy" referrerPolicy="no-referrer" style={{ maxWidth: '100%' }} /> : <p>No released screenshot.</p>}<figcaption>{title.slice(0,500)}</figcaption></figure>;
}
