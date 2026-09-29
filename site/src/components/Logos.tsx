// "Works with" logos, from svgl (https://github.com/pheralb/svgl, MIT) at commit ed75393, in public/logos/. Each logo
// is a trademark of its owner and is shown only to say Mayura works with that product; none of them endorses Mayura.
// Only products the documentation supports are listed.
import { asset } from '../lib/site';

interface Logo { name: string; light: string; dark?: string }

const models: Logo[] = [
  { name: 'OpenAI', light: 'openai', dark: 'openai_dark' },
  { name: 'Anthropic', light: 'anthropic_black', dark: 'anthropic_white' },
  { name: 'Gemini', light: 'gemini' },
  { name: 'Mistral', light: 'mistral-ai_logo' },
  { name: 'DeepSeek', light: 'deepseek' },
  { name: 'xAI', light: 'xai_light', dark: 'xai_dark' },
  { name: 'Groq', light: 'groq' },
  { name: 'OpenRouter', light: 'openrouter_light', dark: 'openrouter_dark' },
  { name: 'Together AI', light: 'togetherai_light', dark: 'togetherai_dark' },
  { name: 'Azure OpenAI', light: 'azure' },
  { name: 'Ollama', light: 'ollama_light', dark: 'ollama_dark' },
];

const platforms: Logo[] = [
  { name: 'Node.js', light: 'nodejs' },
  { name: 'TypeScript', light: 'typescript' },
  { name: 'Docker', light: 'docker' },
  { name: 'Kubernetes', light: 'kubernetes' },
  { name: 'AWS', light: 'aws_light', dark: 'aws_dark' },
  { name: 'Google Cloud', light: 'google-cloud' },
  { name: 'Vercel', light: 'vercel', dark: 'vercel_dark' },
  { name: 'Render', light: 'render_black', dark: 'render_white' },
  { name: 'Railway', light: 'railway', dark: 'railway_dark' },
  { name: 'Heroku', light: 'heroku' },
  { name: 'PostgreSQL', light: 'postgresql' },
  { name: 'SQLite', light: 'sqlite' },
  { name: 'MCP', light: 'model-context-protocol-light', dark: 'model-context-protocol-dark' },
  { name: 'React', light: 'react_light', dark: 'react_dark' },
];

function Mark({ logo }: { logo: Logo }) {
  const image = (file: string, className: string) => (
    <img src={asset(`logos/${file}.svg`)} alt="" width={20} height={20} loading="lazy" decoding="async" className={`size-5 object-contain ${className}`} />
  );
  return (
    <li className="group flex items-center gap-2.5 rounded-full border border-line bg-raised/60 py-1.5 pr-3.5 pl-2 text-sm text-muted transition hover:border-muted/40 hover:text-fg">
      <span className="grayscale transition group-hover:grayscale-0 dark:brightness-[1.8] dark:group-hover:brightness-100">
        {logo.dark ? <>{image(logo.light, 'dark:hidden')}{image(logo.dark, 'hidden dark:block')}</> : image(logo.light, '')}
      </span>
      {logo.name}
    </li>
  );
}

function Row({ label, logos }: { label: string; logos: Logo[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-center">
      <h3 className="text-sm font-medium text-muted lg:text-right">{label}</h3>
      <ul className="flex flex-wrap gap-2">{logos.map(logo => <Mark key={logo.name} logo={logo} />)}</ul>
    </div>
  );
}

export function WorksWith() {
  return (
    <section className="border-b border-line px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <Row label="Any model" logos={models} />
        <Row label="Runs and stores on" logos={platforms} />
      </div>
    </section>
  );
}
