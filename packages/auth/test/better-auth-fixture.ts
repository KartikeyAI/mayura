import type { BetterAuthInstance } from '../src/better-auth.js';

// better-auth's own declarations do not compile under this repository's strict settings (skipLibCheck off: they name
// bun:sqlite, and one of its types fails to index), so the tests load it untyped. That a real instance fits Mayura's
// types is checked on its own, with skipLibCheck as applications have it (types/better-auth-compat.ts).
const modules = { core: 'better-auth', plugins: 'better-auth/plugins', migration: 'better-auth/db/migration', apiKey: '@better-auth/api-key' };
type Endpoint = (input?: unknown) => Promise<any>;
/** A real better-auth instance as these tests use it: Mayura's parts typed, its other endpoints untyped. */
type Used = 'signUpEmail' | 'signOut' | 'createOrganization' | 'setActiveOrganization' | 'getActiveMember' | 'createApiKey' | 'updateApiKey';
export type RealBetterAuth = BetterAuthInstance & { readonly api: BetterAuthInstance['api'] & Record<Used, Endpoint>; readonly options: unknown };

/** A real better-auth 1.7 instance, with the plugins Mayura works with, on the database given; migrated. */
export async function realBetterAuth(database: unknown, extra: { readonly rateLimit?: { readonly enabled: boolean; readonly timeWindow: number; readonly maxRequests: number }; readonly migrate?: boolean } = {}) {
  const { betterAuth } = await import(modules.core) as { betterAuth: (options: unknown) => RealBetterAuth };
  const { bearer, jwt, organization } = await import(modules.plugins) as Record<'bearer' | 'jwt' | 'organization', (options?: unknown) => unknown>;
  const { getMigrations } = await import(modules.migration) as { getMigrations: (options: unknown) => Promise<{ runMigrations(): Promise<void> }> };
  const { apiKey } = await import(modules.apiKey) as { apiKey: (options?: unknown) => unknown };
  const auth = betterAuth({
    database, secret: crypto.getRandomValues(new Uint8Array(32)).reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), ''),
    baseURL: 'http://localhost:3000', emailAndPassword: { enabled: true }, telemetry: { enabled: false }, rateLimit: { enabled: false },
    plugins: [bearer(), jwt(), organization(), apiKey({ defaultPrefix: 'acme_', rateLimit: { enabled: extra.rateLimit?.enabled ?? false, timeWindow: extra.rateLimit?.timeWindow ?? 60_000, maxRequests: extra.rateLimit?.maxRequests ?? 100 } })],
  });
  // better-auth migrates SQL databases; MongoDB needs no schema.
  if (extra.migrate !== false) await (await getMigrations(auth.options)).runMigrations();
  /** Signs a new user up; their bearer token and id. */
  const signUp = async (email: string) => {
    const result = await auth.api.signUpEmail({ body: { email, password: 'a-long-test-password-1', name: email.split('@')[0]! }, returnHeaders: true }) as { headers: Headers; response: { user: { id: string } } };
    return { token: result.headers.get('set-auth-token')!, userId: result.response.user.id };
  };
  return { auth, signUp };
}
