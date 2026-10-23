import { sections as docSections } from 'virtual:mayura-docs';
import { articles } from 'virtual:mayura-content';

/** The directory's areas, in the order its filters list them. `key` matches `area` in an integration page's frontmatter. */
export const areas = [
  { key: 'vectors', title: 'Vector stores' },
  { key: 'rerankers', title: 'Rerankers' },
  { key: 'gateways', title: 'AI gateways' },
  { key: 'providers', title: 'Model providers' },
  { key: 'voice', title: 'Voice' },
  { key: 'storage', title: 'Databases' },
  { key: 'files', title: 'File storage' },
  { key: 'memory', title: 'Memory' },
  { key: 'observability', title: 'Observability' },
  { key: 'sandboxes', title: 'Sandboxes' },
  { key: 'browsers', title: 'Browsers' },
  { key: 'authz', title: 'Authorization' },
  { key: 'auth', title: 'Sign-in' },
  { key: 'keys', title: 'API keys' },
  { key: 'deploy', title: 'Deploy' },
  { key: 'runtimes', title: 'Runtimes' },
  { key: 'frameworks', title: 'Frameworks and protocols' },
] as const;
export type AreaKey = (typeof areas)[number]['key'];

/** One card in the directory: a package, something built into `mayura`, or a guide for a framework or platform. */
export interface DirectoryEntry {
  name: string;
  description: string;
  area: AreaKey;
  logo: string;
  kind: 'package' | 'built-in' | 'guide';
  /** `@mayurajs/<name>` for a package, the entry point for a built-in. */
  label: string;
  /** A docs page (`slug`, optionally `#hash`) or a site path. */
  docs?: { slug: string; hash?: string };
  path?: string;
}

/** What `mayura` itself connects to, without a package; each links to the guide that covers it. */
const builtIns: Omit<DirectoryEntry, 'kind'>[] = [
  { name: 'OpenAI', area: 'providers', logo: 'openai', label: 'mayura/provider-openai', description: 'The Responses API adapter built into mayura, and OpenAI embeddings for memory.', docs: { slug: 'guides/model-providers', hash: 'the-adapters' } },
  { name: 'Anthropic', area: 'providers', logo: 'anthropic', label: 'mayura/provider-anthropic', description: 'The Messages API adapter built into mayura, with thinking and tools.', docs: { slug: 'guides/model-providers', hash: 'the-adapters' } },
  { name: 'OpenAI-compatible APIs', area: 'providers', logo: 'deepseek', label: 'mayura/provider-openai', description: 'DeepSeek, xAI, OpenRouter, Together, Fireworks, gateways and local servers through one adapter.', docs: { slug: 'guides/model-providers', hash: 'openai-compatible-providers' } },
  { name: 'SQLite', area: 'storage', logo: 'sqlite', label: 'mayura/storage-sqlite', description: 'A local database file for runs, workflows, memory and keys.', docs: { slug: 'guides/storage', hash: 'sqlite' } },
  { name: 'PostgreSQL', area: 'storage', logo: 'postgresql', label: 'mayura/storage-postgres', description: 'The production store, on pg or a pool you own (Neon at the edge).', docs: { slug: 'guides/storage', hash: 'postgresql' } },
  { name: 'Amazon S3 and compatibles', area: 'files', logo: 'aws', label: 'mayura/files', description: 'S3, Cloudflare R2, MinIO and Backblaze B2 through the built-in s3Files backend.', docs: { slug: 'guides/files', hash: 's3-and-s3-compatible-services' } },
  { name: 'Mem0', area: 'memory', logo: 'mem0', label: 'mayura/memory-remote', description: 'A hosted semantic index for native memory, checked against your own store.', docs: { slug: 'guides/memory-and-context', hash: 'remote-memory-services' } },
  { name: 'Supermemory', area: 'memory', logo: 'supermemory', label: 'mayura/memory-remote', description: 'A hosted semantic index for native memory, checked against your own store.', docs: { slug: 'guides/memory-and-context', hash: 'remote-memory-services' } },
  { name: 'OpenViking', area: 'memory', logo: 'openviking', label: 'mayura/memory-remote', description: 'A self-hosted context store for native memory, over HTTPS.', docs: { slug: 'guides/memory-and-context', hash: 'remote-memory-services' } },
  { name: 'OpenTelemetry', area: 'observability', logo: 'opentelemetry', label: 'mayura/exporter-otlp', description: 'GenAI spans through your own OpenTelemetry SDK, or as OTLP JSON or protobuf.', docs: { slug: 'guides/observability', hash: 'export-to-opentelemetry' } },
  { name: 'Docker', area: 'sandboxes', logo: 'docker', label: 'mayura/sandbox', description: 'Locked-down local containers for agents, over the Docker CLI or Engine API.', docs: { slug: 'guides/sandboxes', hash: 'docker' } },
  { name: 'QuickJS', area: 'sandboxes', logo: 'quickjs', label: 'mayura/adapter-code-quickjs', description: 'Code Mode: model-written programs in an in-process QuickJS sandbox.', docs: { slug: 'guides/code-mode', hash: 'sandboxes' } },
  { name: 'Chrome and Edge', area: 'browsers', logo: 'chrome', label: 'mayura/browser/local', description: 'The Chrome or Edge installed on the machine, kept to the origins you allow.', docs: { slug: 'guides/browsers' } },
  { name: 'Better Auth', area: 'auth', logo: 'better-auth', label: 'mayura/auth/better-auth', description: 'Host sign-in yourself with better-auth, on your Mayura server.', docs: { slug: 'guides/authentication', hash: 'sign-in-with-better-auth' } },
  { name: 'Mayura API keys', area: 'keys', logo: 'mayura', label: 'mayura/keys', description: 'Issue, rotate and revoke API keys in any Mayura store, with scopes, limits and credits.', docs: { slug: 'guides/authentication', hash: 'api-keys' } },
  { name: 'Docker and Compose', area: 'deploy', logo: 'docker', label: 'mayura deploy', description: 'Images and a Compose file for the server, the worker and migrations.', docs: { slug: 'cli/deploy', hash: 'targets' } },
  { name: 'Kubernetes', area: 'deploy', logo: 'kubernetes', label: 'mayura deploy', description: 'Manifests for the server, the worker, probes and migrations.', docs: { slug: 'cli/deploy', hash: 'kubernetes-manifests' } },
  { name: 'Node.js', area: 'runtimes', logo: 'nodejs', label: 'Node.js 22 and 24', description: 'Every entry point, the CLI and the Node server.', docs: { slug: 'project/support' } },
  { name: 'Bun', area: 'runtimes', logo: 'bun', label: 'Edge runtimes', description: 'Every entry point except the Node-only ones, tested in CI.', docs: { slug: 'guides/deployment', hash: 'edge-runtimes' } },
  { name: 'Deno', area: 'runtimes', logo: 'deno', label: 'Edge runtimes', description: 'Every entry point except the Node-only ones, tested in CI.', docs: { slug: 'guides/deployment', hash: 'edge-runtimes' } },
  { name: 'Cloudflare Workers', area: 'runtimes', logo: 'cloudflare', label: 'Edge runtimes', description: 'Requests in fetch, workflows on a Cron Trigger, storage in D1 or Postgres.', docs: { slug: 'guides/deployment', hash: 'edge-runtimes' } },
  { name: 'Vercel Edge Functions', area: 'runtimes', logo: 'vercel', label: 'Edge runtimes', description: 'Tested on a Vercel Edge deployment, with PostgreSQL through Neon.', docs: { slug: 'guides/deployment', hash: 'edge-runtimes' } },
  { name: 'React', area: 'frameworks', logo: 'react', label: 'mayura/client-react', description: 'Hooks, components and forms for live runs, approvals and workflow progress.', docs: { slug: 'guides/react' } },
  { name: 'Model Context Protocol', area: 'frameworks', logo: 'mcp', label: 'mayura/adapter-mcp', description: 'Call MCP tools as ordinary tools, under your permissions and budget.', docs: { slug: 'guides/mcp' } },
];

