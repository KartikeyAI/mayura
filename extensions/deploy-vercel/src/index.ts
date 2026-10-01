import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, type DeployProject } from 'mayura/cli/deploy';

export interface VercelSettings {
  /**
   * The compiled serverless module exporting `handle(request)`, `advanceWorkflows()` and `migrate()`, relative to the
   * project: by default `mayura.js` next to the app module, such as `dist/src/mayura.js`.
   */
  readonly module: string;
  /** The Vercel team to deploy under (`--scope`); your personal account when absent. */
  readonly scope?: string;
  /** Deploy to production (`--prod`), or a preview; production by default. */
  readonly production: boolean;
  /** Seconds the API function may run (above agents' maxDurationMs), and the workflows function. */
  readonly apiMaxDuration: number;
  readonly advanceMaxDuration: number;
  /** Advance workflows every minute with Vercel Cron; how often cron may run depends on your plan. */
  readonly cron: boolean;
}

const allowed = ['module', 'scope', 'production', 'apiMaxDuration', 'advanceMaxDuration', 'cron'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };

function settings(value: JsonValue | undefined, project: DeployProject): VercelSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.vercel allows only ${allowed.join(', ')}.`);
  const module = raw['module'] ?? `${project.app.slice(0, project.app.lastIndexOf('/') + 1)}mayura.js`; const scope = raw['scope'];
  const production = raw['production'] ?? true; const cron = raw['cron'] ?? true;
  if (typeof module !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}\.(?:js|mjs)$/u.test(module)) fail('targets.vercel.module must be the compiled module\'s path inside the project, such as dist/src/mayura.js.');
  if (scope !== undefined && (typeof scope !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(scope))) fail('targets.vercel.scope must be a Vercel team slug.');
  if (typeof production !== 'boolean') fail('targets.vercel.production must be true or false.');
  if (typeof cron !== 'boolean') fail('targets.vercel.cron must be true or false.');
  const seconds = (name: string, fallback: number): number => {
    const item = raw[name] ?? fallback;
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 10 || item > 900) fail(`targets.vercel.${name} must be from 10 to 900 seconds.`);
    return item as number;
  };
  return { module: module as string, ...(scope === undefined ? {} : { scope: scope as string }), production, apiMaxDuration: seconds('apiMaxDuration', 300),
    advanceMaxDuration: seconds('advanceMaxDuration', 60), cron } as VercelSettings;
}

function files(vercel: VercelSettings): Record<string, string> {
  const from = (depth: number) => `${'../'.repeat(depth)}${vercel.module}`;
  // The workflows function advances what is due within this budget, leaving room for its slowest tool before the limit.
  const budget = Math.max(5_000, (vercel.advanceMaxDuration - 20) * 1_000);
  return {
    'vercel.json': `${JSON.stringify({
      rewrites: [{ source: '/v1/:path*', destination: '/api/mayura?path=:path*' }],
      functions: { 'api/mayura.js': { maxDuration: vercel.apiMaxDuration }, 'api/advance-workflows.js': { maxDuration: vercel.advanceMaxDuration } },
      ...(vercel.cron ? { crons: [{ path: '/api/advance-workflows', schedule: '* * * * *' }] } : {}),
    }, null, 2)}\n`,
    'api/mayura.js': `// Mayura's API on Vercel Functions: vercel.json rewrites /v1/<path> here as ?path=<path>; this puts the path back.
import { handle } from '${from(1)}';

function route(request) {
  const url = new URL(request.url); const path = url.searchParams.get('path') ?? ''; url.searchParams.delete('path');
  return handle(new Request(new URL(\`/v1/\${path}\${url.search}\`, url.origin), request));
}
export const GET = route;
export const POST = route;
export const DELETE = route;
`,
    'api/advance-workflows.js': `// Advances every workflow that is due, then returns: Vercel Cron calls it every minute with the project's CRON_SECRET.
import { advanceWorkflows } from '${from(1)}';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== \`Bearer \${secret}\`) return new Response('Unauthorized', { status: 401 });
  return Response.json(await advanceWorkflows(${budget}));
}
`,
    'deploy/vercel/migrate.mjs': `// Run by mayura deploy before the release: migrates storage with the DATABASE_URL in your environment.
import { migrate } from '${from(2)}';

console.log(JSON.stringify(await migrate()));
`,
  };
}

/** Deploys to Vercel Functions: migrates first, then deploys the API and workflows functions with the Vercel CLI. */
export const vercelTarget = defineDeployTarget<VercelSettings>({
  id: 'vercel', description: 'Deploy to Vercel Functions: migrate from here, then deploy the API and the cron-driven workflows function with the Vercel CLI.', tools: ['vercel', 'npm', 'node'],
  settings,
  files: ({ settings: vercel }) => files(vercel),
  plan: async ({ settings: vercel, readFile }) => {
    for (const path of ['vercel.json', 'api/mayura.js', 'api/advance-workflows.js', 'deploy/vercel/migrate.mjs']) await readFile(path);
    const scope = vercel.scope === undefined ? [] : ['--scope', vercel.scope];
    return [
      { id: 'check-login', description: 'Check that the Vercel CLI is logged in', tool: 'vercel', args: ['whoami', ...scope] },
      { id: 'build', description: 'Build the project here, for the migration', tool: 'npm', args: ['run', 'build'] },
      // Vercel has no pre-deploy step: storage is migrated from here before the new functions go live.
      { id: 'migrate', description: 'Migrate storage with the DATABASE_URL in your environment', tool: 'node', args: ['deploy/vercel/migrate.mjs'] },
      { id: 'deploy', description: `Deploy to ${vercel.production ? 'production' : 'a preview'} and wait for it`, tool: 'vercel',
        args: ['deploy', ...(vercel.production ? ['--prod'] : []), '--yes', ...scope], output: { match: 'https://[A-Za-z0-9.-]+' } },
    ];
  },
});

export default vercelTarget;
