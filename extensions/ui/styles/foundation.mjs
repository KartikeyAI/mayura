// Mayura's shared theme is scoped to UiRoot in both the npm build and shadcn apps.
const font = '"Geist Variable", Geist, system-ui, sans-serif';
const colors = {
  '--color-canvas': '#faf9f6',
  '--color-sidebar': '#f0eee8',
  '--color-nav-active': '#e7e4da',
  '--color-paper': '#fffefb',
  '--color-prompt-surface': '#fff',
  '--color-wash': '#efede6',
  '--color-ink': '#22251e',
  '--color-secondary': '#41453c',
  '--color-muted': '#62655b',
  '--color-line': '#d9d7cc',
  '--color-line-strong': '#8e9183',
  '--color-composer-line': '#d6d6d6',
  '--color-focus': '#4e5148',
  '--color-accent': '#205540',
  '--color-accent-deep': '#163f30',
  '--color-tint-strong': '#dce7da',
  '--color-warning': '#f6eee0',
  '--color-warning-ink': '#684820',
  '--color-action': 'var(--color-accent)',
  '--color-action-hover': 'var(--color-accent-deep)',
  '--color-recording': '#a34e37',
};

const darkColors = {
  '--color-canvas': '#191c19',
  '--color-sidebar': '#151815',
  '--color-nav-active': '#2a3028',
  '--color-paper': '#232721',
  '--color-prompt-surface': 'var(--color-paper)',
  '--color-wash': '#2e342b',
  '--color-ink': '#f2f2ea',
  '--color-secondary': '#d7dacf',
  '--color-muted': '#a6ad9f',
  '--color-line': '#454c41',
  '--color-line-strong': '#8b9586',
  '--color-composer-line': '#6b7566',
  '--color-focus': '#b0bcaa',
  '--color-accent': '#97caaa',
  '--color-accent-deep': '#b3ddbf',
  '--color-tint-strong': '#31483b',
  '--color-warning': '#3a3025',
  '--color-warning-ink': '#edc08a',
  '--color-action': '#356248',
  '--color-action-hover': '#3e7053',
  '--color-recording': '#e1967d',
};

export const uiFoundation = {
  '@layer base': {
    '.mayura-ui': {
      ...colors,
      '--motion-fast': '140ms',
      '--motion-enter': '200ms',
      '--motion-drawer': '265ms',
      '--ease-out': 'cubic-bezier(0.23, 1, 0.32, 1)',
      '--ease-drawer': 'cubic-bezier(0.32, 0.72, 0, 1)',
      'color-scheme': 'light',
      'background-color': 'var(--color-canvas)',
      color: 'var(--color-ink)',
      'font-family': font,
      '-webkit-font-smoothing': 'antialiased',
    },
    '.mayura-ui[data-theme="dark"]': { ...darkColors, 'color-scheme': 'dark' },
    '.mayura-ui button:enabled': { cursor: 'pointer' },
    '.mayura-ui :focus-visible': { outline: '2px solid var(--color-focus)', 'outline-offset': '3px' },
    '.mayura-ui ::selection': { color: 'var(--color-accent-deep)', background: 'var(--color-tint-strong)' },
    '.mayura-ui textarea': { 'caret-color': 'var(--color-accent)' },
  },
  '@keyframes mayura-ui-stream-dot': {
    '0%, 65%, 100%': { opacity: '0.5', transform: 'translateY(0)' },
    '32%': { opacity: '1', transform: 'translateY(-2px)' },
  },
  '@keyframes mayura-ui-approval-appear': {
    from: { opacity: '0', transform: 'translateY(6px)' },
  },
  '@keyframes mayura-ui-voice-recording': {
    to: { opacity: '0.5' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.mayura-ui': { '--motion-fast': '0ms', '--motion-enter': '0ms', '--motion-drawer': '0ms' },
  },
};

// The example shell still uses named Tailwind colors; the library's copied classes use scoped variables directly.
export const exampleTheme = { '@theme': { '--font-sans': font, ...colors } };

export function renderUiCss(rules, indent = '') {
  return Object.entries(rules).map(([key, value]) =>
    typeof value === 'string'
      ? `${indent}${key}: ${value};\n`
      : `${indent}${key} {\n${renderUiCss(value, indent + '  ')}${indent}}\n`).join('');
}
