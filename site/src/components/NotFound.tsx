import { Link } from '@tanstack/react-router';

export function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-32 text-center">
      <p className="font-mono text-sm text-gold">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">This page doesn’t exist</h1>
      <p className="mt-3 text-muted">It may have moved when the documentation was reorganized. Search the docs, or start from the top.</p>
      <div className="mt-8 flex gap-3">
        <Link to="/" className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-soft">Home</Link>
        <Link to="/docs/" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover">Documentation</Link>
      </div>
    </main>
  );
}
