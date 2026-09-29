import { useRouter } from '@tanstack/react-router';
import type { MouseEvent } from 'react';

/**
 * Prerendered HTML (a docs page or a highlighted snippet). Copy buttons in its code blocks work, and links to other
 * pages of the site navigate in place instead of reloading.
 */
export function Html({ html, className }: { html: string; className?: string }) {
  const router = useRouter();

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      const code = copy.parentElement?.querySelector('pre')?.textContent ?? '';
      void navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = 'Copied';
        copy.dataset['copied'] = '';
        setTimeout(() => { copy.textContent = 'Copy'; delete copy.dataset['copied']; }, 1500);
      });
      return;
    }
    const link = target.closest('a');
    if (!link || link.target || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(import.meta.env.BASE_URL)) return;
    if (url.pathname === location.pathname) return; // an anchor on this page: the browser scrolls to it
    event.preventDefault();
    router.history.push(url.pathname + url.search + url.hash);
  };

  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
