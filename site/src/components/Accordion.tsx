import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** Shared site disclosure styling with native keyboard and expanded-state semantics. */
export function Accordion({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-fg">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 font-medium transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        {title}
        <Icon name="arrow" className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <div className="min-w-0 px-6 pb-6">{children}</div>
    </details>
  );
}
