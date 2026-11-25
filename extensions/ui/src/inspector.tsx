'use client';

import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './ui.js';
export interface InspectorProps {
  readonly id: string;
  readonly title: string;
  readonly mobile: boolean;
  readonly contentKey?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const inspectorFrame = 'inspector-frame [--inspector-gutter:clamp(1.25rem,2.4vw,1.75rem)] flex flex-col '
  + '[min-block-size:0] [min-inline-size:0] bg-[var(--color-paper)] text-[var(--color-ink)]';

/** Share the inspector content between the desktop rail and a modal mobile sheet. */
export function Inspector({ id, title, mobile, contentKey, onClose, children }: InspectorProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const sheet = dialog.current;
    if (sheet && !sheet.open) sheet.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (sheet?.open) sheet.close();
    };
  }, [mobile]);

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [contentKey, title]);

  const content = <>
    <div className={'inspector-header flex [min-block-size:4.5rem] flex-none items-center justify-between gap-3 px-[var(--inspector-gutter)] py-3.5'
      + (mobile ? ' [padding-block-start:max(0.875rem,env(safe-area-inset-top))]' : '')}>
      <h2 id={titleId} className="min-w-0 [overflow-wrap:anywhere] text-[19px] font-semibold leading-snug tracking-[-0.02em]">
        {title}
      </h2>
      <button ref={closeButton} type="button" aria-label="Close inspector" onClick={onClose}
        className="motion-button grid size-9 shrink-0 place-items-center rounded-lg text-[var(--color-secondary)] hover:bg-[var(--color-wash)] motion-safe:[transition:transform_var(--motion-fast)_var(--ease-out),background-color_var(--motion-fast)_ease,color_var(--motion-fast)_ease] motion-safe:enabled:active:[transform:scale(.98)]">
        <Icon name="close" size={17} />
      </button>
    </div>
    <div ref={scroller} role="region" aria-label="Inspector content" tabIndex={0}
      className={'inspector-scroll [min-block-size:0] flex-1 overflow-auto overscroll-contain px-[var(--inspector-gutter)] '
        + '[padding-block:0.5rem_1.75rem] [scrollbar-color:var(--color-line-strong)_transparent] [scrollbar-width:thin] focus-visible:outline-offset-[-3px]'
        + (mobile ? ' [padding-block-end:max(1.75rem,env(safe-area-inset-bottom))]' : '')}>
      {children}
    </div>
  </>;

  if (mobile) {
    return <dialog ref={dialog} id={id} aria-labelledby={titleId}
      className={inspectorFrame + ' inspector-sheet fixed inset-0 m-0 [block-size:100dvh] [inline-size:100%] '
        + '[max-block-size:none] [max-inline-size:none] overflow-hidden border-0 p-0 [&:not([open])]:hidden backdrop:bg-[var(--color-canvas)] '
        + '[transition:opacity_var(--motion-enter)_var(--ease-out),transform_var(--motion-enter)_var(--ease-out)] '
        + 'motion-safe:starting:open:opacity-70 motion-safe:starting:open:[transform:translateY(0.5rem)]'}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}>
      {content}
    </dialog>;
  }

  return <aside id={id} aria-labelledby={titleId}
    className={inspectorFrame + ' inspector-rail flex-[0_0_clamp(18.75rem,29vw,25rem)] '
      + '[border-inline-start:1px_solid_var(--color-line)] [transition:opacity_var(--motion-enter)_var(--ease-out)] motion-safe:starting:opacity-0'}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }}>
    {content}
  </aside>;
}
