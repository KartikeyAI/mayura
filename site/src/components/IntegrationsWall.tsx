// The landing page's "works with" wall: a few products per area, each linking to its integration page, and the
// directory for the rest. Logos come from site/src/lib/logos.ts; each is a trademark of its owner, shown only to say
// Mayura works with that product.
import { Link } from '@tanstack/react-router';
import { BrandLogo } from './BrandLogo';
import { Icon } from './Icon';

interface Item { name: string; logo: string; slug: string; hash?: string }
const page = (folder: string) => `integrations/${folder}`;

const rows: { label: string; items: Item[] }[] = [
  { label: 'Models', items: [
    { name: 'OpenAI', logo: 'openai', slug: page('provider-openai') },
    { name: 'Anthropic', logo: 'anthropic', slug: page('provider-anthropic') },
    { name: 'Gemini', logo: 'gemini', slug: page('provider-google') },
    { name: 'Bedrock', logo: 'aws', slug: page('provider-bedrock') },
    { name: 'Azure OpenAI', logo: 'azure', slug: page('provider-azure') },
    { name: 'Mistral', logo: 'mistral', slug: page('provider-mistral') },
    { name: 'Groq', logo: 'groq', slug: page('provider-groq') },
    { name: 'Ollama', logo: 'ollama', slug: page('provider-ollama') },
    { name: 'DeepSeek', logo: 'deepseek', slug: 'guides/model-providers', hash: 'openai-compatible-providers' },
    { name: 'OpenRouter', logo: 'openrouter', slug: 'guides/model-providers', hash: 'openai-compatible-providers' },
  ] },
  { label: 'Data and files', items: [
    { name: 'PostgreSQL', logo: 'postgresql', slug: 'guides/storage', hash: 'postgresql' },
    { name: 'SQLite', logo: 'sqlite', slug: 'guides/storage', hash: 'sqlite' },
    { name: 'Turso', logo: 'turso', slug: page('storage-libsql') },
    { name: 'MySQL', logo: 'mysql', slug: page('storage-mysql') },
    { name: 'MongoDB', logo: 'mongodb', slug: page('storage-mongodb') },
    { name: 'D1', logo: 'cloudflare', slug: page('storage-d1') },
    { name: 'DynamoDB', logo: 'aws', slug: page('storage-dynamodb') },
    { name: 'Cloud Storage', logo: 'google-cloud', slug: page('filestorage-gcs') },
    { name: 'Vercel Blob', logo: 'vercel', slug: page('filestorage-vercel-blob') },
    { name: 'Google Drive', logo: 'google-drive', slug: page('filestorage-google-drive') },
  ] },
  { label: 'Sandboxes and browsers', items: [
    { name: 'Docker', logo: 'docker', slug: 'guides/sandboxes', hash: 'docker' },
    { name: 'E2B', logo: 'e2b', slug: page('sandbox-e2b') },
    { name: 'Daytona', logo: 'daytona', slug: page('sandbox-daytona') },
    { name: 'Modal', logo: 'modal', slug: page('sandbox-modal') },
    { name: 'Vercel Sandbox', logo: 'vercel', slug: page('sandbox-vercel') },
    { name: 'Chrome', logo: 'chrome', slug: 'guides/browsers' },
    { name: 'Browserbase', logo: 'browserbase', slug: page('browser-browserbase') },
    { name: 'Steel', logo: 'steel', slug: page('browser-steel') },
    { name: 'Kernel', logo: 'kernel', slug: page('browser-kernel') },
    { name: 'Firecrawl', logo: 'firecrawl', slug: page('browser-firecrawl') },
  ] },
  { label: 'Voice and tracing', items: [
    { name: 'ElevenLabs', logo: 'elevenlabs', slug: page('voice-elevenlabs') },
    { name: 'Deepgram', logo: 'deepgram', slug: page('voice-deepgram') },
    { name: 'Cartesia', logo: 'cartesia', slug: page('voice-cartesia') },
    { name: 'OpenTelemetry', logo: 'opentelemetry', slug: 'guides/observability', hash: 'export-to-opentelemetry' },
    { name: 'Langfuse', logo: 'langfuse', slug: page('observability-langfuse') },
    { name: 'LangSmith', logo: 'langsmith', slug: page('observability-langsmith') },
    { name: 'Datadog', logo: 'datadog', slug: page('observability-datadog') },
    { name: 'Sentry', logo: 'sentry', slug: page('observability-sentry') },
    { name: 'PostHog', logo: 'posthog', slug: page('observability-posthog') },
  ] },
  { label: 'Sign-in and deploy', items: [
    { name: 'Clerk', logo: 'clerk', slug: page('auth-clerk') },
    { name: 'Auth0', logo: 'auth0', slug: page('auth-auth0') },
    { name: 'Supabase', logo: 'supabase', slug: page('auth-supabase') },
    { name: 'Firebase', logo: 'firebase', slug: page('auth-firebase') },
    { name: 'WorkOS', logo: 'workos', slug: page('auth-workos') },
    { name: 'Kubernetes', logo: 'kubernetes', slug: 'cli/deploy', hash: 'kubernetes-manifests' },
    { name: 'Fly.io', logo: 'fly', slug: page('deploy-fly') },
    { name: 'Cloud Run', logo: 'google-cloud', slug: page('deploy-cloudrun') },
    { name: 'Railway', logo: 'railway', slug: page('deploy-railway') },
    { name: 'Workers', logo: 'cloudflare', slug: page('deploy-cloudflare') },
  ] },
];

function Chip({ item }: { item: Item }) {
  return (
    <li>
      <Link to="/docs/$/" params={{ _splat: item.slug }} {...(item.hash ? { hash: item.hash } : {})}
        className="flex items-center gap-2 rounded-full border border-line bg-raised/60 py-1 pr-3.5 pl-1 text-sm text-muted transition hover:border-muted/40 hover:text-fg">
        <BrandLogo logo={item.logo} size="sm" />
        {item.name}
      </Link>
    </li>
  );
}

export function IntegrationsWall() {
  return (
    <section className="border-b border-line px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <h2 className="mx-auto max-w-3xl text-center text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-[2.6rem] sm:leading-[1.1]">
          Works with what you already use. <span className="text-muted">85 integration packages, released with every version.</span>
        </h2>
        <div className="mt-12 space-y-6">
          {rows.map(row => (
            <div key={row.label} className="grid gap-3 lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-center">
              <h3 className="text-sm font-medium text-muted lg:text-right">{row.label}</h3>
              <ul className="flex flex-wrap gap-2">{row.items.map(item => <Chip key={`${row.label}-${item.name}`} item={item} />)}</ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <Link to="/integrations/"
            className="group inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-bg/60 px-5 text-sm font-medium transition hover:border-muted/50">
            Browse every integration <Icon name="arrow" className="size-4 transition group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