/** Logos and areas for the framework and platform guides in site/content/integrations. */
const guideMeta: Record<string, { logo: string; area: AreaKey; name: string }> = {
  nextjs: { logo: 'nextjs', area: 'frameworks', name: 'Next.js' },
  hono: { logo: 'hono', area: 'frameworks', name: 'Hono' },
  'react-router': { logo: 'react', area: 'frameworks', name: 'React Router' },
  'tanstack-start': { logo: 'tanstack', area: 'frameworks', name: 'TanStack Start' },
  sveltekit: { logo: 'svelte', area: 'frameworks', name: 'SvelteKit' },
  nuxt: { logo: 'nuxt', area: 'frameworks', name: 'Nuxt' },
  vercel: { logo: 'vercel', area: 'deploy', name: 'Vercel' },
  'cloudflare-workers': { logo: 'cloudflare', area: 'runtimes', name: 'Cloudflare Workers' },
  supabase: { logo: 'supabase', area: 'storage', name: 'Supabase' },
  neon: { logo: 'neon', area: 'storage', name: 'Neon' },
  clerk: { logo: 'clerk', area: 'auth', name: 'Clerk' },
  langfuse: { logo: 'langfuse', area: 'observability', name: 'Langfuse' },
  e2b: { logo: 'e2b', area: 'sandboxes', name: 'E2B' },
};

/** Every entry: the integration pages in the docs, the built-ins, and the integration guides. */
export function directory(): DirectoryEntry[] {
  const packages: DirectoryEntry[] = docSections.flatMap(section => section.pages.flatMap(page => page.integration ? [{
    name: page.title, description: page.description, area: page.integration.area as AreaKey,
    logo: page.integration.logo, kind: 'package' as const, label: page.integration.package, docs: { slug: page.slug },
  }] : []));
  const guides: DirectoryEntry[] = articles.integrations.map(article => ({
    name: guideMeta[article.slug]?.name ?? article.title, description: article.description, area: guideMeta[article.slug]?.area ?? 'frameworks',
    logo: guideMeta[article.slug]?.logo ?? 'mayura', kind: 'guide' as const, label: 'Guide', path: `/integrations/${article.slug}/`,
  }));
  return [...packages, ...builtIns.map(entry => ({ ...entry, kind: 'built-in' as const })), ...guides];
}
