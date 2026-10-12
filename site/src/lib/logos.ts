// The logos the integrations directory and integration pages show, by the `logo` key in a page's frontmatter. Files
// are in public/logos/:
//   - from svgl (https://github.com/pheralb/svgl, MIT) at commit ed75393 and f9b726c: plain names;
//   - from Simple Icons (https://simpleicons.org, CC0) 16.35.0, coloured with the brand's colour: `si-*`;
//   - the SVG icon each vendor publishes on its own website: `vendor-*`.
// A brand with none of these gets a tile with its initials instead of an improvised logo. Every logo is a trademark of
// its owner, shown only to say Mayura works with that product; none of them endorses Mayura.

export interface LogoFiles { light: string; dark?: string }
export type LogoSource = LogoFiles | { initials: string };

export const logos: Record<string, LogoSource> = {
  // Models and AI
  openai: { light: 'openai', dark: 'openai_dark' },
  anthropic: { light: 'anthropic_black', dark: 'anthropic_white' },
  gemini: { light: 'gemini' },
  groq: { light: 'groq' },
  mistral: { light: 'mistral-ai_logo' },
  ollama: { light: 'ollama_light', dark: 'ollama_dark' },
  deepseek: { light: 'deepseek' },
  xai: { light: 'xai_light', dark: 'xai_dark' },
  openrouter: { light: 'openrouter_light', dark: 'openrouter_dark' },
  togetherai: { light: 'togetherai_light', dark: 'togetherai_dark' },
  // Clouds
  aws: { light: 'aws_light', dark: 'aws_dark' },
  azure: { light: 'azure' },
  'google-cloud': { light: 'google-cloud' },
  google: { light: 'google' },
  cloudflare: { light: 'cloudflare' },
  vercel: { light: 'vercel', dark: 'vercel_dark' },
  microsoft: { light: 'microsoft' },
  apple: { light: 'apple', dark: 'apple_dark' },
  // Voice
  elevenlabs: { light: 'si-elevenlabs', dark: 'si-elevenlabs_dark' },
  deepgram: { light: 'si-deepgram' },
  assemblyai: { initials: 'AA' },
  cartesia: { light: 'vendor-cartesia' },
  // Data and files
  turso: { light: 'turso-light', dark: 'turso-dark' },
  mysql: { light: 'mysql-icon-light', dark: 'mysql-icon-dark' },
  mongodb: { light: 'mongodb-icon-light', dark: 'mongodb-icon-dark' },
  postgresql: { light: 'postgresql' },
  sqlite: { light: 'sqlite' },
  'google-drive': { light: 'drive' },
  mesa: { light: 'vendor-mesa' },
  'files-sdk': { initials: 'FS' },
  minio: { light: 'si-minio' },
  backblaze: { light: 'si-backblaze' },
  // Observability
  langfuse: { light: 'vendor-langfuse' },
  langsmith: { light: 'si-langchain' },
  datadog: { light: 'datadog' },
  arize: { initials: 'AX' },
  sentry: { light: 'sentry' },
  betterstack: { light: 'si-betterstack', dark: 'si-betterstack_dark' },
  posthog: { light: 'posthog' },
  opentelemetry: { light: 'si-opentelemetry', dark: 'si-opentelemetry_dark' },
  // Sandboxes and hosting
  e2b: { initials: 'E2B' },
  daytona: { light: 'vendor-daytona' },
  fly: { light: 'fly' },
  modal: { light: 'si-modal' },
  railway: { light: 'railway', dark: 'railway_dark' },
  northflank: { initials: 'NF' },
  codesandbox: { light: 'codesandbox-square' },
  render: { light: 'render_black', dark: 'render_white' },
  digitalocean: { light: 'digitalocean' },
  docker: { light: 'docker' },
  kubernetes: { light: 'kubernetes' },
  // Browsers
  browserbase: { light: 'vendor-browserbase' },
  steel: { light: 'vendor-steel' },
  hyperbrowser: { initials: 'HB' },
  browserless: { light: 'vendor-browserless' },
  kernel: { light: 'vendor-kernel' },
  'browser-use': { initials: 'BU' },
  anchor: { initials: 'AB' },
  browserview: { light: 'vendor-browserview' },
  firecrawl: { light: 'firecrawl', dark: 'firecrawl-dark' },
  chrome: { light: 'chrome' },
  edge: { light: 'edge' },
  // Sign-in and keys
  clerk: { light: 'clerk-icon-light', dark: 'clerk-icon-dark' },
  auth0: { light: 'auth0' },
  neon: { light: 'neon' },
  supabase: { light: 'supabase' },
  firebase: { light: 'firebase' },
  workos: { light: 'workos', dark: 'workos-light' },
  facebook: { light: 'facebook-icon' },
  okta: { light: 'si-okta' },
  unkey: { light: 'vendor-unkey' },
  reqkey: { light: 'vendor-reqkey' },
  'better-auth': { light: 'better-auth_light', dark: 'better-auth_dark' },
  // Runtimes, frameworks and protocols
  nodejs: { light: 'nodejs' },
  deno: { light: 'deno', dark: 'deno_dark' },
  bun: { light: 'bun' },
  nextjs: { light: 'nextjs_icon_dark' },
  react: { light: 'react_light', dark: 'react_dark' },
  hono: { light: 'hono' },
  mcp: { light: 'model-context-protocol-light', dark: 'model-context-protocol-dark' },
  mem0: { light: 'vendor-mem0' },
  supermemory: { light: 'vendor-supermemory' },
  openviking: { initials: 'OV' },
  quickjs: { initials: 'QJS' },
  mayura: { light: '../favicon' },
};
