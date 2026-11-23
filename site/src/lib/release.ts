/** Published V1.2 facts shared by the marketing surfaces. Historical release copy stays dated. */
export const integrationPackageCount = 105;

/** Matches the public initializer's six framework starters; docs own the full setup instructions. */
export const frameworkStarters = [
  { id: 'nextjs', name: 'Next.js', detail: 'App Router routes, React chat and a Node worker.' },
  { id: 'hono', name: 'Hono', detail: 'Fetch routes with Vite React; additional Bun, Deno and Workers source.' },
  { id: 'react-router', name: 'React Router', detail: 'Resource routes, React chat and a separate worker.' },
  { id: 'tanstack-start', name: 'TanStack Start', detail: 'Server routes with React and a durable indexing worker.' },
  { id: 'sveltekit', name: 'SvelteKit', detail: 'Native Svelte controls over the headless conversation stores.' },
  { id: 'nuxt', name: 'Nuxt', detail: 'Nitro routes and native Vue conversation controls.' },
] as const;
