import { createFileRoute } from '@tanstack/react-router';
import { UiGallery } from '../components/UiGallery';
import { pageMeta } from '../lib/site';
export const Route = createFileRoute('/ui')({ head:() => pageMeta({ title:'Copy-in UI components · Mayura',description:'Accessible source components you own: chat, threads, approvals, tools, citations and more.',path:'/ui/' }),component:Gallery });
function Gallery() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <p className="text-sm font-medium text-primary">UI gallery</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl">Make the conversation yours.</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-muted">Copy accessible components into your project. Keep your styles, your application state and every approval decision. These previews use local fixtures.</p>
        <div className="mt-12"><UiGallery /></div>
      </div>
    </main>
  );
}
