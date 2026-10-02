import { MayuraError } from '@mayura/core';

/** A key as `Input.dispatchKeyEvent` takes it. */
export interface KeyDefinition { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string }

const named: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const modifierBits: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** A key press such as `Enter`, `a`, `Control+a` or `Shift+Tab`: the key and its modifiers' bit mask. */
export function parseKeys(value: unknown): { readonly key: KeyDefinition; readonly modifiers: number } {
  const parts = typeof value === 'string' && value.length <= 64 ? value.split('+') : [];
  const last = parts.pop();
  if (last === undefined || parts.some(part => !Object.hasOwn(modifierBits, part))) {
    throw new MayuraError('INVALID_INPUT', 'keys is a key such as Enter, Tab, a or ArrowDown, with modifiers such as Control+a or Shift+Tab.');
  }
  const modifiers = parts.reduce((mask, part) => mask | modifierBits[part]!, 0);
  if (Object.hasOwn(named, last)) return { key: named[last]!, modifiers };
  if (/^[a-zA-Z0-9]$/u.test(last)) {
    const upper = last.toUpperCase();
    return { key: { key: last, code: /\d/u.test(last) ? `Digit${last}` : `Key${upper}`, keyCode: upper.charCodeAt(0), ...(modifiers & ~modifierBits.Shift! ? {} : { text: last }) }, modifiers };
  }
  if (/^[ -~]$/u.test(last)) return { key: { key: last, code: '', keyCode: 0, ...(modifiers ? {} : { text: last }) }, modifiers };
  throw new MayuraError('INVALID_INPUT', `Unknown key ${last}.`);
}
