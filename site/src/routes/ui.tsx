import { createFileRoute } from '@tanstack/react-router';
import { UiGallery } from '../components/UiGallery';
import { pageMeta } from '../lib/site';
export const Route = createFileRoute('/ui')({ head:() => pageMeta({ title:'Copy-in UI components · Mayura',description:'Accessible source components you own: chat, threads, approvals, tools, citations and more.',path:'/ui/' }),component:Gallery });
function Gallery() { return <main className="mx-auto max-w-6xl px-6 py-16"><p className="mb-4 text-sm uppercase tracking-widest">Source you own</p><h1 className="mb-6 text-5xl font-semibold tracking-tight">Make the conversation yours.</h1><p className="mb-12 max-w-2xl text-lg text-muted">Copy accessible components into your project. Keep your styles, your application state and every approval decision. These previews use local fixtures.</p><UiGallery /></main>; }
