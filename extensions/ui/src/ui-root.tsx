import type { ComponentPropsWithRef } from 'react';

export interface UiRootProps extends ComponentPropsWithRef<'div'> {
  readonly theme?: 'light' | 'dark';
}

/** Scope the packaged UI styles and theme to this part of the host application. */
export function UiRoot({ theme = 'light', className, ...props }: UiRootProps) {
  return <div {...props} className={className ? 'mayura-ui ' + className : 'mayura-ui'} data-theme={theme} />;
}
