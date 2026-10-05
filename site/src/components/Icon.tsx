// Line icons drawn for this site (24px grid, 1.8px stroke), so the site needs no icon package.
const paths = {
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2 2 4-4',
  gauge: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm0-5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm1-2.5 3.5-4',
  braces: 'M8 4c-2 0-3 1-3 3v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 2 1 3 3 3m8-16c2 0 3 1 3 3v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 2-1 3-3 3',
  workflow: 'M5 3h5v5H5zM14 16h5v5h-5zM7.5 8v4a2 2 0 0 0 2 2h7v2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  models: 'M12 3 3 7.5l9 4.5 9-4.5L12 3Zm-9 9 9 4.5 9-4.5m-18 4.5 9 4.5 9-4.5',
  alert: 'M12 8v5m0 3.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z',
  check: 'M5 12.5 10 17.5 19 7',
  x: 'M6 6l12 12M18 6 6 18',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0m1-9a3 3 0 1 0 0-6m2 15h3a5 5 0 0 0-4-4.9',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  terminal: 'M4 5h16v14H4zM7.5 9.5 10 12l-2.5 2.5M12.5 15h4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  flask: 'M9.5 3h5M10 3v6.5L4.8 18.3A1.8 1.8 0 0 0 6.3 21h11.4a1.8 1.8 0 0 0 1.5-2.7L14 9.5V3M7.5 14.5h9',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  sparkle: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6.5 9a6.5 6.5 0 0 0 13 0M12 18.5V21',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z',
  box: 'M12 3 4 7v10l8 4 8-4V7l-8-4ZM4 7l8 4 8-4m-8 4v10',
  globe: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm-9-9h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3Z',
  key: 'M15 14a5 5 0 1 0-4.7-3.3L3.5 17.5V21h3.5v-2h2v-2h2l1.3-1.3A5 5 0 0 0 15 14Zm1.5-6.5h.01',
  upload: 'M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.6a4.2 4.2 0 0 1-.4 8.4M12 12.5v8m-3-5 3-3 3 3',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
