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
    <div className="inspector-header">
      <h2 id={titleId} className="min-w-0 [overflow-wrap:anywhere] text-[19px] font-semibold leading-snug tracking-[-0.02em]">
        {title}
      </h2>
      <button ref={closeButton} type="button" aria-label="Close inspector" onClick={onClose}
        className="motion-button grid size-9 shrink-0 place-items-center rounded-lg text-secondary hover:bg-wash">
        <Icon name="close" size={17} />
      </button>
    </div>
    <div ref={scroller} className="inspector-scroll" role="region" aria-label="Inspector content" tabIndex={0}>
      {children}
    </div>
  </>;

  if (mobile) {
    return <dialog ref={dialog} id={id} aria-labelledby={titleId} className="inspector-frame inspector-sheet"
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}>
      {content}
    </dialog>;
  }

  return <aside id={id} aria-labelledby={titleId} className="inspector-frame inspector-rail"
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }}>
    {content}
  </aside>;
}
